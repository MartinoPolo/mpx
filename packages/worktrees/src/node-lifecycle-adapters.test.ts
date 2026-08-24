import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createNodeLifecycleFoundation, NodeLifecycleStateStore, NodeRepositoryLock, type ProcessIdentityInspector } from "./node-lifecycle-adapters.js";
import { deriveLifecycleKey, type LifecycleState } from "./lifecycle.js";

const roots: string[] = []; const children: ChildProcess[] = [];
afterEach(async () => { for (const child of children.splice(0)) if (child.exitCode === null) child.kill(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const crashWorker = fileURLToPath(new URL("../test-fixtures/lock-crash-worker.mjs", import.meta.url));
const waitForCreated = (child: ChildProcess) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => finish(new Error("Timed out waiting for lock creation.")), 10_000);
  const message = (value: unknown) => { if (typeof value === "object" && value !== null && (value as { type?: string }).type === "created") finish(); };
  const exit = (code: number | null) => finish(new Error(`Lock worker exited with ${code}.`));
  const finish = (error?: Error) => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); error ? reject(error) : resolve(); };
  child.on("message", message); child.once("exit", exit);
});
const killAndWait = (child: ChildProcess) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Timed out killing lock worker.")), 10_000);
  child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill();
});

const present = (fingerprint: string): ProcessIdentityInspector => ({ inspect: async pid => ({ status: "present", pid, startFingerprint: fingerprint }) });
const lockLocation = (directory: string, key: string) => path.join(directory, `${createHash("sha256").update(key).digest("hex")}.json.lock`);
const owner = (pid: number, startFingerprint: string, token = "owner-token") => ({ schemaVersion: 1, owner: "mpx", token, pid, processStartFingerprint: startFingerprint, acquiredAt: 1 });

it("keeps a live matching process identity locked until the bounded timeout", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mpx-lifecycle-lock-")); roots.push(directory);
  const first = new NodeRepositoryLock(directory, { processIdentityInspector: present("birth-self"), timeoutMs: 100, retryMs: 1 });
  const second = new NodeRepositoryLock(directory, { processIdentityInspector: present("birth-self"), timeoutMs: 10, retryMs: 1 });
  const release = await first.acquire("live-owner");
  await expect(second.acquire("live-owner")).rejects.toMatchObject({ code: "WORKTREE_LOCK_TIMEOUT" });
  await release();
});

it("reclaims a lock when a live PID has a different process-start fingerprint", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mpx-lifecycle-lock-")); roots.push(directory);
  const key = "reused-pid"; const lockPath = lockLocation(directory, key); await mkdir(lockPath);
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner(12345, "old-birth")));
  const inspector: ProcessIdentityInspector = { inspect: async pid => pid === process.pid ? { status: "present", pid, startFingerprint: "birth-self" } : { status: "present", pid, startFingerprint: "new-birth" } };
  const release = await new NodeRepositoryLock(directory, { processIdentityInspector: inspector, timeoutMs: 100, retryMs: 1 }).acquire(key);
  expect(JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"))).toMatchObject({ pid: process.pid, processStartFingerprint: "birth-self" });
  await release();
});

it("recovers a production lock after its fingerprinted owner process is killed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mpx-lifecycle-lock-crash-")); roots.push(directory);
  const key = "killed-owner";
  const child = fork(crashWorker, ["owned", directory, key], { stdio: ["ignore", "ignore", "pipe", "ipc"] }); children.push(child);
  await waitForCreated(child); await killAndWait(child);

  const release = await new NodeRepositoryLock(directory, { timeoutMs: 2_000, retryMs: 10 }).acquire(key);
  expect(JSON.parse(await readFile(path.join(lockLocation(directory, key), "owner.json"), "utf8"))).toMatchObject({ pid: process.pid, owner: "mpx" });
  await release();
});

it("recovers a killed worker's ownerless lock directory only after grace", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mpx-lifecycle-lock-ownerless-crash-")); roots.push(directory);
  const key = "killed-ownerless";
  const child = fork(crashWorker, ["ownerless", directory, key], { stdio: ["ignore", "ignore", "pipe", "ipc"] }); children.push(child);
  await waitForCreated(child); await killAndWait(child);
  await expect(new NodeRepositoryLock(directory, { ownerlessGraceMs: 250, timeoutMs: 30, retryMs: 5 }).acquire(key)).rejects.toMatchObject({ code: "WORKTREE_LOCK_TIMEOUT" });

  await new Promise(resolve => setTimeout(resolve, 275));
  const release = await new NodeRepositoryLock(directory, { ownerlessGraceMs: 250, timeoutMs: 2_000, retryMs: 10 }).acquire(key);
  expect(JSON.parse(await readFile(path.join(lockLocation(directory, key), "owner.json"), "utf8"))).toMatchObject({ pid: process.pid });
  await release();
});

