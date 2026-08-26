import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { MpxError, sha256Canonical, type JsonValue } from "@mpx/core";
import {
  ExecutionError,
  ExecutionService,
  ExecutorRegistry,
  HostApprovalStore,
  RuntimeAdapterRegistry,
  compactLaunchBanner,
  locateTrustedExecutable,
  type DirectTty,
  type ExecutorAdapter,
  type FileInspection,
  type LaunchAuditStore,
  type ProcessRequest,
  type ProcessResult,
  type RuntimeAdapter,
  type RuntimeLaunchBinding,
  type VerificationEvidence,
  sameVerificationEvidence,
} from "@mpx/executors";
import type { LaunchDescriptor } from "@mpx/launch";
import { createRuntimeCapabilityManifestV1, createRuntimeContextV1, parseRuntimeContextV1, revalidateRuntimeArtifact, validateRuntimeCapabilityBinding, type PublishedRuntimeArtifactReference, type RuntimeCapabilityManifestV1, type RuntimeProjectionLaunchBinding, type RuntimeContextV1, type ToolAuthorityV1 } from "@mpx/runtime-contracts";
import { createClaudeInvocationPlan, publishClaudeProjection } from "@mpx/runtime-claude";
import { buildPiProjection, createPiRuntimeProfileV1, PI_CAPABILITY_IDS, planPiInvocation, type PiRuntimeProfileV1 } from "@mpx/runtime-pi";
import type { CatalogSkill, ResolvedManifest, RuntimeSkillArtifact } from "@mpx/skills";
import { composeRuntimeStatusEnvelopeV1, parseRuntimeStatusEnvelopeV1, parseStatusSnapshotV1, readStatusSnapshotV1, type RuntimeStatusEnvelopeV1, type StatusSnapshotV1 } from "@mpx/status";

export interface LaunchProjection {
  readonly directory: string;
  readonly reference: PublishedRuntimeArtifactReference;
  readonly pluginDirectory?: string;
  readonly extension?: string;
  readonly runtimeContextFile?: string;
  readonly theme?: string;
}
export interface LaunchProjectionBuildInput {
  readonly descriptor: LaunchDescriptor;
  readonly manifest: ResolvedManifest;
  readonly artifact: RuntimeSkillArtifact;
  readonly catalog: readonly CatalogSkill[];
  readonly canonicalRoot: string;
  readonly agentsRoot: string;
  readonly artifactsRoot: string;
  readonly runtimeContext: RuntimeContextV1;
  readonly statusSnapshot: StatusSnapshotV1;
  readonly runtimeStatusEnvelope: RuntimeStatusEnvelopeV1;
  readonly runtimeCapabilityManifest: RuntimeCapabilityManifestV1;
  readonly runtimeLaunchBinding: RuntimeLaunchBinding;
  readonly piRuntimeProfile?: PiRuntimeProfileV1;
  readonly launchBanner: string;
  readonly artifactRevalidator?: typeof revalidateRuntimeArtifact;
}

export interface LaunchStatusSnapshotBinding {
  readonly schemaVersion: 1;
  readonly launchKey: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly worktreeId: string | null;
  readonly worktreePath: string | null;
}
export interface LaunchStatusSnapshotMaterializer {
  materialize(input: { readonly binding: LaunchStatusSnapshotBinding; readonly snapshot: StatusSnapshotV1 }, signal?: AbortSignal): Promise<string | undefined>;
}

export interface LaunchExecutionContext {
  launchExecutorAdapters?: readonly ExecutorAdapter[];
  launchRuntimeAdapters?: readonly RuntimeAdapter[];
  launchRoutes?: { materialize(descriptor: LaunchDescriptor, projectRoot?: string): Promise<Readonly<Record<string, string>>> };
  launchAudit?: LaunchAuditStore;
  launchTty?: DirectTty;
  launchExpectedKey?: string;
  launchProjectionBuilder?: (input:LaunchProjectionBuildInput)=>Promise<LaunchProjection>;
  launchProjectionValidator?: (input:{runtime:"claude"|"pi";directory:string;reference:PublishedRuntimeArtifactReference})=>Promise<void>;
  launchProjectionArtifactRevalidator?: typeof revalidateRuntimeArtifact;
  launchExecutableResolver?: (input:{runtime:"claude"|"pi";candidate:string;cwd:string;environment:NodeJS.ProcessEnv})=>Promise<{executable:string;argvPrefix:readonly string[]}>;
  launchRuntimeWiringFactory?: (input: { descriptor: LaunchDescriptor; artifact: RuntimeSkillArtifact; snapshot: StatusSnapshotV1; cwd: string }) => RuntimeLaunchWiring;
  launchStatusSnapshotMaterializer?: LaunchStatusSnapshotMaterializer;
  launchStatusSnapshotReader?: (file: string, signal?: AbortSignal) => Promise<StatusSnapshotV1>;
  launchStatusRefreshClock?: { schedule(callback: () => Promise<void>, intervalMs: number): () => void };
  launchStatusShutdownClock?: { wait(milliseconds: number): Promise<void> };
  launchStatusShutdownDeadlineMs?: number;
}

function statusError(code: "STATUS_SNAPSHOT_PATH_INVALID" | "STATUS_SNAPSHOT_BINDING_INVALID", message: string): MpxError {
  return new MpxError({ code, message, retryable: false });
}
function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function statusBinding(descriptor: LaunchDescriptor, repositoryId: string, snapshot: StatusSnapshotV1): LaunchStatusSnapshotBinding {
  return Object.freeze({ schemaVersion: 1, launchKey: descriptor.launchKey, projectId: snapshot.project.id, repositoryId, worktreeId: snapshot.worktree.id, worktreePath: snapshot.worktree.path });
}

