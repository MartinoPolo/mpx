import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createNodeWorktreeIncludeDependencies, deriveLifecycleKey, deriveWorktreePath, planWorktreeIncludes } from "@mpx/worktrees";
import type { PreparationPlan, ProjectConfig } from "@mpx/config";
import type { ProviderProcessRequest } from "@mpx/providers";
import { afterEach, expect, it, vi } from "vitest";
import { catalogPath, classifyProviderProcessResult, defaultContext, NodeProviderProcessExecutor, NodeRepositorySelectorResolver, parseForgeRepositoryUrl, preparationRuntime, providerService, requireRepositoryBoundLifecycleState, resolveBuiltInProviderExecutable, verifyPreparationWorkerHandshake, windowsProcessIdentityInspector, worktrees } from "./context.js";

const exec = promisify(execFile);

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("provides fail-closed Docker resume admission in the production CLI context", async () => {
  expect(defaultContext.sessionDockerResumeAdmission).toBeTypeOf("function");
  await expect(defaultContext.sessionDockerResumeAdmission!({ launch: { executor: { kind: "docker" } } } as never)).resolves.toMatchObject({ admitted: false, hostFallback: false });
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd });
}

async function includeLifecycleFixture(branch: string) {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-context-include-"));
  roots.push(root);
  const mainRoot = path.join(root, "main repo");
  const sourceRoot = path.join(root, "source repo");
  const stateRoot = path.join(root, "state");
  await Promise.all([mkdir(mainRoot), mkdir(sourceRoot), mkdir(stateRoot)]);
  for (const repository of [mainRoot, sourceRoot]) await git(repository, "init", "-b", "main");

  await writeFile(path.join(mainRoot, "mpxconfig.json"), JSON.stringify({
    schemaVersion: 1,
    project: { id: "context/include" },
    repository: { provider: "generic", remote: "origin" },
  }));
  await writeFile(path.join(mainRoot, ".worktreeinclude"), "local data/**\n");
  await git(mainRoot, "add", "mpxconfig.json", ".worktreeinclude");
  await git(mainRoot, "-c", "user.name=MPX Test", "-c", "user.email=mpx@example.invalid", "commit", "-m", "fixture");

  await mkdir(path.join(sourceRoot, "local data"));
  await writeFile(path.join(sourceRoot, "local data", "approved secret.txt"), "approved bytes");
  await writeFile(path.join(sourceRoot, "local data", "tracked.txt"), "tracked bytes");
  await writeFile(path.join(sourceRoot, "unapproved.txt"), "unapproved bytes");
  await git(sourceRoot, "add", "local data/tracked.txt");
  await git(sourceRoot, "-c", "user.name=MPX Test", "-c", "user.email=mpx@example.invalid", "commit", "-m", "tracked fixture");

  const destinationRoot = deriveWorktreePath(mainRoot, branch);
  const effects: string[] = [];
  const approvedDestination = path.join(destinationRoot, "local data", "approved secret.txt");
  const unexpectedPortCall = async (): Promise<never> => { throw new Error("Unexpected fake port call."); };
  const portService = {
    ensure: async () => {
      effects.push(await exists(approvedDestination) ? "ports-after-copy" : "ports-before-copy");
      return { lease: { leaseId: "fake-lease", projectId: "context/include", repositoryId: "fake-repository", worktreeId: branch, worktreePath: destinationRoot, role: "linked" as const, slot: 1, configHash: "fake-config", services: {}, claims: [], updatedAt: 1 }, warnings: [] };
    },
    resolve: unexpectedPortCall, list: unexpectedPortCall, inspect: unexpectedPortCall, kill: unexpectedPortCall,
    release: unexpectedPortCall, rebuild: unexpectedPortCall, captureReleaseIdentity: unexpectedPortCall,
    releaseLinkedAfterRemoval: unexpectedPortCall, resolveOrphan: unexpectedPortCall,
    reconcile: async () => ({ orphaned: [], removed: [], repaired: [] }),
  };
  const service = worktrees({
    env: { LOCALAPPDATA: stateRoot },
    portService,
    preparationRuntimeFactory: () => ({
      run: async () => { effects.push(effects.at(-1) === "ports-after-copy" ? "preparation-after-ports" : "preparation-before-ports"); return { status: "ready" }; },
      retry: async () => ({ status: "ready" }),
      cancel: async () => ({ status: "cancelled" }),
      reconcile: async () => ({ status: "ready" }),
    }),
  });
  const request = { cwd: mainRoot, branch, base: "main", sourceRoot };
  return { mainRoot, sourceRoot, destinationRoot, stateRoot, effects, service, portService, request };
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

async function currentIncludeApproval(fixture: Awaited<ReturnType<typeof includeLifecycleFixture>>): Promise<string> {
  const plan = await planWorktreeIncludes({
    repositoryId: "context/include",
    sourceRoot: fixture.sourceRoot,
    mainRoot: fixture.mainRoot,
    destinationRoot: fixture.destinationRoot,
  }, createNodeWorktreeIncludeDependencies());
  return plan.approval;
}

it("selects only the packaged trusted catalog instead of a malicious cwd ancestor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-catalog-ancestor-"));
  roots.push(root);
  const maliciousRoot = path.join(root, "malicious");
  const nested = path.join(maliciousRoot, "packages", "app");
  await mkdir(path.join(maliciousRoot, "content", "skills"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(maliciousRoot, "content", "skills", "shadow.txt"), "shadowed");

  const packaged = fileURLToPath(new URL("../../../content/skills", import.meta.url));
  await expect(catalogPath({ env: {} }, nested)).resolves.toBe(packaged);
});

