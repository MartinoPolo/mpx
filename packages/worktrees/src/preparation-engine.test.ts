import { describe, expect, it } from "vitest";
import type { PreparationPlan, PreparationStep } from "@mpx/config";
import {
  PreparationEngine,
  createPreparationApproval,
  preparationApprovalPhrase,
  preparationApprovalPhrases,
  type PreparationEvidence,
  type PreparationState,
  type PreparationAdapters,
  type SpawnRequest,
  type SpawnResult,
} from "./preparation-engine.js";

const root = "C:\\repos\\app.worktrees\\feature";
const plan = (steps: PreparationStep[], execution: "foreground" | "background" | "none" = "foreground"): PreparationPlan => ({
  execution, steps: steps.map(step => ({ ...step, required: step.required ?? true })), order: steps.map(step => step.id), logging: { maxOutputBytes: 65536, redactEnvironmentValues: true },
});

function harness(options: { results?: SpawnResult[]; evidence?: Partial<PreparationEvidence>; worker?: { pid: number; startFingerprint: string; ownerToken: string }; canonicalPaths?: Record<string, string>; inspectError?: Error; terminateError?: Error } = {}) {
  let now = 1000;
  const states = new Map<string, PreparationState>();
  const logs = new Map<string, string>();
  const spawns: SpawnRequest[] = [];
  const terminations: number[] = [];
  let evidence: PreparationEvidence = {
    repositoryIdentity: "git-common:C:/repos/app/.git", head: "abc", configHash: "cfg",
    packageManifestHash: "pkg", lockfileHashes: [{ path: "pnpm-lock.yaml", hash: "lock" }],
    ...options.evidence,
  };
  const results = [...(options.results ?? [{ exitCode: 0, output: "ok" }])];
  const processFacts = new Map<number, { startFingerprint: string; owner: "mpx" | "other"; ownerToken?: string }>();
  const makeStore = (): PreparationAdapters["store"] => ({
    load: async key => states.get(key),
    compareAndSwap: async (key, expectedRevision, state, revalidate) => { const current = states.get(key); if (current?.revision !== expectedRevision || (current === undefined) !== (expectedRevision === undefined)) return false; await revalidate?.(); states.set(key, structuredClone(state)); return true; },
    writeLogAtomic: async (path, content) => { logs.set(path, content); },
  });
  const adapters: PreparationAdapters = {
    evidence: { capture: async () => ({ ...evidence, lockfileHashes: [...evidence.lockfileHashes] }) },
    execution: {
      resolveExecutable: async command => ({ path: command, sha256: "executable-hash" }),
      spawn: async request => { spawns.push(request); const result = results.shift() ?? { exitCode: 0, output: "" }; if (result.pid && result.startFingerprint) { const owned = { pid: result.pid, startFingerprint: result.startFingerprint, ownerToken: "process-token" }; processFacts.set(result.pid, { startFingerprint: result.startFingerprint, owner: "mpx", ownerToken: "process-token" }); await request.onStarted(owned); } return result; },
      startBackground: async (_request, onVerified) => { const worker = options.worker ?? { pid: 77, startFingerprint: "worker-start", ownerToken: "worker-token" }; await onVerified(worker); return worker; },
    },
    store: makeStore(),
    clock: { now: () => now, sleep: async ms => { now += ms; } },
    process: {
      inspect: async pid => { if (options.inspectError) throw options.inspectError; return processFacts.get(pid); },
      terminateTree: async pid => { if (options.terminateError) throw options.terminateError; terminations.push(pid); processFacts.delete(pid); },
    },
    paths: {
      canonicalize: async value => options.canonicalPaths?.[value] ?? value,
    },
  };
  return { adapters, secondAdapters: { ...adapters, store: makeStore() }, states, logs, spawns, terminations, setEvidence: (next: Partial<PreparationEvidence>) => { evidence = { ...evidence, ...next }; }, processFacts };
}

