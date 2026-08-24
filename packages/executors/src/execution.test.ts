import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sha256Canonical } from "@mpx/core";
import type { JsonValue } from "@mpx/core";
import type { LaunchDescriptor } from "@mpx/launch";
import type { ProcessRequest } from "./index.js";
import { ExecutorRegistry, ExecutionService, FileLaunchAuditStore, HostApprovalStore, RuntimeAdapterRegistry, compactLaunchBanner, createLaunchExecutionAudit, invokeBoundedProcess, locateTrustedExecutable, materializePrivateRoutes, sanitizedEnvironment, sanitizeHostReason, type LaunchAuditRecord, type LaunchAuditStore } from "./index.js";

const hash = (value: string) => value.repeat(64);
const artifactReference = (runtime: "claude" | "pi" = "pi") => ({ schemaVersion: 4 as const, runtime, manifestKey: hash("7"), artifactKey: hash("8"), fileMapHash: hash("9") });
function descriptor(executor: "docker" | "host" = "docker"): LaunchDescriptor {
  const tuple = {
    schemaVersion: 2 as const, nativeRuntimeRootDigest: hash("a"), runtime: "pi" as const,
    binding: { projectId: "sample/app", repositoryId: "sample/repo" }, identity: { name: "personal", domain: "personal" }, mode: "project", skillPolicy: "clean",
    executor: executor === "docker" ? { name: "docker" as const, effectiveEnforcement: "mount-enforced" as const, isolation: "container" as const, interception: { kind: "container-boundary" as const, intercepted: ["container-filesystem", "declared-mounts"] as const, knownBypasses: ["host-services", "direct-extra-mounts"] as const }, mounts: { kind: "explicit" as const, policyEnforced: true as const }, confidentiality: { isolated: "mount-dependent" as const, hostReadable: true as const, limitation: "Mounted content, host services, and direct extra mounts remain confidentiality limitations." as const }, availability: "available" as const } : { name: "host" as const, effectiveEnforcement: "advisory" as const, isolation: "none" as const, interception: { kind: "policy-hooks" as const, intercepted: ["mpx-mediated-operations"] as const, knownBypasses: ["raw-shell", "direct-filesystem", "unmanaged-children"] as const }, mounts: { kind: "host-direct" as const, policyEnforced: false as const }, confidentiality: { isolated: false as const, hostReadable: true as const, limitation: "No filesystem or confidentiality isolation is enforced." as const } },
    executorVerification: { status: "verified" as const, verifier: "fixture", evidenceDigest: hash("b") }, workspace: "direct" as const,
    networkPolicy: { name: "minimal", declaration: { preset: "deny-all" as const } }, preset: null,
    provenance: { runtime: "explicit" as const, identity: "explicit" as const, mode: "explicit" as const, skillPolicy: "explicit" as const, contentScope: "explicit" as const, executor: "explicit" as const, workspace: "explicit" as const, networkPolicy: "explicit" as const }, diagnostics: [], contentScope: { name: "personal" }, grants: [], cwdClassification: { domain: "personal", contentScope: "personal" },
    routes: { gitAuthor: "git-personal", providers: { github: "gh-personal" }, ssh: "ssh-personal", mcp: { allow: [], shareNativeAuth: false as const } },
    intendedPolicy: { mode: "project", resources: { "selected-project": "read-write" as const }, grants: [], inputsDigest: hash("c"), approvalsDigest: hash("d") },
    skillArtifact: { schemaVersion: 3 as const, runtime: "pi" as const, identity: "personal", skillPolicy: "clean", contentScope: "personal", projectId: "sample/app", catalogHash: hash("1"), enabledPacks: [], skillPolicyConfigHash: hash("2"), contentScopeExposureHash: hash("3"), projectExposureHash: hash("4"), effectivePolicyHash: hash("5"), artifactKey: hash("6") },
    elevationAudit: { elevated: executor === "host", reason: executor === "host" ? "Legacy tool" : null, approvalsDigest: hash("d"), banner: executor === "host" ? { code: "ELEVATED_LAUNCH" as const, persistent: true as const, message: "ELEVATED LAUNCH — host-compatibility — Legacy tool" } : null },
  };
  return { ...tuple, launchKey: sha256Canonical(tuple as unknown as JsonValue) } as LaunchDescriptor;
}