it("binds production GitHub and GitLab adapters to the resolved project root", async () => {
  const requests: ProviderProcessRequest[] = [];
  const execute = vi.fn(async (request: ProviderProcessRequest) => { requests.push(request); return { exitCode: 0, stdout: "[]", stderr: "" }; });
  const cwd = path.resolve("C:/resolved/project");
  const resolve = vi.fn(async () => "github.example/remote-owner/remote-repository");
  const service = await providerService({ env: {}, providerProcessExecutor: { execute }, repositorySelectorResolver: { resolve } }, {
    schemaVersion: 1,
    project: { id: "must-not-be-used/as-selector" },
    repository: { provider: "github", remote: "upstream" },
    issues: { provider: "github" },
  } as ProjectConfig, cwd);

  await service.invoke({ providerId: "github", capability: "issue.list", route: "work-gh", input: {} });
  await service.invoke({ providerId: "gitlab", capability: "issue.list", route: "work-gl", input: {} });

  expect(resolve).toHaveBeenCalledWith({ root: cwd, remote: "upstream" });
  expect(requests).toEqual([
    { argv: ["gh", "issue", "list", "--json", "number,id,title,body,state,labels,url,assignees", "--repo", "github.example/remote-owner/remote-repository"], route: "work-gh", cwd, authExitCodes: [4] },
    { argv: ["glab", "issue", "list", "--output", "json", "--repo", "github.example/remote-owner/remote-repository"], route: "work-gl", cwd },
  ]);
});

it("rejects an operation-cwd provider executable found on PATH", async () => {
  const operationCwd = await mkdtemp(path.join(tmpdir(), "mpx-provider-hijack-"));
  roots.push(operationCwd);
  const candidate = path.join(operationCwd, process.platform === "win32" ? "gh.EXE" : "gh");
  await writeFile(candidate, "hijack");

  await expect(resolveBuiltInProviderExecutable("gh", operationCwd, { PATH: operationCwd, PATHEXT: ".EXE" })).rejects.toMatchObject({ code: "EACCES" });
});

