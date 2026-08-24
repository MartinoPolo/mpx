import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createNodeWorktreeIncludeDependencies, deriveLifecycleKey, deriveWorktreePath, planWorktreeIncludes } from "@mpx/worktrees";
import type { PreparationPlan } from "@mpx/config";
import { afterEach, expect, it, vi } from "vitest";
import { preparationRuntime, requireRepositoryBoundLifecycleState, verifyPreparationWorkerHandshake, windowsProcessIdentityInspector, worktrees } from "./context.js";

const exec = promisify(execFile);

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

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
});

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
});

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