export class NodeLaunchStatusSnapshotMaterializer implements LaunchStatusSnapshotMaterializer {
  constructor(readonly stateRoot: string) {}
  async materialize(input: { binding: LaunchStatusSnapshotBinding; snapshot: StatusSnapshotV1 }, signal?: AbortSignal): Promise<string> {
    try {
      signal?.throwIfAborted();
      if (!path.isAbsolute(this.stateRoot)) throw new Error("state root");
      const rootStat = await lstat(this.stateRoot);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("state root shape");
      const canonicalStateRoot = await realpath(this.stateRoot);
      const statusRoot = path.join(this.stateRoot, "status");
      await mkdir(statusRoot, { recursive: true });
      const statusStat = await lstat(statusRoot), canonicalStatusRoot = await realpath(statusRoot);
      if (statusStat.isSymbolicLink() || !statusStat.isDirectory() || !pathWithin(canonicalStateRoot, canonicalStatusRoot)) throw new Error("status root shape");
      const segments = [sha256Canonical(input.binding.projectId as unknown as JsonValue), sha256Canonical(input.binding.repositoryId as unknown as JsonValue), sha256Canonical(JSON.stringify([input.binding.worktreeId, input.binding.worktreePath]) as unknown as JsonValue), input.binding.launchKey];
      let directory = statusRoot;
      for (const segment of segments) {
        directory = path.join(directory, segment);
        await mkdir(directory, { recursive: true });
        const stat = await lstat(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("status directory shape");
      }
      if (!pathWithin(canonicalStatusRoot, await realpath(directory))) throw new Error("status directory escape");
      const snapshotPath = path.join(directory, "current.json");
      for (const file of [snapshotPath, `${snapshotPath}.binding.json`]) {
        try { if ((await lstat(file)).isSymbolicLink()) throw new Error("status file link"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const bindingPath = `${snapshotPath}.binding.json`;
      const bindingText = JSON.stringify(input.binding);
      signal?.throwIfAborted();
      const bindingTemporary = path.join(directory, `.binding-${randomUUID()}.tmp`);
      try {
        await writeFile(bindingTemporary, bindingText, { encoding: "utf8", mode: 0o600, flag: "wx" });
        try { await link(bindingTemporary, bindingPath); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(bindingPath, "utf8") !== bindingText) throw error; }
      } finally { await rm(bindingTemporary, { force: true }); }
      const temporaryPath = path.join(directory, `.current-${randomUUID()}.tmp`);
      try {
        signal?.throwIfAborted();
        await writeFile(temporaryPath, JSON.stringify(input.snapshot), { encoding: "utf8", mode: 0o600, flag: "wx" });
        signal?.throwIfAborted();
        await rename(temporaryPath, snapshotPath);
      } finally { await rm(temporaryPath, { force: true }); }
      return snapshotPath;
    } catch (error) {
      if (error instanceof MpxError) throw error;
      throw statusError("STATUS_SNAPSHOT_PATH_INVALID", "The MPX private status snapshot location is unsafe.");
    }
  }
}

export async function resolveLaunchStatusSnapshotPath(input: { stateRoot: string; descriptor: LaunchDescriptor; repositoryId: string; snapshot: StatusSnapshotV1; materializer?: LaunchStatusSnapshotMaterializer; signal?: AbortSignal }): Promise<string | undefined> {
  const expected = statusBinding(input.descriptor, input.repositoryId, parseStatusSnapshotV1(input.snapshot));
  const statusRoot = path.join(input.stateRoot, "status");
  let candidate: string | undefined;
  try { candidate = await (input.materializer ?? new NodeLaunchStatusSnapshotMaterializer(input.stateRoot)).materialize({ binding: expected, snapshot: input.snapshot }, input.signal); }
  catch (error) { if (error instanceof MpxError) throw error; throw statusError("STATUS_SNAPSHOT_BINDING_INVALID", "The private status snapshot could not be resolved."); }
  input.signal?.throwIfAborted();
  if (candidate === undefined) return undefined;
  try {
    if (!path.isAbsolute(input.stateRoot) || !path.isAbsolute(candidate) || !pathWithin(statusRoot, candidate)) throw statusError("STATUS_SNAPSHOT_PATH_INVALID", "The private status snapshot path is outside MPX local state.");
    const [rootStat, fileStat, bindingStat] = await Promise.all([lstat(statusRoot), lstat(candidate), lstat(`${candidate}.binding.json`)]);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || fileStat.isSymbolicLink() || !fileStat.isFile() || bindingStat.isSymbolicLink() || !bindingStat.isFile() || bindingStat.size > 16_384) throw statusError("STATUS_SNAPSHOT_PATH_INVALID", "The private status snapshot path is unsafe.");
    const [canonicalRoot, canonicalFile, binding, current] = await Promise.all([realpath(statusRoot), realpath(candidate), readFile(`${candidate}.binding.json`, "utf8").then(text => JSON.parse(text) as unknown), readStatusSnapshotV1(candidate)]);
    if (!pathWithin(canonicalRoot, canonicalFile)) throw statusError("STATUS_SNAPSHOT_PATH_INVALID", "The private status snapshot path escapes MPX local state.");
    if (JSON.stringify(binding) !== JSON.stringify(expected) || current.project.id !== expected.projectId || current.worktree.id !== expected.worktreeId || current.worktree.path !== expected.worktreePath) throw statusError("STATUS_SNAPSHOT_BINDING_INVALID", "The private status snapshot is not bound to this launch.");
    return canonicalFile;
  } catch (error) {
    if (error instanceof MpxError) throw error;
    throw statusError("STATUS_SNAPSHOT_BINDING_INVALID", "The private status snapshot is missing, invalid, or unbound.");
  }
}

type TrustedRuntimeExecutable = { executable: string; argvPrefix: readonly string[] };

const unavailableResult = (): never => { throw new ExecutionError("EXECUTOR_GATE_UNVERIFIED", "Docker execution is gated until runtime containment evidence is available.", { executor: "docker" }); };
const dockerGate: ExecutorAdapter = {
  name: "docker",
  verify: async () => ({ status: "unverified", verifier: "phase-f2-pending", evidenceDigest: sha256Canonical({ executor: "docker", proof: "pending" }) }),
  execute: async () => unavailableResult(),
};

function inheritedProcess(request: ProcessRequest): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.executable, [...request.argv], { cwd: request.cwd, env: { ...request.environment }, shell: false, stdio: "inherit", windowsHide: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ exitCode: code ?? (signal ? 1 : 0), stdout: "", stderr: "", truncated: false }));
  });
}
const hostExecutor: ExecutorAdapter = {
  name: "host",
  verify: async () => ({ status: "verified", verifier: "direct-host", evidenceDigest: sha256Canonical({ executor: "host", invocation: "direct-inherited-stdio" }) }),
  execute: inheritedProcess,
};
const MAX_JS_WRAPPER_BYTES = 131_072;