it("resolves a trusted built-in from an absolute PATH directory to its canonical path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-provider-resolution-"));
  roots.push(root);
  const operationCwd = path.join(root, "project");
  const trustedDirectory = path.join(root, "trusted-bin");
  await Promise.all([mkdir(operationCwd), mkdir(trustedDirectory)]);
  const candidate = path.join(trustedDirectory, process.platform === "win32" ? "glab.CMD" : "glab");
  await writeFile(candidate, "trusted");

  await expect(resolveBuiltInProviderExecutable("glab", operationCwd, { PATH: trustedDirectory, PATHEXT: ".CMD" })).resolves.toBe(await realpath(candidate));
  await expect(resolveBuiltInProviderExecutable("custom", operationCwd, { PATH: trustedDirectory, PATHEXT: ".CMD" })).rejects.toMatchObject({ code: "EINVAL" });
});

it("binds native provider authentication to isolated safe route environments without mutating process.env", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-provider-route-"));
  roots.push(root);
  const operationCwd = path.join(root, "project");
  const trustedDirectory = path.join(root, "trusted-bin");
  const appData = path.join(root, "appdata");
  await Promise.all([mkdir(operationCwd), mkdir(trustedDirectory), mkdir(appData)]);
  const extension = process.platform === "win32" ? ".EXE" : "";
  for (const executable of ["gh", "glab", "kf"]) await copyFile(process.execPath, path.join(trustedDirectory, `${executable}${extension}`));
  const environment = { PATH: trustedDirectory, PATHEXT: ".EXE", APPDATA: appData, gh_config_dir: "C:/ambient-gh", Glab_Config_Dir: "C:/ambient-glab", mpx_provider_route: "ambient" };
  const originalProcessRoute = process.env.MPX_PROVIDER_ROUTE;
  const executor = new NodeProviderProcessExecutor(environment);
  const expression = "process.stdout.write(JSON.stringify({route:process.env.MPX_PROVIDER_ROUTE,gh:process.env.GH_CONFIG_DIR,glab:process.env.GLAB_CONFIG_DIR}))";
  const githubWork = JSON.parse((await executor.execute({ argv: ["gh", "-e", expression], route: "github-work", cwd: operationCwd })).stdout) as Record<string, string>;
  const githubPersonal = JSON.parse((await executor.execute({ argv: ["gh", "-e", expression], route: "github-personal", cwd: operationCwd })).stdout) as Record<string, string>;
  const gitlabWork = JSON.parse((await executor.execute({ argv: ["glab", "-e", expression], route: "gitlab-work", cwd: operationCwd })).stdout) as Record<string, string>;
  const kanbanWork = JSON.parse((await executor.execute({ argv: ["kf", "-e", expression], route: "kanban-work", cwd: operationCwd })).stdout) as Record<string, string>;

  expect(githubWork).toEqual({ route: "github-work", gh: path.join(appData, "mpx", "provider-routes", "github", "github-work") });
  expect(githubPersonal.gh).toBe(path.join(appData, "mpx", "provider-routes", "github", "github-personal"));
  expect(githubPersonal.gh).not.toBe(githubWork.gh);
  expect(gitlabWork).toEqual({ route: "gitlab-work", glab: path.join(appData, "mpx", "provider-routes", "gitlab", "gitlab-work") });
  expect(kanbanWork).toEqual({ route: "kanban-work" });
  expect(process.env.MPX_PROVIDER_ROUTE).toBe(originalProcessRoute);
});

it("uses the exact launch-injected provider route instead of ambient or requested identity paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-provider-runtime-route-"));
  roots.push(root);
  const operationCwd = path.join(root, "project"), trustedDirectory = path.join(root, "trusted-bin"), injected = path.join(root, "runtime", "github-work");
  await Promise.all([mkdir(operationCwd), mkdir(trustedDirectory), mkdir(injected, { recursive: true })]);
  const executable = path.join(trustedDirectory, process.platform === "win32" ? "gh.EXE" : "gh");
  await copyFile(process.execPath, executable);
  const environment = { PATH: trustedDirectory, PATHEXT: ".EXE", APPDATA: path.join(root, "ambient"), GH_CONFIG_DIR: path.join(root, "other-identity"), MPX_RUNTIME_CONTEXT: "{}", MPX_RUNTIME_ROUTE_PROVIDER_GITHUB: injected };
  const expression = "process.stdout.write(process.env.GH_CONFIG_DIR??'')";
  const result = await new NodeProviderProcessExecutor(environment).execute({ argv: ["gh", "-e", expression], route: "github-personal", cwd: operationCwd });
  expect(result.stdout).toBe(injected);
});