function descriptorWithNativeRoot(runtime: "claude" | "pi", identity: "personal" | "work", root: string): LaunchDescriptor {
  const base = descriptor();
  const tuple = {
    ...base,
    runtime,
    identity: { name: identity, domain: identity },
    nativeRuntimeRootDigest: sha256Canonical(root.replaceAll("\\", "/").toLowerCase().replace(/\/$/u, "")),
  };
  const { launchKey: _discarded, ...identityTuple } = tuple;
  return { ...identityTuple, launchKey: sha256Canonical(identityTuple as unknown as JsonValue) } as LaunchDescriptor;
}

function routesFor(value: LaunchDescriptor): Readonly<Record<string, string>> {
  return {
    [`git:${value.routes.gitAuthor}`]: `C:/state/routes/git/${value.routes.gitAuthor}`,
    ...Object.fromEntries(Object.entries(value.routes.providers).map(([provider, label]) => [`provider-${provider}:${label}`, `C:/state/routes/provider/${provider}/${label}`])),
    ...(value.routes.ssh ? { [`ssh:${value.routes.ssh}`]: `C:/state/routes/ssh/${value.routes.ssh}` } : {}),
    ...Object.fromEntries(value.routes.mcp.allow.map((label) => [`mcp:${label}`, `C:/state/routes/mcp/${label}`])),
  };
}
function service(verification: "verified" | "unverified" | "unavailable", effects: string[]) {
  const executors = new ExecutorRegistry();
  executors.register({ name: "docker", verify: async () => ({ status: verification, verifier: "fake", evidenceDigest: hash("e") }), execute: async (request) => { effects.push(`process:${request.executable}`); return { exitCode: 0, stdout: "ok", stderr: "", truncated: false }; } });
  const runtimes = new RuntimeAdapterRegistry();
  runtimes.register({ runtime: "pi", prepare: async () => ({ executable: "C:/trusted/node.exe", argv: ["C:/trusted/pi.mjs"], environment: { MPX_LAUNCH_KEY: "bound" } }) });
  return new ExecutionService({ executors, runtimes, routes: { materialize: async (value) => { effects.push("routes"); return routesFor(value); } }, production: true });
}

describe("execution gates", () => {
  it("executes verified fake Docker through routes, runtime adapter, and executor", async () => {
    const effects: string[] = [];
    await expect(service("verified", effects).execute({ artifact: artifactReference(), descriptor: descriptor(), cwd: "C:/project", environment: {} })).resolves.toMatchObject({ exitCode: 0 });
    expect(effects).toEqual(["routes", "process:C:/trusted/node.exe"]);
  });

  it("returns structured Docker gate errors without host fallback or side effects", async () => {
    for (const [status, code] of [["unverified", "EXECUTOR_GATE_UNVERIFIED"], ["unavailable", "EXECUTOR_UNAVAILABLE"]] as const) {
      const effects: string[] = [];
      await expect(service(status, effects).execute({ artifact: artifactReference(), descriptor: descriptor(), cwd: "C:/project", environment: {} })).rejects.toMatchObject({ code, details: { executor: "docker" } });
      expect(effects).toEqual([]);
    }
  });

  it("rejects non-TTY host execution before route or process access and binds one approval to the exact request", async () => {
    const effects: string[] = []; const approvals = new HostApprovalStore();
    const hostDescriptor = descriptor("host");
    const executors = new ExecutorRegistry(); executors.register({ name: "host", verify: async () => ({ status: "verified", verifier: "host", evidenceDigest: hash("e") }), execute: async () => { effects.push("process"); return { exitCode: 0, stdout: "", stderr: "", truncated: false }; } });
    const runtimes = new RuntimeAdapterRegistry(); runtimes.register({ runtime: "pi", prepare: async () => { effects.push("runtime"); return { executable: "C:/trusted/pi.exe", argv: [], environment: {} }; } });
    const execution = new ExecutionService({ executors, runtimes, approvals, routes: { materialize: async (value) => { effects.push("routes"); return routesFor(value); } }, production: true });
    await expect(execution.execute({ artifact: artifactReference(), descriptor: hostDescriptor, cwd: "C:/project", environment: {}, tty: { direct: false, confirm: vi.fn() } })).rejects.toMatchObject({ code: "HOST_TTY_REQUIRED" });
    expect(effects).toEqual([]);
    const request = execution.hostApprovalRequest({ descriptor: hostDescriptor, cwd: "C:/project", environment: {} }, "nonce-1");
    const approval = await approvals.approve(request, { direct: true, confirm: async () => true });
    await expect(execution.execute({ artifact: artifactReference(), descriptor: hostDescriptor, cwd: "C:/other", environment: {}, hostApproval: approval, tty: { direct: true, confirm: async () => true } })).rejects.toMatchObject({ code: "HOST_APPROVAL_MISMATCH" });
    expect(effects).toEqual([]);
  });
});

