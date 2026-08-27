import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ExecutionError, compactLaunchBanner, createLaunchExecutionAudit, type ExecutorAdapter, type RuntimeAdapter } from "@mpx/executors";
import { sha256Canonical, type JsonValue } from "@mpx/core";
import { canonicalNativeRootDigest, type LaunchDescriptor } from "@mpx/launch";
import { createSessionLifecycleBindingV1, revalidateRuntimeArtifact } from "@mpx/runtime-contracts";
import { SessionService, SessionStore, type SessionRecordV1 } from "@mpx/sessions";
import { run as runCli } from "./main.js";
import { captureIo } from "./io.js";
import { NodeLaunchStatusSnapshotMaterializer, resolveLaunchStatusSnapshotPath, resolveTrustedRuntimeExecutable, runWithLifecycleConsumption, type LaunchExecutionContext } from "./launch-execution.js";
import { NodePrivateRouteMaterializer, defaultContext } from "./context.js";

function run(...[argv, io, context]: Parameters<typeof runCli>): ReturnType<typeof runCli> {
  const rootAttestationService = { verify: async (identity: { domain: string; name: string }) => ({ schemaVersion: 1 as const, ref: `test-${identity.name}`, identity, runtime: "pi" as const, rootDigest: "a".repeat(64), mode: "root-attested" as const, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }) };
  return runCli(argv, io, { rootAttestationService: rootAttestationService as never, accountAuthVerifier: { verify: async () => undefined }, ...context, env: context?.env ?? process.env });
}

async function launchFixture(): Promise<{ cwd: string; env: NodeJS.ProcessEnv; catalogRoot: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "mpx-cli-launch-f-"));
  await mkdir(path.join(cwd, ".git"));
  await writeFile(path.join(cwd, "mpxconfig.json"), JSON.stringify({ schemaVersion: 1, project: { id: "sample/app" }, repository: { provider: "generic", remote: "origin" } }));
  const appdata = await mkdtemp(path.join(tmpdir(), "mpx-cli-launch-appdata-"));
  await mkdir(path.join(appdata, "mpx"));
  const identity = (name: string) => ({ domain: "work", runtimeRoots: { claude: `C:/native/${name}/claude`, pi: `C:/native/${name}/pi` }, gitAuthorRoute: `git-${name}` });
  await writeFile(path.join(appdata, "mpx", "config.json"), JSON.stringify({
    identities: { personal: identity("personal"), work: identity("work") },
    domains: { work: [cwd] }, contentScopes: { work: { roots: [cwd], skillPacks: ["core"] } },
    modes: { project: { resources: { "selected-project": "read-write" } } },
    skillPolicies: { clean: { skillExposure: { default: "explicit-only" } } },
    presets: { "work-project": { identity: "work", mode: "project", skillPolicy: "clean", contentScope: "work", executor: "docker", workspace: "clone", networkPolicy: "implementation" } },
    launchDefaults: { projects: { "sample/app": { work: "work-project" } }, scopes: { work: { work: "work-project" } } },
    networkPolicies: { implementation: { preset: "balanced" } }, executors: { host: {}, docker: {} },
  }));
  return { cwd, env: { APPDATA: appdata, LOCALAPPDATA: appdata }, catalogRoot: fileURLToPath(new URL("../../../packages/skills/test/fixtures/catalog", import.meta.url)) };
}

function publishedReference(input: Parameters<NonNullable<LaunchExecutionContext["launchProjectionBuilder"]>>[0]) {
  return { projectionKey: "f".repeat(64), fileMapHash: "e".repeat(64), launchBinding: { launchKey: input.runtimeContext.launchKey, descriptorDigest: input.runtimeContext.launchDescriptor.digest, runtimeArtifactKey: input.artifact.reference.artifactKey, runtime: input.descriptor.runtime, manifestKey: input.manifest.manifestKey } };
}
function materializeRoutes(descriptor: { routes: { gitAuthor: string; providers: Record<string, string>; ssh?: string | null; mcp: { allow: readonly string[] } } }) {
  return {
    [`git:${descriptor.routes.gitAuthor}`]: `C:/state/routes/git/${descriptor.routes.gitAuthor}`,
    ...Object.fromEntries(Object.entries(descriptor.routes.providers).map(([provider, label]) => [`provider-${provider}:${label}`, `C:/state/routes/provider/${provider}/${label}`])),
    ...(descriptor.routes.ssh ? { [`ssh:${descriptor.routes.ssh}`]: `C:/state/routes/ssh/${descriptor.routes.ssh}` } : {}),
    ...Object.fromEntries(descriptor.routes.mcp.allow.map((label) => [`mcp:${label}`, `C:/state/routes/mcp/${label}`])),
  };
}
function verifiedExecution() {
  const execute = vi.fn(async (_request:Parameters<ExecutorAdapter["execute"]>[0]) => ({ exitCode: 0, stdout: "", stderr: "", truncated: false }));
  const executor: ExecutorAdapter = { name: "docker", verify: async () => ({ status: "verified", verifier: "fake-docker", evidenceDigest: "a".repeat(64) }), execute };
  const prepare = vi.fn(async (_input: Parameters<RuntimeAdapter["prepare"]>[0]) => ({ executable: "C:/trusted/pi.exe", argv: [], environment: {} }));
  const pi: RuntimeAdapter = { runtime: "pi", prepare };
  const claude: RuntimeAdapter = { runtime: "claude", prepare };
  const context:LaunchExecutionContext={ launchExecutorAdapters: [executor], launchRuntimeAdapters: [pi, claude], launchRoutes: { materialize: async (descriptor) => materializeRoutes(descriptor) } };
  return { execute, prepare, context };
}

async function explainedDescriptor(fixture: Awaited<ReturnType<typeof launchFixture>>, identity: "personal" | "work" = "work"): Promise<LaunchDescriptor> {
  const io = captureIo();
  expect(await run(["--json", "--cwd", fixture.cwd, "launch", "explain", "--runtime", "pi", "--identity", identity], io, { env: fixture.env, catalogRoot: fixture.catalogRoot })).toBe(0);
  return JSON.parse(io.out[0]!).data as LaunchDescriptor;
}
async function configurePiRoot(fixture: Awaited<ReturnType<typeof launchFixture>>, root: string): Promise<void> {
  fixture.env.MPX_PI_EXECUTABLE = process.execPath;
  const file = path.join(fixture.env.APPDATA!, "mpx", "config.json"), config = JSON.parse(await readFile(file, "utf8"));
  config.identities.work.runtimeRoots.pi = root;
  await writeFile(file, JSON.stringify(config));
}
async function recordedPiLaunch(fixture: Awaited<ReturnType<typeof launchFixture>>): Promise<{ descriptor: LaunchDescriptor; launch: SessionRecordV1["launch"] }> {
  let captured: Parameters<NonNullable<LaunchExecutionContext["launchProjectionBuilder"]>>[0] | undefined;
  const execute = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", truncated: false }));
  const executor: ExecutorAdapter = { name: "docker", verify: async () => ({ status: "verified", verifier: "resume-fixture", evidenceDigest: "a".repeat(64) }), execute };
  const builder = async (input: Parameters<NonNullable<LaunchExecutionContext["launchProjectionBuilder"]>>[0]) => { captured = input; return { directory: path.join(fixture.cwd, "prior-projection"), reference: publishedReference(input), extension: path.join(fixture.cwd, "prior-projection", "extension.mjs"), runtimeContextFile: path.join(fixture.cwd, "prior-projection", "runtime-context.json"), theme: "green" as const }; };
  const snapshot = { schemaVersion: 1 as const, project: { id: "sample/app", cwd: fixture.cwd }, worktree: { id: "worktree", path: fixture.cwd, role: "main" as const, branch: "main" }, portResolution: "valid" as const, services: [], diagnostics: [] };
  const io = captureIo();
  expect(await run(["--cwd", fixture.cwd, "launch", "pi", "--identity", "work"], io, { env: fixture.env, catalogRoot: fixture.catalogRoot, launchExecutorAdapters: [executor], launchExecutableResolver: async () => ({ executable: process.execPath, argvPrefix: [] }), launchProjectionBuilder: builder, launchProjectionValidator: async () => undefined, launchRoutes: { materialize: async descriptor => materializeRoutes(descriptor) }, statusProvider: { snapshot: async () => snapshot } }), JSON.stringify(io)).toBe(0);
  const input = captured!, descriptor = input.descriptor;
  return { descriptor, launch: { launchKey: descriptor.launchKey, descriptorDigest: sha256Canonical(descriptor as unknown as JsonValue), mode: descriptor.mode, skillPolicy: descriptor.skillPolicy, contentScope: descriptor.contentScope.name, executor: { kind: descriptor.executor.name }, workspace: descriptor.workspace, networkPolicy: descriptor.networkPolicy.name, grants: descriptor.grants, artifactKey: input.artifact.reference.artifactKey, manifestKey: input.manifest.manifestKey } };
}
function withRoutes(descriptor: LaunchDescriptor, routes: LaunchDescriptor["routes"]): LaunchDescriptor {
  const { launchKey: _discarded, ...tuple } = { ...descriptor, routes };
  return { ...tuple, launchKey: sha256Canonical(tuple as unknown as JsonValue) } as LaunchDescriptor;
}
async function provisionRoute(root: string, descriptor: LaunchDescriptor, kind: string, label: string): Promise<string> {
  const directory = path.join(root, "private-routes", descriptor.identity.name, descriptor.runtime, kind, label);
  const data = path.join(directory, "data");
  await mkdir(data, { recursive: true });
  await writeFile(path.join(directory, "binding.json"), JSON.stringify({ schemaVersion: 1, runtime: descriptor.runtime, identity: descriptor.identity, kind, label, ...(kind === "mcp" ? { launchKey: descriptor.launchKey } : {}) }));
  if (kind === "mcp") await writeFile(path.join(data, "route.json"), JSON.stringify({ mcpServers: { [label]: { type: "stdio", command: process.execPath, args: [] } } }));
  return data;
}