const request = (preparationPlan: PreparationPlan, approval: Awaited<ReturnType<typeof createPreparationApproval>>, env: Record<string, string | undefined> = {}) => ({
  key: "app/feature", plan: preparationPlan, approval, ...preparationApprovalPhrases(approval), worktreeRoot: root, packageManager: "pnpm" as const, environment: env, logDirectory: `${root}\\.mpx\\logs`,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const persisted = (overrides: Partial<PreparationState> = {}): PreparationState => ({
  schemaVersion: 2, owner: "mpx", key: "app/feature", runId: "11111111-1111-4111-8111-111111111111", revision: 1,
  status: "preparing", execution: "background", createdAt: 1, updatedAt: 2, steps: [], ...overrides,
});

describe("preparation approval and execution", () => {
  it("CAS-creates a new versioned run at revision one with an unguessable identity", async () => {
    const h = harness(); const p = plan([], "none");
    const state = await new PreparationEngine(h.adapters).prepare(request(p, { schemaVersion: 1, owner: "mpx", steps: [] }));
    expect(state).toMatchObject({ schemaVersion: 2, revision: 1, status: "ready" });
    expect(state.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(h.states.get("app/feature")).toEqual(state);
  });

  it("renders an exact content-bound approval without merging package and argv trust", async () => {
    const h = harness({ evidence: { resolvedPackageScriptBody: "vite build" } });
    const p = plan([{ id: "build", uses: "package-script", script: "build" }, { id: "tool", uses: "executable", argv: ["tool"] }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters);
    const phrases = preparationApprovalPhrases(approval);
    expect(phrases.packageAutomationApproval).toMatch(/^APPROVE PACKAGE AUTOMATION [0-9a-f]{64}$/u);
    expect(phrases.explicitExecutableApproval).toMatch(/^APPROVE EXPLICIT EXECUTABLES [0-9a-f]{64}$/u);
    expect(phrases.packageAutomationApproval).not.toBe(phrases.explicitExecutableApproval);
    expect(approval.steps.map(step => step.kind)).toEqual(["package", "explicit-argv"]);
  });

  it("fails a mixed plan before spawn when either separate approval is missing or wrong-kind", async () => {
    const h = harness({ evidence: { resolvedPackageScriptBody: "vite build" } });
    const p = plan([{ id: "build", uses: "package-script", script: "build" }, { id: "tool", uses: "executable", argv: ["tool"] }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters);
    const phrases = preparationApprovalPhrases(approval);
    await expect(new PreparationEngine(h.adapters).prepare({ ...request(p, approval), explicitExecutableApproval: phrases.packageAutomationApproval })).rejects.toMatchObject({ code: "PREPARATION_APPROVAL_STALE" });
    expect(h.spawns).toHaveLength(0);
    expect(h.states).toHaveLength(0);
  });

  it("constructs package argv from the approved launcher and trusted prefix", async () => {
    const h = harness();
    h.adapters.execution.resolveExecutable = async () => ({ path: "C:\\trusted\\node.exe", sha256: "node-hash", size: 10, modifiedMs: 1, trustedPrefixArguments: ["C:\\trusted\\node_modules\\npm\\bin\\npm-cli.js"], supportFiles: [{ path: "C:\\trusted\\node_modules\\npm\\bin\\npm-cli.js", sha256: "script-hash", size: 11, modifiedMs: 1 }] });
    const p = plan([{ id: "install", uses: "package-install" }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "npm", environment: {} }, h.adapters);
    await new PreparationEngine(h.adapters).prepare({ ...request(p, approval), packageManager: "npm" });
    expect(h.spawns[0]?.argv).toEqual(["C:\\trusted\\node.exe", "C:\\trusted\\node_modules\\npm\\bin\\npm-cli.js", "ci"]);
    expect(h.spawns[0]?.shell).toBe(false);
  });

  it("runs finite steps sequentially with direct argv and persists ready facts", async () => {
    const h = harness({ evidence: { resolvedPackageScriptBody: "tsc -b" }, results: [{ exitCode: 0, output: "installed" }, { exitCode: 0, output: "built" }, { exitCode: 0, output: "clean" }] });
    const p = plan([{ id: "install", uses: "package-install" }, { id: "build", uses: "package-script", script: "build" }, { id: "status", uses: "executable", argv: ["git", "status", "--short"] }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters);
    const state = await new PreparationEngine(h.adapters).prepare(request(p, approval));
    expect(h.spawns.map(spawn => spawn.argv)).toEqual([["pnpm", "install", "--frozen-lockfile"], ["pnpm", "run", "build"], ["git", "status", "--short"]]);
    expect(h.spawns.every(spawn => spawn.shell === false)).toBe(true);
    expect(state.status).toBe("ready");
    expect(state.steps.map(step => step.status)).toEqual(["ready", "ready", "ready"]);
  });

  it("rejects malformed approval before persisting a ghost preparing state", async () => {
    const h = harness();
    const p = plan([{ id: "install", uses: "package-install" }]);
    await expect(new PreparationEngine(h.adapters).prepare(request(p, { schemaVersion: 1, owner: "mpx", steps: [] } as Awaited<ReturnType<typeof createPreparationApproval>>))).rejects.toMatchObject({ code: "PREPARATION_APPROVAL_STALE" });
    expect(h.states.get("app/feature")).toBeUndefined();
  });

  it("rejects stale approval before spawning when any bound evidence changes", async () => {
    const h = harness(); const p = plan([{ id: "install", uses: "package-install" }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters);
    h.setEvidence({ head: "def" });
    await expect(new PreparationEngine(h.adapters).prepare(request(p, approval))).rejects.toMatchObject({ code: "PREPARATION_APPROVAL_STALE" });
    expect(h.spawns).toHaveLength(0); expect(h.states.get("app/feature")?.status).toBe("failed");
  });

  it("binds package scripts to their resolved body and explicit argv to a distinct approval kind", async () => {
    const h = harness({ evidence: { resolvedPackageScriptBody: "vite build" } });
    const p = plan([{ id: "build", uses: "package-script", script: "build" }, { id: "tool", uses: "executable", argv: ["tool", "--safe"] }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters);
    expect(approval.steps.map(step => step.kind)).toEqual(["package", "explicit-argv"]);
    h.setEvidence({ resolvedPackageScriptBody: "curl attacker" });
    await expect(new PreparationEngine(h.adapters).prepare(request(p, approval))).rejects.toMatchObject({ code: "PREPARATION_APPROVAL_STALE" });
  });

  it("rejects a cwd that escapes the worktree before approval or execution", async () => {
    const h = harness(); const p = plan([{ id: "run", uses: "executable", argv: ["tool"], cwd: "..\\outside" }]);
    await expect(createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters)).rejects.toMatchObject({ code: "PREPARATION_CWD_ESCAPE" });
    expect(h.spawns).toHaveLength(0);
  });

  it("keeps approved environment values out of approval, persisted state, and redacted logs", async () => {
    const secret = "approved-environment-value";
    const h = harness({ results: [{ exitCode: 0, output: `VISIBLE=${secret}` }] });
    const p = plan([{ id: "run", uses: "executable", argv: ["tool"], environment: ["VISIBLE"] }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: { VISIBLE: secret } }, h.adapters);
    expect(JSON.stringify(approval)).not.toContain(secret);

    const state = await new PreparationEngine(h.adapters).prepare(request(p, approval, { VISIBLE: secret }));
    expect(JSON.stringify(state)).not.toContain(secret);
    expect(h.spawns[0]?.environmentNames).toEqual(["VISIBLE"]);
    const log = [...h.logs.values()][0]!;
    expect(log).toBe("VISIBLE=[REDACTED]");
    expect(log).toContain("VISIBLE");
    expect(log).toContain("[REDACTED]");
    expect(log).not.toContain(secret);
  });

  it("rejects a lexically contained cwd whose canonical target escapes before spawn", async () => {
    const escaped = `${root}\\dir\\link`;
    const h = harness({ canonicalPaths: { [root]: root, [escaped]: "C:\\repos\\outside" } });
    const p = plan([{ id: "run", uses: "executable", argv: ["tool"], cwd: "dir\\link" }]);
    await expect(createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters)).rejects.toMatchObject({ code: "PREPARATION_CWD_ESCAPE" });
    expect(h.spawns).toHaveLength(0);
  });

  it("continues after optional failure but stops after required failure", async () => {
    const h = harness({ results: [{ exitCode: 2, output: "optional" }, { exitCode: 3, output: "required" }, { exitCode: 0, output: "never" }] });
    const p = plan([{ id: "optional", uses: "executable", argv: ["one"], required: false }, { id: "required", uses: "executable", argv: ["two"] }, { id: "later", uses: "executable", argv: ["three"] }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters);
    const state = await new PreparationEngine(h.adapters).prepare(request(p, approval));
    expect(state.status).toBe("failed"); expect(h.spawns).toHaveLength(2); expect(state.steps[0]?.status).toBe("failed");
  });

  it("writes bounded logs with environment values redacted", async () => {
    const secret = "very-sensitive-value";
    const h = harness({ results: [{ exitCode: 0, output: `${"x".repeat(70000)} ${secret}` }] });
    const p = plan([{ id: "run", uses: "executable", argv: ["tool"], environment: ["VISIBLE"] }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: { VISIBLE: secret } }, h.adapters);
    const state = await new PreparationEngine(h.adapters).prepare(request(p, approval, { VISIBLE: secret }));
    const log = [...h.logs.values()][0]!; expect(Buffer.byteLength(log)).toBeLessThanOrEqual(65536); expect(log).not.toContain(secret); expect(log).toContain("[REDACTED]");
    expect(Buffer.byteLength(state.steps[0]!.logTail!)).toBeLessThanOrEqual(4096); expect(state.steps[0]!.logTail).not.toContain(secret);
  });

  it("times out and terminates only the matching MPX-owned process fingerprint", async () => {
    const h = harness({ results: [{ exitCode: null, output: "hung", timedOut: true, pid: 44, startFingerprint: "start-44" }] });
    const p = plan([{ id: "run", uses: "executable", argv: ["tool"], timeoutSeconds: 1 }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters);
    const state = await new PreparationEngine(h.adapters).prepare(request(p, approval));
    expect(h.terminations).toEqual([44]); expect(state.status).toBe("failed"); expect(state.steps[0]?.failure).toBe("timeout");
  });

  it("terminates an exactly matching owned worker and persists cancellation", async () => {
    const h = harness();
    h.states.set("app/feature", { schemaVersion: 2, owner: "mpx", key: "app/feature", runId: "11111111-1111-4111-8111-111111111111", revision: 1, status: "preparing", execution: "background", createdAt: 1, updatedAt: 2, steps: [{ id: "run", status: "preparing", process: { pid: 77, startFingerprint: "worker-start", ownerToken: "worker-token" } }], worker: { pid: 77, startFingerprint: "worker-start", ownerToken: "worker-token" } });
    h.processFacts.set(77, { owner: "mpx", startFingerprint: "worker-start", ownerToken: "worker-token" });

    const state = await new PreparationEngine(h.adapters).cancel("app/feature");
    expect(h.terminations).toEqual([77]);
    expect(state.status).toBe("cancelled");
    expect(state.steps[0]).toMatchObject({ status: "cancelled" });
    expect(h.states.get("app/feature")).toMatchObject({ status: "cancelled", steps: [{ status: "cancelled" }] });
  });

  it("reconciles an exact matching foreground child as still preparing after restart", async () => {
    const h = harness();
    h.states.set("app/feature", persisted({ execution: "foreground", steps: [{ id: "run", status: "preparing", process: { pid: 76, startFingerprint: "child-start", ownerToken: "child-token" } }] }));
    h.processFacts.set(76, { owner: "mpx", startFingerprint: "child-start", ownerToken: "child-token" });

    const state = await new PreparationEngine(h.secondAdapters).reconcile("app/feature");

    expect(state.status).toBe("preparing");
    expect(state.revision).toBe(1);
  });

  it("reconciles an exact matching owned worker as still preparing after restart", async () => {
    const h = harness();
    h.states.set("app/feature", { schemaVersion: 2, owner: "mpx", key: "app/feature", runId: "11111111-1111-4111-8111-111111111111", revision: 1, status: "preparing", execution: "background", createdAt: 1, updatedAt: 2, steps: [], worker: { pid: 77, startFingerprint: "worker-start", ownerToken: "worker-token" } });
    h.processFacts.set(77, { owner: "mpx", startFingerprint: "worker-start", ownerToken: "worker-token" });

    const state = await new PreparationEngine(h.adapters).reconcile("app/feature");
    expect(state.status).toBe("preparing");
    expect(h.terminations).toEqual([]);
  });

  it("does not terminate a reused PID during cancellation and reconcile, and maps both to unknown", async () => {
    const h = harness(); h.states.set("app/feature", { schemaVersion: 2, owner: "mpx", key: "app/feature", runId: "11111111-1111-4111-8111-111111111111", revision: 1, status: "preparing", execution: "background", createdAt: 1, updatedAt: 2, steps: [], worker: { pid: 77, startFingerprint: "old", ownerToken: "worker-token" } });
    h.processFacts.set(77, { owner: "mpx", startFingerprint: "reused", ownerToken: "worker-token" });
    const engine = new PreparationEngine(h.adapters);
    expect((await engine.cancel("app/feature")).status).toBe("unknown");
    h.states.set("app/feature", { schemaVersion: 2, owner: "mpx", key: "app/feature", runId: "11111111-1111-4111-8111-111111111111", revision: 1, status: "preparing", execution: "background", createdAt: 1, updatedAt: 2, steps: [], worker: { pid: 77, startFingerprint: "old", ownerToken: "worker-token" } });
    expect((await engine.reconcile("app/feature")).status).toBe("unknown");
    expect(h.terminations).toEqual([]);
  });

  it("finishes preparing state as unknown when process inspection fails", async () => {
    const h = harness({ inspectError: new Error("inspect failed") });
    h.states.set("app/feature", { schemaVersion: 2, owner: "mpx", key: "app/feature", runId: "11111111-1111-4111-8111-111111111111", revision: 1, status: "preparing", execution: "background", createdAt: 1, updatedAt: 2, steps: [], worker: { pid: 77, startFingerprint: "worker-start", ownerToken: "worker-token" } });
    const engine = new PreparationEngine(h.adapters);
    expect((await engine.cancel("app/feature")).status).toBe("unknown");
    h.states.set("app/feature", { schemaVersion: 2, owner: "mpx", key: "app/feature", runId: "11111111-1111-4111-8111-111111111111", revision: 1, status: "preparing", execution: "background", createdAt: 1, updatedAt: 2, steps: [], worker: { pid: 77, startFingerprint: "worker-start", ownerToken: "worker-token" } });
    expect((await engine.reconcile("app/feature")).status).toBe("unknown");
  });

  it("finishes preparing state as unknown when termination fails and never claims cancellation", async () => {
    const h = harness({ terminateError: new Error("terminate failed") });
    h.states.set("app/feature", { schemaVersion: 2, owner: "mpx", key: "app/feature", runId: "11111111-1111-4111-8111-111111111111", revision: 1, status: "preparing", execution: "background", createdAt: 1, updatedAt: 2, steps: [], worker: { pid: 77, startFingerprint: "worker-start", ownerToken: "worker-token" } });
    h.processFacts.set(77, { owner: "mpx", startFingerprint: "worker-start", ownerToken: "worker-token" });
    expect((await new PreparationEngine(h.adapters).cancel("app/feature")).status).toBe("unknown");
    expect(h.terminations).toEqual([]);
  });

  it("does not start a background worker with stale approval", async () => {
    const h = harness(); const p = plan([{ id: "run", uses: "executable", argv: ["tool"] }], "background");
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters);
    h.setEvidence({ configHash: "changed" });
    await expect(new PreparationEngine(h.adapters).prepare(request(p, approval))).rejects.toMatchObject({ code: "PREPARATION_APPROVAL_STALE" });
    expect(h.states.get("app/feature")?.worker).toBeUndefined();
  });

  it.each([
    ["ready", { exitCode: 0, output: "done" }],
    ["failed", { exitCode: 7, output: "failed" }],
  ] as const)("preserves cancellation when a deferred %s completion loses the CAS race", async (_outcome, result) => {
    const h = harness(); const completion = deferred<SpawnResult>();
    h.adapters.execution.spawn = async request => { await request.onStarted({ pid: 55, startFingerprint: "birth-55", ownerToken: "token-55" }); h.processFacts.set(55, { owner: "mpx", startFingerprint: "birth-55", ownerToken: "token-55" }); return completion.promise; };
    const p = plan([{ id: "run", uses: "executable", argv: ["tool"] }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters);
    const running = new PreparationEngine(h.adapters).prepare(request(p, approval));
    await expect.poll(() => h.states.get("app/feature")?.steps[0]?.process?.pid).toBe(55);
    const cancelled = await new PreparationEngine(h.secondAdapters).cancel("app/feature");
    completion.resolve(result); const completed = await running;
    expect(cancelled.status).toBe("cancelled"); expect(completed.status).toBe("cancelled");
    expect(h.states.get("app/feature")?.status).toBe("cancelled");
  });

  it("explicitly retries a failed run with a fresh log identity while preserving its diagnostics", async () => {
    const h = harness({ results: [{ exitCode: 2, output: "old diagnostics" }, { exitCode: 0, output: "fixed diagnostics" }] });
    const p = plan([{ id: "run", uses: "executable", argv: ["tool"] }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters);
    const engine = new PreparationEngine(h.adapters);
    const failed = await engine.prepare(request(p, approval));
    const oldLogPath = failed.steps[0]!.logPath!;
    expect(failed.status).toBe("failed");
    expect(h.logs.get(oldLogPath)).toBe("old diagnostics");

    const retried = await engine.retry(request(p, approval));
    const currentLogPath = retried.steps[0]!.logPath!;

    expect(retried.status).toBe("ready");
    expect(retried.runId).not.toBe(failed.runId);
    expect(currentLogPath).not.toBe(oldLogPath);
    expect(h.logs.get(oldLogPath)).toBe("old diagnostics");
    expect(h.logs.get(currentLogPath)).toBe("fixed diagnostics");
    expect(retried.previousRuns).toEqual([{ runId: failed.runId, status: "failed", execution: "foreground", createdAt: failed.createdAt, updatedAt: failed.updatedAt, finishedAt: failed.finishedAt, steps: failed.steps }]);
  });

  it("fails closed when explicit retry sees an unknown run", async () => {
    const h = harness(); const p = plan([{ id: "run", uses: "executable", argv: ["tool"] }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters);
    const unknown = persisted({ status: "unknown", finishedAt: 9 }); h.states.set("app/feature", unknown);

    await expect(new PreparationEngine(h.adapters).retry(request(p, approval))).rejects.toMatchObject({ code: "PREPARATION_RETRY_NOT_TERMINAL" });
    expect(h.states.get("app/feature")).toEqual(unknown);
    expect(h.spawns).toHaveLength(0);
  });

  it("rejects a worker resume when its exact run is absent and never recreates state", async () => {
    const h = harness(); const p = plan([{ id: "run", uses: "executable", argv: ["tool"] }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters);
    await expect(new PreparationEngine(h.adapters).resume({ ...request(p, approval), runId: "11111111-1111-4111-8111-111111111111" })).rejects.toMatchObject({ code: "PREPARATION_RUN_STALE" });
    expect(h.states.size).toBe(0); expect(h.spawns).toHaveLength(0);
  });

  it("prevents stale worker completion from overwriting an explicit retry", async () => {
    const h = harness(); const oldCompletion = deferred<SpawnResult>(); let invocation = 0;
    h.adapters.execution.spawn = async () => invocation++ === 0 ? oldCompletion.promise : { exitCode: 0, output: "retry" };
    const p = plan([{ id: "run", uses: "executable", argv: ["tool"] }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters);
    const oldRun = new PreparationEngine(h.adapters).prepare(request(p, approval));
    await expect.poll(() => h.states.get("app/feature")?.steps[0]?.status).toBe("preparing");
    const active = h.states.get("app/feature")!;
    h.states.set("app/feature", { ...structuredClone(active), revision: active.revision + 1, status: "failed", finishedAt: 20 });

    const retry = await new PreparationEngine(h.secondAdapters).retry(request(p, approval));
    oldCompletion.resolve({ exitCode: 0, output: "stale" });
    await oldRun;

    expect(h.states.get("app/feature")).toMatchObject({ runId: retry.runId, status: "ready" });
    expect(h.states.get("app/feature")?.previousRuns?.at(-1)?.runId).toBe(active.runId);
  });

  it("prevents a stale run completion from mutating replacement state", async () => {
    const h = harness(); const completion = deferred<SpawnResult>();
    h.adapters.execution.spawn = async () => completion.promise;
    const p = plan([{ id: "run", uses: "executable", argv: ["tool"] }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters);
    const running = new PreparationEngine(h.adapters).prepare(request(p, approval));
    await expect.poll(() => h.states.get("app/feature")?.steps[0]?.status).toBe("preparing");
    h.states.set("app/feature", persisted({ runId: "99999999-9999-4999-8999-999999999999", revision: 1, status: "cancelled", finishedAt: 10 }));
    completion.resolve({ exitCode: 0, output: "stale" });
    expect((await running).runId).toBe("99999999-9999-4999-8999-999999999999");
    expect(h.states.get("app/feature")).toMatchObject({ runId: "99999999-9999-4999-8999-999999999999", revision: 1, status: "cancelled" });
  });

  it("durably claims cancelling before terminating and finalizing cancellation", async () => {
    const h = harness(); const terminated = deferred<void>();
    h.states.set("app/feature", persisted({ worker: { pid: 77, startFingerprint: "birth-77", ownerToken: "token-77" } }));
    h.processFacts.set(77, { owner: "mpx", startFingerprint: "birth-77", ownerToken: "token-77" });
    h.adapters.process.terminateTree = async () => terminated.promise;
    const cancellation = new PreparationEngine(h.adapters).cancel("app/feature");
    await expect.poll(() => h.states.get("app/feature")?.status).toBe("cancelling");
    terminated.resolve(); expect((await cancellation).status).toBe("cancelled");
  });

  it("reconciles a stranded cancelling state to unknown in a fresh engine", async () => {
    const h = harness(); h.states.set("app/feature", persisted({ status: "cancelling" }));
    const state = await new PreparationEngine(h.secondAdapters).reconcile("app/feature");
    expect(state).toMatchObject({ status: "unknown", revision: 2 });
  });

  it.each([
    ["wrong marker owner", { owner: "other" as const, startFingerprint: "birth-77", ownerToken: "token-77" }],
    ["wrong owner token", { owner: "mpx" as const, startFingerprint: "birth-77", ownerToken: "wrong" }],
    ["reused PID", { owner: "mpx" as const, startFingerprint: "reused", ownerToken: "token-77" }],
  ])("does not kill a process with %s", async (_case, inspection) => {
    const h = harness(); h.states.set("app/feature", persisted({ worker: { pid: 77, startFingerprint: "birth-77", ownerToken: "token-77" } })); h.processFacts.set(77, inspection);
    expect((await new PreparationEngine(h.adapters).cancel("app/feature")).status).toBe("unknown");
    expect(h.terminations).toEqual([]);
  });

  it("returns background only after atomically persisting worker PID and start fingerprint", async () => {
    const h = harness({ worker: { pid: 91, startFingerprint: "birth-91", ownerToken: "worker-token-91" } }); const p = plan([{ id: "run", uses: "executable", argv: ["tool"] }], "background");
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters);
    const state = await new PreparationEngine(h.adapters).prepare(request(p, approval));
    expect(state.status).toBe("preparing"); expect(h.states.get("app/feature")?.worker).toEqual({ pid: 91, startFingerprint: "birth-91", ownerToken: "worker-token-91" });
  });

  it("continues finalization through more than three CAS conflicts for the same preparing run", async () => {
    const h = harness(); const p = plan([{ id: "run", uses: "executable", argv: ["tool"] }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters);
    h.adapters.execution.spawn = async () => { throw new Error("spawn rejected"); };
    const originalCompareAndSwap = h.adapters.store.compareAndSwap;
    let conflicts = 4;
    h.adapters.store.compareAndSwap = async (key, expectedRevision, next, revalidate) => {
      if (expectedRevision !== undefined && conflicts > 0) {
        conflicts -= 1;
        const current = h.states.get(key)!;
        h.states.set(key, { ...structuredClone(current), revision: current.revision + 1 });
        return false;
      }
      return originalCompareAndSwap(key, expectedRevision, next, revalidate);
    };
    await expect(new PreparationEngine(h.adapters).prepare(request(p, approval))).rejects.toThrow("spawn rejected");
    expect(conflicts).toBe(0);
    expect(h.states.get("app/feature")).toMatchObject({ status: "failed", steps: [{ status: "failed", failure: "execution" }] });
  });

  it.each(["spawn", "log"] as const)("finalizes a run when the %s adapter rejects after CAS creation", async kind => {
    const h = harness(); const p = plan([{ id: "run", uses: "executable", argv: ["tool"] }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters);
    if (kind === "spawn") h.adapters.execution.spawn = async () => { throw new Error("spawn rejected"); };
    else h.adapters.store.writeLogAtomic = async () => { throw new Error("log rejected"); };
    await expect(new PreparationEngine(h.adapters).prepare(request(p, approval))).rejects.toThrow(`${kind} rejected`);
    expect(h.states.get("app/feature")).toMatchObject({ status: "failed", steps: [{ status: "failed", failure: "execution" }] });
  });

  it("keeps an unknown timeout unknown when secondary termination cannot be verified", async () => {
    const h = harness({ results: [{ exitCode: null, output: "hung", timedOut: true, pid: 44, startFingerprint: "start-44", terminationState: "unknown" }] });
    h.adapters.process.terminateTree = async () => undefined;
    const p = plan([{ id: "run", uses: "executable", argv: ["tool"], timeoutSeconds: 1 }]);
    const approval = await createPreparationApproval({ plan: p, worktreeRoot: root, packageManager: "pnpm", environment: {} }, h.adapters);
    const engine = new PreparationEngine(h.adapters);
    const state = await engine.prepare(request(p, approval));
    expect(state).toMatchObject({ status: "unknown", steps: [{ status: "unknown", terminationState: "unknown", process: { pid: 44 } }] });
    await expect(engine.retry(request(p, approval))).rejects.toMatchObject({ code: "PREPARATION_RETRY_NOT_TERMINAL" });
    await expect(engine.cancel("app/feature")).resolves.toMatchObject({ status: "unknown" });
  });
});