describe("trust and privacy boundaries", () => {
  it("locates only trusted absolute executables and Node entries, rejecting project wrappers and mpx shims", async () => {
    const inspect = async (file: string) => ({ file: true, realpath: file, content: file.endsWith("mpx") ? "#!/bin/sh\nmpx pi" : "" });
    await expect(locateTrustedExecutable({ candidates: ["C:/project/node_modules/.bin/pi.cmd", "C:/trusted/mpx", "C:/trusted/pi.mjs"], projectRoot: "C:/project", trustedRoots: ["C:/trusted"], nodeExecutable: "C:/trusted/node.exe", inspect })).resolves.toEqual({ executable: "C:/trusted/node.exe", argvPrefix: ["C:/trusted/pi.mjs"] });
    await expect(locateTrustedExecutable({ candidates: ["pi"], projectRoot: "C:/project", trustedRoots: ["C:/trusted"], nodeExecutable: "C:/trusted/node.exe", inspect })).rejects.toMatchObject({ code: "TRUSTED_EXECUTABLE_NOT_FOUND" });
  });

  it("fails closed on unknown private routes and exposes only state-local materialized paths", async () => {
    const writes: string[] = [];
    await expect(materializePrivateRoutes(descriptor(), { stateRoot: "C:/Users/me/.mpx", known: { "git:git-personal": "private" }, write: async (target) => { writes.push(target); } })).rejects.toMatchObject({ code: "PRIVATE_ROUTE_UNKNOWN" });
    expect(writes).toEqual([]);
  });

  it("sanitizes host reasons and launch audits without leaking raw paths or tokens", async () => {
    const reason = "Need C:/private/repo token=abc123 for restart";
    expect(sanitizeHostReason(reason)).toContain("[path]");
    expect(sanitizeHostReason(reason)).toContain("token=[redacted]");
    expect(sanitizeHostReason(reason)).not.toContain("C:/private/repo");
    expect(sanitizeHostReason(reason)).not.toContain("abc123");

    const approvals = new HostApprovalStore();
    const execution = new ExecutionService({ executors: new ExecutorRegistry(), runtimes: new RuntimeAdapterRegistry(), routes: { materialize: async () => ({}) }, approvals, production: false });
    const hostDescriptor = descriptor("host");
    const sanitizedReason = sanitizeHostReason(reason);
    const descriptorTuple = { ...hostDescriptor, elevationAudit: { ...hostDescriptor.elevationAudit, reason: sanitizedReason } } as const;
    const { launchKey: _discardedLaunchKey, ...descriptorIdentity } = descriptorTuple;
    const descriptorReason = { ...descriptorIdentity, launchKey: sha256Canonical(descriptorIdentity as unknown as JsonValue) } as LaunchDescriptor;
    const request = execution.hostApprovalRequest({ descriptor: descriptorReason, cwd: "C:/project", environment: {} }, "nonce-1");
    expect(request.reason).toBe(sanitizedReason);
    expect(request.reason).not.toContain("C:/private/repo");
    expect(request.reason).not.toContain("abc123");
    expect(JSON.stringify(createLaunchExecutionAudit(descriptorReason, { started: true }))).not.toContain("C:/private/repo");
    expect(JSON.stringify(createLaunchExecutionAudit(descriptorReason, { started: true }))).not.toContain("abc123");
  });

  it("rejects missing private routes before runtime preparation or process execution", async () => {
    const effects: string[] = [];
    const executors = new ExecutorRegistry();
    executors.register({ name: "docker", verify: async () => ({ status: "verified", verifier: "fixture", evidenceDigest: hash("e") }), execute: async () => { effects.push("process"); return { exitCode: 0, stdout: "", stderr: "", truncated: false }; } });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({ runtime: "pi", prepare: async () => { effects.push("runtime"); return { executable: "C:/trusted/pi.exe", argv: [], environment: {} }; } });
    const execution = new ExecutionService({ executors, runtimes, routes: { materialize: async () => ({}) }, production: true });

    await expect(execution.execute({ artifact: artifactReference(), descriptor: descriptor(), cwd: "C:/project", environment: {} })).rejects.toMatchObject({ code: "PRIVATE_ROUTE_MISSING" });
    expect(effects).toEqual([]);
  });

  it("rejects unsafe private-route paths before runtime preparation or process execution", async () => {
    const effects: string[] = [];
    const executors = new ExecutorRegistry();
    executors.register({ name: "docker", verify: async () => ({ status: "verified", verifier: "fixture", evidenceDigest: hash("e") }), execute: async () => { effects.push("process"); return { exitCode: 0, stdout: "", stderr: "", truncated: false }; } });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({ runtime: "pi", prepare: async () => { effects.push("runtime"); return { executable: "C:/trusted/pi.exe", argv: [], environment: {} }; } });
    const execution = new ExecutionService({ executors, runtimes, routes: { materialize: async () => ({ ...routesFor(descriptor()), "git:git-personal": "relative/path" }) }, production: true });

    await expect(execution.execute({ artifact: artifactReference(), descriptor: descriptor(), cwd: "C:/project", environment: {} })).rejects.toMatchObject({ code: "PRIVATE_ROUTE_PATH_INVALID" });
    expect(effects).toEqual([]);
  });

  it("fails unsupported MCP routes before child execution", async () => {
    const selected = descriptor();
    const tuple = { ...selected, routes: { ...selected.routes, mcp: { allow: ["context7"], shareNativeAuth: false as const } } };
    const { launchKey: _old, ...body } = tuple;
    const rebound = { ...body, launchKey: sha256Canonical(body as unknown as JsonValue) } as LaunchDescriptor;
    const effects: string[] = [];
    const executors = new ExecutorRegistry();
    executors.register({ name: "docker", verify: async () => ({ status: "verified", verifier: "fixture", evidenceDigest: hash("e") }), execute: async () => { effects.push("process"); return { exitCode: 0, stdout: "", stderr: "", truncated: false }; } });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({ runtime: "pi", prepare: async () => ({ executable: "C:/trusted/pi.exe", argv: [], environment: {} }) });
    const execution = new ExecutionService({ executors, runtimes, routes: { materialize: async () => routesFor(rebound) } });
    await expect(execution.execute({ descriptor: rebound, artifact: artifactReference(), cwd: "C:/project", environment: {} })).rejects.toMatchObject({ code: "PRIVATE_ROUTE_CONSUMER_UNAVAILABLE" });
    expect(effects).toEqual([]);
  });

  it("scrubs secrets while preserving only allowlisted OS, terminal, launch-context, and root variables", () => {
    expect(sanitizedEnvironment({ PATH: "safe", TERM: "xterm", HOME: "C:/home", MPX_LAUNCH_KEY: "key", CLAUDE_CONFIG_DIR: "C:/ambient/claude", PI_CODING_AGENT_DIR: "C:/ambient/pi", TOKEN: "secret", API_KEY: "secret", APPROVAL_NONCE: "secret", RANDOM: "drop" }, { MPX_RUNTIME_ROOT: "C:/state/runtime", CLAUDE_CONFIG_DIR: "C:/adapter/claude", PI_CODING_AGENT_DIR: "C:/adapter/pi" })).toEqual({ PATH: "safe", TERM: "xterm", HOME: "C:/home", MPX_LAUNCH_KEY: "key", MPX_RUNTIME_ROOT: "C:/state/runtime" });
  });

  it.each([
    ["claude", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR"],
    ["pi", "PI_CODING_AGENT_DIR", "CLAUDE_CONFIG_DIR"],
  ] as const)("passes the selected %s native root only through its private child environment channel", async (runtime, selectedVariable, otherVariable) => {
    const root = `C:/accounts/personal/${runtime}`;
    const selectedDescriptor = descriptorWithNativeRoot(runtime, "personal", root);
    const requests: ProcessRequest[] = [];
    const prepareInputs: unknown[] = [];
    const routeMap = routesFor(selectedDescriptor);
    const executors = new ExecutorRegistry();
    executors.register({ name: "docker", verify: async () => ({ status: "verified", verifier: "fixture", evidenceDigest: hash("e") }), execute: async (request) => { requests.push(request); return { exitCode: 0, stdout: "", stderr: "", truncated: false }; } });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({ runtime, prepare: async (input) => { prepareInputs.push(input); return { executable: "C:/trusted/runtime.exe", argv: ["--safe"], environment: { [selectedVariable]: "C:/adapter-controlled", [otherVariable]: "C:/crossed", TOKEN: "secret", ARBITRARY: "drop" } }; } });
    const execution = new ExecutionService({ executors, runtimes, routes: { materialize: async () => routeMap }, production: true });

    await execution.execute({
      artifact: artifactReference(runtime),
      descriptor: selectedDescriptor,
      cwd: "C:/project",
      environment: { [selectedVariable]: "C:/ambient", [otherVariable]: "C:/ambient-crossed", TOKEN: "ambient-secret", APPROVAL_KEY: "ambient-approval", RANDOM: "drop" },
      privateLaunch: { launchKey: selectedDescriptor.launchKey, runtime, identity: selectedDescriptor.identity, nativeRuntimeRoot: root },
    });

    expect(requests[0]?.environment).toEqual(expect.objectContaining({ [selectedVariable]: root }));
    expect(requests[0]?.environment).toEqual(expect.objectContaining(runtime === "claude"
      ? { MPX_RUNTIME_ROUTE_GIT_AUTHOR: "C:/state/routes/git/git-personal", MPX_RUNTIME_ROUTE_PROVIDER_GITHUB: "C:/state/routes/provider/github/gh-personal" }
      : { MPX_RUNTIME_ROUTE_GIT_AUTHOR: "C:/state/routes/git/git-personal", MPX_RUNTIME_ROUTE_PROVIDER_GITHUB: "C:/state/routes/provider/github/gh-personal" }));
    expect(requests[0]?.environment).toMatchObject({ GIT_CONFIG_GLOBAL: "C:/state/routes/git/git-personal/gitconfig", GH_CONFIG_DIR: "C:/state/routes/provider/github/gh-personal", GIT_SSH_COMMAND: 'ssh -F "C:/state/routes/ssh/ssh-personal/config"' });
    expect(JSON.stringify(prepareInputs)).not.toContain(root);
  });

  it("rejects a work native root bound to a personal descriptor before side effects without disclosing either root", async () => {
    const personalRoot = "C:/accounts/personal/pi";
    const workRoot = "C:/accounts/work/pi";
    const selectedDescriptor = descriptorWithNativeRoot("pi", "personal", personalRoot);
    const effects: string[] = [];
    const executors = new ExecutorRegistry();
    executors.register({ name: "docker", verify: async () => { effects.push("verify"); return { status: "verified", verifier: "fixture", evidenceDigest: hash("e") }; }, execute: async () => { effects.push("process"); return { exitCode: 0, stdout: "", stderr: "", truncated: false }; } });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({ runtime: "pi", prepare: async () => { effects.push("runtime"); return { executable: "C:/trusted/pi.exe", argv: [], environment: {} }; } });
    const execution = new ExecutionService({ executors, runtimes, routes: { materialize: async () => { effects.push("routes"); return {}; } }, production: true });

    const error = await execution.execute({ artifact: artifactReference(), descriptor: selectedDescriptor, cwd: "C:/project", environment: {}, privateLaunch: { launchKey: selectedDescriptor.launchKey, runtime: "pi", identity: { name: "work", domain: "work" }, nativeRuntimeRoot: workRoot } }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "PRIVATE_LAUNCH_BINDING_MISMATCH" });
    expect(effects).toEqual([]);
    expect(JSON.stringify({ descriptor: selectedDescriptor, banner: compactLaunchBanner(selectedDescriptor), audit: createLaunchExecutionAudit(selectedDescriptor, { started: false, errorCode: error.code }), error })).not.toMatch(/accounts[\\/](?:personal|work)/u);
  });

  it("invokes argv-only processes with hard bounds and emits a compact immutable audit", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", truncated: false }));
    await invokeBoundedProcess({ run }, { executable: "C:/trusted/pi.exe", argv: ["--version"], cwd: "C:/project", environment: {}, timeoutMs: 999_999, maxOutputBytes: 9_999_999 });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ shell: false, timeoutMs: 300_000, maxOutputBytes: 1_048_576, argv: ["--version"] }));
    const audit = createLaunchExecutionAudit(descriptor("host"), { started: false, errorCode: "EXECUTOR_UNAVAILABLE" });
    expect(audit).toMatchObject({ schemaVersion: 1, executor: "host", outcome: "failed", errorCode: "EXECUTOR_UNAVAILABLE" });
    expect(JSON.stringify(audit)).not.toMatch(/nonce|C:\\/u);
    expect(Object.isFrozen(audit)).toBe(true);
  });
});