describe("production private launch services", () => {
  it("provides production route and audit services on the default context", () => {
    expect(defaultContext.launchRoutes).toBeDefined();
    expect(defaultContext.launchAudit).toBeDefined();
  });

  it.each(["../work", "a/b", "a\\b", ".", "..", "route%2fescape", "route\u0000hidden"])("rejects malicious opaque route label %s without disclosing it", async label => {
    const fixture = await launchFixture();
    const selected = withRoutes(await explainedDescriptor(fixture), { gitAuthor: label, providers: {}, ssh: null, mcp: { allow: [], shareNativeAuth: false } });
    const error = await new NodePrivateRouteMaterializer(path.join(fixture.env.LOCALAPPDATA!, "mpx")).materialize(selected).catch(reason => reason);
    expect(error).toMatchObject({ code: "PRIVATE_ROUTE_LABEL_INVALID" });
    expect(JSON.stringify(error)).not.toContain(label);
  });

  it("fails closed when a selected production route is missing", async () => {
    const fixture = await launchFixture();
    const selected = await explainedDescriptor(fixture);
    await expect(new NodePrivateRouteMaterializer(path.join(fixture.env.LOCALAPPDATA!, "mpx")).materialize(selected)).rejects.toMatchObject({ code: "PRIVATE_ROUTE_UNAVAILABLE" });
  });

  it("materializes all exact launch-bound Git, provider, SSH, and MCP route data", async () => {
    const fixture = await launchFixture();
    const selected = withRoutes(await explainedDescriptor(fixture), { gitAuthor: "git-work", providers: { github: "gh-work" }, ssh: "ssh-work", mcp: { allow: ["context7"], shareNativeAuth: false } });
    const root = path.join(fixture.env.LOCALAPPDATA!, "mpx");
    const expected = {
      "git:git-work": await provisionRoute(root, selected, "git", "git-work"),
      "provider-github:gh-work": await provisionRoute(root, selected, "provider-github", "gh-work"),
      "ssh:ssh-work": await provisionRoute(root, selected, "ssh", "ssh-work"),
      "mcp:context7": await provisionRoute(root, selected, "mcp", "context7"),
    };
    await expect(new NodePrivateRouteMaterializer(root).materialize(selected, fixture.cwd)).resolves.toEqual({ ...expected, "mcp:context7": path.join(expected["mcp:context7"], "route.json") });
  });

  it.each([
    { mcpServers: { context7: { type: "http", url: "https://private.invalid" } } },
    { mcpServers: { context7: { type: "stdio", command: "relative/server", args: [] } } },
    { mcpServers: { context7: { type: "stdio", command: "C:/trusted/server.exe", args: [], env: { API_TOKEN: "secret" } } } },
    { mcpServers: { context7: { type: "stdio", command: "C:/trusted/server.exe", args: [], extra: true } } },
  ])("rejects unsupported or injectable MCP route descriptors before projection", async routeDescriptor => {
    const fixture = await launchFixture();
    const selected = withRoutes(await explainedDescriptor(fixture), { gitAuthor: "git-work", providers: {}, ssh: null, mcp: { allow: ["context7"], shareNativeAuth: false } });
    const root = path.join(fixture.env.LOCALAPPDATA!, "mpx");
    await provisionRoute(root, selected, "git", "git-work");
    const data = await provisionRoute(root, selected, "mcp", "context7");
    await writeFile(path.join(data, "route.json"), JSON.stringify(routeDescriptor));
    const error = await new NodePrivateRouteMaterializer(root).materialize(selected, fixture.cwd).catch(reason => reason);
    expect(error).toMatchObject({ code: "PRIVATE_ROUTE_UNAVAILABLE" });
    expect(JSON.stringify(error)).not.toContain(JSON.stringify(routeDescriptor));
  });

  it("rejects wide and deep empty private route data", async () => {
    const fixture = await launchFixture(); const selected = await explainedDescriptor(fixture); const root = path.join(fixture.env.LOCALAPPDATA!, "mpx");
    const wide = await provisionRoute(root, selected, "git", selected.routes.gitAuthor);
    for (let index = 0; index <= 128; index += 1) await mkdir(path.join(wide, `d-${index}`));
    await expect(new NodePrivateRouteMaterializer(root).materialize(selected)).rejects.toMatchObject({ code: "PRIVATE_ROUTE_UNAVAILABLE" });
    await rm(wide, { recursive: true }); await mkdir(wide);
    let current = wide;
    for (let depth = 0; depth <= 16; depth += 1) { current = path.join(current, "d"); await mkdir(current); }
    await expect(new NodePrivateRouteMaterializer(root).materialize(selected)).rejects.toMatchObject({ code: "PRIVATE_ROUTE_UNAVAILABLE" });
  });

  it("reuses stable preprovisioned route data across launch keys", async () => {
    const fixture = await launchFixture();
    const first = await explainedDescriptor(fixture, "work");
    const second = withRoutes(first, { ...first.routes, mcp: { ...first.routes.mcp, allow: ["context7"] } });
    const root = path.join(fixture.env.LOCALAPPDATA!, "mpx");
    await provisionRoute(root, first, "git", first.routes.gitAuthor);
    await expect(new NodePrivateRouteMaterializer(root).materialize(first)).resolves.toHaveProperty(`git:${first.routes.gitAuthor}`);
    await expect(new NodePrivateRouteMaterializer(root).materialize(second)).rejects.toMatchObject({ code: "PRIVATE_ROUTE_UNAVAILABLE" });
    const { launchKey: _launchKey, ...firstTuple } = first;
    const changedTuple = { ...firstTuple, executorVerification: { ...first.executorVerification, evidenceDigest: "f".repeat(64) } };
    const third = { ...changedTuple, launchKey: sha256Canonical(changedTuple as unknown as JsonValue) } as LaunchDescriptor;
    expect(third.launchKey).not.toBe(first.launchKey);
    await expect(new NodePrivateRouteMaterializer(root).materialize(third)).resolves.toHaveProperty(`git:${first.routes.gitAuthor}`);
  });

  it("prevents personal/work route reuse even when an opaque label matches", async () => {
    const fixture = await launchFixture();
    const work = await explainedDescriptor(fixture, "work");
    const personal = await explainedDescriptor(fixture, "personal");
    const root = path.join(fixture.env.LOCALAPPDATA!, "mpx");
    await provisionRoute(root, work, "git", work.routes.gitAuthor);
    await expect(new NodePrivateRouteMaterializer(root).materialize(personal)).rejects.toMatchObject({ code: "PRIVATE_ROUTE_UNAVAILABLE" });
  });
});

describe("production runtime executable resolution", () => {
  const fnmWrapper = `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\nexec "$basedir/node" "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"\n`;

  it("resolves a real exact FNM Pi wrapper through its sibling Node and CLI entry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-fnm-production-")), project = await mkdtemp(path.join(tmpdir(), "mpx-fnm-project-"));
    const wrapper = path.join(root, "pi"), node = path.join(root, "node"), entry = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    await mkdir(path.dirname(entry), { recursive: true }); await writeFile(wrapper, fnmWrapper); await cp(process.execPath, node); await writeFile(entry, "export {};\n");
    await expect(resolveTrustedRuntimeExecutable({ runtime: "pi", cwd: project, environment: { MPX_PI_EXECUTABLE: wrapper, PATH: root } })).resolves.toEqual({ executable: node, argvPrefix: [entry] });
  });

  it("rejects a real near-match FNM Pi wrapper even when its sibling tree exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-fnm-near-")), project = await mkdtemp(path.join(tmpdir(), "mpx-fnm-project-"));
    const wrapper = path.join(root, "pi"), node = path.join(root, "node"), entry = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    await mkdir(path.dirname(entry), { recursive: true }); await writeFile(wrapper, fnmWrapper.replace('"$@"', '"$@"; echo injected')); await cp(process.execPath, node); await writeFile(entry, "export {};\n");
    await expect(resolveTrustedRuntimeExecutable({ runtime: "pi", cwd: project, environment: { MPX_PI_EXECUTABLE: wrapper, PATH: root } })).rejects.toMatchObject({ code: "TRUSTED_EXECUTABLE_NOT_FOUND" });
  });
});