it.each([undefined, "../secret", "C:/private", "token-route", "route.pem"])("fails closed before executable resolution for unsafe provider route %s", async route => {
  const operationCwd = await mkdtemp(path.join(tmpdir(), "mpx-provider-route-reject-"));
  roots.push(operationCwd);
  const resolve = vi.fn(async () => process.execPath);
  const executor = new NodeProviderProcessExecutor({ APPDATA: path.join(operationCwd, "appdata") }, resolve);
  await expect(executor.execute({ argv: ["gh", "--version"], ...(route === undefined ? {} : { route }), cwd: operationCwd })).rejects.toMatchObject({ code: "EINVAL" });
  expect(resolve).not.toHaveBeenCalled();
});

it("fails closed when APPDATA is unavailable", async () => {
  const operationCwd = await mkdtemp(path.join(tmpdir(), "mpx-provider-appdata-reject-"));
  roots.push(operationCwd);
  const resolve = vi.fn(async () => process.execPath);
  await expect(new NodeProviderProcessExecutor({}, resolve).execute({ argv: ["kf", "--version"], route: "kanban-work", cwd: operationCwd })).rejects.toMatchObject({ code: "EINVAL" });
  expect(resolve).not.toHaveBeenCalled();
});

it("memoizes only successful executable resolution for canonical cwd and path inputs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-provider-cache-"));
  roots.push(root);
  const operationCwd = path.join(root, "project");
  const trustedDirectory = path.join(root, "trusted-bin");
  const appData = path.join(root, "appdata");
  await Promise.all([mkdir(operationCwd), mkdir(trustedDirectory), mkdir(appData)]);
  const executable = path.join(trustedDirectory, process.platform === "win32" ? "gh.EXE" : "gh");
  await copyFile(process.execPath, executable);
  const resolve = vi.fn(async () => {
    if (resolve.mock.calls.length === 1) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return executable;
  });
  const executor = new NodeProviderProcessExecutor({ PATH: trustedDirectory, PATHEXT: ".EXE", APPDATA: appData }, resolve);
  const request = { argv: ["gh", "-e", "process.stdout.write('ok')"] as [string, ...string[]], route: "github-work", cwd: operationCwd };
  await expect(executor.execute(request)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(executor.execute(request)).resolves.toMatchObject({ exitCode: 0, stdout: "ok" });
  await expect(executor.execute(request)).resolves.toMatchObject({ exitCode: 0, stdout: "ok" });
  expect(resolve).toHaveBeenCalledTimes(2);
});

it("honors provider operation timeouts and rejects signalled execution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-provider-timeout-"));
  roots.push(root);
  const operationCwd = path.join(root, "project");
  const trustedDirectory = path.join(root, "trusted-bin");
  const appData = path.join(root, "appdata");
  await Promise.all([mkdir(operationCwd), mkdir(trustedDirectory), mkdir(appData)]);
  const executable = path.join(trustedDirectory, process.platform === "win32" ? "gh.EXE" : "gh");
  await copyFile(process.execPath, executable);
  const executor = new NodeProviderProcessExecutor({ PATH: trustedDirectory, PATHEXT: ".EXE", APPDATA: appData });
  await expect(executor.execute({ argv: ["gh", "-e", "setTimeout(() => {}, 5000)"], route: "github-work", cwd: operationCwd, timeoutMilliseconds: 20 })).rejects.toMatchObject({ killed: true });
});

