import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BranchLeaseStore,
  ConversationBranchService,
  BranchLineageStore,
  SessionError,
  createClaudeBranchAdapter,
  createPiBranchAdapter,
  planWindowsTerminalTab,
  type BranchRequestV1,
} from "./index.js";

const digest = "a".repeat(64);
const base: BranchRequestV1 = {
  schemaVersion: 1,
  parent: { runtimeQualifiedId: "claude:parent id", nativeSessionRef: { kind: "native-id", value: "parent id" } },
  child: { runtimeQualifiedId: "claude:new", runtime: "claude" },
  launchIdentity: { identity: { domain: "personal", name: "me" }, rootDigest: digest, nativeBindingRef: "binding", mode: "interactive", executor: "host", skillPolicy: "standard", contentScope: "repo", workspace: "direct", networkPolicy: "restricted", grants: [{ resource: "repo", access: "write" }], artifactKey: "artifact", manifestKey: "manifest", launchKey: "launch", descriptorDigest: digest },
  workspace: { selection: "isolated", intent: "modify", cwd: "C:/repo with spaces", projectRef: "project", repositoryRef: "repo", worktreeRef: null, branch: "mpx/session-child" },
  files: { sharing: "isolated", collisionDisclosure: ["same repository history"], duplicateWriterRiskAcknowledged: false },
  terminal: { enabled: false },
};

function dependencies() {
  return {
    inspectWorkspace: vi.fn(async () => ({ exists: true, collisionDisclosure: ["same repository history"] as const })),
    createIsolatedWorktree: vi.fn(async () => ({ cwd: "C:/repo.worktrees/mpx/session-child", worktreeRef: "wt-child" })),
    adapters: { claude: createClaudeBranchAdapter("C:/Program Files/Claude/claude.exe"), pi: createPiBranchAdapter("C:/Program Files/Pi/pi.exe") },
  };
}

