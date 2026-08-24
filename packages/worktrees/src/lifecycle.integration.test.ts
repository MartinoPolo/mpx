import { execFile, fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { sha256Canonical, type JsonValue } from "@mpx/core";
import { createNodeLifecycleFoundation, WorktreeLifecycleService } from "./index.js";

const exec = promisify(execFile); const roots: string[] = []; const children: ChildProcess[] = [];
afterEach(async () => { for (const child of children.splice(0)) if (child.exitCode === null) child.kill(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const lifecycleWorker = fileURLToPath(new URL("../test-fixtures/lifecycle-worker.mjs", import.meta.url));
const waitFor = <T extends { type: string }>(child: ChildProcess, type: string, timeoutMs = 15_000) => new Promise<T>((resolve, reject) => {
  let stderr = ""; child.stderr?.on("data", chunk => { stderr += String(chunk); });
  const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${type}. ${stderr}`)), timeoutMs);
  const message = (value: unknown) => { if (typeof value === "object" && value !== null && (value as { type?: string }).type === type) finish(undefined, value as T); };
  const exit = (code: number | null) => finish(new Error(`Worker exited with ${code} before ${type}. ${stderr}`));
  const finish = (error?: Error, value?: T) => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); error ? reject(error) : resolve(value!); };
  child.on("message", message); child.once("exit", exit);
});

it("does not execute a repository-local git.exe shim for lifecycle Git invocations", async () => {
  if (process.platform !== "win32") return;
  const root = await mkdtemp(path.join(tmpdir(), "mpx lifecycle git shim "));
  roots.push(root);
  const repository = path.join(root, "repository with spaces");
  await exec("git", ["init", repository]);
  await writeFile(path.join(repository, "git.exe"), "not a trusted executable");

  const output = await createNodeLifecycleFoundation(path.join(root, "state")).git.run(["rev-parse", "--show-toplevel"], repository);

  expect(path.resolve(output.toString("utf8").trim())).toBe(path.resolve(repository));
});

it("converges two separate processes creating one branch through the production repository lock", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "mpx lifecycle process concurrent ")); roots.push(parent);
  const main = path.join(parent, "repo");
  await exec("git", ["init", "-b", "main", main]);
  await writeFile(path.join(main, "mpxconfig.json"), JSON.stringify({ schemaVersion: 1, project: { id: "integration/process-concurrent" }, repository: { provider: "generic", remote: "origin" } }));
  await writeFile(path.join(main, "file.txt"), "base");
  await exec("git", ["add", "."], { cwd: main });
  await exec("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=MPX Test", "commit", "-m", "base"], { cwd: main });
  const workers = [0, 1].map(() => { const child = fork(lifecycleWorker, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] }); children.push(child); return child; });
  await Promise.all(workers.map(child => waitFor(child, "ready")));
  const completed = workers.map(child => waitFor<{ type: "done"; result: { worktreePath: string; leaseId: string } }>(child, "done"));
  for (const child of workers) child.send({ type: "go", cwd: main, branch: "feature/process-concurrent", stateRoot: path.join(parent, "state"), leaseRoot: path.join(parent, "leases") });
  const results = await Promise.all(completed);

  expect(new Set(results.map(value => value.result.worktreePath)).size).toBe(1);
  expect(new Set(results.map(value => value.result.leaseId))).toEqual(new Set(["shared-lease"]));
  const listed = await exec("git", ["worktree", "list", "--porcelain"], { cwd: main });
  expect((listed.stdout.match(/branch refs\/heads\/feature\/process-concurrent/gu) ?? [])).toHaveLength(1);
  expect((await readFile(path.join(parent, "leases", "mutations.log"), "utf8")).trim().split(/\r?\n/u)).toEqual(["created"]);
}, 30_000);

it("serializes simultaneous real creates so only one worktree and lease are mutated", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "mpx lifecycle concurrent ")); roots.push(parent);
  const main = path.join(parent, "repo");
  await exec("git", ["init", "-b", "main", main]);
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: main });
  await exec("git", ["config", "user.name", "MPX Test"], { cwd: main });
  const config = { schemaVersion: 1, project: { id: "integration/concurrent" }, repository: { provider: "generic", remote: "origin" }, tooling: { packageManager: "pnpm" } } as const;
  await writeFile(path.join(main, "mpxconfig.json"), JSON.stringify(config)); await writeFile(path.join(main, "file.txt"), "base");
  await exec("git", ["add", "."], { cwd: main }); await exec("git", ["commit", "-m", "base"], { cwd: main });
  const stateRoot = path.join(parent, "state"); let leases = 0;
  const service = (foundation: ReturnType<typeof createNodeLifecycleFoundation>) => new WorktreeLifecycleService({
    ...foundation,
    ports: { ensure: async () => ({ lease: { leaseId: `lease-${++leases}` } }), captureReleaseIdentity: async () => ({}), releaseLinkedAfterRemoval: async () => ({ }), reconcile: async () => ({ orphaned: [] }) },
    preparation: { prepare: async () => ({ status: "ready" }), cancel: async () => ({ status: "cancelled" }), reconcile: async () => ({ status: "ready" }) },
    configHash: value => sha256Canonical(value as unknown as JsonValue),
  });
  const firstService = service(createNodeLifecycleFoundation(stateRoot));
  const secondService = service(createNodeLifecycleFoundation(stateRoot));
  const [first, second] = await Promise.all([
    firstService.create({ cwd: main, branch: "feature/concurrent", base: "main" }),
    secondService.create({ cwd: main, branch: "feature/concurrent", base: "main" }),
  ]);
  expect(first.worktreePath).toBe(second.worktreePath);
  expect(leases).toBe(1);
  const listed = await exec("git", ["worktree", "list", "--porcelain"], { cwd: main });
  expect((listed.stdout.match(/branch refs\/heads\/feature\/concurrent/gu) ?? [])).toHaveLength(1);
});

it("restarts from durable pre-Git intent without adding a second worktree after a post-Git write failure", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "mpx lifecycle restart ")); roots.push(parent);
  const main = path.join(parent, "repo");
  await exec("git", ["init", "-b", "main", main]);
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: main });
  await exec("git", ["config", "user.name", "MPX Test"], { cwd: main });
  const config = { schemaVersion: 1, project: { id: "integration/restart" }, repository: { provider: "generic", remote: "origin" } } as const;
  await writeFile(path.join(main, "mpxconfig.json"), JSON.stringify(config));
  await exec("git", ["add", "."], { cwd: main });
  await exec("git", ["commit", "-m", "base"], { cwd: main });
  const stateRoot = path.join(parent, "state");
  const firstFoundation = createNodeLifecycleFoundation(stateRoot);
  let writes = 0;
  const failingState = { ...firstFoundation.state, load: firstFoundation.state.load, writeAtomic: async (key: string, state: Parameters<typeof firstFoundation.state.writeAtomic>[1]) => {
    writes += 1;
    if (writes === 2) throw new Error("disk full");
    await firstFoundation.state.writeAtomic(key, state);
  } };
  const dependencies = (foundation: ReturnType<typeof createNodeLifecycleFoundation>) => ({
    ...foundation,
    ports: { ensure: async () => ({ lease: { leaseId: "lease" } }), captureReleaseIdentity: async () => ({}), releaseLinkedAfterRemoval: async () => ({}), reconcile: async () => ({ orphaned: [] }) },
    preparation: { prepare: async () => ({ status: "ready" }), cancel: async () => ({ status: "cancelled" }), reconcile: async () => ({ status: "ready" }) },
    configHash: value => sha256Canonical(value as unknown as JsonValue),
  });
  await expect(new WorktreeLifecycleService({ ...dependencies(firstFoundation), state: failingState }).create({ cwd: main, branch: "feature/restart", base: "main" })).rejects.toThrow("disk full");
  const second = new WorktreeLifecycleService(dependencies(createNodeLifecycleFoundation(stateRoot)));
  await expect(second.create({ cwd: main, branch: "feature/restart", base: "main" })).resolves.toMatchObject({ status: "ready" });
  const listed = await exec("git", ["worktree", "list", "--porcelain"], { cwd: main });
  expect((listed.stdout.match(/branch refs\/heads\/feature\/restart/gu) ?? [])).toHaveLength(1);
});

async function realRemovalFixture(label: string) {
  const parent = await mkdtemp(path.join(tmpdir(), `mpx lifecycle ${label} `)); roots.push(parent);
  const main = path.join(parent, "repo");
  await exec("git", ["init", "-b", "main", main]);
  await writeFile(path.join(main, "mpxconfig.json"), JSON.stringify({ schemaVersion: 1, project: { id: `integration/${label}` }, repository: { provider: "generic", remote: "origin" } }));
  await writeFile(path.join(main, "file.txt"), "base");
  await exec("git", ["add", "."], { cwd: main });
  await exec("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=MPX Test", "commit", "-m", "base"], { cwd: main });
  const foundation = createNodeLifecycleFoundation(path.join(parent, "state"), "git", { operationCwd: main });
  let releases = 0;
  const service = new WorktreeLifecycleService({ ...foundation,
    ports: { ensure: async () => ({ lease: { leaseId: "lease" } }), captureReleaseIdentity: async () => ({ leaseId: "lease" }), releaseLinkedAfterRemoval: async () => ({ released: (++releases, true) }), reconcile: async () => ({ orphaned: [] }) },
    preparation: { prepare: async () => ({ status: "ready" }), cancel: async () => ({ status: "cancelled" }), reconcile: async () => ({ status: "ready" }) },
    configHash: value => sha256Canonical(value as unknown as JsonValue),
  });
  const created = await service.create({ cwd: main, branch: `feature/${label}`, base: "main" });
  return { main, service, worktreePath: created.worktreePath!, releases: () => releases };
}

it("preserves a real dirty worktree and its port lease when removal is refused", async () => {
  const value = await realRemovalFixture("dirty-refusal");
  await writeFile(path.join(value.worktreePath, "dirty.txt"), "uncommitted");
  await expect(value.service.remove({ cwd: value.main, worktreePath: value.worktreePath })).rejects.toMatchObject({ code: "WORKTREE_REMOVE_DIRTY" });
  expect(await readFile(path.join(value.worktreePath, "dirty.txt"), "utf8")).toBe("uncommitted");
  expect(value.releases()).toBe(0);
});

it("preserves a real git-locked worktree and its port lease when removal is refused", async () => {
  const value = await realRemovalFixture("locked-refusal");
  await exec("git", ["worktree", "lock", value.worktreePath], { cwd: value.main });
  await expect(value.service.remove({ cwd: value.main, worktreePath: value.worktreePath })).rejects.toMatchObject({ code: "WORKTREE_REMOVE_LOCKED" });
  expect(await readFile(path.join(value.worktreePath, "file.txt"), "utf8")).toBe("base");
  expect(value.releases()).toBe(0);
});

it("preserves a real linked worktree and lease when the operation cwd is inside it", async () => {
  const value = await realRemovalFixture("descendant-refusal");
  const descendant = path.join(value.worktreePath, "packages", "app");
  await mkdir(descendant, { recursive: true });
  const foundation = createNodeLifecycleFoundation(path.join(path.dirname(value.main), "state"), "git", { operationCwd: descendant });
  let released = false;
  const service = new WorktreeLifecycleService({
    ...foundation,
    ports: { ensure: async () => ({}), captureReleaseIdentity: async () => { throw new Error("must not capture"); }, releaseLinkedAfterRemoval: async () => ({ released: (released = true) }), reconcile: async () => ({ orphaned: [] }) },
    preparation: { prepare: async () => ({ status: "ready" }), cancel: async () => ({ status: "cancelled" }), reconcile: async () => ({ status: "ready" }) },
    configHash: value => sha256Canonical(value as unknown as JsonValue),
  });

  await expect(service.remove({ cwd: value.main, worktreePath: value.worktreePath })).rejects.toMatchObject({ code: "WORKTREE_REMOVE_IN_USE" });
  const listed = await exec("git", ["worktree", "list", "--porcelain"], { cwd: value.main });
  expect(listed.stdout).toContain(`worktree ${value.worktreePath.replace(/\\/gu, "/")}`);
  await expect(readFile(path.join(value.worktreePath, "file.txt"), "utf8")).resolves.toBe("base");
  expect(released).toBe(false);
  expect(value.releases()).toBe(0);
});

it("reconciles a manually removed real worktree and permits explicit identity-bound lease recovery without erasing history", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "mpx lifecycle external deletion ")); roots.push(parent);
  const main = path.join(parent, "repo"); const stateRoot = path.join(parent, "state"); const leaseFile = path.join(parent, "lease.json");
  await exec("git", ["init", "-b", "main", main]);
  await writeFile(path.join(main, "mpxconfig.json"), JSON.stringify({ schemaVersion: 1, project: { id: "integration/external" }, repository: { provider: "generic", remote: "origin" } }));
  await writeFile(path.join(main, "file.txt"), "base");
  await exec("git", ["add", "."], { cwd: main });
  await exec("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=MPX Test", "commit", "-m", "base"], { cwd: main });
  const identityFor = (worktreePath: string, configHash: string) => ({ schemaVersion: 1 as const, leaseId: "external-lease", projectId: "integration/external", repositoryId: "repository", worktreeId: "external-worktree", worktreePath, role: "linked" as const, configHash });
  const adapter = () => ({
    ensure: async (request: { cwd: string; configHash: string }) => { const identity = identityFor(request.cwd, request.configHash); await writeFile(leaseFile, JSON.stringify(identity)); return { lease: { leaseId: identity.leaseId } }; },
    captureReleaseIdentity: async (request: { cwd: string; configHash: string }) => identityFor(request.cwd, request.configHash),
    releaseLinkedAfterRemoval: async ({ identity }: { identity: ReturnType<typeof identityFor> }) => { const durable = JSON.parse(await readFile(leaseFile, "utf8")); if (JSON.stringify(durable) !== JSON.stringify(identity)) throw new Error("identity mismatch"); await rm(leaseFile); return { released: true }; },
    reconcile: async () => { try { const lease = JSON.parse(await readFile(leaseFile, "utf8")); return { orphaned: [{ leaseId: lease.leaseId, worktreePath: lease.worktreePath, reason: "worktree-missing" }] }; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { orphaned: [] }; throw error; } },
  });
  const dependencies = () => ({
    ...createNodeLifecycleFoundation(stateRoot), ports: adapter(),
    preparation: { prepare: async () => ({ status: "ready" }), cancel: async () => ({ status: "cancelled" }), reconcile: async () => ({ status: "ready" }) },
    configHash: (value: unknown) => sha256Canonical(value as JsonValue),
  });
  const created = await new WorktreeLifecycleService(dependencies()).create({ cwd: main, branch: "feature/external", base: "main" });
  const identity = JSON.parse(await readFile(leaseFile, "utf8")) as ReturnType<typeof identityFor>;
  await rm(created.worktreePath!, { recursive: true, force: true });
  const prunable = await exec("git", ["worktree", "list", "--porcelain"], { cwd: main });
  expect(prunable.stdout).toContain("prunable");

  const freshDependencies = dependencies(); const fresh = new WorktreeLifecycleService(freshDependencies);
  await expect(fresh.reconcile({ cwd: main })).resolves.toMatchObject({ orphaned: [{ leaseId: "external-lease", reason: "worktree-missing" }] });
  const orphaned = (await freshDependencies.state.list!((await freshDependencies.repository.resolve(main)).commonGitDirectory))[0]!;
  expect(orphaned).toMatchObject({ status: "orphaned", externalDeletion: true, worktreePath: created.worktreePath, leaseId: "external-lease" });

  await expect(freshDependencies.ports.releaseLinkedAfterRemoval({ repositoryCwd: main, identity })).resolves.toMatchObject({ released: true });
  await expect(readFile(leaseFile)).rejects.toMatchObject({ code: "ENOENT" });
  const history = (await freshDependencies.state.list!((await freshDependencies.repository.resolve(main)).commonGitDirectory))[0]!;
  expect(history).toMatchObject({ status: "orphaned", externalDeletion: true, leaseId: "external-lease" });
});

it("creates and removes a slash branch in a spaced real-repository path without consulting editors", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "mpx lifecycle spaces ")); roots.push(parent);
  const main = path.join(parent, "widget repo");
  await exec("git", ["init", "-b", "main", main]);
  const config = { schemaVersion: 1, project: { id: "integration/widget" }, repository: { provider: "generic", remote: "origin" }, tooling: { packageManager: "pnpm" } } as const;
  await writeFile(path.join(main, "mpxconfig.json"), JSON.stringify(config)); await writeFile(path.join(main, "file.txt"), "base");
  await exec("git", ["add", "."], { cwd: main });
  await exec("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=MPX Test", "commit", "-m", "base"], { cwd: main });
  const foundation = createNodeLifecycleFoundation(path.join(parent, "state")); let lease = true;
  const service = new WorktreeLifecycleService({
    ...foundation,
    ports: {
      ensure: async () => ({ lease: { leaseId: "lease" } }), captureReleaseIdentity: async request => ({ schemaVersion: 1, leaseId: "lease", projectId: "integration/widget", repositoryId: "repository", worktreeId: "linked-worktree", worktreePath: request.cwd, role: "linked", configHash: request.configHash }),
      releaseLinkedAfterRemoval: async () => ({ released: (lease = false, true) }), reconcile: async () => ({ orphaned: [] }),
    },
    preparation: { prepare: async () => ({ status: "ready" }), cancel: async () => ({ status: "cancelled" }), reconcile: async () => ({ status: "ready" }) },
    configHash: value => sha256Canonical(value as unknown as JsonValue),
  });
  const previousEditor = process.env.GIT_EDITOR;
  const previousSequenceEditor = process.env.GIT_SEQUENCE_EDITOR;
  const editorSentinel = path.join(parent, "impossible editor.exe");
  const sequenceEditorSentinel = path.join(parent, "impossible sequence editor.exe");
  process.env.GIT_EDITOR = editorSentinel;
  process.env.GIT_SEQUENCE_EDITOR = sequenceEditorSentinel;
  try {
    const created = await service.create({ cwd: main, branch: "feature/issue-42", base: "main" });
    expect(await readFile(path.join(created.worktreePath!, "file.txt"), "utf8")).toBe("base");
    const removed = await service.remove({ cwd: main, worktreePath: created.worktreePath! });
    expect(removed).toMatchObject({ status: "removed", released: true }); expect(lease).toBe(false);
    const recreated = await service.create({ cwd: main, branch: "feature/issue-42", base: "main" });
    expect(recreated).toMatchObject({ status: "ready", worktreePath: created.worktreePath });
    expect(await readFile(path.join(recreated.worktreePath!, "file.txt"), "utf8")).toBe("base");
  } finally {
    if (previousEditor === undefined) delete process.env.GIT_EDITOR; else process.env.GIT_EDITOR = previousEditor;
    if (previousSequenceEditor === undefined) delete process.env.GIT_SEQUENCE_EDITOR; else process.env.GIT_SEQUENCE_EDITOR = previousSequenceEditor;
  }
});