describe("Phase F launch execution", () => {
  it("orchestrates a confirmed production resume through reconstruction, verification, lifecycle binding, and launch handoff", async () => {
    const fixture = await launchFixture(), nativeRoot = path.join(fixture.env.APPDATA!, "native", "work", "pi");
    await configurePiRoot(fixture, nativeRoot);
    const prior = await recordedPiLaunch(fixture), descriptor = prior.descriptor, launch = prior.launch!;
    const sessionFile = path.join(nativeRoot, "sessions", "resume.jsonl");
    await mkdir(path.dirname(sessionFile), { recursive: true }); await writeFile(sessionFile, "{}\n");
    const store = new SessionStore(path.join(fixture.env.LOCALAPPDATA!, "mpx")), service = new SessionService(store);
    const descriptorDigest = sha256Canonical(descriptor as unknown as JsonValue);
    const now = new Date().toISOString(), bindingRef = "resume-native", accountRef = "resume-account";
    await store.saveNativeBinding({ schemaVersion: 1, ref: bindingRef, identity: { domain: "work", name: "work" }, runtime: "pi", recordedRootDigest: canonicalNativeRootDigest(nativeRoot), accountBindingRef: accountRef, createdAt: now, updatedAt: now });
    const saved: SessionRecordV1 = { schemaVersion: 1, recordId: "resume-production", runtimeQualifiedId: "pi:resume-production", runtime: "pi", identity: { domain: "work", name: "work" }, nativeBindingRef: bindingRef, nativeSessionRef: { kind: "root-relative-file", value: "sessions/resume.jsonl" }, launch, location: { cwd: fixture.cwd, project: "sample/app", repository: descriptor.binding.repositoryId, worktree: null }, metadata: { title: null, model: null, effort: null }, liveness: "inactive", process: null, workflow: { status: "unfinished", inbox: true, nextAction: null, priority: null, note: null, relatedIssue: null, relatedReview: null }, resume: { state: "unknown", diagnostic: null, lastVerifiedAt: null, lastPlanDigest: null }, timestamps: { createdAt: now, updatedAt: now, lastActivityAt: null }, lifecycle: { bindingId: null, sequence: 0, timestamp: null } };
    await service.save(saved);
    const resumeDependencies = async () => ({ resolveConfiguredRoot: async () => ({ root: nativeRoot, canonicalRootDigest: canonicalNativeRootDigest(nativeRoot), identity: saved.identity, runtime: "pi" as const }), verifyAccountBinding: async () => "verified" as const, verifyNativeTarget: async () => ({ valid: true, activity: "inactive" as const }) });
    const plannedIo = captureIo(), baseContext = { env: fixture.env, catalogRoot: fixture.catalogRoot, sessionStore: store, sessionResumeDependencies: resumeDependencies };
    expect(await runCli(["--json", "--cwd", fixture.cwd, "session", "resume", saved.recordId], plannedIo, baseContext)).toBe(0);
    const confirmationDigest = JSON.parse(plannedIo.out[0]!).data.confirmationDigest as string;
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", truncated: false }));
    const executor: ExecutorAdapter = { name: "docker", verify: async () => descriptor.executorVerification, execute };
    const prepareLifecycle = vi.fn(async (input: Parameters<NonNullable<LaunchExecutionContext["launchLifecycleBridge"]>["prepare"]>[0]) => ({ binding: createSessionLifecycleBindingV1({ bindingId: "resume-lifecycle", bindingRef: "opaque", runtime: "pi", identityRef: "work:work", launchKey: input.runtimeContext.launchKey, launchDescriptorDigest: input.runtimeContext.launchDescriptor.digest, artifactKey: input.runtimeContext.runtimeArtifact.artifactKey, manifestKey: input.runtimeContext.manifestKey, projectRef: descriptor.binding.projectId ?? "sample/app", repositoryRef: descriptor.binding.repositoryId, worktreeRef: "direct", createdAt: now, expiresAt: "2099-01-01T00:00:00.000Z" }), eventDirectory: path.join(store.stateRoot, "events") }));
    const rootVerify = vi.fn(async () => ({ schemaVersion: 1 as const, ref: accountRef, identity: saved.identity, runtime: "pi" as const, rootDigest: canonicalNativeRootDigest(nativeRoot), mode: "root-attested" as const, createdAt: now, updatedAt: now }));
    const authVerify = vi.fn(async () => undefined), confirmedIo = captureIo();
    const projection = async (input: Parameters<NonNullable<LaunchExecutionContext["launchProjectionBuilder"]>>[0]) => ({ directory: path.join(fixture.cwd, "projection"), reference: publishedReference(input), extension: path.join(fixture.cwd, "projection", "extension.mjs"), runtimeContextFile: path.join(fixture.cwd, "projection", "runtime-context.json"), theme: "green" as const });
    const statusSnapshot = { schemaVersion: 1 as const, project: { id: "sample/app", cwd: fixture.cwd }, worktree: { id: "worktree", path: fixture.cwd, role: "main" as const, branch: "main" }, portResolution: "valid" as const, services: [], diagnostics: [] };
    expect(await runCli(["--json", "--cwd", fixture.cwd, "session", "resume", saved.recordId, "--confirm-plan", confirmationDigest], confirmedIo, { ...baseContext, rootAttestationService: { verify: rootVerify } as never, accountAuthVerifier: { verify: authVerify }, launchExecutorAdapters: [executor], launchExecutableResolver: async () => ({ executable: process.execPath, argvPrefix: [] }), launchProjectionBuilder: projection, launchProjectionValidator: async () => undefined, launchRoutes: { materialize: async value => materializeRoutes(value) }, launchLifecycleBridge: { prepare: prepareLifecycle, consume: vi.fn(async () => 0) }, statusProvider: { snapshot: async () => statusSnapshot } }), JSON.stringify({ confirmedIo, root: rootVerify.mock.calls, auth: authVerify.mock.calls, lifecycle: prepareLifecycle.mock.calls.length, execute: execute.mock.calls.length })).toBe(0);
    expect(rootVerify).toHaveBeenCalledTimes(2);
    expect(rootVerify).toHaveBeenCalledWith(saved.identity, nativeRoot, accountRef);
    expect(authVerify).toHaveBeenCalledTimes(2);
    expect(authVerify).toHaveBeenCalledWith(nativeRoot);
    expect(prepareLifecycle).toHaveBeenCalledWith(expect.objectContaining({ nativeRuntimeRoot: nativeRoot, nativeSessionRef: saved.nativeSessionRef, nativeBinding: expect.objectContaining({ ref: bindingRef }) }));
    expect(execute).toHaveBeenCalledOnce();
  });

  it("blocks a changed Pi account before confirmed-resume discovery or launch effects", async () => {
    const fixture = await launchFixture(), nativeRoot = path.join(fixture.env.APPDATA!, "native", "work", "pi");
    await configurePiRoot(fixture, nativeRoot);
    const prior = await recordedPiLaunch(fixture), descriptor = prior.descriptor, launch = prior.launch!;
    const store = new SessionStore(path.join(fixture.env.LOCALAPPDATA!, "mpx")), service = new SessionService(store);
    const now = new Date().toISOString(), bindingRef = "changed-account-native", accountRef = "changed-account-ref";
    await store.saveNativeBinding({ schemaVersion: 1, ref: bindingRef, identity: { domain: "work", name: "work" }, runtime: "pi", recordedRootDigest: canonicalNativeRootDigest(nativeRoot), accountBindingRef: accountRef, createdAt: now, updatedAt: now });
    const saved: SessionRecordV1 = { schemaVersion: 1, recordId: "changed-account", runtimeQualifiedId: "pi:changed-account", runtime: "pi", identity: { domain: "work", name: "work" }, nativeBindingRef: bindingRef, nativeSessionRef: { kind: "root-relative-file", value: "sessions/resume.jsonl" }, launch, location: { cwd: fixture.cwd, project: "sample/app", repository: descriptor.binding.repositoryId, worktree: null }, metadata: { title: null, model: null, effort: null }, liveness: "inactive", process: null, workflow: { status: "unfinished", inbox: true, nextAction: null, priority: null, note: null, relatedIssue: null, relatedReview: null }, resume: { state: "unknown", diagnostic: null, lastVerifiedAt: null, lastPlanDigest: null }, timestamps: { createdAt: now, updatedAt: now, lastActivityAt: null }, lifecycle: { bindingId: null, sequence: 0, timestamp: null } };
    await service.save(saved);
    const resumeDependencies = async () => ({ resolveConfiguredRoot: async () => ({ root: nativeRoot, canonicalRootDigest: canonicalNativeRootDigest(nativeRoot), identity: saved.identity, runtime: "pi" as const }), verifyAccountBinding: async () => "verified" as const, verifyNativeTarget: async () => ({ valid: true, activity: "inactive" as const }) });
    const planningIo = captureIo(), baseContext = { env: fixture.env, catalogRoot: fixture.catalogRoot, sessionStore: store, sessionResumeDependencies: resumeDependencies };
    expect(await runCli(["--json", "--cwd", fixture.cwd, "session", "resume", saved.recordId], planningIo, baseContext)).toBe(0);
    await writeFile(path.join(fixture.cwd, "mpxconfig.json"), "not-json");
    const effects: string[] = [], rootVerify = vi.fn(async () => { throw Object.assign(new Error("changed"), { code: "ACCOUNT_ROOT_CHANGED" }); }), authVerify = vi.fn(async () => undefined);
    const effect = (name: string) => vi.fn(async () => { effects.push(name); throw new Error(`${name} should not run`); });
    const io = captureIo();
    expect(await runCli(["--json", "--cwd", fixture.cwd, "session", "resume", saved.recordId, "--confirm-plan", JSON.parse(planningIo.out[0]!).data.confirmationDigest], io, { ...baseContext, rootAttestationService: { verify: rootVerify } as never, accountAuthVerifier: { verify: authVerify }, launchExecutorAdapters: [{ name: "docker", verify: effect("audit"), execute: effect("child") } as never], launchProjectionBuilder: effect("projection"), launchRoutes: { materialize: effect("routes") }, launchLifecycleBridge: { prepare: effect("lifecycle"), consume: vi.fn(async () => 0) }, statusProvider: { snapshot: effect("status") } })).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ error: { code: "SESSION_RESUME_ACCOUNT_MISMATCH" } });
    expect(rootVerify).toHaveBeenCalledWith(saved.identity, nativeRoot, accountRef);
    expect(authVerify).not.toHaveBeenCalled();
    expect(effects).toEqual([]);
  });

  it("rejects a confirmed resume after its configured native root crosses roots", async () => {
    const fixture = await launchFixture(), oldRoot = path.join(fixture.env.APPDATA!, "native", "work", "pi");
    await configurePiRoot(fixture, oldRoot);
    const prior = await recordedPiLaunch(fixture), descriptor = prior.descriptor, launch = prior.launch!, store = new SessionStore(path.join(fixture.env.LOCALAPPDATA!, "mpx"));
    const now = new Date().toISOString();
    await store.saveNativeBinding({ schemaVersion: 1, ref: "cross-root-binding", identity: { domain: "work", name: "work" }, runtime: "pi", recordedRootDigest: canonicalNativeRootDigest(oldRoot), accountBindingRef: "account", createdAt: now, updatedAt: now });
    const saved = { schemaVersion: 1, recordId: "cross-root", runtimeQualifiedId: "pi:cross-root", runtime: "pi", identity: { domain: "work", name: "work" }, nativeBindingRef: "cross-root-binding", nativeSessionRef: { kind: "root-relative-file", value: "sessions/resume.jsonl" }, launch, location: { cwd: fixture.cwd, project: "sample/app", repository: descriptor.binding.repositoryId, worktree: null }, metadata: { title: null, model: null, effort: null }, liveness: "inactive", process: null, workflow: { status: "unfinished", inbox: true, nextAction: null, priority: null, note: null, relatedIssue: null, relatedReview: null }, resume: { state: "unknown", diagnostic: null, lastVerifiedAt: null, lastPlanDigest: null }, timestamps: { createdAt: now, updatedAt: now, lastActivityAt: null }, lifecycle: { bindingId: null, sequence: 0, timestamp: null } } as SessionRecordV1;
    await new SessionService(store).save(saved);
    const dependencies = async () => ({ resolveConfiguredRoot: async () => ({ root: oldRoot, canonicalRootDigest: canonicalNativeRootDigest(oldRoot), identity: saved.identity, runtime: "pi" as const }), verifyAccountBinding: async () => "verified" as const, verifyNativeTarget: async () => ({ valid: true, activity: "inactive" as const }) });
    const planningIo = captureIo(); expect(await runCli(["--json", "session", "resume", saved.recordId], planningIo, { env: fixture.env, catalogRoot: fixture.catalogRoot, sessionStore: store, sessionResumeDependencies: dependencies })).toBe(0);
    const configFile = path.join(fixture.env.APPDATA!, "mpx", "config.json"), config = JSON.parse(await readFile(configFile, "utf8"));
    config.identities.work.runtimeRoots.pi = path.join(fixture.env.APPDATA!, "attacker-root"); await writeFile(configFile, JSON.stringify(config));
    const execute = vi.fn(); const io = captureIo();
    expect(await runCli(["--json", "session", "resume", saved.recordId, "--confirm-plan", JSON.parse(planningIo.out[0]!).data.confirmationDigest], io, { env: fixture.env, catalogRoot: fixture.catalogRoot, sessionStore: store, nativeAccountBindingVerifier: { verify: async () => "verified" }, launchExecutorAdapters: [{ name: "docker", verify: async () => descriptor.executorVerification, execute } as ExecutorAdapter] })).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ error: { code: "SESSION_RESUME_ROOT_MISMATCH" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("gates Pi account verification before launch side effects while leaving Claude unaffected", async () => {
    const fixture = await launchFixture(), io = captureIo(), effects: string[] = [];
    const rootAttestationService = { verify: vi.fn(async () => { throw Object.assign(new Error("missing"), { code: "ACCOUNT_ENROLLMENT_MISSING" }); }) };
    const context = { env: fixture.env, catalogRoot: fixture.catalogRoot, rootAttestationService: rootAttestationService as never, accountAuthVerifier: { verify: vi.fn(async () => undefined) }, launchExecutorAdapters: [{ name: "docker" as const, verify: async () => { effects.push("executor"); return { status: "verified" as const, verifier: "fake", evidenceDigest: "a".repeat(64) }; }, execute: vi.fn() }], launchProjectionBuilder: vi.fn(async () => { effects.push("projection"); throw new Error(); }), launchRoutes: { materialize: vi.fn(async () => { effects.push("routes"); return {}; }) }, statusProvider: { snapshot: vi.fn(async () => { effects.push("status"); throw new Error(); }) } };
    expect(await runCli(["--json", "--cwd", fixture.cwd, "launch", "pi", "--identity", "work"], io, context)).toBe(1);
    expect(effects).toEqual([]);
    const claude = verifiedExecution(), claudeIo = captureIo();
    expect(await runCli(["--cwd", fixture.cwd, "launch", "claude", "--identity", "work"], claudeIo, { ...context, ...claude.context })).toBe(0);
    expect(rootAttestationService.verify).toHaveBeenCalledTimes(1);
  });
  it("revalidates the exact Pi root after runtime preparation and blocks a swapped root before child execution", async () => {
    const fixture = await launchFixture(), io = captureIo(), fake = verifiedExecution(), order: string[] = [];
    fake.prepare.mockImplementation(async () => { order.push("prepare"); return { executable: "C:/trusted/pi.exe", argv: [], environment: {} }; });
    const changed = Object.assign(new Error("root changed"), { code: "ACCOUNT_ROOT_CHANGED" });
    const verify = vi.fn(async () => { order.push("verify"); if (verify.mock.calls.length === 2) throw changed; return { schemaVersion: 1, ref: "opaque", identity: { domain: "work", name: "work" }, runtime: "pi", rootDigest: "a".repeat(64), mode: "root-attested", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }; });
    expect(await runCli(["--json", "--cwd", fixture.cwd, "launch", "pi", "--identity", "work"], io, { env: fixture.env, catalogRoot: fixture.catalogRoot, ...fake.context, rootAttestationService: { verify } as never, accountAuthVerifier: { verify: async () => undefined } })).toBe(1);
    expect(order).toEqual(["verify", "prepare", "verify"]);
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it("preserves the runtime execution error when lifecycle consumption also fails", async () => {
    const execution = new ExecutionError("RUNTIME_EXECUTION_FAILED", "runtime failed");
    const lifecycle = new Error("lifecycle failed");
    const failure = await runWithLifecycleConsumption(async () => { throw execution; }, async () => { throw lifecycle; }).catch(error => error);
    expect(failure).toBe(execution);
    expect(failure).toMatchObject({ code: "RUNTIME_EXECUTION_FAILED", cause: lifecycle });
  });

  it("fails with lifecycle consumption when runtime execution succeeds", async () => {
    const lifecycle = new Error("lifecycle failed");
    await expect(runWithLifecycleConsumption(async () => ({ exitCode: 0, stdout: "", stderr: "", truncated: false }), async () => { throw lifecycle; })).rejects.toBe(lifecycle);
  });

  it.each([
    ["pi", "MPX_PI_EXECUTABLE"],
    ["claude", "MPX_CLAUDE_EXECUTABLE"],
  ] as const)("privately propagates a launch-bound live status file to the production %s plan", async (runtime, executableVariable) => {
    const fixture = await launchFixture(), io = captureIo();
    const executable = path.join(fixture.env.APPDATA!, `${runtime}-live.exe`);
    await writeFile(executable, "trusted\n");
    let childStatusPath: string | undefined;
    const execute = vi.fn(async (request: Parameters<ExecutorAdapter["execute"]>[0]) => {
      childStatusPath = request.environment.MPX_STATUS_SNAPSHOT_FILE;
      if (childStatusPath) {
        const updated = { ...JSON.parse(await readFile(childStatusPath, "utf8")), portResolution: "stale" };
        await writeFile(childStatusPath, JSON.stringify(updated));
        expect(JSON.parse(await readFile(request.environment.MPX_STATUS_SNAPSHOT_FILE!, "utf8")).portResolution).toBe("stale");
      }
      return { exitCode: 0, stdout: "", stderr: "", truncated: false };
    });
    const executor: ExecutorAdapter = { name: "docker", verify: async () => ({ status: "verified", verifier: "fake-docker", evidenceDigest: "a".repeat(64) }), execute };
    const builder = vi.fn(async (input: Parameters<NonNullable<LaunchExecutionContext["launchProjectionBuilder"]>>[0]) => ({
      directory: `C:/immutable/${runtime}`, reference: publishedReference(input),
      ...(runtime === "pi" ? { extension: "C:/immutable/pi/extension.mjs", runtimeContextFile: "C:/immutable/pi/runtime-context.json", theme: "green" } : { pluginDirectory: "C:/immutable/claude" }),
    }));
    const auditRecords: unknown[] = [];
    const launchAudit = { start: vi.fn(async record => { auditRecords.push(record); return "attempt"; }), terminal: vi.fn(async (_id, record) => { auditRecords.push(record); }) };
    expect(await run(["--cwd", fixture.cwd, "launch", runtime, "--identity", "work"], io, {
      env: { ...fixture.env, MPX_APPS: fixture.env.APPDATA, [executableVariable]: executable }, catalogRoot: fixture.catalogRoot,
      launchExecutorAdapters: [executor], launchProjectionBuilder: builder, launchProjectionValidator: async () => undefined,
      launchRoutes: { materialize: async descriptor => materializeRoutes(descriptor) }, launchAudit,
    }), JSON.stringify(io)).toBe(0);
    expect(childStatusPath).toContain(path.join(fixture.env.LOCALAPPDATA!, "mpx", "status"));
    const publicSurfaces = JSON.stringify({ io, projection: builder.mock.calls[0]![0], auditRecords });
    expect(publicSurfaces).not.toContain(childStatusPath);
  });

  it("rejects traversal status paths without projection, process, or path disclosure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-status-state-"));
    const snapshot = { schemaVersion: 1 as const, project: { id: "sample/app", cwd: "C:/repo" }, worktree: { id: "wt", path: "C:/repo", role: "main" as const, branch: "main" }, portResolution: "valid" as const, services: [], diagnostics: [] };
    const malicious = path.join(root, "..", "private-other-project", "status.json");
    const error = await resolveLaunchStatusSnapshotPath({ stateRoot: root, descriptor: { launchKey: "a".repeat(64) } as LaunchDescriptor, repositoryId: "repo", snapshot, materializer: { materialize: async () => malicious } }).catch(reason => reason);
    expect(error).toMatchObject({ code: "STATUS_SNAPSHOT_PATH_INVALID" });
    expect(JSON.stringify(error)).not.toContain(malicious);
  });

  it("rejects a status file bound to another project before launch side effects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-status-crossing-"));
    const first = { schemaVersion: 1 as const, project: { id: "project/one", cwd: "C:/repo-one" }, worktree: { id: "wt-one", path: "C:/repo-one", role: "main" as const, branch: "main" }, portResolution: "valid" as const, services: [], diagnostics: [] };
    const descriptor = { launchKey: "a".repeat(64) } as LaunchDescriptor;
    const owned = new NodeLaunchStatusSnapshotMaterializer(root);
    const pathForOne = await resolveLaunchStatusSnapshotPath({ stateRoot: root, descriptor, repositoryId: "repo-one", snapshot: first, materializer: owned });
    const second = { ...first, project: { id: "project/two", cwd: "C:/repo-two" }, worktree: { ...first.worktree, id: "wt-two", path: "C:/repo-two" } };
    const effects: string[] = [];
    const error = await resolveLaunchStatusSnapshotPath({ stateRoot: root, descriptor, repositoryId: "repo-two", snapshot: second, materializer: { materialize: async () => { effects.push("resolve"); return pathForOne; } } }).catch(reason => reason);
    expect(error).toMatchObject({ code: "STATUS_SNAPSHOT_BINDING_INVALID" });
    expect(effects).toEqual(["resolve"]);
    expect(JSON.stringify(error)).not.toContain(pathForOne);
  });

  it("awaits failed refresh fallback during shutdown and cancels all later status work", async () => {
    const fixture = await launchFixture(), io = captureIo();
    const executable = path.join(fixture.env.APPDATA!, "pi-refresh.exe");
    await writeFile(executable, "trusted\n");
    const stateRoot = path.join(fixture.env.LOCALAPPDATA!, "mpx");
    await mkdir(stateRoot, { recursive: true });
    const snapshot = { schemaVersion: 1 as const, project: { id: "sample/app", cwd: fixture.cwd }, worktree: { id: "wt-refresh", path: fixture.cwd, role: "main" as const, branch: "main" }, portResolution: "valid" as const, services: [], diagnostics: [] };
    const deferred = <T>() => {
      let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
      const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
      return { promise, resolve, reject };
    };
    const processExit = deferred<{ exitCode: number; stdout: string; stderr: string; truncated: boolean }>();
    const normalWrite = deferred<string | undefined>();
    const fallbackRead = deferred<typeof snapshot>();
    const fallbackWrite = deferred<void>();
    const productionMaterializer = new NodeLaunchStatusSnapshotMaterializer(stateRoot);
    let materializations = 0;
    const materializer = { materialize: vi.fn(async (input: Parameters<NodeLaunchStatusSnapshotMaterializer["materialize"]>[0]) => {
      materializations += 1;
      if (materializations === 1) return productionMaterializer.materialize(input);
      if (materializations === 2) return normalWrite.promise;
      await fallbackWrite.promise;
      return productionMaterializer.materialize(input);
    }) };
    let scheduled: (() => Promise<void>) | undefined;
    const cancel = vi.fn();
    const clock = { schedule: vi.fn((callback: () => Promise<void>, intervalMs: number) => { expect(intervalMs).toBe(1_000); scheduled = callback; return cancel; }) };
    const execute = vi.fn(async () => processExit.promise);
    const executor: ExecutorAdapter = { name: "docker", verify: async () => ({ status: "verified", verifier: "fake-docker", evidenceDigest: "a".repeat(64) }), execute };
    const builder = vi.fn(async (input: Parameters<NonNullable<LaunchExecutionContext["launchProjectionBuilder"]>>[0]) => ({ directory: "C:/immutable/pi", reference: publishedReference(input), extension: "C:/immutable/pi/extension.mjs", runtimeContextFile: "C:/immutable/pi/runtime-context.json", theme: "green" as const }));
    const statusProvider = { snapshot: vi.fn(async () => snapshot) };
    const reader = vi.fn(async () => fallbackRead.promise);

    const launch = run(["--cwd", fixture.cwd, "launch", "pi", "--identity", "work"], io, {
      env: { ...fixture.env, MPX_APPS: fixture.env.APPDATA, MPX_PI_EXECUTABLE: executable }, catalogRoot: fixture.catalogRoot,
      launchExecutorAdapters: [executor], launchProjectionBuilder: builder, launchProjectionValidator: async () => undefined,
      launchRoutes: { materialize: async descriptor => materializeRoutes(descriptor) }, launchStatusSnapshotMaterializer: materializer,
      launchStatusSnapshotReader: reader, launchStatusRefreshClock: clock, statusProvider,
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const refresh = scheduled!();
    await vi.waitFor(() => expect(materializer.materialize).toHaveBeenCalledTimes(2));
    processExit.resolve({ exitCode: 0, stdout: "", stderr: "", truncated: false });
    normalWrite.reject(new Error("normal refresh failed"));
    await vi.waitFor(() => expect(reader).toHaveBeenCalledOnce());
    expect(cancel).toHaveBeenCalledOnce();
    let shutdownReturned = false;
    void launch.then(() => { shutdownReturned = true; });
    await Promise.resolve();
    expect(shutdownReturned).toBe(false);
    fallbackRead.resolve(snapshot);
    await vi.waitFor(() => expect(materializer.materialize).toHaveBeenCalledTimes(3));
    expect(shutdownReturned).toBe(false);
    fallbackWrite.resolve();
    await expect(refresh).resolves.toBeUndefined();
    await expect(launch).resolves.toBe(0);
    const completedMaterializations = materializer.materialize.mock.calls.length;
    await scheduled!();
    expect(materializer.materialize).toHaveBeenCalledTimes(completedMaterializations);
    expect(statusProvider.snapshot).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
    await rm(path.join(stateRoot, "status"), { recursive: true, force: true });
  });

  it.each(["materialize", "fallback-read"] as const)("bounds shutdown when live status %s never resolves and suppresses late work", async hungStage => {
    const fixture = await launchFixture(), io = captureIo();
    const executable = path.join(fixture.env.APPDATA!, `pi-hung-${hungStage}.exe`);
    await writeFile(executable, "trusted\n");
    const stateRoot = path.join(fixture.env.LOCALAPPDATA!, "mpx");
    await mkdir(stateRoot, { recursive: true });
    const snapshot = { schemaVersion: 1 as const, project: { id: "sample/app", cwd: fixture.cwd }, worktree: { id: "wt-hung", path: fixture.cwd, role: "main" as const, branch: "main" }, portResolution: "valid" as const, services: [], diagnostics: [] };
    const deferred = <T>() => {
      let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
      const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
      return { promise, resolve, reject };
    };
    const processExit = deferred<{ exitCode: number; stdout: string; stderr: string; truncated: boolean }>();
    const hung = deferred<string | undefined>();
    const hungRead = deferred<typeof snapshot>();
    const shutdownDeadline = deferred<void>();
    const productionMaterializer = new NodeLaunchStatusSnapshotMaterializer(stateRoot);
    let materializations = 0, refreshSignal: AbortSignal | undefined, readSignal: AbortSignal | undefined;
    const materializer = { materialize: vi.fn(async (input: Parameters<NodeLaunchStatusSnapshotMaterializer["materialize"]>[0], signal?: AbortSignal) => {
      materializations += 1;
      if (materializations === 1) return productionMaterializer.materialize(input, signal);
      refreshSignal = signal;
      if (hungStage === "materialize") return hung.promise;
      throw new Error("normal refresh failed");
    }) };
    const reader = vi.fn(async (_file: string, signal?: AbortSignal) => { readSignal = signal; return hungRead.promise; });
    let scheduled: (() => Promise<void>) | undefined;
    const cancel = vi.fn();
    const clock = { schedule: vi.fn((callback: () => Promise<void>) => { scheduled = callback; return cancel; }) };
    const wait = vi.fn((milliseconds: number) => { expect(milliseconds).toBe(250); return shutdownDeadline.promise; });
    const execute = vi.fn(async () => processExit.promise);
    const executor: ExecutorAdapter = { name: "docker", verify: async () => ({ status: "verified", verifier: "fake-docker", evidenceDigest: "a".repeat(64) }), execute };
    const builder = vi.fn(async (input: Parameters<NonNullable<LaunchExecutionContext["launchProjectionBuilder"]>>[0]) => ({ directory: "C:/immutable/pi", reference: publishedReference(input), extension: "C:/immutable/pi/extension.mjs", runtimeContextFile: "C:/immutable/pi/runtime-context.json", theme: "green" as const }));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const launch = run(["--cwd", fixture.cwd, "launch", "pi", "--identity", "work"], io, {
        env: { ...fixture.env, MPX_APPS: fixture.env.APPDATA, MPX_PI_EXECUTABLE: executable }, catalogRoot: fixture.catalogRoot,
        launchExecutorAdapters: [executor], launchProjectionBuilder: builder, launchProjectionValidator: async () => undefined,
        launchRoutes: { materialize: async descriptor => materializeRoutes(descriptor) }, launchStatusSnapshotMaterializer: materializer,
        launchStatusSnapshotReader: reader, launchStatusRefreshClock: clock, launchStatusShutdownClock: { wait }, launchStatusShutdownDeadlineMs: 250,
        statusProvider: { snapshot: vi.fn(async () => snapshot) },
      });
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      const refresh = scheduled!();
      if (hungStage === "materialize") await vi.waitFor(() => expect(refreshSignal).toBeDefined());
      else await vi.waitFor(() => expect(reader).toHaveBeenCalledOnce());
      processExit.resolve({ exitCode: 0, stdout: "", stderr: "", truncated: false });
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(refreshSignal?.aborted).toBe(true);
      if (hungStage === "fallback-read") expect(readSignal?.aborted).toBe(true);
      let returned = false;
      void launch.then(() => { returned = true; });
      await Promise.resolve();
      expect(returned).toBe(false);
      shutdownDeadline.resolve();
      await expect(launch).resolves.toBe(0);
      expect(wait).toHaveBeenCalledOnce();
      hung.resolve(undefined);
      if (hungStage === "fallback-read") hungRead.reject(new Error("late read rejection"));
      await expect(refresh).resolves.toBeUndefined();
      await Promise.resolve();
      expect(materializer.materialize).toHaveBeenCalledTimes(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      hungRead.promise.catch(() => undefined);
      await rm(path.join(stateRoot, "status"), { recursive: true, force: true });
    }
  });

  it("gates the safe default Docker executor without falling back to host", async () => {
    const fixture = await launchFixture(), io = captureIo();
    expect(await run(["--json", "--cwd", fixture.cwd, "launch", "pi", "--identity", "work"], io, { env: fixture.env, catalogRoot: fixture.catalogRoot, launchRoutes: { materialize: async () => ({}) } })).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: "EXECUTOR_GATE_UNVERIFIED", details: { executor: "docker" } } });
  });

  it("executes a verified injected Docker launch without mixing an output envelope", async () => {
    const fixture = await launchFixture(), fake = verifiedExecution(), io = captureIo();
    expect(await run(["--json", "--cwd", fixture.cwd, "launch", "pi", "--identity", "work"], io, { env: fixture.env, catalogRoot: fixture.catalogRoot, ...fake.context })).toBe(0);
    expect(fake.execute).toHaveBeenCalledOnce();
    expect(io.out).toEqual([]); expect(io.err).toEqual([]);
  });

  it("returns a nonzero runtime process exit from a silent launch", async () => {
    const fixture = await launchFixture(), fake = verifiedExecution(), io = captureIo();
    fake.execute.mockResolvedValueOnce({ exitCode: 7, stdout: "", stderr: "runtime failed", truncated: false });
    expect(await run(["--cwd", fixture.cwd, "launch", "pi", "--identity", "work"], io, { env: fixture.env, catalogRoot: fixture.catalogRoot, ...fake.context })).toBe(7);
    expect(io.out).toEqual([]);
  });

  it("accepts reordered exact executor evidence at the CLI preflight boundary and rejects extra fields", async () => {
    for (const extra of [false, true]) {
      const fixture = await launchFixture(), fake = verifiedExecution(), io = captureIo();
      let checks = 0;
      const executor = fake.context.launchExecutorAdapters![0]!;
      const verify = async () => {
        checks += 1;
        const evidence = { evidenceDigest: "a".repeat(64), status: "verified" as const, verifier: "fake-docker" };
        return checks === 1 || !extra ? evidence : { ...evidence, extra: true } as typeof evidence;
      };
      const context = { ...fake.context, launchExecutorAdapters: [{ ...executor, verify }] };
      expect(await run(["--json", "--cwd", fixture.cwd, "launch", "pi", "--identity", "work"], io, { env: fixture.env, catalogRoot: fixture.catalogRoot, ...context })).toBe(extra ? 1 : 0);
      if (extra) expect(JSON.parse(io.out[0]!)).toMatchObject({ error: { code: "LAUNCH_RESTART_REQUIRED" } });
      expect(fake.execute).toHaveBeenCalledTimes(extra ? 0 : 1);
    }
  });

  it.each([
    ["cc", "claude", "personal"], ["ccw", "claude", "work"], ["pi", "pi", "personal"], ["piw", "pi", "work"],
  ] as const)("keeps alias %s limited to runtime and identity", async (alias, runtime, identity) => {
    const fixture = await launchFixture(), fake = verifiedExecution(), io = captureIo();
    expect(await run(["--cwd", fixture.cwd, alias], io, { env: fixture.env, catalogRoot: fixture.catalogRoot, ...fake.context })).toBe(0);
    const descriptor = fake.prepare.mock.calls[0]![0].descriptor;
    expect(descriptor).toMatchObject({ runtime, identity: { name: identity }, mode: "project", skillPolicy: "clean", workspace: "clone", executor: { name: "docker" }, networkPolicy: { name: "implementation" } });
  });

  it("rejects an alias runtime conflict before projection or process side effects", async () => {
    const fixture = await launchFixture(), io = captureIo();
    const builder = vi.fn();
    const execute = vi.fn();
    const executor: ExecutorAdapter = { name: "docker", verify: async () => ({ status: "verified", verifier: "fake-docker", evidenceDigest: "a".repeat(64) }), execute };

    expect(await run(["--json", "--cwd", fixture.cwd, "cc", "--runtime", "pi"], io, {
      env: { ...fixture.env, MPX_CLAUDE_EXECUTABLE: "C:/tools/claude.exe" },
      catalogRoot: fixture.catalogRoot,
      launchExecutorAdapters: [executor],
      launchProjectionBuilder: builder,
      launchRoutes: { materialize: async () => ({}) },
    })).toBe(1);

    expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: "ALIAS_RUNTIME_MISMATCH" } });
    expect(builder).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects host approval minting in JSON/noninteractive mode", async () => {
    const fixture = await launchFixture(), io = captureIo();
    expect(await run(["--json", "--cwd", fixture.cwd, "launch", "pi", "--identity", "work", "--executor", "host", "--workspace", "direct", "--reason", "Trusted compatibility"], io, { env: fixture.env, catalogRoot: fixture.catalogRoot })).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: "HOST_TTY_REQUIRED" } });
  });

  it("executes explicit host mode only through two sanitized direct-TTY approvals and a trusted runtime plan", async () => {
    const fixture=await launchFixture(), io=captureIo(), execute=vi.fn(async(_request:Parameters<ExecutorAdapter["execute"]>[0])=>({exitCode:0,stdout:"",stderr:"",truncated:false}));
    const host:ExecutorAdapter={name:"host",verify:async()=>({status:"verified",verifier:"fake-host",evidenceDigest:"c".repeat(64)}),execute};
    const prepare=vi.fn(async()=>({executable:"C:/trusted/pi.exe",argv:["--trusted-plan"],environment:{}}));
    const messages:string[]=[];
    const reason="Need C:/secret/project token=abc123 for restart";
    const confirm=vi.fn(async(message:string)=>{messages.push(message);return true;});
    expect(await run(["--cwd",fixture.cwd,"launch","pi","--identity","work","--executor","host","--workspace","direct","--reason",reason],io,{env:fixture.env,catalogRoot:fixture.catalogRoot,launchExecutorAdapters:[host],launchRuntimeAdapters:[{runtime:"pi",prepare}],launchRoutes:{materialize:async descriptor=>materializeRoutes(descriptor)},launchTty:{direct:true,confirm}})).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).toContain("[path]");
      expect(message).toContain("token=[redacted]");
      expect(message).not.toContain("C:/secret/project");
      expect(message).not.toContain("abc123");
    }
    const preparedDescriptor = ((prepare.mock.calls[0] as unknown as [{ descriptor: Parameters<RuntimeAdapter["prepare"]>[0]["descriptor"] }])[0]).descriptor;
    expect(JSON.stringify(createLaunchExecutionAudit(preparedDescriptor,{started:true}))).not.toContain("C:/secret/project");
    expect(JSON.stringify(createLaunchExecutionAudit(preparedDescriptor,{started:true}))).not.toContain("abc123");
    expect(prepare).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0]).toMatchObject({executable:"C:/trusted/pi.exe",argv:["--trusted-plan"]});
  });

  it.each([
    ["pi", "personal", "C:/native/personal/pi", "C:/native/work/pi", "PI_CODING_AGENT_DIR"],
    ["claude", "work", "C:/native/work/claude", "C:/native/personal/claude", "CLAUDE_CONFIG_DIR"],
  ] as const)("propagates only the descriptor-bound private %s root for %s", async (runtime, identity, selectedRoot, otherRoot, variable) => {
    const fixture = await launchFixture(), fake = verifiedExecution(), io = captureIo();
    expect(await run(["--cwd", fixture.cwd, "launch", runtime, "--identity", identity], io, { env: { ...fixture.env, CLAUDE_CONFIG_DIR: otherRoot, PI_CODING_AGENT_DIR: otherRoot }, catalogRoot: fixture.catalogRoot, ...fake.context })).toBe(0);
    const request = fake.execute.mock.calls[0]![0];
    expect(request.environment[variable]).toBe(selectedRoot);
    expect(JSON.stringify(request.environment)).not.toContain(otherRoot);
    const descriptor=fake.prepare.mock.calls[0]![0].descriptor;
    expect(JSON.stringify(fake.prepare.mock.calls[0]![0])).not.toContain(selectedRoot);
    expect(JSON.stringify({banner:compactLaunchBanner(descriptor),audit:createLaunchExecutionAudit(descriptor,{started:true})})).not.toContain(selectedRoot);
    expect(JSON.stringify(io)).not.toContain(selectedRoot);
  });

  it.each([
    ["pi", "MPX_PI_EXECUTABLE"],
    ["claude", "MPX_CLAUDE_EXECUTABLE"],
  ] as const)("uses the trusted %s publisher verification without a second CLI hash walk", async (runtime, executableVariable) => {
    const fixture = await launchFixture(), io = captureIo();
    const executable = path.join(fixture.env.APPDATA!, `${runtime}-publisher.exe`);
    await writeFile(executable, "trusted\n");
    const execute = vi.fn(async (_request: Parameters<ExecutorAdapter["execute"]>[0]) => ({ exitCode: 0, stdout: "", stderr: "", truncated: false }));
    const executor: ExecutorAdapter = { name: "docker", verify: async () => ({ status: "verified", verifier: "fake-docker", evidenceDigest: "a".repeat(64) }), execute };
    const validator = vi.fn(async () => undefined);
    const artifactRevalidator = vi.fn(revalidateRuntimeArtifact);
    const contentRoot = await mkdtemp(path.join(tmpdir(), "mpx-publisher-content-"));
    const catalogRoot = path.join(contentRoot, "catalog");
    await cp(fixture.catalogRoot, catalogRoot, { recursive: true });
    await mkdir(path.join(contentRoot, "agents"));

    expect(await run(["--cwd", fixture.cwd, "launch", runtime, "--identity", "work"], io, {
      env: { ...fixture.env, MPX_APPS: fixture.env.APPDATA, [executableVariable]: executable }, catalogRoot,
      launchExecutorAdapters: [executor], launchProjectionValidator: validator, launchProjectionArtifactRevalidator: artifactRevalidator,
      launchRoutes: { materialize: async descriptor => materializeRoutes(descriptor) },
    }), JSON.stringify(io)).toBe(0);

    expect(artifactRevalidator).toHaveBeenCalledOnce();
    expect(validator).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0].environment.MPX_RUNTIME_PROJECTION_REFERENCE).toBeDefined();
    await rm(contentRoot, { recursive: true, force: true });
  });

  it.each([
    ["pi", "MPX_PI_EXECUTABLE"],
    ["claude", "MPX_CLAUDE_EXECUTABLE"],
  ] as const)("builds and revalidates the production %s projection before execution", async (runtime, executableVariable) => {
    const fixture=await launchFixture(), io=captureIo(), effects:string[]=[];
    const executable = path.join(fixture.env.APPDATA!, `${runtime}.exe`);
    await writeFile(executable, "trusted\n");
    const execute=vi.fn(async()=>({exitCode:0,stdout:"",stderr:"",truncated:false}));
    const executor:ExecutorAdapter={name:"docker",verify:async()=>({status:"verified",verifier:"fake-docker",evidenceDigest:"a".repeat(64)}),execute};
    const builder=vi.fn(async(input:Parameters<NonNullable<LaunchExecutionContext["launchProjectionBuilder"]>>[0])=>{
      effects.push("build");
      return {directory:`C:/immutable/${runtime}`,reference:publishedReference(input),...(runtime==="pi"?{extension:"C:/immutable/pi/extension.mjs",runtimeContextFile:"C:/immutable/pi/runtime-context.json",theme:"green"}:{pluginDirectory:"C:/immutable/claude"})};
    });
    const validator=vi.fn(async()=>{effects.push("validate");});
    expect(await run(["--cwd",fixture.cwd,"launch",runtime,"--identity","work"],io,{env:{...fixture.env,MPX_APPS:fixture.env.APPDATA,[executableVariable]:executable},catalogRoot:fixture.catalogRoot,launchExecutorAdapters:[executor],launchProjectionBuilder:builder,launchProjectionValidator:validator,launchRoutes:{materialize:async descriptor=>materializeRoutes(descriptor)}})).toBe(0);
    expect(effects).toEqual(["build","validate"]);
    expect(builder).toHaveBeenCalledOnce(); expect(validator).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(builder.mock.calls[0]![0])).not.toContain(`C:/native/work/${runtime}`);
    expect(JSON.stringify(io)).not.toContain(`C:/native/work/${runtime}`);
  });

  it("rejects a mismatched explicit published binding before validation or invocation", async () => {
    const fixture = await launchFixture(), io = captureIo(), execute = vi.fn(), validator = vi.fn();
    const executable = path.join(fixture.env.APPDATA!, "pi-binding.exe"); await writeFile(executable, "trusted\n");
    const executor: ExecutorAdapter = { name: "docker", verify: async () => ({ status: "verified", verifier: "fake-docker", evidenceDigest: "a".repeat(64) }), execute };
    const builder = vi.fn(async (input: Parameters<NonNullable<LaunchExecutionContext["launchProjectionBuilder"]>>[0]) => ({ directory: "C:/immutable/pi", reference: { ...publishedReference(input), launchBinding: { ...publishedReference(input).launchBinding, launchKey: "0".repeat(64) } }, extension: "C:/immutable/pi/extension.mjs", runtimeContextFile: "C:/immutable/pi/runtime-context.json", theme: "green" as const }));
    expect(await run(["--json", "--cwd", fixture.cwd, "launch", "pi", "--identity", "work"], io, { env: { ...fixture.env, MPX_APPS: fixture.env.APPDATA, MPX_PI_EXECUTABLE: executable }, catalogRoot: fixture.catalogRoot, launchExecutorAdapters: [executor], launchProjectionBuilder: builder, launchProjectionValidator: validator, launchRoutes: { materialize: async descriptor => materializeRoutes(descriptor) } })).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: "LAUNCH_RESTART_REQUIRED" } });
    expect(validator).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });

  it("performs no projection or process side effects when a launch precondition fails", async () => {
    const fixture=await launchFixture(), io=captureIo(), builder=vi.fn(), execute=vi.fn();
    const executor:ExecutorAdapter={name:"docker",verify:async()=>({status:"verified",verifier:"fake-docker",evidenceDigest:"a".repeat(64)}),execute};
    expect(await run(["--json","--cwd",fixture.cwd,"launch","pi","--identity","work"],io,{env:{...fixture.env,MPX_PI_EXECUTABLE:"C:/tools/pi.exe"},catalogRoot:fixture.catalogRoot,launchExecutorAdapters:[executor],launchProjectionBuilder:builder,launchExpectedKey:"0".repeat(64),launchRoutes:{materialize:async()=>({})}})).toBe(1);
    expect(builder).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["relative", "tools/pi.exe"],
    ["nonexistent", "C:/trusted/missing-pi.exe"],
  ] as const)("fails trusted runtime preflight for a %s Pi executable before status, routes, projection, or process side effects", async (_label, executable) => {
    const fixture = await launchFixture(), io = captureIo();
    const effects: string[] = [];
    const execute = vi.fn(async (_request: Parameters<ExecutorAdapter["execute"]>[0]) => { effects.push("process"); return { exitCode: 0, stdout: "", stderr: "", truncated: false }; });
    const executor: ExecutorAdapter = { name: "docker", verify: async () => ({ status: "verified", verifier: "fake-docker", evidenceDigest: "a".repeat(64) }), execute };
    const builder = vi.fn(async (input: Parameters<NonNullable<LaunchExecutionContext["launchProjectionBuilder"]>>[0]) => { effects.push("build"); return { directory: "C:/immutable/pi", reference: publishedReference(input), extension: "C:/immutable/pi/extension.mjs", runtimeContextFile: "C:/immutable/pi/runtime-context.json", theme: "green" as const }; });
    const statusProvider = { snapshot: vi.fn(async () => { effects.push("status"); return { schemaVersion: 1 as const, project: { id: "sample/app", cwd: fixture.cwd }, worktree: { id: null, path: null, role: null, branch: null }, portResolution: "missing" as const, services: [], diagnostics: [] }; }) };
    const launchRoutes = { materialize: vi.fn(async descriptor => { effects.push("routes"); return materializeRoutes(descriptor); }) };

    expect(await run(["--json", "--cwd", fixture.cwd, "launch", "pi", "--identity", "work"], io, {
      env: { ...fixture.env, MPX_PI_EXECUTABLE: executable },
      catalogRoot: fixture.catalogRoot,
      launchExecutorAdapters: [executor],
      launchProjectionBuilder: builder,
      launchRoutes,
      statusProvider,
    })).toBe(1);

    expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: "TRUSTED_EXECUTABLE_NOT_FOUND" } });
    expect(statusProvider.snapshot).not.toHaveBeenCalled();
    expect(launchRoutes.materialize).not.toHaveBeenCalled();
    expect(builder).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(effects).toEqual([]);
  });

  it("fails trusted runtime preflight for a project-local Pi executable before status, routes, projection, or process side effects", async () => {
    const fixture = await launchFixture(), io = captureIo();
    const localExecutable = path.join(fixture.cwd, "tools", "pi.exe");
    await mkdir(path.dirname(localExecutable), { recursive: true });
    await writeFile(localExecutable, "echo hijack\n");
    const effects: string[] = [];
    const execute = vi.fn(async (_request: Parameters<ExecutorAdapter["execute"]>[0]) => { effects.push("process"); return { exitCode: 0, stdout: "", stderr: "", truncated: false }; });
    const executor: ExecutorAdapter = { name: "docker", verify: async () => ({ status: "verified", verifier: "fake-docker", evidenceDigest: "a".repeat(64) }), execute };
    const builder = vi.fn(async (input: Parameters<NonNullable<LaunchExecutionContext["launchProjectionBuilder"]>>[0]) => { effects.push("build"); return { directory: "C:/immutable/pi", reference: publishedReference(input), extension: "C:/immutable/pi/extension.mjs", runtimeContextFile: "C:/immutable/pi/runtime-context.json", theme: "green" as const }; });
    const statusProvider = { snapshot: vi.fn(async () => { effects.push("status"); return { schemaVersion: 1 as const, project: { id: "sample/app", cwd: fixture.cwd }, worktree: { id: null, path: null, role: null, branch: null }, portResolution: "missing" as const, services: [], diagnostics: [] }; }) };
    const launchRoutes = { materialize: vi.fn(async descriptor => { effects.push("routes"); return materializeRoutes(descriptor); }) };

    expect(await run(["--json", "--cwd", fixture.cwd, "launch", "pi", "--identity", "work"], io, {
      env: { ...fixture.env, MPX_PI_EXECUTABLE: localExecutable },
      catalogRoot: fixture.catalogRoot,
      launchExecutorAdapters: [executor],
      launchProjectionBuilder: builder,
      launchRoutes,
      statusProvider,
    })).toBe(1);

    expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: "TRUSTED_EXECUTABLE_NOT_FOUND" } });
    expect(statusProvider.snapshot).not.toHaveBeenCalled();
    expect(launchRoutes.materialize).not.toHaveBeenCalled();
    expect(builder).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(effects).toEqual([]);
  });

  it("binds a nested project skill into the combined artifact without native Pi skill argv", async () => {
    const fixture = await launchFixture(), io = captureIo();
    const nested = path.join(fixture.cwd, "packages", "web");
    const skillDirectory = path.join(fixture.cwd, ".agents", "skills", "local");
    await mkdir(nested, { recursive: true }); await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: local\ndescription: Local\ndisable-model-invocation: true\nmetadata:\n  mpx:\n    projectExposure: explicit-only\n---\nBody\n");
    const executable = path.join(fixture.env.APPDATA!, "pi-nested.exe"); await writeFile(executable, "trusted\n");
    const execute = vi.fn(async (_request: Parameters<ExecutorAdapter["execute"]>[0]) => ({ exitCode: 0, stdout: "", stderr: "", truncated: false }));
    const executor: ExecutorAdapter = { name: "docker", verify: async () => ({ status: "verified", verifier: "fake-docker", evidenceDigest: "a".repeat(64) }), execute };
    const builder = vi.fn(async (input: Parameters<NonNullable<LaunchExecutionContext["launchProjectionBuilder"]>>[0]) => {
      expect(input.descriptor.intendedPolicy.inputsDigest).toBe(sha256Canonical({ schemaVersion: 1, manifestKey: input.manifest.manifestKey, skillArtifactKey: input.descriptor.skillArtifact.artifactKey } as unknown as JsonValue));
      expect(input.catalog.find((skill) => skill.identity === "local")).toMatchObject({ sourcePath: path.join(skillDirectory, "SKILL.md"), directoryHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(input.artifact.entries.find((entry) => entry.identity === "local")?.source.kind).toBe("project");
      return { directory: "C:/immutable/pi", reference: publishedReference(input), extension: "C:/immutable/pi/extension.mjs", runtimeContextFile: "C:/immutable/pi/runtime-context.json", theme: "green" as const };
    });
    expect(await run(["--cwd", nested, "launch", "pi", "--identity", "work"], io, { env: { ...fixture.env, MPX_APPS: fixture.env.APPDATA, MPX_PI_EXECUTABLE: executable }, catalogRoot: fixture.catalogRoot, launchExecutorAdapters: [executor], launchProjectionBuilder: builder, launchProjectionValidator: async () => undefined, launchRoutes: { materialize: async descriptor => materializeRoutes(descriptor) } })).toBe(0);
    expect(execute.mock.calls[0]![0]).toMatchObject({ cwd: nested });
    expect(execute.mock.calls[0]![0].argv).not.toContain("--skill");
    expect(execute.mock.calls[0]![0].argv.join(" ")).not.toContain(skillDirectory);
  });

  it("uses a trusted absolute Pi executable with status before projection and process work", async () => {
    const fixture = await launchFixture(), io = captureIo();
    const effects: string[] = [];
    const execute = vi.fn(async (_request: Parameters<ExecutorAdapter["execute"]>[0]) => { effects.push("process"); return { exitCode: 0, stdout: "", stderr: "", truncated: false }; });
    const executor: ExecutorAdapter = { name: "docker", verify: async () => ({ status: "verified", verifier: "fake-docker", evidenceDigest: "a".repeat(64) }), execute };
    const builder = vi.fn(async (input: Parameters<NonNullable<LaunchExecutionContext["launchProjectionBuilder"]>>[0]) => {
      effects.push(`build:${input.launchBanner}`);
      return { directory: "C:/immutable/pi", reference: publishedReference(input), extension: "C:/immutable/pi/extension.mjs", runtimeContextFile: "C:/immutable/pi/runtime-context.json", theme: "green" as const };
    });
    const validator = vi.fn(async () => { effects.push("validate"); });
    const statusProvider = { snapshot: vi.fn(async () => { effects.push("status"); return { schemaVersion: 1 as const, project: { id: "sample/app", cwd: fixture.cwd }, worktree: { id: "wt-1", path: fixture.cwd, role: "main" as const, branch: "main" }, portResolution: "valid" as const, services: [{ id: "web", mode: "managed" as const, scope: "checkout" as const, protocol: "http" as const, port: 4100, listening: true, conflict: "none" as const, pid: 7 }], diagnostics: [] }; }) };
    const launchRoutes = { materialize: vi.fn(async descriptor => { effects.push("routes"); return materializeRoutes(descriptor); }) };

    const trustedExecutable = path.join(fixture.env.APPDATA!, "pi.exe");
    await writeFile(trustedExecutable, "trusted\n");
    expect(await run(["--cwd", fixture.cwd, "launch", "pi", "--identity", "work"], io, {
      env: { ...fixture.env, MPX_APPS: fixture.env.APPDATA, MPX_PI_EXECUTABLE: trustedExecutable },
      catalogRoot: fixture.catalogRoot,
      launchExecutorAdapters: [executor],
      launchProjectionBuilder: builder,
      launchProjectionValidator: validator,
      launchRoutes,
      statusProvider,
    })).toBe(0);

    expect(effects[0]).toBe("routes");
    expect(effects[1]).toBe("status");
    expect(effects[2]).toMatch(/^build:/u);
    expect(effects.slice(3)).toEqual(["validate", "process"]);
    expect(statusProvider.snapshot).toHaveBeenCalledOnce();
    expect(launchRoutes.materialize).toHaveBeenCalledOnce();
    expect(builder).toHaveBeenCalledOnce();
    expect(validator).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0]).toMatchObject({ executable: trustedExecutable.replaceAll("\\", "/"), argv: ["--no-extensions", "--extension", "C:/immutable/pi/extension.mjs", "--no-skills", "--theme", "green"] });
  });

  it("fails before projection or process work when trusted private-route materialization is absent", async () => {
    const fixture = await launchFixture(), io = captureIo();
    const builder = vi.fn();
    const execute = vi.fn();
    const executor: ExecutorAdapter = { name: "docker", verify: async () => ({ status: "verified", verifier: "fake-docker", evidenceDigest: "a".repeat(64) }), execute };

    expect(await run(["--json", "--cwd", fixture.cwd, "launch", "pi", "--identity", "work"], io, {
      env: { ...fixture.env, MPX_PI_EXECUTABLE: "C:/tools/pi.exe" },
      catalogRoot: fixture.catalogRoot,
      launchExecutorAdapters: [executor],
      launchProjectionBuilder: builder,
    })).toBe(1);

    expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: "PRIVATE_ROUTE_MATERIALIZER_REQUIRED" } });
    expect(builder).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves restart remediation when launch rights change", async () => {
    const fixture = await launchFixture(), fake = verifiedExecution(), io = captureIo();
    expect(await run(["--json", "--cwd", fixture.cwd, "launch", "pi", "--identity", "work"], io, { env: fixture.env, catalogRoot: fixture.catalogRoot, ...fake.context, launchExpectedKey:"0".repeat(64) })).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: "LAUNCH_RESTART_REQUIRED", remediation: expect.stringContaining("restart") } });
  });

  it("keeps raw native roots out of launch envelopes and the public descriptor", async () => {
    const fixture=await launchFixture(), io=captureIo();
    expect(await run(["--json","--cwd",fixture.cwd,"launch","explain","--runtime","pi","--identity","work"],io,{env:fixture.env,catalogRoot:fixture.catalogRoot})).toBe(0);
    const output=io.out.join("\n");
    expect(output).not.toContain("C:/native/work/pi");
    expect(output).not.toContain("C:/native/personal/pi");
    expect(JSON.parse(output).data).toHaveProperty("nativeRuntimeRootDigest");
  });

  it("reports the logical skill artifact separately from the exact validated published projection binding", async () => {
    const io = captureIo();
    const context = { schemaVersion: 1, launchKey: "a".repeat(64), launchDescriptor: { reference: "launch.json", digest: "b".repeat(64) }, manifestKey: "c".repeat(64), runtimeArtifact: { schemaVersion: 4, runtime: "pi", manifestKey: "c".repeat(64), artifactKey: "d".repeat(64), fileMapHash: "e".repeat(64) }, binding: { projectId: "sample/app", repositoryId: "sample/app", contentScope: "work" } };
    const launchBinding = { launchKey: context.launchKey, descriptorDigest: context.launchDescriptor.digest, runtimeArtifactKey: context.runtimeArtifact.artifactKey, runtime: "pi", manifestKey: context.manifestKey };
    const projection = { projectionKey: "f".repeat(64), launchBinding, fileMapHash: "9".repeat(64) };
    expect(await run(["--json", "launch", "current"], io, { env: { MPX_RUNTIME_CONTEXT: JSON.stringify(context), MPX_RUNTIME_PROJECTION_REFERENCE: JSON.stringify(projection) } })).toBe(0);
    expect(JSON.parse(io.out[0]!).data).toEqual({ launchKey: context.launchKey, descriptorDigest: context.launchDescriptor.digest, manifestKey: context.manifestKey, artifactKey: context.runtimeArtifact.artifactKey, projectionKey: projection.projectionKey, launchBinding, binding: context.binding });
  });
});