describe("conversation branching", () => {
  it("plans a modifying parallel branch in a new isolated worktree by default", async () => {
    const deps = dependencies();
    const plan = await new ConversationBranchService(deps).plan({ ...base, workspace: { ...base.workspace, selection: "default" } });
    expect(plan.workspace).toMatchObject({ selection: "isolated", sharing: "isolated", provision: "new-worktree" });
    expect(deps.createIsolatedWorktree).not.toHaveBeenCalled();
  });

  it("preserves a work identity and immutable launch root/mode/executor in the child plan", async () => {
    const plan = await new ConversationBranchService(dependencies()).plan({ ...base, launchIdentity: { ...base.launchIdentity, identity: { domain: "work", name: "employee" }, rootDigest: "b".repeat(64), nativeBindingRef: "work-binding", mode: "locked-down", executor: "host" } });
    expect(plan.launchIdentity).toEqual({ ...base.launchIdentity, identity: { domain: "work", name: "employee" }, rootDigest: "b".repeat(64), nativeBindingRef: "work-binding", mode: "locked-down", executor: "host" });
  });

  it("rejects a missing or deleted repository/worktree during read-only planning", async () => {
    const deps = dependencies(); deps.inspectWorkspace.mockResolvedValue({ exists: false, collisionDisclosure: [] });
    await expect(new ConversationBranchService(deps).plan(base)).rejects.toMatchObject({ code: "SESSION_BRANCH_WORKSPACE_MISSING" });
  });

  it("fails closed for Docker until the selected executor is explicitly admitted", async () => {
    await expect(new ConversationBranchService(dependencies()).plan({ ...base, launchIdentity: { ...base.launchIdentity, executor: "docker" } })).rejects.toMatchObject({ code: "SESSION_BRANCH_EXECUTOR_NOT_ADMITTED" });
  });

  it("repeats proof-bound Docker session admission at apply before any worktree or launch side effect", async () => {
    const deps = dependencies(), runtime = { launch: vi.fn() };
    const admitExecutor = vi.fn(async (value: BranchRequestV1 | { kind: string }) => !("kind" in value) || false);
    const service = new ConversationBranchService({ ...deps, admitExecutor, runtime }, new BranchLeaseStore(await mkdtemp(path.join(tmpdir(), "mpx-branch-"))));
    const request = { ...base, launchIdentity: { ...base.launchIdentity, executor: "docker" as const } };
    const plan = await service.plan(request);
    await expect(service.apply(plan, plan.confirmationDigest)).rejects.toMatchObject({ code: "SESSION_BRANCH_EXECUTOR_NOT_ADMITTED" });
    expect(admitExecutor).toHaveBeenNthCalledWith(1, request);
    expect(admitExecutor).toHaveBeenNthCalledWith(2, plan);
    expect(deps.createIsolatedWorktree).not.toHaveBeenCalled();
    expect(runtime.launch).not.toHaveBeenCalled();
  });

  it("requires explicit risk acknowledgement for a shared current checkout", async () => {
    await expect(new ConversationBranchService(dependencies()).plan({ ...base, workspace: { ...base.workspace, selection: "shared" }, files: { ...base.files, sharing: "shared" } })).rejects.toMatchObject({ code: "SESSION_BRANCH_SHARED_RISK_UNACKNOWLEDGED" });
  });

  it("does not provision or acquire a writer lease before digest confirmation", async () => {
    const deps = dependencies(), leases = new BranchLeaseStore(await mkdtemp(path.join(tmpdir(), "mpx-branch-")));
    const service = new ConversationBranchService(deps, leases), plan = await service.plan(base);
    await expect(service.apply(plan, "b".repeat(64))).rejects.toMatchObject({ code: "SESSION_BRANCH_CONFIRMATION_MISMATCH" });
    expect(deps.createIsolatedWorktree).not.toHaveBeenCalled();
  });

  it("prevents two child sessions from holding a writer lease for one workspace", async () => {
    const leases = new BranchLeaseStore(await mkdtemp(path.join(tmpdir(), "mpx-branch-")));
    const first = await leases.acquire("C:/shared repo", "claude:one");
    await expect(leases.acquire("C:/shared repo", "pi:two")).rejects.toMatchObject({ code: "SESSION_BRANCH_DUPLICATE_WRITER" });
    await first.release();
    await expect(leases.acquire("C:/shared repo", "pi:two")).resolves.toBeDefined();
  });

  it("serializes native writer acquisition between two controller processes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-branch-processes-")), fixture = path.resolve(import.meta.dirname, "../test-fixtures/branch-lease-worker.mjs");
    const run = (owner: string, hold: number) => spawn(process.execPath, [fixture, root, "C:/shared repo", owner, String(hold)], { stdio: ["ignore", "pipe", "inherit"] });
    const first = run("claude:one", 3_000);
    await new Promise<void>((resolve, reject) => { first.stdout.once("data", chunk => chunk.toString().includes("ACQUIRED") ? resolve() : reject(new Error(chunk.toString()))); first.once("error", reject); });
    const second = run("pi:two", 0); let output = ""; second.stdout.on("data", chunk => { output += chunk; });
    await new Promise<void>((resolve, reject) => { second.once("exit", () => resolve()); second.once("error", reject); });
    expect(output).toContain("ERROR:SESSION_BRANCH_DUPLICATE_WRITER");
    await new Promise<void>((resolve, reject) => { first.once("exit", () => resolve()); first.once("error", reject); });
  });

  it("can restore and release a durable writer lease after controller restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-branch-")), firstStore = new BranchLeaseStore(root), first = await firstStore.acquire("C:/shared repo", "claude:child");
    const restored = await new BranchLeaseStore(root).restore(first.workspaceDigest, "claude:child");
    await restored.release();
    await expect(firstStore.acquire("C:/shared repo", "pi:next")).resolves.toBeDefined();
  });

  it("records controller, heartbeat, launch, session, and workspace identities", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-branch-record-")), now = 10_000;
    const store = new BranchLeaseStore(root, { processId: 41, controllerStartFingerprint: "start-41", now: () => now, leaseTtlMs: 5_000 });
    const lease = await store.acquire("C:/shared repo", "claude:child", { launchKey: "launch-1", nativeBindingRef: "binding-1", parentRuntimeQualifiedId: "claude:parent", worktreeRef: "wt-1" });
    const record = JSON.parse(await readFile(path.join(root, `${lease.workspaceDigest}.writer`, "owner.json"), "utf8"));
    expect(record).toMatchObject({ schemaVersion: 1, owner: "claude:child", controller: { pid: 41, startFingerprint: "start-41" }, createdAt: 10_000, heartbeatAt: 10_000, expiresAt: 15_000, launch: { launchKey: "launch-1" }, session: { runtimeQualifiedId: "claude:child", parentRuntimeQualifiedId: "claude:parent", nativeBindingRef: "binding-1" }, workspace: { cwd: "C:/shared repo", digest: lease.workspaceDigest, worktreeRef: "wt-1" } });
    expect(record.token).toEqual(expect.any(String));
    await lease.release();
  });

  it("reclaims an expired lease only when its exact controller is dead and no child session is observed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-branch-recover-")); let now = 1_000;
    const first = new BranchLeaseStore(root, { processId: 11, controllerStartFingerprint: "old", now: () => now, leaseTtlMs: 100, heartbeatIntervalMs: 1_000 });
    await first.acquire("C:/shared repo", "claude:old"); now = 1_101;
    const second = new BranchLeaseStore(root, { processId: 22, controllerStartFingerprint: "new", now: () => now, processInspector: { inspect: async pid => pid === 22 ? { status: "present", pid, startFingerprint: "new" } : { status: "absent" } }, observeSession: async () => "absent" });
    await expect(second.acquire("C:/shared repo", "pi:new")).resolves.toMatchObject({ owner: "pi:new" });
  });

  it("treats PID reuse, live controllers, and unknown inspection fail-closed", async () => {
    const scenarios = [
      { inspection: { status: "present" as const, pid: 11, startFingerprint: "reused" }, code: undefined },
      { inspection: { status: "present" as const, pid: 11, startFingerprint: "old" }, code: "SESSION_BRANCH_DUPLICATE_WRITER" },
      { inspection: { status: "unknown" as const }, code: "SESSION_BRANCH_LEASE_INSPECTION_UNKNOWN" },
    ];
    for (const scenario of scenarios) {
      const root = await mkdtemp(path.join(tmpdir(), "mpx-branch-inspect-")); let now = 1_000;
      const first = new BranchLeaseStore(root, { processId: 11, controllerStartFingerprint: "old", now: () => now, leaseTtlMs: 100, heartbeatIntervalMs: 1_000 });
      await first.acquire("C:/shared repo", "claude:old"); now = 1_101;
      const second = new BranchLeaseStore(root, { processId: 22, controllerStartFingerprint: "new", now: () => now, processInspector: { inspect: async pid => pid === 22 ? { status: "present", pid, startFingerprint: "new" } : scenario.inspection }, observeSession: async () => "absent" });
      const attempt = second.acquire("C:/shared repo", "pi:new");
      if (scenario.code) await expect(attempt).rejects.toMatchObject({ code: scenario.code }); else await expect(attempt).resolves.toBeDefined();
    }
  });

  it("does not reclaim a crashed controller lease while lifecycle observations show a native child writer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-branch-child-")); let now = 1_000;
    await new BranchLeaseStore(root, { processId: 11, controllerStartFingerprint: "old", now: () => now, leaseTtlMs: 100, heartbeatIntervalMs: 1_000 }).acquire("C:/shared repo", "claude:old"); now = 1_101;
    const store = new BranchLeaseStore(root, { now: () => now, processInspector: { inspect: async pid => pid === process.pid ? { status: "present", pid, startFingerprint: `pid-${pid}` } : { status: "absent" } }, observeSession: async () => "active" });
    await expect(store.acquire("C:/shared repo", "pi:new")).rejects.toMatchObject({ code: "SESSION_BRANCH_DUPLICATE_WRITER" });
  });

  it("a stale release cannot remove a token replacement", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-branch-token-")), store = new BranchLeaseStore(root);
    const lease = await store.acquire("C:/shared repo", "claude:old"), file = path.join(root, `${lease.workspaceDigest}.writer`, "owner.json");
    const record = JSON.parse(await readFile(file, "utf8")); await writeFile(file, JSON.stringify({ ...record, token: "replacement" }));
    await lease.release();
    await expect(readFile(file, "utf8")).resolves.toContain("replacement");
  });

  it("uses Claude's native fork/resume argv without copying transcripts", () => {
    expect(createClaudeBranchAdapter("C:/Program Files/Claude/claude.exe").plan(base.parent, "C:/repo & work")).toEqual({ executable: "C:/Program Files/Claude/claude.exe", argv: ["--resume", "parent id", "--fork-session"], cwd: "C:/repo & work", nativeTarget: "runtime-created" });
  });

  it("admits a Pi fork only for an identity-stable regular source under the selected root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi root & ")), session = path.join(root, "sessions", "parent.jsonl");
    await mkdir(path.dirname(session)); await writeFile(session, "{}");
    const adapter = createPiBranchAdapter("C:/Program Files/Pi/pi.exe");
    await expect(adapter.plan({ runtimeQualifiedId: "pi:parent", nativeSessionRef: { kind: "root-relative-file", value: "sessions/parent.jsonl" } }, "C:/repo", root)).resolves.toEqual({ executable: "C:/Program Files/Pi/pi.exe", argv: ["--fork", session.replaceAll("\\", "/")], cwd: "C:/repo", nativeTarget: "runtime-created" });
    await expect(adapter.plan({ runtimeQualifiedId: "pi:parent", nativeSessionRef: { kind: "root-relative-file", value: "../escape" } }, "C:/repo", root)).rejects.toMatchObject({ code: "SESSION_BRANCH_PI_TARGET_INVALID" });
  });

  it("emits an optional Windows Terminal tab as executable and argv with no shell text", () => {
    expect(planWindowsTerminalTab({ enabled: true, executable: "C:/Program Files/WindowsApps/wt.exe", cwd: "C:/repo & work", title: "child; title" }, { executable: "C:/Program Files/Pi/pi.exe", argv: ["--fork", "C:/pi root/a.jsonl"], cwd: "C:/repo & work", nativeTarget: "runtime-created" })).toEqual({ executable: "C:/Program Files/WindowsApps/wt.exe", argv: ["new-tab", "--title", "child; title", "--startingDirectory", "C:/repo & work", "--", "C:/Program Files/Pi/pi.exe", "--fork", "C:/pi root/a.jsonl"], cwd: "C:/repo & work" });
    expect(planWindowsTerminalTab({ enabled: false }, { executable: "x", argv: [], cwd: "C:/repo", nativeTarget: "runtime-created" })).toBeNull();
  });

  it("restores finalized parent-child lineage and workspace disclosure after a process restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-branch-lineage-")), first = new BranchLineageStore(root);
    await first.savePending({ pendingRuntimeQualifiedId: "pi:pending", parentRuntimeQualifiedId: "pi:parent", identity: { domain: "work", name: "me" }, nativeBindingRef: "binding", cwd: "C:/shared", worktreeRef: null, sharing: "shared", collisionDisclosure: ["concurrent changes share the current checkout"], writerLease: { owner: "pi:pending", workspaceDigest: digest } });
    await first.finalize("pi:pending", { runtimeQualifiedId: "pi:actual", nativeSessionRef: { kind: "root-relative-file", value: "sessions/actual.jsonl" } });
    await expect(new BranchLineageStore(root).read("pi:pending")).resolves.toMatchObject({ status: "active", parentRuntimeQualifiedId: "pi:parent", actual: { runtimeQualifiedId: "pi:actual" }, sharing: "shared", collisionDisclosure: ["concurrent changes share the current checkout"] });
  });

  it("performs binding/auth preflight before worktree, lease, terminal, or runtime side effects", async () => {
    const deps = dependencies(), failure = new SessionError("ACCOUNT_AUTH_UNAVAILABLE", "OAuth unavailable"), runtime = { launch: vi.fn() }, terminal = { launch: vi.fn() };
    const service = new ConversationBranchService({ ...deps, validateNativeBinding: vi.fn(async () => { throw failure; }), runtime, terminal, lineage: { savePending: vi.fn(), finalize: vi.fn(), fail: vi.fn() } }, new BranchLeaseStore(await mkdtemp(path.join(tmpdir(), "mpx-branch-"))));
    const plan = await service.plan(base);
    await expect(service.apply(plan, plan.confirmationDigest)).rejects.toBe(failure);
    expect(deps.createIsolatedWorktree).not.toHaveBeenCalled(); expect(runtime.launch).not.toHaveBeenCalled(); expect(terminal.launch).not.toHaveBeenCalled();
  });

  it("cleans a new worktree and releases its durable writer lease when native launch fails", async () => {
    const deps = dependencies(), leases = new BranchLeaseStore(await mkdtemp(path.join(tmpdir(), "mpx-branch-"))), remove = vi.fn(async () => undefined);
    const service = new ConversationBranchService({ ...deps, removeIsolatedWorktree: remove, validateNativeBinding: vi.fn(async () => undefined), runtime: { launch: vi.fn(async () => { throw new Error("spawn failed"); }) }, lineage: { savePending: vi.fn(), finalize: vi.fn(), fail: vi.fn() } }, leases);
    const plan = await service.plan(base);
    await expect(service.apply(plan, plan.confirmationDigest)).rejects.toThrow("spawn failed");
    expect(remove).toHaveBeenCalledWith({ cwd: "C:/repo.worktrees/mpx/session-child", worktreeRef: "wt-child" });
    await expect(leases.acquire("C:/repo.worktrees/mpx/session-child", "claude:retry")).resolves.toBeDefined();
  });

  it("launches the optional terminal plan only through the terminal argv adapter", async () => {
    const deps = dependencies(), runtime = { launch: vi.fn() }, terminal = { launch: vi.fn(async () => ({ lifecycle: Promise.resolve({ runtimeQualifiedId: "claude:actual", nativeSessionRef: { kind: "native-id" as const, value: "actual" } }), exited: Promise.resolve() })) };
    const service = new ConversationBranchService({ ...deps, validateNativeBinding: vi.fn(async () => undefined), runtime, terminal, lineage: { savePending: vi.fn(), finalize: vi.fn(), fail: vi.fn() } }, new BranchLeaseStore(await mkdtemp(path.join(tmpdir(), "mpx-branch-"))));
    const plan = await service.plan({ ...base, terminal: { enabled: true, executable: "C:/Program Files/WindowsApps/wt.exe", title: "child & safe" } });
    await service.apply(plan, plan.confirmationDigest);
    expect(runtime.launch).not.toHaveBeenCalled();
    expect(terminal.launch).toHaveBeenCalledWith(expect.objectContaining({ executable: "C:/Program Files/WindowsApps/wt.exe", argv: ["new-tab", "--title", "child & safe", "--startingDirectory", "C:/repo.worktrees/mpx/session-child", "--", "C:/Program Files/Claude/claude.exe", "--resume", "parent id", "--fork-session"] }), plan);
  });

  it("retains the writer lease while the launched child remains active", async () => {
    const deps = dependencies(), leases = new BranchLeaseStore(await mkdtemp(path.join(tmpdir(), "mpx-branch-")));
    let exit!: () => void; const exited = new Promise<void>(resolve => { exit = resolve; });
    const service = new ConversationBranchService({ ...deps, validateNativeBinding: vi.fn(async () => undefined), runtime: { launch: vi.fn(async () => ({ lifecycle: Promise.resolve({ runtimeQualifiedId: "claude:actual", nativeSessionRef: { kind: "native-id" as const, value: "actual" } }), exited })) }, lineage: { savePending: vi.fn(), finalize: vi.fn(), fail: vi.fn() } }, leases);
    const plan = await service.plan(base); await service.apply(plan, plan.confirmationDigest);
    await expect(leases.acquire("C:/repo.worktrees/mpx/session-child", "claude:other")).rejects.toMatchObject({ code: "SESSION_BRANCH_DUPLICATE_WRITER" });
    exit(); await exited; await new Promise(resolve => setTimeout(resolve, 20));
    await expect(leases.acquire("C:/repo.worktrees/mpx/session-child", "claude:other")).resolves.toBeDefined();
  });

  it("after confirmation launches through the argv adapter and atomically finalizes pending lineage from its lifecycle event", async () => {
    const deps = dependencies(), exited = Promise.resolve();
    const launch = vi.fn(async () => ({
      lifecycle: Promise.resolve({ runtimeQualifiedId: "claude:actual-child", nativeSessionRef: { kind: "native-id" as const, value: "actual-child" } }),
      exited,
    }));
    const savePending = vi.fn(async () => undefined), finalize = vi.fn(async () => undefined);
    const service = new ConversationBranchService({ ...deps, validateNativeBinding: vi.fn(async () => undefined), runtime: { launch }, lineage: { savePending, finalize, fail: vi.fn() } }, new BranchLeaseStore(await mkdtemp(path.join(tmpdir(), "mpx-branch-"))));
    const plan = await service.plan(base);
    const applied = await service.apply(plan, plan.confirmationDigest);
    expect(launch).toHaveBeenCalledWith({ executable: "C:/Program Files/Claude/claude.exe", argv: ["--resume", "parent id", "--fork-session"], cwd: "C:/repo.worktrees/mpx/session-child", nativeTarget: "runtime-created" }, plan);
    expect(savePending).toHaveBeenCalledWith(expect.objectContaining({ pendingRuntimeQualifiedId: base.child.runtimeQualifiedId, sharing: "isolated", parentRuntimeQualifiedId: base.parent.runtimeQualifiedId }));
    expect(finalize).toHaveBeenCalledWith(base.child.runtimeQualifiedId, { runtimeQualifiedId: "claude:actual-child", nativeSessionRef: { kind: "native-id", value: "actual-child" } });
    expect(applied.child).toEqual({ runtimeQualifiedId: "claude:actual-child", nativeSessionRef: { kind: "native-id", value: "actual-child" } });
  });
});