it.each([
  ["https://github.example/acme/project.git", "github.example/acme/project"],
  ["ssh://git@gitlab.example/acme/project.git", "gitlab.example/acme/project"],
  ["git@github.example:acme/project.git", "github.example/acme/project"],
] as const)("parses a strict forge repository remote %s", (remote, selector) => {
  expect(parseForgeRepositoryUrl(remote)).toBe(selector);
});

it.each([
  "https://user:secret@github.example/acme/project.git",
  "ssh://other@github.example/acme/project.git",
  "https://github.example/acme/project.git?token=secret",
  "https://github.example/acme/project.git#fragment",
  "https://github.example/acme/../project.git",
  "https://github.example/group/subgroup/project.git",
  "git@github.example:acme/%2e%2e.git",
  "file:///C:/private/repository",
])("rejects unsafe forge repository remote %s", remote => {
  expect(() => parseForgeRepositoryUrl(remote)).toThrowError(expect.objectContaining({ code: "REPOSITORY_REMOTE_INVALID" }));
});

it("resolves only the configured Git remote into the production repository selector", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "mpx-provider-remote-"));
  roots.push(repository);
  await git(repository, "init", "-b", "main");
  await git(repository, "remote", "add", "origin", "https://github.example/ambient/default.git");
  await git(repository, "remote", "add", "configured-upstream", "git@gitlab.example:acme/selected.git");
  const resolver = new NodeRepositorySelectorResolver(process.env);
  await expect(resolver.resolve({ root: repository, remote: "configured-upstream" })).resolves.toBe("gitlab.example/acme/selected");
  await expect(resolver.resolve({ root: repository, remote: "missing" })).rejects.toMatchObject({ code: "REPOSITORY_REMOTE_UNAVAILABLE" });
});