describe("persistent launch audit sequencing", () => {
  function auditedExecution(audit: LaunchAuditStore, effects: string[], process: () => Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean }> = async () => ({ exitCode: 0, stdout: "ok", stderr: "", truncated: false })) {
    const executors = new ExecutorRegistry();
    executors.register({ name: "docker", verify: async () => ({ status: "verified", verifier: "fixture", evidenceDigest: hash("e") }), execute: async () => { effects.push("process"); return process(); } });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({ runtime: "pi", prepare: async () => ({ executable: "C:/trusted/pi.exe", argv: [], environment: {} }) });
    return new ExecutionService({ executors, runtimes, routes: { materialize: async value => routesFor(value) }, audit, production: true });
  }

  it("persists a bounded sanitized start record before process execution", async () => {
    const effects: string[] = []; const records: LaunchAuditRecord[] = [];
    const audit: LaunchAuditStore = { start: async record => { effects.push("audit:start"); records.push(record); return "attempt"; }, terminal: async () => undefined };
    await auditedExecution(audit, effects).execute({ artifact: artifactReference(), descriptor: descriptor(), cwd: "C:/secret/project", environment: { TOKEN: "secret" }, approvalNonce: "nonce" });
    expect(effects).toEqual(["audit:start", "process"]);
    expect(records[0]).toMatchObject({ phase: "start", launchKey: descriptor().launchKey, manifestKey: artifactReference().manifestKey, artifactKey: artifactReference().artifactKey, fileMapHash: artifactReference().fileMapHash, runtime: "pi", identity: "personal" });
    expect(JSON.stringify(records[0])).not.toMatch(/secret|TOKEN|nonce|cwd|environment|native/iu);
  });

  it("persists a terminal success result after exactly one process mutation", async () => {
    const effects: string[] = []; const records: LaunchAuditRecord[] = [];
    const audit: LaunchAuditStore = { start: async record => { records.push(record); return "attempt"; }, terminal: async (_attempt, record) => { effects.push("audit:terminal"); records.push(record); } };
    await auditedExecution(audit, effects).execute({ artifact: artifactReference(), descriptor: descriptor(), cwd: "C:/project", environment: {} });
    expect(effects).toEqual(["process", "audit:terminal"]);
    expect(records[1]).toMatchObject({ phase: "terminal", outcome: "result", exitCode: 0, truncated: false });
  });

  it("persists a sanitized terminal failure after a process error", async () => {
    const records: LaunchAuditRecord[] = [];
    const audit: LaunchAuditStore = { start: async () => "attempt", terminal: async (_attempt, record) => { records.push(record); } };
    await expect(auditedExecution(audit, [], async () => { throw Object.assign(new Error("token=secret C:/private"), { code: "SPAWN_FAILED" }); }).execute({ artifact: artifactReference(), descriptor: descriptor(), cwd: "C:/project", environment: {} })).rejects.toMatchObject({ code: "SPAWN_FAILED" });
    expect(records[0]).toMatchObject({ phase: "terminal", outcome: "failure", errorCode: "SPAWN_FAILED" });
    expect(JSON.stringify(records[0])).not.toMatch(/secret|private/iu);
  });

  it("audits a runtime artifact preparation failure after route trust succeeds", async () => {
    const records: LaunchAuditRecord[] = [];
    const audit: LaunchAuditStore = { start: async record => { records.push(record); return "attempt"; }, terminal: async (_attempt, record) => { records.push(record); } };
    const executors = new ExecutorRegistry();
    executors.register({ name: "docker", verify: async () => ({ status: "verified", verifier: "fixture", evidenceDigest: hash("e") }), execute: async () => { throw new Error("must not execute"); } });
    const runtimes = new RuntimeAdapterRegistry();
    runtimes.register({ runtime: "pi", prepare: async () => { throw Object.assign(new Error("private artifact path"), { code: "ARTIFACT_INVALID" }); } });
    const execution = new ExecutionService({ executors, runtimes, routes: { materialize: async value => routesFor(value) }, audit, production: true });
    await expect(execution.execute({ artifact: artifactReference(), descriptor: descriptor(), cwd: "C:/project", environment: {} })).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    expect(records.map(record => record.phase)).toEqual(["start", "terminal"]);
    expect(records[1]).toMatchObject({ outcome: "failure", errorCode: "ARTIFACT_INVALID" });
  });

  it("fails closed before process execution when the start audit cannot be persisted", async () => {
    const effects: string[] = [];
    const audit: LaunchAuditStore = { start: async () => { throw new Error("disk unavailable C:/private"); }, terminal: async () => undefined };
    await expect(auditedExecution(audit, effects).execute({ artifact: artifactReference(), descriptor: descriptor(), cwd: "C:/project", environment: {} })).rejects.toMatchObject({ code: "AUDIT_START_WRITE_FAILED" });
    expect(effects).toEqual([]);
  });

  it("does not retry process mutation or disclose details when terminal persistence is ambiguous", async () => {
    const effects: string[] = [];
    const audit: LaunchAuditStore = { start: async () => "attempt", terminal: async () => { throw new Error("ambiguous C:/private token=secret"); } };
    const error = await auditedExecution(audit, effects).execute({ artifact: artifactReference(), descriptor: descriptor(), cwd: "C:/project", environment: {} }).catch(reason => reason);
    expect(error).toMatchObject({ code: "AUDIT_TERMINAL_WRITE_FAILED" });
    expect(JSON.stringify(error)).not.toMatch(/private|secret/iu);
    expect(effects).toEqual(["process"]);
  });

  it("does not write audits before descriptor and trust validation", async () => {
    const writes = vi.fn();
    const audit: LaunchAuditStore = { start: writes, terminal: writes };
    const malformed = { ...descriptor(), launchKey: "0".repeat(64) } as LaunchDescriptor;
    await expect(auditedExecution(audit, []).execute({ artifact: artifactReference(), descriptor: malformed, cwd: "C:/project", environment: {} })).rejects.toBeDefined();
    expect(writes).not.toHaveBeenCalled();
  });

  it("persists immutable exclusive production records under an injectable local root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-audit-"));
    try {
      const store = new FileLaunchAuditStore(root);
      const start = { schemaVersion: 1 as const, phase: "start" as const, launchKey: "a".repeat(64), runtime: "pi" as const, executor: "docker" as const, identity: "work", identityDomain: "work", mode: "project", contentScope: "work", projectId: "sample/app", repositoryId: "sample/repo", manifestKey: "c".repeat(64), artifactKey: "b".repeat(64), fileMapHash: "d".repeat(64), elevated: false, reason: null };
      const attempt = await store.start(start);
      const terminal = { schemaVersion: 1 as const, phase: "terminal" as const, launchKey: start.launchKey, outcome: "result" as const, exitCode: 0, truncated: false, errorCode: null };
      await store.terminal(attempt, terminal);
      await expect(store.terminal(attempt, terminal)).rejects.toMatchObject({ code: "EEXIST" });
      const directory = path.join(root, "launch-audits", "aa", start.launchKey);
      const files = await readdir(directory);
      expect(files).toHaveLength(2);
      expect(await Promise.all(files.map(file => readFile(path.join(directory, file), "utf8")))).toEqual(expect.arrayContaining([`${JSON.stringify(start)}\n`, `${JSON.stringify(terminal)}\n`]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