it("reclaims a lock when its owner process is absent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mpx-lifecycle-lock-")); roots.push(directory);
  const key = "absent-owner"; const lockPath = lockLocation(directory, key); await mkdir(lockPath);
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner(12345, "old-birth")));
  const inspector: ProcessIdentityInspector = { inspect: async pid => pid === process.pid ? { status: "present", pid, startFingerprint: "birth-self" } : { status: "absent", pid } };
  const release = await new NodeRepositoryLock(directory, { processIdentityInspector: inspector, timeoutMs: 100, retryMs: 1 }).acquire(key);
  expect(JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"))).toMatchObject({ pid: process.pid });
  await release();
});

it("fails closed when process identity inspection is unknown", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mpx-lifecycle-lock-")); roots.push(directory);
  const key = "unknown-owner"; const lockPath = lockLocation(directory, key); await mkdir(lockPath);
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner(12345, "birth-owner")));
  const inspector: ProcessIdentityInspector = { inspect: async pid => pid === process.pid ? { status: "present", pid, startFingerprint: "birth-self" } : { status: "unknown", pid } };
  await expect(new NodeRepositoryLock(directory, { processIdentityInspector: inspector, timeoutMs: 10, retryMs: 1 }).acquire(key)).rejects.toMatchObject({ code: "WORKTREE_LOCK_TIMEOUT" });
  expect(await readFile(path.join(lockPath, "owner.json"), "utf8")).toContain("birth-owner");
});

it("recovers a crash-created ownerless lock only after the bounded grace", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mpx-lifecycle-lock-")); roots.push(directory);
  const key = "ownerless"; const lockPath = lockLocation(directory, key); await mkdir(lockPath);
  const modifiedAt = (await stat(lockPath)).mtimeMs; let now = modifiedAt + 1;
  const early = new NodeRepositoryLock(directory, { processIdentityInspector: present("birth-self"), ownerlessGraceMs: 30, timeoutMs: 5, retryMs: 1, now: () => now++ });
  await expect(early.acquire(key)).rejects.toMatchObject({ code: "WORKTREE_LOCK_TIMEOUT" });
  now = modifiedAt + 35;
  const release = await new NodeRepositoryLock(directory, { processIdentityInspector: present("birth-self"), ownerlessGraceMs: 30, timeoutMs: 100, retryMs: 1, now: () => now++ }).acquire(key);
  await release();
});

it("reclaims malformed owner metadata only after ownerless grace", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mpx-lifecycle-lock-")); roots.push(directory);
  const key = "malformed"; const lockPath = lockLocation(directory, key); const ownerPath = path.join(lockPath, "owner.json");
  await mkdir(lockPath); await writeFile(ownerPath, "{not-json");
  const old = new Date(Date.now() - 5_000); await utimes(ownerPath, old, old);
  const release = await new NodeRepositoryLock(directory, { processIdentityInspector: present("birth-self"), ownerlessGraceMs: 30, timeoutMs: 100, retryMs: 1 }).acquire(key);
  expect(JSON.parse(await readFile(ownerPath, "utf8"))).toMatchObject({ processStartFingerprint: "birth-self" });
  await release();
});

it("exposes process identity inspection injection through the Node lifecycle foundation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mpx-lifecycle-lock-")); roots.push(directory);
  const inspect = vi.fn(async (pid: number) => ({ status: "present" as const, pid, startFingerprint: "foundation-birth" }));
  const foundation = createNodeLifecycleFoundation(directory, "git", { processIdentityInspector: { inspect } });
  const release = await foundation.lock.acquire("foundation");
  expect(inspect).toHaveBeenCalledWith(process.pid);
  await release();
});

it("overrides inherited Git editor variables in the direct lifecycle Git adapter", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mpx-lifecycle-git-env-")); roots.push(directory);
  const previousEditor = process.env.GIT_EDITOR; const previousSequenceEditor = process.env.GIT_SEQUENCE_EDITOR;
  process.env.GIT_EDITOR = "inherited-editor-must-not-run"; process.env.GIT_SEQUENCE_EDITOR = "inherited-sequence-editor-must-not-run";
  try {
    const foundation = createNodeLifecycleFoundation(directory);
    await expect(foundation.git.run(["var", "GIT_EDITOR"], directory)).resolves.toSatisfy(output => output.toString("utf8").trim() === "true");
    await expect(foundation.git.run(["var", "GIT_SEQUENCE_EDITOR"], directory)).resolves.toSatisfy(output => output.toString("utf8").trim() === "true");
  } finally {
    if (previousEditor === undefined) delete process.env.GIT_EDITOR; else process.env.GIT_EDITOR = previousEditor;
    if (previousSequenceEditor === undefined) delete process.env.GIT_SEQUENCE_EDITOR; else process.env.GIT_SEQUENCE_EDITOR = previousSequenceEditor;
  }
});