export function directProcessTty(): DirectTty {
  return {
    direct: Boolean(stdin.isTTY && stdout.isTTY),
    confirm: async message => {
      const terminal = createInterface({ input: stdin, output: stdout });
      try { return (await terminal.question(`${message}\nType YES to continue: `)).trim() === "YES"; }
      finally { terminal.close(); }
    },
  };
}

export function executorAdapter(context: LaunchExecutionContext, name: "docker" | "host"): ExecutorAdapter {
  return context.launchExecutorAdapters?.find(adapter => adapter.name === name) ?? (name === "docker" ? dockerGate : hostExecutor);
}

export async function executorEvidence(context: LaunchExecutionContext, name: "docker" | "host"): Promise<VerificationEvidence> {
  return executorAdapter(context, name).verify();
}

export function runtimeContextFor(descriptor: LaunchDescriptor, manifest: ResolvedManifest, artifact: RuntimeSkillArtifact): RuntimeContextV1 {
  const descriptorArtifact = descriptor.skillArtifact;
  const policyInputsDigest = sha256Canonical({ schemaVersion: 1, manifestKey: manifest.manifestKey, skillArtifactKey: descriptorArtifact.artifactKey } as unknown as JsonValue);
  if(descriptor.intendedPolicy.inputsDigest!==policyInputsDigest || manifest.binding.projectId!==descriptor.binding.projectId || manifest.binding.repositoryId!==descriptor.binding.repositoryId || manifest.binding.contentScope!==descriptor.contentScope.name || artifact.manifestKey!==manifest.manifestKey || artifact.runtime!==descriptor.runtime
    || descriptorArtifact.runtime!==descriptor.runtime || descriptorArtifact.identity!==descriptor.identity.name || descriptorArtifact.skillPolicy!==descriptor.skillPolicy || descriptorArtifact.contentScope!==descriptor.contentScope.name || descriptorArtifact.projectId!==descriptor.binding.projectId) {
    throw new MpxError({code:"LAUNCH_RESTART_REQUIRED",message:"Runtime content or repository bindings changed before invocation.",remediation:"Resolve a new launch and restart the runtime process."});
  }
  return createRuntimeContextV1({
    launchKey: descriptor.launchKey,
    launchDescriptor: { reference: "launch.json", digest: sha256Canonical(descriptor as unknown as JsonValue) },
    manifestKey: manifest.manifestKey,
    runtimeArtifact: artifact.reference,
    binding: manifest.binding,
  });
}

export function currentLaunchTuple(environment: NodeJS.ProcessEnv): { launchKey: string; descriptorDigest: string; manifestKey: string; artifactKey: string; projectionKey: string; launchBinding: RuntimeProjectionLaunchBinding; binding: RuntimeContextV1["binding"] } {
  const raw = environment.MPX_RUNTIME_CONTEXT;
  const rawProjection = environment.MPX_RUNTIME_PROJECTION_REFERENCE;
  if (!raw || !rawProjection) throw new MpxError({ code: "LAUNCH_CONTEXT_REQUIRED", message: "This command requires an immutable process-bound runtime context.", remediation: "Start the runtime through 'mpx launch'." });
  try {
    const context = parseRuntimeContextV1(JSON.parse(raw));
    const projection = JSON.parse(rawProjection) as PublishedRuntimeArtifactReference;
    const launchBinding = projection.launchBinding;
    const immutable=[context.launchKey,context.launchDescriptor.digest,context.manifestKey,context.runtimeArtifact.artifactKey,context.runtimeArtifact.fileMapHash,projection.projectionKey,projection.fileMapHash,launchBinding?.launchKey,launchBinding?.descriptorDigest,launchBinding?.runtimeArtifactKey,launchBinding?.manifestKey];
    if(immutable.some(value=>typeof value!=="string"||!/^[a-f0-9]{64}$/u.test(value)) || !launchBinding || (launchBinding.runtime!=="claude"&&launchBinding.runtime!=="pi") || Object.keys(projection).sort().join(",")!=="fileMapHash,launchBinding,projectionKey" || Object.keys(launchBinding).sort().join(",")!=="descriptorDigest,launchKey,manifestKey,runtime,runtimeArtifactKey" || launchBinding.launchKey!==context.launchKey || launchBinding.descriptorDigest!==context.launchDescriptor.digest || launchBinding.runtimeArtifactKey!==context.runtimeArtifact.artifactKey || launchBinding.runtime!==context.runtimeArtifact.runtime || launchBinding.manifestKey!==context.manifestKey) throw new Error("invalid immutable projection binding");
    return Object.freeze({ launchKey: context.launchKey, descriptorDigest: context.launchDescriptor.digest, manifestKey: context.manifestKey, artifactKey: context.runtimeArtifact.artifactKey, projectionKey: projection.projectionKey, launchBinding: Object.freeze({ ...launchBinding }), binding: Object.freeze({ ...context.binding }) });
  } catch { throw new MpxError({ code: "LAUNCH_CONTEXT_INVALID", message: "The process-bound runtime context is invalid.", remediation: "Relaunch and restart the runtime process." }); }
}