it("classifies authentication exits only from backend request metadata", () => {
  expect(classifyProviderProcessResult(null, "output", "")).toEqual({ exitCode: 0, stdout: "output", stderr: "" });
  expect(classifyProviderProcessResult(Object.assign(new Error("auth"), { code: 4 }), "", "denied", [4])).toEqual({ exitCode: 4, stdout: "", stderr: "denied", failure: "auth" });
  expect(classifyProviderProcessResult(Object.assign(new Error("not generic auth"), { code: 4 }), "", "failed")).toEqual({ exitCode: 4, stdout: "", stderr: "failed" });
  expect(classifyProviderProcessResult(Object.assign(new Error("command"), { code: 9 }), "", "failed", [4])).toEqual({ exitCode: 9, stdout: "", stderr: "failed" });
  for (const error of [
    Object.assign(new Error("permission"), { code: "EACCES" }),
    Object.assign(new Error("signal"), { code: null, signal: "SIGTERM" }),
    Object.assign(new Error("buffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
  ]) expect(() => classifyProviderProcessResult(error, "", "")).toThrow(error);
});

it("adapts Windows process inspection for production CAS lock identity with fail-closed errors", async () => {
  await expect(windowsProcessIdentityInspector({ inspect: async pid => ({ pid, startFingerprint: "windows-start" }) }).inspect(42)).resolves.toEqual({ status: "present", pid: 42, startFingerprint: "windows-start" });
  await expect(windowsProcessIdentityInspector({ inspect: async () => undefined }).inspect(42)).resolves.toEqual({ status: "absent", pid: 42 });
  await expect(windowsProcessIdentityInspector({ inspect: async () => { throw new Error("unknown"); } }).inspect(42)).resolves.toEqual({ status: "unknown", pid: 42 });
});

it("requires repository-bound lifecycle state for manual prepare and cancel", async () => {
  const key = deriveLifecycleKey("C:/repos/one/.git", "feature/test");
  const foundation = {
    state: { load: async () => ({ schemaVersion: 1, owner: "mpx", key, repositoryId: "sample/app", repositoryIdentity: "C:/repos/one/.git", mainRoot: "C:/repos/one", worktreePath: "C:/repo.worktrees/feature", branch: "feature/test", base: "main", status: "ready", createdAt: 1, updatedAt: 1 }) },
    repository: { resolve: async () => ({ commonGitDirectory: "C:/repos/two/.git", mainRoot: "C:/repos/two", config: { project: { id: "sample/app" } } }) },
  } as never;
  await expect(requireRepositoryBoundLifecycleState(key, "C:/repo", foundation)).rejects.toMatchObject({ code: "WORKTREE_REPOSITORY_MISMATCH" });
});

it("rejects a wrong derived key before manual preparation repository or process access", async () => {
  let resolved = false;
  const foundation = {
    state: { load: async () => ({ schemaVersion: 1, owner: "mpx", key: "wrong", repositoryId: "sample/app", repositoryIdentity: "C:/repos/one/.git", mainRoot: "C:/repos/one", worktreePath: "C:/repo.worktrees/feature", branch: "feature/test", base: "main", status: "ready", createdAt: 1, updatedAt: 1 }) },
    repository: { resolve: async () => { resolved = true; throw new Error("must not resolve"); } },
  } as never;
  await expect(requireRepositoryBoundLifecycleState("wrong", "C:/repo", foundation)).rejects.toMatchObject({ code: "WORKTREE_LIFECYCLE_STATE_INVALID" });
  expect(resolved).toBe(false);
});

it("rejects manual access when the canonical worktree path belongs to another branch", async () => {
  const requestedKey = deriveLifecycleKey("C:/repos/one/.git", "feature/other");
  const foundation = {
    state: { load: async () => ({ schemaVersion: 1, owner: "mpx", key: requestedKey, repositoryId: "sample/app", repositoryIdentity: "C:/repos/one/.git", mainRoot: "C:/repos/one", worktreePath: "C:/repo.worktrees/other", branch: "feature/other", base: "main", status: "ready", createdAt: 1, updatedAt: 1 }) },
    repository: { resolve: async () => ({ commonGitDirectory: "C:/repos/one/.git", mainRoot: "C:/repos/one", config: { project: { id: "sample/app" } } }) },
    git: { list: async () => [{ path: "C:/repo.worktrees/other", branch: "feature/allowed" }] },
  } as never;
  await expect(requireRepositoryBoundLifecycleState(requestedKey, "C:/repo", foundation)).rejects.toMatchObject({ code: "WORKTREE_REPOSITORY_MISMATCH" });
});

it("skips package-manager resolution when preparation execution is none", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-context-none-"));
  roots.push(root);
  const noLockfilesRoot = path.join(root, "no-lockfiles");
  const multipleLockfilesRoot = path.join(root, "multiple-lockfiles");
  await mkdir(noLockfilesRoot);
  await mkdir(multipleLockfilesRoot);
  await writeFile(path.join(noLockfilesRoot, "mpxconfig.json"), JSON.stringify({ schemaVersion: 1 }));
  await writeFile(path.join(multipleLockfilesRoot, "mpxconfig.json"), JSON.stringify({ schemaVersion: 1 }));
  await writeFile(path.join(multipleLockfilesRoot, "package-lock.json"), "{}");
  await writeFile(path.join(multipleLockfilesRoot, "yarn.lock"), "lock");
  const runtime = preparationRuntime(root, {});
  for (const worktreeRoot of [noLockfilesRoot, multipleLockfilesRoot]) {
    await expect(runtime.run({
      key: `lifecycle-none:${path.basename(worktreeRoot)}`,
      plan: { execution: "none", steps: [], order: [], logging: { maxOutputBytes: 65536, redactEnvironmentValues: true } },
      worktreeRoot,
      packageManager: "none",
    })).resolves.toMatchObject({ status: "ready" });
  }
});

it("returns exact approval and content-bound evidence when validateOnly follows exact approval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-context-preparation-"));
  roots.push(root);
  const repository = path.join(root, "repository");
  await mkdir(repository);
  await git(repository, "init", "-b", "main");
  await writeFile(path.join(repository, "mpxconfig.json"), JSON.stringify({ schemaVersion: 1, project: { id: "context/preparation" }, repository: { provider: "generic", remote: "origin" } }));
  await git(repository, "add", "mpxconfig.json");
  await git(repository, "-c", "user.name=MPX Test", "-c", "user.email=mpx@example.invalid", "commit", "-m", "fixture");
  const plan: PreparationPlan = { execution: "foreground", steps: [{ id: "verify", uses: "executable", argv: ["node", "--version"], required: true }], order: ["verify"], logging: { maxOutputBytes: 65536, redactEnvironmentValues: true } };
  const runtime = preparationRuntime(root, {});
  const request = { key: "preparation-boundary", plan, worktreeRoot: repository, packageManager: "none" as const, validateOnly: true };
  const pending = await runtime.run(request) as { expectedApproval: string; approval: unknown; status: string };
  expect(pending.status).toBe("approval-required");
  await expect(runtime.run({ ...request, exactApproval: pending.expectedApproval })).resolves.toEqual({ status: "approved", expectedApproval: pending.expectedApproval, approval: pending.approval });
}, 15_000);