it("does not let an old releaser delete a replacement lock", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mpx-lifecycle-lock-")); roots.push(directory);
  const lock = new NodeRepositoryLock(directory, { processIdentityInspector: present("birth-self"), timeoutMs: 100, retryMs: 1, ownerlessGraceMs: 0 });
  const key = "replacement"; const lockPath = lockLocation(directory, key); const oldRelease = await lock.acquire(key);
  await rm(lockPath, { recursive: true, force: true });
  const replacementRelease = await lock.acquire(key); const replacement = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
  await oldRelease();
  expect(JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"))).toEqual(replacement);
  await replacementRelease();
});

it("treats the operation CWD and its descendants as in-use with Windows case-insensitive containment", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mpx-lifecycle-use-")); roots.push(directory);
  const foundation = createNodeLifecycleFoundation(directory, "git", { operationCwd: "C:\\Repos\\Worktree\\packages\\app" });
  await expect(foundation.git.isInUse("c:\\repos\\worktree")).resolves.toBe(true);
  await expect(foundation.git.isInUse("C:\\Repos\\Other")).resolves.toBe(false);
});

it("reports only external usage and leaves owned preparation cancellation to the lifecycle service", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mpx-lifecycle-use-")); roots.push(directory);
  const state: LifecycleState = { schemaVersion: 1, owner: "mpx", key: deriveLifecycleKey("C:/repo/.git", "feature/test"), repositoryId: "fixture/app", repositoryIdentity: "C:/repo/.git", mainRoot: "C:/repo", worktreePath: "C:/repo.worktrees/test", branch: "feature/test", base: "main", configHash: "hash", status: "preparing", createdAt: 1, updatedAt: 1 };
  const inspected: string[] = [];
  const foundation = createNodeLifecycleFoundation(directory, "git", { operationCwd: "C:/elsewhere", isPreparationWorkerActive: async persisted => { inspected.push(persisted.key); return true; } });
  await expect(foundation.git.isInUse(state.worktreePath, state)).resolves.toBe(false);
  expect(inspected).toEqual([]);
});

it("refuses to persist a lifecycle key not derived from repository identity and branch", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mpx-lifecycle-state-")); roots.push(directory);
  const store = new NodeLifecycleStateStore(directory);
  const state: LifecycleState = { schemaVersion: 1, owner: "mpx", key: "wrong", repositoryId: "fixture/app", repositoryIdentity: "C:/repo/.git", mainRoot: "C:/repo", worktreePath: "C:/repo.worktrees/test", branch: "feature/test", base: "main", configHash: "hash", status: "ready", createdAt: 1, updatedAt: 1 };
  await expect(store.writeAtomic(state.key, state)).rejects.toMatchObject({ code: "WORKTREE_LIFECYCLE_STATE_INVALID" });
});

it("fails closed when include recovery evidence is not a boolean", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mpx-lifecycle-state-"));
  roots.push(directory);
  const store = new NodeLifecycleStateStore(directory);
  const key = deriveLifecycleKey("C:/repo/.git", "feature/test");
  const state: LifecycleState = {
    schemaVersion: 1,
    owner: "mpx",
    key,
    repositoryId: "fixture/app",
    repositoryIdentity: "C:/repo/.git",
    mainRoot: "C:/repo",
    worktreePath: "C:/repo.worktrees/test",
    branch: "feature/test",
    base: "main",
    configHash: "hash",
    status: "ready",
    createdAt: 1,
    updatedAt: 1,
    includeEvidence: { manifestSha256: "manifest" },
  };
  await store.writeAtomic(key, state);
  const file = path.join(directory, `${createHash("sha256").update(key).digest("hex")}.json`);
  const parsed = JSON.parse(await readFile(file, "utf8")) as { includeEvidence: Record<string, unknown> };
  parsed.includeEvidence.copyStarted = "yes";
  await writeFile(file, `${JSON.stringify(parsed)}\\n`);
  await expect(store.load(key)).rejects.toMatchObject({ code: "WORKTREE_LIFECYCLE_STATE_INVALID" });
});

it("fails closed when lifecycle state is missing repositoryIdentity", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mpx-lifecycle-state-"));
  roots.push(directory);
  const store = new NodeLifecycleStateStore(directory);
  const key = deriveLifecycleKey("C:/repo/.git", "feature/test");
  const state: LifecycleState = {
    schemaVersion: 1,
    owner: "mpx",
    key,
    repositoryId: "fixture/app",
    repositoryIdentity: "C:/repo/.git",
    mainRoot: "C:/repo",
    worktreePath: "C:/repo.worktrees/feature/test",
    branch: "feature/test",
    base: "main",
    configHash: "hash",
    status: "ready",
    createdAt: 1,
    updatedAt: 1,
  };
  await store.writeAtomic(key, state);
  const file = path.join(directory, `${createHash("sha256").update(key).digest("hex")}.json`);
  const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  delete parsed.repositoryIdentity;
  await writeFile(file, `${JSON.stringify(parsed)}\n`);
  await expect(store.load(key)).rejects.toMatchObject({ code: "WORKTREE_LIFECYCLE_STATE_INVALID" });
});