function requiredEnvironment(environment:NodeJS.ProcessEnv,name:string):string {
  const value=environment[name];
  if(!value) throw new MpxError({code:"RUNTIME_PROJECTION_REQUIRED",message:`Trusted runtime input ${name} is required.`,remediation:"Configure the trusted runtime executable, then relaunch."});
  return value;
}
function absoluteRoots(environment: NodeJS.ProcessEnv): readonly string[] {
  const roots = new Set<string>();
  const include = (value: string | undefined): void => {
    if (!value) return;
    const trimmed = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
    if (path.win32.isAbsolute(trimmed) || path.posix.isAbsolute(trimmed)) roots.add(trimmed);
  };
  for (const directory of (environment.PATH ?? environment.Path ?? "").split(path.delimiter)) include(directory);
  include(environment.MPX_APPS);
  include(path.dirname(process.execPath));
  return [...roots];
}
async function inspectExecutable(file: string): Promise<FileInspection> {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) return { file: false, realpath: file };
  const resolved = await realpath(file);
  if (!/\.(?:mjs|cjs|js)$/iu.test(resolved)) return { file: true, realpath: resolved };
  if (stat.size > MAX_JS_WRAPPER_BYTES) throw new Error("wrapper too large");
  return { file: true, realpath: resolved, content: (await readFile(file)).toString("utf8") };
}
async function resolveTrustedRuntimeExecutable(input: { runtime: "claude" | "pi"; cwd: string; environment: NodeJS.ProcessEnv; resolver?: LaunchExecutionContext["launchExecutableResolver"] }): Promise<TrustedRuntimeExecutable> {
  const variable = input.runtime === "claude" ? "MPX_CLAUDE_EXECUTABLE" : "MPX_PI_EXECUTABLE";
  const candidate = requiredEnvironment(input.environment, variable);
  if (input.resolver) return input.resolver({ runtime: input.runtime, candidate, cwd: input.cwd, environment: input.environment });
  return locateTrustedExecutable({ candidates: [candidate], projectRoot: input.cwd, trustedRoots: absoluteRoots(input.environment), nodeExecutable: process.execPath, inspect: inspectExecutable });
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const CLAUDE_MODEL_TOOLS = Object.freeze(["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "Skill", "Task", "WebFetch", "WebSearch", "Write", "dev_server"]);
const PI_MODEL_TOOLS = Object.freeze(["Agent", "bash", "dev_server", "edit", "find", "get_subagent_result", "grep", "ls", "mpx_model_load", "mpx_model_search", "read", "steer_subagent", "write"]);
function authority(name: string, executor: "docker" | "host", routes: readonly string[]): ToolAuthorityV1 {
  return Object.freeze({ schemaVersion: 1, name, executors: Object.freeze([executor]), routes: Object.freeze([...routes]), network: Object.freeze({ mode: "deny-all" as const, destinations: Object.freeze([]) }), paidCredits: Object.freeze({ allowed: false, maxCredits: 0 }), input: Object.freeze({ maxBytes: 1024 * 1024 }), output: Object.freeze({ maxBytes: 1024 * 1024 }), timeout: Object.freeze({ maxMs: 120_000 }), cache: Object.freeze({ mode: "disabled" as const, maxBytes: 0 }) });
}
export interface RuntimeLaunchWiring {
  readonly capability: RuntimeCapabilityManifestV1;
  readonly status: RuntimeStatusEnvelopeV1;
  readonly launchBinding: RuntimeLaunchBinding;
  readonly piProfile?: PiRuntimeProfileV1;
}
export function validateRuntimeLaunchWiring(descriptor: LaunchDescriptor, snapshotInput: StatusSnapshotV1, wiring: RuntimeLaunchWiring): RuntimeLaunchWiring {
  try {
    const snapshot = parseStatusSnapshotV1(snapshotInput), status = parseRuntimeStatusEnvelopeV1(wiring.status);
    validateRuntimeCapabilityBinding(wiring.capability, { manifestKey: wiring.capability.manifestKey, launchKey: descriptor.launchKey, runtime: descriptor.runtime, identity: { ...descriptor.identity, nativeRuntimeRootDigest: descriptor.nativeRuntimeRootDigest }, binding: { ...descriptor.binding, contentScope: descriptor.contentScope.name }, executor: descriptor.executor.name });
    const expectedPorts = [...new Set(snapshot.services.flatMap(service => service.port === null ? [] : [service.port]))].sort((left, right) => left - right);
    const expectedWorktree = snapshot.worktree.path ?? snapshot.project.cwd;
    if (status.binding.launchKey !== descriptor.launchKey || status.binding.runtimeId !== descriptor.runtime || status.binding.repositoryId !== descriptor.binding.repositoryId || status.harness.kind !== descriptor.runtime
      || wiring.launchBinding.launchKey !== descriptor.launchKey || wiring.launchBinding.runtime !== descriptor.runtime || wiring.launchBinding.executor !== descriptor.executor.name
      || wiring.launchBinding.identity.name !== descriptor.identity.name || wiring.launchBinding.identity.domain !== descriptor.identity.domain
      || path.resolve(wiring.launchBinding.worktreeRoot) !== path.resolve(expectedWorktree) || JSON.stringify(wiring.launchBinding.assignedPorts) !== JSON.stringify(expectedPorts)) throw new Error("stale runtime wiring");
    const required = descriptor.runtime === "pi" ? PI_MODEL_TOOLS : [...CLAUDE_MODEL_TOOLS, ...descriptor.routes.mcp.allow.map(label => `mcp:${label}`)];
    const admitted = new Set(wiring.capability.tools.map(tool => tool.name));
    if (required.some(tool => !admitted.has(tool))) throw new Error("missing tool authority");
    return wiring;
  } catch {
    throw new MpxError({ code: "LAUNCH_RESTART_REQUIRED", message: "Runtime capability or status bindings changed before invocation.", remediation: "Resolve a new launch and restart the runtime process." });
  }
}
function runtimeWiring(descriptor: LaunchDescriptor, artifact: RuntimeSkillArtifact, snapshotInput: StatusSnapshotV1, cwd: string): RuntimeLaunchWiring {
  const snapshot = parseStatusSnapshotV1(snapshotInput);
  const routes = Object.freeze([`git:${descriptor.routes.gitAuthor}`, ...Object.entries(descriptor.routes.providers).map(([provider, label]) => `provider-${provider}:${label}`), ...(descriptor.routes.ssh ? [`ssh:${descriptor.routes.ssh}`] : []), ...descriptor.routes.mcp.allow.map(label => `mcp:${label}`)].sort());
  const modelTools = descriptor.runtime === "pi" ? PI_MODEL_TOOLS : Object.freeze([...CLAUDE_MODEL_TOOLS, ...descriptor.routes.mcp.allow.map(label => `mcp:${label}`)]);
  const worktreeRoot = snapshot.worktree.path ?? cwd;
  const assignedPorts = Object.freeze([...new Set(snapshot.services.flatMap(service => service.port === null ? [] : [service.port]))].sort((left, right) => left - right));
  const piProfile = descriptor.runtime === "pi" ? createPiRuntimeProfileV1(PI_CAPABILITY_IDS) : undefined;
  const capability = createRuntimeCapabilityManifestV1({
    runtime: descriptor.runtime, launchKey: descriptor.launchKey, identity: { ...descriptor.identity, nativeRuntimeRootDigest: descriptor.nativeRuntimeRootDigest },
    binding: { ...descriptor.binding, contentScope: descriptor.contentScope.name }, executor: descriptor.executor.name,
    tools: modelTools.map(name => authority(name, descriptor.executor.name, name.startsWith("mcp:") ? routes.filter(route => route.startsWith("mcp:")) : [])), routes,
    resources: [...new Set([...Object.keys(descriptor.intendedPolicy.resources), ...descriptor.grants.map(grant => grant.resource)])],
    mounts: [`worktree:${sha256Canonical((path.resolve(worktreeRoot).replaceAll("\\", "/")) as unknown as JsonValue)}`], destinations: [],
    skills: artifact.entries.filter(entry => entry.permissions.modelInvocation).map(entry => entry.identity),
    models: piProfile ? piProfile.models : ["haiku", "opus", "sonnet"], nesting: { depth: 0, maxDepth: 2 },
  });
  const observedAt = new Date().toISOString();
  const freshness = Object.freeze({ state: "current" as const, observedAt, errorCode: null });
  const unavailable = Object.freeze({ state: "unavailable" as const, observedAt: null, errorCode: null });
  const binding = Object.freeze({ launchKey: descriptor.launchKey, runtimeId: descriptor.runtime, repositoryId: descriptor.binding.repositoryId });
  const status = composeRuntimeStatusEnvelopeV1({ generatedAt: observedAt, binding, harness: descriptor.runtime === "claude" ? { kind: "claude", version: null, surface: "statusline" } : { kind: "pi", version: null, surface: "footer" }, contributions: [{ source: "launch", binding, groups: {
    identity: { freshness, profile: descriptor.identity.name === "personal" || descriptor.identity.name === "work" ? descriptor.identity.name : null, label: descriptor.identity.name === "personal" ? "Personal" : descriptor.identity.name === "work" ? "Work" : null },
    location: { freshness, label: snapshot.worktree.role ?? "project" },
    development: { freshness, services: snapshot.services.map(service => ({ id: service.id, state: service.conflict !== "none" ? "conflict" : service.listening ? "listening" : "stopped", port: service.port })) },
    actions: { freshness: unavailable, items: [] },
  } }] });
  const launchBinding = deepFreeze({ launchKey: descriptor.launchKey, runtime: descriptor.runtime, identity: { ...descriptor.identity }, worktreeRoot, assignedPorts: [...assignedPorts], executor: descriptor.executor.name });
  return validateRuntimeLaunchWiring(descriptor, snapshot, deepFreeze({ capability, status: parseRuntimeStatusEnvelopeV1(status), launchBinding, ...(piProfile ? { piProfile } : {}) }));
}

async function buildProductionProjection(input:LaunchProjectionBuildInput):Promise<LaunchProjection> {
  if(input.descriptor.runtime==="pi") return buildPiProjection({manifest:input.manifest,artifact:input.artifact,catalog:input.catalog,canonicalRoot:input.canonicalRoot,context:input.runtimeContext,expectedLaunch:{launchKey:input.descriptor.launchKey,descriptorDigest:input.runtimeContext.launchDescriptor.digest},currentBinding:input.manifest.binding,artifactsRoot:input.artifactsRoot,statusSnapshot:input.statusSnapshot,runtimeStatusEnvelope:input.runtimeStatusEnvelope,runtimeCapabilityManifest:input.runtimeCapabilityManifest,runtimeLaunchBinding:{...input.runtimeLaunchBinding,runtime:"pi"},launchBanner:input.launchBanner,...(input.artifactRevalidator?{artifactRevalidator:input.artifactRevalidator}:{})});
  return publishClaudeProjection({manifest:input.manifest,artifact:input.artifact,catalog:input.catalog,canonical:input.canonicalRoot,agents:input.agentsRoot,artifactsRoot:input.artifactsRoot,statusSnapshot:input.statusSnapshot,runtimeStatusEnvelope:input.runtimeStatusEnvelope,launchBanner:input.launchBanner,runtimeContext:input.runtimeContext,...(input.artifactRevalidator?{artifactRevalidator:input.artifactRevalidator}:{})});
}
function productionRuntimeAdapters(input:{descriptor:LaunchDescriptor;cwd:string;environment:NodeJS.ProcessEnv;nativeRuntimeRoot:string;stateRoot:string;projectionInput:Omit<LaunchProjectionBuildInput,"statusSnapshot"|"launchBanner">;launchBanner:string;statusSnapshot:(signal?:AbortSignal)=>Promise<StatusSnapshotV1>;bindStatusPath:(value:string|undefined)=>void;statusMaterializer?:LaunchStatusSnapshotMaterializer;trustedExecutable?:TrustedRuntimeExecutable;builder?:LaunchExecutionContext["launchProjectionBuilder"];validator?:LaunchExecutionContext["launchProjectionValidator"]}):RuntimeAdapter[] {
  const projection=async(runtime:"claude"|"pi")=>{
    const snapshot=parseStatusSnapshotV1(await input.statusSnapshot());
    const statusSnapshotPath=await resolveLaunchStatusSnapshotPath({stateRoot:input.stateRoot,descriptor:input.descriptor,repositoryId:input.projectionInput.manifest.binding.repositoryId,snapshot,...(input.statusMaterializer?{materializer:input.statusMaterializer}:{})});
    input.bindStatusPath(statusSnapshotPath);
    const customBuilder=input.builder!==undefined;
    const built=await (input.builder??buildProductionProjection)({ ...input.projectionInput, statusSnapshot: snapshot, launchBanner: input.launchBanner });
    const expectedBinding={launchKey:input.projectionInput.runtimeContext.launchKey,descriptorDigest:input.projectionInput.runtimeContext.launchDescriptor.digest,runtimeArtifactKey:input.projectionInput.artifact.reference.artifactKey,runtime,manifestKey:input.projectionInput.manifest.manifestKey};
    if(JSON.stringify(built.reference.launchBinding)!==JSON.stringify(expectedBinding)) throw new MpxError({code:"LAUNCH_RESTART_REQUIRED",message:"The runtime projection does not match the selected launch binding.",remediation:"Rebuild the projection and restart the runtime process."});
    if(customBuilder) {
      if(input.validator) await input.validator({runtime,directory:built.directory,reference:built.reference});
      else {
        const validation=await revalidateRuntimeArtifact(built.directory,built.reference);
        if(!validation.valid) throw new MpxError({code:"LAUNCH_RESTART_REQUIRED",message:"The immutable runtime projection changed before invocation.",remediation:"Rebuild the projection and restart the runtime process."});
      }
    }
    return {built,statusSnapshotPath};
  };
  if (input.descriptor.runtime === "claude") return [{runtime:"claude",modelTriggerableTools:CLAUDE_MODEL_TOOLS,prepare:async({routes})=>{
    if (!input.trustedExecutable) throw new ExecutionError("TRUSTED_EXECUTABLE_NOT_FOUND", "No trusted absolute runtime executable or Node entry was found.");
    const projectionResult=await projection("claude"),built=projectionResult.built,pluginDirectory=built.pluginDirectory??built.directory;
    const mcpConfigPaths=input.descriptor.routes.mcp.allow.map(label=>routes[`mcp:${label}`]!);
    const plan=createClaudeInvocationPlan({executable:input.trustedExecutable.executable,pluginDirectory,accountRoot:input.nativeRuntimeRoot,runtimeContext:input.projectionInput.runtimeContext,projectionReference:built.reference,environment:input.environment,...(mcpConfigPaths.length?{mcpConfigPaths}:{}),...(projectionResult.statusSnapshotPath?{statusSnapshotPath:projectionResult.statusSnapshotPath}:{})});
    return {executable:plan.executable,argv:[...input.trustedExecutable.argvPrefix,...plan.args],environment:plan.env};
  }}];
  return [{runtime:"pi",modelTriggerableTools:PI_MODEL_TOOLS,prepare:async()=>{
    if (!input.trustedExecutable) throw new ExecutionError("TRUSTED_EXECUTABLE_NOT_FOUND", "No trusted absolute runtime executable or Node entry was found.");
    const projectionResult=await projection("pi"),built=projectionResult.built;
    if(!built.extension||!built.runtimeContextFile) throw new MpxError({code:"RUNTIME_PROJECTION_INVALID",message:"The Pi projection is incomplete."});
    const plan=planPiInvocation({executable:input.trustedExecutable.executable,extension:built.extension,theme:built.theme==="amber"?"amber":"green",accountRoot:input.nativeRuntimeRoot,runtimeContextFile:built.runtimeContextFile,runtimeContext:input.projectionInput.runtimeContext,projectionReference:built.reference,cwd:input.cwd,immutableProjectionDirectory:built.directory,...(projectionResult.statusSnapshotPath?{statusSnapshotPath:projectionResult.statusSnapshotPath}:{})});
    return {executable:plan.executable,argv:[...input.trustedExecutable.argvPrefix,...plan.args],environment:plan.env};
  }}];
}
function registries(context: LaunchExecutionContext, descriptor: LaunchDescriptor, defaults:readonly RuntimeAdapter[], selectedExecutor?:ExecutorAdapter): { executors: ExecutorRegistry; runtimes: RuntimeAdapterRegistry } {
  const executors = new ExecutorRegistry(); executors.register(selectedExecutor ?? executorAdapter(context, descriptor.executor.name));
  const runtimes = new RuntimeAdapterRegistry();
  for (const adapter of context.launchRuntimeAdapters ?? defaults) runtimes.register(adapter);
  return { executors, runtimes };
}

export async function executeResolvedLaunch(input: {
  descriptor: LaunchDescriptor;
  manifest: ResolvedManifest;
  artifact: RuntimeSkillArtifact;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  context: LaunchExecutionContext;
  tty?: DirectTty;
  nativeRuntimeRoot:string;
  catalog:readonly CatalogSkill[];
  canonicalRoot:string;
  agentsRoot:string;
  artifactsRoot:string;
  stateRoot:string;
  statusSnapshot: (signal?: AbortSignal)=>Promise<StatusSnapshotV1>;
}): Promise<ProcessResult> {
  const runtimeContext = runtimeContextFor(input.descriptor, input.manifest, input.artifact);
  const adapter=executorAdapter(input.context,input.descriptor.executor.name), currentEvidence=await adapter.verify();
  if(!sameVerificationEvidence(currentEvidence,input.descriptor.executorVerification)) throw new ExecutionError("LAUNCH_RESTART_REQUIRED","Executor verification evidence changed before invocation.",{restartRequired:true});
  if (input.context.launchExpectedKey !== undefined && input.context.launchExpectedKey !== input.descriptor.launchKey) throw new ExecutionError("LAUNCH_RESTART_REQUIRED", "Launch rights or binding changed; create a new launch and restart.", { restartRequired: true });
  if (!input.context.launchRoutes) throw new ExecutionError("PRIVATE_ROUTE_MATERIALIZER_REQUIRED", "Trusted private-route materialization is required before launch.");
  if (currentEvidence.status === "unavailable") throw new ExecutionError("EXECUTOR_UNAVAILABLE", `Executor '${adapter.name}' is unavailable.`, { executor: adapter.name });
  if (currentEvidence.status !== "verified") throw new ExecutionError("EXECUTOR_GATE_UNVERIFIED", `Executor '${adapter.name}' has not been verified.`, { executor: adapter.name });
  const trustedExecutable = input.context.launchRuntimeAdapters || currentEvidence.status !== "verified"
    ? undefined
    : await resolveTrustedRuntimeExecutable({ runtime: input.descriptor.runtime, cwd: input.cwd, environment: input.environment, resolver: input.context.launchExecutableResolver });
  const materializedRoutes = await input.context.launchRoutes.materialize(input.descriptor, input.cwd);
  const initialSnapshot = parseStatusSnapshotV1(await input.statusSnapshot());
  const wiring = validateRuntimeLaunchWiring(input.descriptor, initialSnapshot, input.context.launchRuntimeWiringFactory?.({ descriptor: input.descriptor, artifact: input.artifact, snapshot: initialSnapshot, cwd: input.cwd }) ?? runtimeWiring(input.descriptor, input.artifact, initialSnapshot, input.cwd));
  const projectionInput={descriptor:input.descriptor,manifest:input.manifest,artifact:input.artifact,catalog:input.catalog,canonicalRoot:input.canonicalRoot,agentsRoot:input.agentsRoot,artifactsRoot:input.artifactsRoot,runtimeContext,runtimeStatusEnvelope:wiring.status,runtimeCapabilityManifest:wiring.capability,runtimeLaunchBinding:wiring.launchBinding,...(wiring.piProfile?{piRuntimeProfile:wiring.piProfile}:{}),...(input.context.launchProjectionArtifactRevalidator?{artifactRevalidator:input.context.launchProjectionArtifactRevalidator}:{})};
  let boundStatusPath:string|undefined;
  const processAdapter:ExecutorAdapter=input.context.launchRuntimeAdapters ? adapter : {name:adapter.name,verify:()=>adapter.verify(),execute:async request=>{
    let stopped=false, containmentExpired=false, pending:Promise<void>|undefined;
    const refreshAbort=new AbortController();
    const safeRefresh=async():Promise<void>=>{
      if(stopped||!boundStatusPath) return;
      if(pending) return pending;
      const work=(async()=>{
        try {
          const snapshot=parseStatusSnapshotV1(await input.statusSnapshot(refreshAbort.signal));
          if(stopped) return;
          const refreshed=await resolveLaunchStatusSnapshotPath({stateRoot:input.stateRoot,descriptor:input.descriptor,repositoryId:input.manifest.binding.repositoryId,snapshot,signal:refreshAbort.signal,...(input.context.launchStatusSnapshotMaterializer?{materializer:input.context.launchStatusSnapshotMaterializer}:{})});
          if(refreshed!==boundStatusPath) throw statusError("STATUS_SNAPSHOT_BINDING_INVALID","The refreshed private status snapshot changed its launch binding.");
        } catch {
          if(containmentExpired||!boundStatusPath) return;
          try {
            const lastValid = await (input.context.launchStatusSnapshotReader ?? readStatusSnapshotV1)(boundStatusPath,refreshAbort.signal);
            if(containmentExpired) return;
            const failed = parseStatusSnapshotV1({ ...lastValid, portResolution:"invalid", diagnostics:[{code:"STATUS_REFRESH_FAILED",severity:"error",message:"Live status refresh failed.",serviceId:null}] });
            await resolveLaunchStatusSnapshotPath({stateRoot:input.stateRoot,descriptor:input.descriptor,repositoryId:input.manifest.binding.repositoryId,snapshot:failed,signal:refreshAbort.signal,...(input.context.launchStatusSnapshotMaterializer?{materializer:input.context.launchStatusSnapshotMaterializer}:{})});
          } catch { /* The child retains the last atomically complete status file. */ }
        }
      })();
      pending=work.finally(()=>{ pending=undefined; });
      return pending;
    };
    const clock=input.context.launchStatusRefreshClock??{schedule:(callback:()=>Promise<void>,intervalMs:number)=>{const timer=setInterval(()=>{void callback();},intervalMs);timer.unref?.();return()=>clearInterval(timer);}};
    const cancel=clock.schedule(safeRefresh,1_000);
    try{return await adapter.execute({...request,environment:Object.freeze({...request.environment,...(boundStatusPath?{MPX_STATUS_SNAPSHOT_FILE:boundStatusPath}:{})})});}
    finally{
      stopped=true;
      cancel();
      refreshAbort.abort();
      const completion=pending?.catch(()=>undefined);
      if(completion){
        // Status I/O is cooperative, so one second is the final containment bound for non-cooperative injected or platform work.
        const deadlineMs=input.context.launchStatusShutdownDeadlineMs??1_000;
        let deadlineTimer:NodeJS.Timeout|undefined;
        const deadline=input.context.launchStatusShutdownClock?.wait(deadlineMs)??new Promise<void>(resolve=>{deadlineTimer=setTimeout(resolve,deadlineMs);});
        const outcome=await Promise.race([completion.then(()=>"complete" as const),deadline.then(()=>"deadline" as const,()=>"deadline" as const)]);
        if(deadlineTimer) clearTimeout(deadlineTimer);
        containmentExpired=outcome==="deadline";
      }
    }
  }};
  const selected = registries(input.context,input.descriptor,productionRuntimeAdapters({descriptor:input.descriptor,cwd:input.cwd,environment:input.environment,nativeRuntimeRoot:input.nativeRuntimeRoot,stateRoot:input.stateRoot,projectionInput,launchBanner:compactLaunchBanner(input.descriptor),statusSnapshot:async()=>initialSnapshot,bindStatusPath:value=>{boundStatusPath=value;},...(input.context.launchStatusSnapshotMaterializer?{statusMaterializer:input.context.launchStatusSnapshotMaterializer}:{}),...(trustedExecutable ? { trustedExecutable } : {}),...(input.context.launchProjectionBuilder?{builder:input.context.launchProjectionBuilder}:{}),...(input.context.launchProjectionValidator?{validator:input.context.launchProjectionValidator}:{})}),processAdapter);
  const approvals = new HostApprovalStore();
  const service = new ExecutionService({ ...selected, routes: { materialize: async () => materializedRoutes }, ...(input.context.launchAudit ? { audit: input.context.launchAudit } : {}), approvals });
  let hostApproval;
  const tty = input.tty;
  const environment=Object.fromEntries(Object.entries(input.environment).filter((entry):entry is [string,string]=>entry[1]!==undefined));
  if (input.descriptor.executor.name === "host") {
    if (!tty?.direct) throw new ExecutionError("HOST_TTY_REQUIRED", "Host execution requires a direct TTY.");
    const nonce = sha256Canonical({ launchKey: input.descriptor.launchKey, runtimeContext } as unknown as JsonValue);
    hostApproval = await approvals.approve(service.hostApprovalRequest({ descriptor: input.descriptor, cwd: input.cwd, environment, ...(input.context.launchExpectedKey ? { expectedLaunchKey: input.context.launchExpectedKey } : {}) }, nonce), tty);
  }
  return service.execute({ descriptor: input.descriptor, artifact: input.artifact.reference, capability: wiring.capability, runtimeStatusEnvelope: wiring.status, runtimeLaunchBinding: wiring.launchBinding, cwd: input.cwd, environment: { ...environment, MPX_RUNTIME_CONTEXT: JSON.stringify(runtimeContext) }, privateLaunch: { launchKey: input.descriptor.launchKey, runtime: input.descriptor.runtime, identity: input.descriptor.identity, nativeRuntimeRoot: input.nativeRuntimeRoot }, ...(input.context.launchExpectedKey ? { expectedLaunchKey: input.context.launchExpectedKey } : {}), ...(hostApproval ? { hostApproval, tty } : {}) });
}

export function executionMpxError(error: ExecutionError): MpxError {
  const restart = error.code === "LAUNCH_RESTART_REQUIRED" || error.details?.restartRequired === true;
  const capabilityRemediation = error.code === "RUNTIME_CAPABILITY_UNSUPPORTED" && typeof error.details?.remediation === "string" ? error.details.remediation : undefined;
  return new MpxError({ code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}), ...(restart ? { remediation: "Create a new launch and restart the runtime process; current-process rights cannot be widened." } : capabilityRemediation ? { remediation: capabilityRemediation } : {}) });
}