it("rejects manual preparation when repository configuration changed without retrying", async () => {
  const fixture = await includeLifecycleFixture("config-mismatch");
  await expect(fixture.service.create(fixture.request)).rejects.toMatchObject({ code: "WORKTREE_INCLUDE_APPROVAL_REQUIRED" });
  const retry = vi.fn(async () => ({ status: "ready" }));
  const service = worktrees({
    env: { LOCALAPPDATA: fixture.stateRoot },
    portService: fixture.portService,
    preparationRuntimeFactory: () => ({
      run: async () => ({ status: "ready" }), retry,
      cancel: async () => ({ status: "cancelled" }), reconcile: async () => ({ status: "ready" }),
    }),
  } as never);
  await writeFile(path.join(fixture.mainRoot, "mpxconfig.json"), JSON.stringify({ schemaVersion: 1, project: { id: "context/include" }, repository: { provider: "generic", remote: "origin" }, tooling: { packageManager: "pnpm" } }));
  const key = deriveLifecycleKey(path.join(fixture.mainRoot, ".git"), fixture.request.branch);
  await expect(service.prepare({ key, cwd: fixture.mainRoot })).rejects.toMatchObject({ code: "WORKTREE_CONFIG_HASH_MISMATCH" });
  expect(retry).not.toHaveBeenCalled();
}, 15_000);

it("copies nothing and stops before ports or preparation when include approval is missing", async () => {
  const fixture = await includeLifecycleFixture("missing-approval");

  await expect(fixture.service.create(fixture.request)).rejects.toMatchObject({ code: "WORKTREE_INCLUDE_APPROVAL_REQUIRED" });

  await expect(exists(path.join(fixture.destinationRoot, "local data", "approved secret.txt"))).resolves.toBe(false);
  expect(fixture.effects).toEqual([]);
}, 15_000);

it("copies nothing when source evidence and the include manifest make an approval stale", async () => {
  const fixture = await includeLifecycleFixture("stale-approval");
  await expect(fixture.service.create(fixture.request)).rejects.toMatchObject({ code: "WORKTREE_INCLUDE_APPROVAL_REQUIRED" });
  const approval = await currentIncludeApproval(fixture);
  await writeFile(path.join(fixture.sourceRoot, "local data", "approved secret.txt"), "changed bytes");
  await writeFile(path.join(fixture.mainRoot, ".worktreeinclude"), "local data/**\nother/**\n");

  await expect(fixture.service.create({ ...fixture.request, includeApproval: approval })).rejects.toMatchObject({ code: "WORKTREE_INCLUDE_APPROVAL_REQUIRED" });

  await expect(exists(path.join(fixture.destinationRoot, "local data", "approved secret.txt"))).resolves.toBe(false);
  expect(fixture.effects).toEqual([]);
}, 15_000);

it("copies only the exactly approved untracked file with spaces before ports and preparation", async () => {
  const fixture = await includeLifecycleFixture("valid-approval");
  await expect(fixture.service.create(fixture.request)).rejects.toMatchObject({ code: "WORKTREE_INCLUDE_APPROVAL_REQUIRED" });
  const approval = await currentIncludeApproval(fixture);

  await expect(fixture.service.create({ ...fixture.request, includeApproval: approval })).resolves.toMatchObject({ status: "ready", leaseId: "fake-lease" });

  await expect(readFile(path.join(fixture.destinationRoot, "local data", "approved secret.txt"), "utf8")).resolves.toBe("approved bytes");
  await expect(exists(path.join(fixture.destinationRoot, "local data", "tracked.txt"))).resolves.toBe(false);
  await expect(exists(path.join(fixture.destinationRoot, "unapproved.txt"))).resolves.toBe(false);
  expect(fixture.effects).toEqual(["ports-after-copy", "preparation-after-ports"]);
}, 15_000);

it("persists only a sanitized cancellation failure message in durable state", async () => {
  const fixture = await includeLifecycleFixture("cancel-sanitized");
  const key = deriveLifecycleKey(path.join(fixture.mainRoot, ".git"), fixture.request.branch);
  await expect(fixture.service.create(fixture.request)).rejects.toMatchObject({ code: "WORKTREE_INCLUDE_APPROVAL_REQUIRED" });
  await fixture.service.create({ ...fixture.request, includeApproval: await currentIncludeApproval(fixture) });
  const appData = { LOCALAPPDATA: fixture.stateRoot };
  const service = worktrees({
    env: appData,
    portService: fixture.portService,
    preparationRuntimeFactory: () => ({
      run: async () => ({ status: "ready" }),
      retry: async () => ({ status: "ready" }),
      cancel: async () => { throw new Error("token=abc123 path=C:/secret/worktree"); },
      reconcile: async () => ({ status: "ready" }),
    }),
  } as never, fixture.mainRoot);
  await expect(service.cancel({ cwd: fixture.mainRoot, key })).rejects.toThrow(/token=abc123/);
  const statePath = path.join(fixture.stateRoot, "mpx", "worktrees", "lifecycle", `${createHash("sha256").update(key).digest("hex")}.json`);
  const persisted = JSON.parse(await readFile(statePath, "utf8")) as { failure?: { message?: string } };
  expect(persisted.failure?.message).toBe("Preparation cancellation could not be verified.");
  expect(JSON.stringify(persisted)).not.toContain("abc123");
  expect(JSON.stringify(persisted)).not.toContain("C:/secret/worktree");
}, 15_000);

it("rejects a worker handshake for a different persisted run", () => {
  expect(verifyPreparationWorkerHandshake(
    { owner: "mpx", runId: "persisted-run", status: "preparing", worker: { pid: 42, startFingerprint: "birth-42", ownerToken: "token-42" } },
    { owner: "mpx", startFingerprint: "birth-42", ownerToken: "token-42" },
    42,
    "stale-run",
  )).toBe(false);
});

it("requires persisted pid, fingerprint, MPX owner, and owner token for worker handshake", () => {
  expect(verifyPreparationWorkerHandshake(
    { owner: "mpx", runId: "run-42", status: "preparing", worker: { pid: 42, startFingerprint: "birth-42", ownerToken: "token-42" } },
    { owner: "mpx", startFingerprint: "birth-42", ownerToken: "token-42" },
    42, "run-42",
  )).toBe(true);

  expect(verifyPreparationWorkerHandshake(
    { owner: "mpx", runId: "run-42", status: "preparing", worker: { pid: 42, startFingerprint: "birth-42", ownerToken: "token-42" } },
    { owner: "mpx", startFingerprint: "birth-42", ownerToken: "wrong" },
    42, "run-42",
  )).toBe(false);

  expect(verifyPreparationWorkerHandshake(
    { owner: "mpx", runId: "run-42", status: "preparing", worker: { pid: 42, startFingerprint: "birth-42" } },
    { owner: "mpx", startFingerprint: "birth-42" },
    42, "run-42",
  )).toBe(false);
});
