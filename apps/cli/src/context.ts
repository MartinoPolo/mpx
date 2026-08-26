import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, mkdir, opendir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MpxError } from "@mpx/core";
import { isSafeRouteLabel, loadUserConfig, preparationPlan, type PreparationPlan, type ProjectConfig } from "@mpx/config";
import { PortService, RealGitWorktreeAdapter, RegistryStore } from "@mpx/ports";
import { createStatusProvider, type StatusProvider } from "@mpx/status";
import { createGitHubAdapters } from "@mpx/provider-github";
import { createGitLabAdapters } from "@mpx/provider-gitlab";
import { createKanbanFlowAdapter } from "@mpx/provider-kanbanflow";
import { createLocalIssueAdapter, LocalIssueStore, rebuildObsidianIssueViews } from "@mpx/provider-local";
import { BUILTIN_PROVIDERS, ProviderRegistry, ProviderService, providerRegistry, type ProviderAdapter, type ProviderDescriptor, type ProviderProcessExecutor, type ProviderProcessRequest, type ProviderProcessResult } from "@mpx/providers";
import { WindowsPortPlatformAdapter, WindowsProcessCapabilities } from "@mpx/windows";
import { FileMruStore, NodePreparationEvidenceAdapter, NodePreparationExecutionAdapter, NodePreparationProcessAdapter, NodePreparationStore, PreparationEngine, WorktreeLifecycleService, awaitBackgroundPreparationActivation, createNodeLifecycleFoundation, createNodeWorktreeIncludeDependencies, assertLifecycleStateIdentity, deriveLifecycleKey, sameLifecyclePath, createPreparationApproval, executeWorktreeIncludePlan, listWorktrees, nodePreparationPaths, planWorktreeIncludes, preparationApprovalPhrases, resolvePreparationPackageManager, resolveRepository, selectWorktree, type ConfiguredPackageManager, type FileSystemAdapter, type GitAdapter, type PackageManager, type PreparationAdapters } from "@mpx/worktrees";
import { sha256Canonical, type JsonValue } from "@mpx/core";
import { canonicalNativeRootDigest, parseLaunchDescriptorV2, type LaunchDescriptor } from "@mpx/launch";
import { FileLaunchAuditStore, SBX_V0_39_0_PIN, diagnoseSbx, resolveTrustedSbxExecutable, type BoundedProcessRunner, type F2SandboxSessionResumeAdmission, type LaunchAuditStartRecord, type LaunchAuditStore, type LaunchAuditTerminalRecord, type RouteMaterializer } from "@mpx/executors";
import type { LaunchExecutionContext } from "./launch-execution.js";
import type { SbxExecutionDependencies } from "./sbx-execution.js";
import type { CliDevService } from "./dev-command.js";
import { ClaudeActiveScanner, PiV2ActiveRegistryScanner, SessionStore, deriveNativeBindingRef, type BranchArgvExecutionAdapter, type ConversationBranchService, type IdentityV1, type ProcessInspector, type ResumeDependencies, type ResumePlanV1, type RootAttestationService, type RuntimeDiscovery, type SessionProcessInspector, type SessionRecordV1 } from "@mpx/sessions";
import type { AccountAuthVerifier } from "./account-command.js";
import { InstallOrchestrator, InstallerService, NodeCurrentReleaseBuilder, NodeReceiptStore, NodeRunnerFileVerifier, NodeTransactionStore, ProductionInstallerOperationAdapter, type InstallerOperationAdapter, type TransactionStore } from "@mpx/installer";
import { WindowsScheduledTaskAdapter } from "@mpx/windows";
import { PiResumeTargetError, verifyPiResumeTarget } from "@mpx/runtime-pi";
import { createProductionSessionDockerResumeAdmission } from "./session-docker-resume.js";

export type CliPortService = Pick<PortService, "ensure" | "resolve" | "list" | "inspect" | "kill" | "release" | "reconcile" | "rebuild" | "captureReleaseIdentity" | "releaseLinkedAfterRemoval" | "resolveOrphan">;
export interface CliWorktreeService {
  create(request: Record<string, unknown>): Promise<unknown>;
  remove(request: Record<string, unknown>): Promise<unknown>;
  list(request: {cwd:string}): Promise<unknown>;
  select(request: {cwd:string;path:string}): Promise<{path:string}>;
  status(request: {cwd:string}): Promise<unknown>;
  prepare(request: Record<string, unknown>): Promise<unknown>;
  cancel(request: Record<string, unknown>): Promise<unknown>;
  reconcile(request: Record<string, unknown>): Promise<unknown>;
}

export interface CliProviderService {
  invoke(request: { providerId: string; capability: string; route?: string; input: JsonValue }): Promise<unknown>;
}

export interface CliRepositorySelectorResolver {
  resolve(request: { root: string; remote: string }): Promise<string>;
}

export interface NativeAccountBindingVerifier {
  verify(accountBindingRef: string): Promise<"verified" | "unavailable" | "mismatch" | "duplicate">;
}
export interface NativeAccountBindingResolver {
  resolve(identity: IdentityV1, runtime: "claude" | "pi", nativeRoot: string): Promise<string | null>;
}

export interface CliContext extends LaunchExecutionContext {
  env: NodeJS.ProcessEnv;
  catalogRoot?: string;
  accessFile?: (file: string) => Promise<void>;
  portService?: CliPortService;
  portServiceFactory?: (stateRoot: string) => CliPortService;
  statusProvider?: StatusProvider;
  statusProviderFactory?: (portService: CliPortService) => StatusProvider;
  worktreeService?: CliWorktreeService;
  worktreeServiceFactory?: (stateRoot: string, portService: CliPortService, operationCwd: string) => CliWorktreeService;
  preparationRuntimeFactory?: (stateRoot: string, environment: NodeJS.ProcessEnv) => CliPreparationRuntime;
  providerService?: CliProviderService;
  devService?: CliDevService;
  providerProcessExecutor?: ProviderProcessExecutor;
  repositorySelectorResolver?: CliRepositorySelectorResolver;
  /** Test seam for the standalone-sbx process transport; production requires no injection. */
  launchSbxExecutionDependencies?: SbxExecutionDependencies;
  /** Optional read-only standalone sbx probe. It must never start or reset the daemon. */
  sbxDiagnostics?: () => Promise<{ readonly available: boolean; readonly failureCodes: readonly string[]; readonly readOnly: true }>;
  sessionStore?: SessionStore;
  sessionStoreFactory?: (stateRoot: string) => SessionStore;
  sessionDiscoveries?: () => Promise<readonly { scanner: RuntimeDiscovery; context?: { identity: IdentityV1; nativeBindingRef: string; runtime: "claude" | "pi" } }[]>;
  sessionProcessInspector?: SessionProcessInspector;
  sessionResumeDependencies?: (record: SessionRecordV1) => Promise<ResumeDependencies>;
  nativeAccountBindingVerifier?: NativeAccountBindingVerifier;
  nativeAccountBindingResolver?: NativeAccountBindingResolver;
  rootAttestationService?: RootAttestationService;
  accountAuthVerifier?: AccountAuthVerifier;
  sessionResumeExecutor?: (plan: ResumePlanV1) => Promise<unknown>;
  sessionBranchService?: ConversationBranchService;
  /** Argv-only process transports. No command strings or shell execution are accepted. */
  sessionBranchRuntimeAdapter?: BranchArgvExecutionAdapter;
  sessionBranchTerminalAdapter?: BranchArgvExecutionAdapter;
  /** Application-owned F2 proof/state adapter. It plans admission before any resume side effect. */
  sessionDockerResumeAdmission?: (plan: ResumePlanV1) => Promise<F2SandboxSessionResumeAdmission>;
  scheduledCaptureAuthority?: { inspect(): Promise<Readonly<{ installed: boolean; authorityDigest: string | null }>> };
  installerService?: InstallerService;
  installerServiceFactory?: (stateRoot: string) => InstallerService;
  installOrchestrator?: InstallOrchestrator;
  installerOperationAdapter?: InstallerOperationAdapter;
  installerTransactionStore?: TransactionStore;
  /** Application-owned trusted extensions; never populated from project configuration. */
  trustedProviderComposition?: Readonly<{ descriptors: readonly ProviderDescriptor[]; adapters: readonly ProviderAdapter[] }>;
}

async function sha256File(file:string):Promise<string>{const hash=createHash("sha256");for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest("hex")}
export async function createDefaultSbxDiagnostics(environment:NodeJS.ProcessEnv,operationCwd:string):Promise<{readonly available:boolean;readonly failureCodes:readonly string[];readonly readOnly:true}>{
 const value=(name:string):string|undefined=>Object.entries(environment).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1];
 const pathDirectories=(value("PATH")??"").split(path.delimiter).filter(directory=>path.isAbsolute(directory));
 const configured=value("MPX_SBX_EXECUTABLE");
 const candidates=[...(configured?[configured]:[]),...pathDirectories.flatMap(directory=>[path.join(directory,"sbx.exe")])];
 const trustedRoots=[...(configured&&path.isAbsolute(configured)?[path.dirname(configured)]:[]),...pathDirectories,...(value("MPX_APPS")?[value("MPX_APPS")!]:[]),...(value("LOCALAPPDATA")?[path.join(value("LOCALAPPDATA")!,"DockerSandboxes","bin")]:[])].filter(root=>path.isAbsolute(root));
 let executable:string|undefined;
 try{executable=await resolveTrustedSbxExecutable({candidates,projectRoot:operationCwd,trustedRoots,expectedSha256:SBX_V0_39_0_PIN.windowsBinarySha256,inspect:async file=>{const info=await lstat(file),canonical=await realpath(file);return {file:info.isFile()&&!info.isSymbolicLink(),realpath:canonical,sha256:await sha256File(canonical)}}})}catch{return {available:false,failureCodes:["SBX_NOT_FOUND"],readOnly:true}}
 const probeEnvironment=Object.fromEntries(["SYSTEMROOT","WINDIR","LOCALAPPDATA","APPDATA","USERPROFILE","TEMP","TMP"].flatMap(name=>value(name)===undefined?[]:[[name,value(name)!]]));
 const runner:BoundedProcessRunner={run:request=>new Promise((resolve,reject)=>{execFile(request.executable,[...request.argv],{cwd:request.cwd,env:probeEnvironment,timeout:request.timeoutMs,maxBuffer:request.maxOutputBytes,windowsHide:true},(error,stdout,stderr)=>{const code=error&&typeof (error as {code?:unknown}).code==="number"?(error as {code:number}).code:0;if(error&&typeof (error as {code?:unknown}).code!=="number")reject(error);else resolve({exitCode:code,stdout,stderr,truncated:false})})})};
 return diagnoseSbx({executable,cwd:operationCwd,runner,pin:SBX_V0_39_0_PIN});
}

const builtInProviderExecutables = new Set(["gh", "glab", "kf"]);
const providerProcessTimeoutMilliseconds = 120_000;
const providerProcessMaxBufferBytes = 10 * 1024 * 1024;
const safeRepositorySegment = /^[A-Za-z0-9_.][A-Za-z0-9._-]*$/u;
const safeRemoteName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

type ExecutableResolver = (executable: string, operationCwd: string, environment: NodeJS.ProcessEnv) => Promise<string>;

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function resolutionError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function isWithin(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function resolveTrustedExecutableOnPath(executable: string, operationCwd: string, environment: NodeJS.ProcessEnv): Promise<string> {
  if (!path.isAbsolute(operationCwd)) throw resolutionError("EINVAL", "The operation cwd must be absolute.");
  const canonicalOperationCwd = await realpath(operationCwd);
  const pathValue = environmentValue(environment, "PATH") ?? "";
  const pathExtensions = process.platform === "win32"
    ? ["", ...(environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map(extension => extension.startsWith(".") ? extension : `.${extension}`)]
    : [""];

  for (const rawDirectory of pathValue.split(path.delimiter)) {
    const directory = rawDirectory.startsWith('"') && rawDirectory.endsWith('"') ? rawDirectory.slice(1, -1) : rawDirectory;
    if (!path.isAbsolute(directory)) continue;
    for (const extension of pathExtensions) {
      const candidate = path.join(directory, `${executable}${extension}`);
      try {
        if (!(await stat(candidate)).isFile()) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
        throw error;
      }
      const canonicalCandidate = await realpath(candidate);
      if (isWithin(canonicalOperationCwd, canonicalCandidate)) throw resolutionError("EACCES", "Executables inside the operation cwd are not trusted.");
      return canonicalCandidate;
    }
  }
  throw resolutionError("ENOENT", "The trusted executable was not found on PATH.");
}

export async function resolveBuiltInProviderExecutable(executable: string, operationCwd: string, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (!builtInProviderExecutables.has(executable)) throw resolutionError("EINVAL", "The provider executable is not a trusted built-in.");
  return resolveTrustedExecutableOnPath(executable, operationCwd, environment);
}

export function classifyProviderProcessResult(error: unknown, stdout: string, stderr: string, authExitCodes: readonly number[] = []): ProviderProcessResult {
  if (error !== null && error !== undefined) {
    const exitCode = (error as { code?: unknown }).code;
    if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode < 0) throw error;
    return { exitCode, stdout, stderr, ...(authExitCodes.includes(exitCode) ? { failure: "auth" as const } : {}) };
  }
  return { exitCode: 0, stdout, stderr };
}

function routeBoundEnvironment(environment: NodeJS.ProcessEnv, executable: string, route: string | undefined): NodeJS.ProcessEnv {
  if (route === undefined || !isSafeRouteLabel(route)) throw resolutionError("EINVAL", "A safe provider route is required.");
  const appData = environmentValue(environment, "APPDATA");
  if (!appData || !path.isAbsolute(appData)) throw resolutionError("EINVAL", "APPDATA must be an absolute path for provider authentication.");
  const isolatedEntries = Object.entries(environment).filter(([key]) => !["gh_config_dir", "glab_config_dir", "mpx_provider_route"].includes(key.toLowerCase()));
  const result: NodeJS.ProcessEnv = { ...Object.fromEntries(isolatedEntries), MPX_PROVIDER_ROUTE: route };
  const runtimeBound = environmentValue(environment, "MPX_RUNTIME_CONTEXT") !== undefined;
  if (executable === "gh") {
    const injected = environmentValue(environment, "MPX_RUNTIME_ROUTE_PROVIDER_GITHUB");
    if (runtimeBound && (!injected || !path.isAbsolute(injected))) throw resolutionError("EINVAL", "The exact launch-injected GitHub route is required.");
    result.GH_CONFIG_DIR = runtimeBound ? injected! : path.join(appData, "mpx", "provider-routes", "github", route);
  }
  if (executable === "glab") {
    const injected = environmentValue(environment, "MPX_RUNTIME_ROUTE_PROVIDER_GITLAB");
    if (runtimeBound && (!injected || !path.isAbsolute(injected))) throw resolutionError("EINVAL", "The exact launch-injected GitLab route is required.");
    result.GLAB_CONFIG_DIR = runtimeBound ? injected! : path.join(appData, "mpx", "provider-routes", "gitlab", route);
  }
  return result;
}

export class NodeProviderProcessExecutor implements ProviderProcessExecutor {
  readonly #resolutionCache = new Map<string, string>();

  constructor(private readonly environment: NodeJS.ProcessEnv = process.env, private readonly executableResolver: ExecutableResolver = resolveBuiltInProviderExecutable) {}

  async execute(request: ProviderProcessRequest): Promise<ProviderProcessResult> {
    const [executable, ...args] = request.argv;
    if (!builtInProviderExecutables.has(executable)) throw resolutionError("EINVAL", "The provider executable is not a trusted built-in.");
    const childEnvironment = routeBoundEnvironment(this.environment, executable, request.route);
    const operationCwd = request.cwd ?? process.cwd();
    const canonicalOperationCwd = await realpath(operationCwd);
    const cacheKey = JSON.stringify([executable, canonicalOperationCwd, environmentValue(this.environment, "PATH") ?? "", environmentValue(this.environment, "PATHEXT") ?? ""]);
    let resolvedExecutable = this.#resolutionCache.get(cacheKey);
    if (resolvedExecutable === undefined) {
      resolvedExecutable = await this.executableResolver(executable, canonicalOperationCwd, this.environment);
      if (!path.isAbsolute(resolvedExecutable)) throw resolutionError("EACCES", "The provider executable did not resolve to an absolute path.");
      resolvedExecutable = await realpath(resolvedExecutable);
      if (isWithin(canonicalOperationCwd, resolvedExecutable)) throw resolutionError("EACCES", "Provider executables inside the operation cwd are not trusted.");
      this.#resolutionCache.set(cacheKey, resolvedExecutable);
    } else {
      resolvedExecutable = await realpath(resolvedExecutable);
      if (isWithin(canonicalOperationCwd, resolvedExecutable)) throw resolutionError("EACCES", "Provider executables inside the operation cwd are not trusted.");
    }
    return new Promise((resolve, reject) => execFile(resolvedExecutable, args, {
      cwd: canonicalOperationCwd,
      env: childEnvironment,
      windowsHide: true,
      timeout: request.timeoutMilliseconds ?? providerProcessTimeoutMilliseconds,
      maxBuffer: providerProcessMaxBufferBytes,
    }, (error, stdout, stderr) => {
      try { resolve(classifyProviderProcessResult(error, stdout, stderr, request.authExitCodes ?? [])); }
      catch (failure) { reject(failure); }
    }));
  }
}

function repositorySelectorError(code: string, message: string): MpxError {
  return new MpxError({ code, message, retryable: false });
}

function validRepositorySegment(value: string): boolean {
  return value !== "." && value !== ".." && safeRepositorySegment.test(value);
}

export function parseForgeRepositoryUrl(value: string): string {
  if (value.length === 0 || value !== value.trim() || /[\\\0]/u.test(value)) throw repositorySelectorError("REPOSITORY_REMOTE_INVALID", "The configured repository remote URL is invalid.");
  let host: string;
  let pathValue: string;
  const scp = /^(?:([^@/:?#]+)@)?([^@/:?#]+):([^?#]+)$/u.exec(value);
  if (scp && !value.includes("://")) {
    const user = scp[1];
    if (user !== undefined && user !== "git") throw repositorySelectorError("REPOSITORY_REMOTE_INVALID", "The configured repository remote URL has untrusted credentials.");
    host = scp[2]!.toLowerCase();
    pathValue = scp[3]!;
  } else {
    let remote: URL;
    try { remote = new URL(value); } catch { throw repositorySelectorError("REPOSITORY_REMOTE_INVALID", "The configured repository remote URL is invalid."); }
    if (remote.protocol !== "https:" && remote.protocol !== "ssh:") throw repositorySelectorError("REPOSITORY_REMOTE_INVALID", "The configured repository remote URL scheme is unsupported.");
    if ((remote.username !== "" && remote.username !== "git") || remote.password !== "") throw repositorySelectorError("REPOSITORY_REMOTE_INVALID", "The configured repository remote URL has untrusted credentials.");
    if (remote.search !== "" || remote.hash !== "" || remote.port !== "") throw repositorySelectorError("REPOSITORY_REMOTE_INVALID", "The configured repository remote URL contains unsupported components.");
    host = remote.hostname.toLowerCase();
    pathValue = remote.pathname.startsWith("/") ? remote.pathname.slice(1) : remote.pathname;
  }
  if (!validRepositorySegment(host) || pathValue.includes("%")) throw repositorySelectorError("REPOSITORY_REMOTE_INVALID", "The configured repository remote URL is unsafe.");
  const segments = pathValue.split("/");
  if (segments.length !== 2) throw repositorySelectorError("REPOSITORY_REMOTE_INVALID", "The configured repository remote URL must identify one owner and repository.");
  const owner = segments[0]!;
  const repository = segments[1]!.endsWith(".git") ? segments[1]!.slice(0, -4) : segments[1]!;
  if (!validRepositorySegment(owner) || !validRepositorySegment(repository)) throw repositorySelectorError("REPOSITORY_REMOTE_INVALID", "The configured repository remote URL contains unsafe path segments.");
  return `${host}/${owner}/${repository}`;
}

export class NodeRepositorySelectorResolver implements CliRepositorySelectorResolver {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async resolve(request: { root: string; remote: string }): Promise<string> {
    if (!path.isAbsolute(request.root) || !safeRemoteName.test(request.remote) || request.remote === "." || request.remote === "..") {
      throw repositorySelectorError("REPOSITORY_REMOTE_INVALID", "The configured repository remote is invalid.");
    }
    let gitExecutable: string;
    try { gitExecutable = await resolveTrustedExecutableOnPath("git", request.root, this.environment); }
    catch { throw repositorySelectorError("REPOSITORY_SELECTOR_UNAVAILABLE", "A trusted Git executable is required to resolve the configured repository remote."); }
    const output = await new Promise<string>((resolve, reject) => execFile(gitExecutable, ["-C", request.root, "config", "--get", `remote.${request.remote}.url`], {
      cwd: request.root,
      env: { ...this.environment, GIT_TERMINAL_PROMPT: "0" },
      encoding: "utf8",
      windowsHide: true,
      timeout: providerProcessTimeoutMilliseconds,
      maxBuffer: providerProcessMaxBufferBytes,
    }, (error, stdout) => error ? reject(error) : resolve(stdout))).catch(() => {
      throw repositorySelectorError("REPOSITORY_REMOTE_UNAVAILABLE", "The configured repository remote URL is missing or unavailable.");
    });
    const lines = output.split(/\r?\n/u).filter(line => line.length > 0);
    if (lines.length !== 1) throw repositorySelectorError("REPOSITORY_REMOTE_INVALID", "The configured repository remote URL is malformed.");
    return parseForgeRepositoryUrl(lines[0]!);
  }
}

export function configuredProviderRegistry(context: CliContext): ProviderRegistry {
  const extensions = context.trustedProviderComposition?.descriptors ?? [];
  return extensions.length === 0 ? providerRegistry : new ProviderRegistry([...BUILTIN_PROVIDERS, ...extensions], extensions);
}

export async function providerService(context: CliContext, config: ProjectConfig, cwd: string, selection?: { providerId: string; capability: string }): Promise<CliProviderService> {
  if (context.providerService) return context.providerService;
  const executor = context.providerProcessExecutor ?? new NodeProviderProcessExecutor(context.env);
  const selectedProvider = selection?.providerId;
  const needsForgeRepository = selectedProvider === undefined || selectedProvider === "github" || selectedProvider === "gitlab";
  const repository = needsForgeRepository
    ? await (context.repositorySelectorResolver ?? new NodeRepositorySelectorResolver(context.env)).resolve({ root: cwd, remote: config.repository.remote })
    : undefined;
  let localRoot: string | undefined;
  let localOnChanged: (() => Promise<void>) | undefined;
  if (selectedProvider === "local" && config.issues?.provider === "local") {
    const appdata = context.env.APPDATA;
    if (!appdata || !path.isAbsolute(appdata)) throw new MpxError({ code: "LOCAL_ISSUE_STORE_UNAVAILABLE", message: "Local issues require identity-local user configuration." });
    const user = await loadUserConfig(path.join(appdata, "mpx", "config.json"), context.env);
    localRoot = user.localIssueStores?.[config.issues.store ?? ""]?.root;
    if (!localRoot) throw new MpxError({ code: "LOCAL_ISSUE_STORE_UNAVAILABLE", message: "The selected logical local issue store is not registered in user configuration." });
    if (config.issues.view) {
      const view = user.localViews?.[config.issues.view];
      if (!view) throw new MpxError({ code: "LOCAL_VIEW_UNAVAILABLE", message: "The selected logical local view is not registered in user configuration." });
      localOnChanged = async () => { await rebuildObsidianIssueViews(new LocalIssueStore(localRoot!, { projectId: config.project.id }), { vaultRoot: view.vaultRoot, outputRoot: view.outputRoot, projectId: config.project.id, resumeBaseUrl: view.resumeBaseUrl }); };
    }
  }
  const adapters = [
    ...(selectedProvider === undefined || selectedProvider === "github" ? createGitHubAdapters(executor, { cwd, ...(repository === undefined ? {} : { repository }) }) : []),
    ...(selectedProvider === undefined || selectedProvider === "gitlab" ? createGitLabAdapters(executor, { cwd, ...(repository === undefined ? {} : { repository }) }) : []),
    ...(selectedProvider === undefined || selectedProvider === "kanbanflow" ? [createKanbanFlowAdapter(executor, { cwd, ...(config.issues?.provider === "kanbanflow" && config.issues.states !== undefined ? { states: config.issues.states } : {}) })] : []),
    ...(selectedProvider === "local" && localRoot ? [createLocalIssueAdapter({ root: localRoot, projectId: config.project.id, ...(localOnChanged ? { onChanged: async () => localOnChanged!() } : {}) })] : []),
    ...(context.trustedProviderComposition?.adapters.filter(adapter => selectedProvider === undefined || adapter.providerId === selectedProvider) ?? []),
  ];
  return new ProviderService(configuredProviderRegistry(context), adapters);
}

function privateRouteError(code: "PRIVATE_ROUTE_LABEL_INVALID" | "PRIVATE_ROUTE_UNAVAILABLE", message: string): MpxError {
  return new MpxError({ code, message, retryable: false });
}
function safeOpaqueRouteLabel(value: string): boolean {
  return value === value.normalize("NFC") && value !== "." && value !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/u.test(value) && !value.endsWith(".") && !value.includes("..");
}
function privateRouteSelections(descriptor: LaunchDescriptor): readonly { key: string; kind: string; label: string }[] {
  const selections = [
    { key: `git:${descriptor.routes.gitAuthor}`, kind: "git", label: descriptor.routes.gitAuthor },
    ...Object.entries(descriptor.routes.providers).map(([provider, label]) => ({ key: `provider-${provider}:${label}`, kind: `provider-${provider}`, label })),
    ...(descriptor.routes.ssh ? [{ key: `ssh:${descriptor.routes.ssh}`, kind: "ssh", label: descriptor.routes.ssh }] : []),
    ...descriptor.routes.mcp.allow.map(label => ({ key: `mcp:${label}`, kind: "mcp", label })),
  ];
  const ambiguous = new Set<string>();
  for (const selection of selections) {
    if (!safeOpaqueRouteLabel(selection.label) || !/^(?:git|ssh|mcp|provider-[a-z0-9][a-z0-9-]{0,31})$/u.test(selection.kind)) throw privateRouteError("PRIVATE_ROUTE_LABEL_INVALID", "A selected private route label is invalid.");
    const folded = `${selection.kind}:${selection.label.toLowerCase()}`;
    if (ambiguous.has(folded)) throw privateRouteError("PRIVATE_ROUTE_LABEL_INVALID", "Selected private route labels are ambiguous.");
    ambiguous.add(folded);
  }
  return selections;
}
function routeWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
async function validatePrivateRouteData(root: string): Promise<void> {
  let fileCount = 0, directoryCount = 0, totalBytes = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const candidate = path.join(directory, entry.name), candidateStat = await lstat(candidate);
      if (candidateStat.isSymbolicLink() || !routeWithin(root, await realpath(candidate))) throw new Error("route data link or escape");
      if (candidateStat.isDirectory()) {
        directoryCount += 1; if (directoryCount > 128) throw new Error("route data exceeds directory bounds");
        const childDepth = depth + 1; if (childDepth > 16) throw new Error("route data exceeds depth bounds");
        await visit(candidate, childDepth);
      } else if (candidateStat.isFile()) {
        fileCount += 1; totalBytes += candidateStat.size;
        if (fileCount > 256 || totalBytes > 8 * 1024 * 1024) throw new Error("route data exceeds bounds");
      } else throw new Error("route data special file");
    }
  };
  await visit(root, 0);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
async function validateMcpRouteDescriptor(value: unknown, label: string, descriptorFile: string, stateRoot: string, projectRoot?: string): Promise<void> {
  if (!exactKeys(value, ["mcpServers"]) || !exactKeys(value.mcpServers, [label])) throw new Error("mcp config shape");
  const server = value.mcpServers[label];
  if (!exactKeys(server, ["type", "command", "args"]) || server.type !== "stdio" || typeof server.command !== "string" || server.command.length === 0 || server.command.length > 4096 || /[\0-\x1f\x7f]/u.test(server.command) || (!path.win32.isAbsolute(server.command) && !path.posix.isAbsolute(server.command))) throw new Error("mcp server shape");
  if (!Array.isArray(server.args) || server.args.length > 64 || server.args.some(argument => typeof argument !== "string" || argument.length > 4096 || /[\0-\x1f\x7f]/u.test(argument))) throw new Error("mcp argument bounds");
  if (/\.(?:cmd|bat|ps1)$/iu.test(server.command) || /^(?:sh|bash|zsh|fish|cmd|powershell|pwsh)(?:\.exe)?$/iu.test(path.basename(server.command))) throw new Error("mcp shell command");
  const commandStat = await lstat(server.command), command = await realpath(server.command);
  if (!commandStat.isFile() || commandStat.isSymbolicLink() || routeWithin(stateRoot, command) || routeWithin(path.dirname(descriptorFile), command) || (projectRoot !== undefined && routeWithin(await realpath(projectRoot), command))) throw new Error("mcp command trust");
}

export class NodePrivateRouteMaterializer implements RouteMaterializer {
  constructor(readonly root: string) {}
  async materialize(descriptorInput: LaunchDescriptor, projectRoot?: string): Promise<Readonly<Record<string, string>>> {
    const selections = privateRouteSelections(descriptorInput);
    let descriptor: LaunchDescriptor;
    try { descriptor = parseLaunchDescriptorV2(descriptorInput); }
    catch { throw privateRouteError("PRIVATE_ROUTE_UNAVAILABLE", "Private route binding validation failed."); }
    try {
      if (!path.isAbsolute(this.root)) throw new Error("state root");
      const rootStat = await lstat(this.root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("state root shape");
      const canonicalRoot = await realpath(this.root);
      const materialized: Record<string, string> = {};
      for (const selection of selections) {
        const directory = path.join(canonicalRoot, "private-routes", descriptor.identity.name, descriptor.runtime, selection.kind, selection.label);
        const bindingFile = path.join(directory, "binding.json");
        const data = path.join(directory, "data");
        const [directoryStat, bindingStat, dataStat] = await Promise.all([lstat(directory), lstat(bindingFile), lstat(data)]);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory() || bindingStat.isSymbolicLink() || !bindingStat.isFile() || bindingStat.size > 16_384 || dataStat.isSymbolicLink() || !dataStat.isDirectory()) throw new Error("route shape");
        const canonicalData = await realpath(data);
        if (!routeWithin(canonicalRoot, canonicalData)) throw new Error("route escape");
        await validatePrivateRouteData(canonicalData);
        const binding = JSON.parse(await readFile(bindingFile, "utf8")) as unknown;
        const expected = { schemaVersion: 1, runtime: descriptor.runtime, identity: descriptor.identity, kind: selection.kind, label: selection.label, ...(selection.kind === "mcp" ? { launchKey: descriptor.launchKey } : {}) };
        if (JSON.stringify(binding) !== JSON.stringify(expected)) throw new Error("route binding");
        if (selection.kind === "mcp") {
          const descriptorFile = path.join(canonicalData, "route.json");
          const descriptorStat = await lstat(descriptorFile);
          if (descriptorStat.isSymbolicLink() || !descriptorStat.isFile() || descriptorStat.size > 16_384 || !routeWithin(canonicalData, await realpath(descriptorFile))) throw new Error("mcp route descriptor shape");
          await validateMcpRouteDescriptor(JSON.parse(await readFile(descriptorFile, "utf8")), selection.label, descriptorFile, canonicalRoot, projectRoot);
          materialized[selection.key] = descriptorFile;
        } else materialized[selection.key] = canonicalData;
      }
      return Object.freeze(materialized);
    } catch { throw privateRouteError("PRIVATE_ROUTE_UNAVAILABLE", "A selected private route is missing, malformed, or not bound to this launch."); }
  }
}

class EnvironmentRouteMaterializer implements RouteMaterializer {
  constructor(readonly environment: NodeJS.ProcessEnv) {}
  materialize(descriptor: LaunchDescriptor, projectRoot?: string): Promise<Readonly<Record<string, string>>> { return new NodePrivateRouteMaterializer(stateRoot({ env: this.environment })).materialize(descriptor, projectRoot); }
}
class EnvironmentLaunchAuditStore implements LaunchAuditStore {
  constructor(readonly environment: NodeJS.ProcessEnv) {}
  #store(): FileLaunchAuditStore { return new FileLaunchAuditStore(stateRoot({ env: this.environment })); }
  start(record: LaunchAuditStartRecord): Promise<string> { return this.#store().start(record); }
  terminal(attemptId: string, record: LaunchAuditTerminalRecord): Promise<void> { return this.#store().terminal(attemptId, record); }
}

export function stateRoot(context: CliContext): string {
  const localAppData = context.env.LOCALAPPDATA;
  if (!localAppData || !path.isAbsolute(localAppData)) throw new MpxError({
    code: "STATE_ROOT_UNAVAILABLE",
    message: "LOCALAPPDATA must be an absolute path.",
    remediation: "Set LOCALAPPDATA to an absolute user-local application data directory.",
  });
  return path.join(localAppData, "mpx");
}

export const defaultContext: CliContext = { env: process.env, launchRoutes: new EnvironmentRouteMaterializer(process.env), launchAudit: new EnvironmentLaunchAuditStore(process.env), sessionDockerResumeAdmission: createProductionSessionDockerResumeAdmission(process.env) };

export function sessions(context: CliContext): SessionStore {
  if (context.sessionStore) return context.sessionStore;
  const root = stateRoot(context);
  return context.sessionStoreFactory?.(root) ?? new SessionStore(root);
}

export function productionSessionResumeDependencies(user: import("@mpx/config").UserConfig, store: SessionStore, verifier?: NativeAccountBindingVerifier, environment: NodeJS.ProcessEnv = process.env, processes: Pick<WindowsProcessCapabilities, "inspect"> = new WindowsProcessCapabilities(), piTargetVerifier: typeof verifyPiResumeTarget = verifyPiResumeTarget): (record: SessionRecordV1) => Promise<ResumeDependencies> {
  return async record => ({
    resolveConfiguredRoot: async nativeBindingRef => {
      const binding = await store.readNativeBinding(nativeBindingRef);
      const configured = user.identities[binding.identity.name];
      if (!configured || configured.domain !== binding.identity.domain) throw new MpxError({ code: "SESSION_RESUME_IDENTITY_MISMATCH", message: "The recorded identity is not configured." });
      const root = configured.runtimeRoots[binding.runtime];
      return { root, canonicalRootDigest: canonicalNativeRootDigest(root), identity: binding.identity, runtime: binding.runtime };
    },
    ...(verifier ? { verifyAccountBinding: (accountBindingRef: string) => verifier.verify(accountBindingRef) } : {}),
    verifyNativeTarget: async (root, ref, runtimeQualifiedId) => {
      if (record.runtime === "pi") {
        try {
          await piTargetVerifier(root, ref);
        } catch (failure) {
          if (failure instanceof PiResumeTargetError && failure.code === "PI_RESUME_TARGET_INVALID") return { valid: false, activity: "unavailable" as const };
          return { valid: true, activity: "unavailable" as const };
        }
        if (!record.process) return { valid: true, activity: "unavailable" as const };
        let inspected;
        try { inspected = await processes.inspect(record.process.pid); }
        catch { return { valid: true, activity: "unavailable" as const }; }
        if (inspected === undefined) return { valid: true, activity: "inactive" as const };
        return { valid: true, activity: inspected.startFingerprint === record.process.startFingerprint ? "active" as const : "unavailable" as const };
      }
      const expected = runtimeQualifiedId.slice("claude:".length);
      const valid=ref.kind === "native-id" && ref.value === expected && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(ref.value);
      if (!valid) return { valid: false, activity: "unavailable" as const };
      const executable=environment.MPX_CLAUDE_EXECUTABLE;
      if(!executable||!path.isAbsolute(executable)) return { valid: true, activity: "unavailable" as const };
      const activity=await new Promise<"active"|"inactive"|"unavailable">(resolve=>execFile(executable,["agents","--json"],{env:{...environment,CLAUDE_CONFIG_DIR:root},shell:false,windowsHide:true,timeout:15_000,maxBuffer:4*1024*1024},(failure,stdout)=>{if(failure){resolve("unavailable");return;}try{const value=JSON.parse(stdout) as unknown;const entries=Array.isArray(value)?value:typeof value==="object"&&value!==null&&Array.isArray((value as {agents?:unknown}).agents)?(value as {agents:unknown[]}).agents:[];resolve(entries.some(item=>typeof item==="object"&&item!==null&&(item as {sessionId?:unknown}).sessionId===ref.value)?"active":"inactive");}catch{resolve("unavailable");}}));
      return { valid: true, activity };
    },
  });
}

export interface ProductionSessionDiscoveryOptions {
  readonly piProcessInspector?: ProcessInspector;
  readonly clock?: () => number;
}

export async function productionSessionDiscoveries(user: import("@mpx/config").UserConfig, store: SessionStore, environment: NodeJS.ProcessEnv, accountResolver?: NativeAccountBindingResolver, options: ProductionSessionDiscoveryOptions = {}): Promise<readonly { scanner: RuntimeDiscovery; context: { identity: IdentityV1; nativeBindingRef: string; runtime: "claude" | "pi" } }[]> {
  const existing = await store.listNativeBindings();
  const piProcessInspector = options.piProcessInspector ?? { inspect: async (pid: number) => {
    try {
      const inspected = await new WindowsProcessCapabilities().inspect(pid);
      return inspected ? { startFingerprint: inspected.startFingerprint } : null;
    } catch { return null; }
  } };
  const result: { scanner: RuntimeDiscovery; context: { identity: IdentityV1; nativeBindingRef: string; runtime: "claude" | "pi" } }[] = [];
  for (const [name, configured] of Object.entries(user.identities).sort(([a], [b]) => a.localeCompare(b))) {
    const identity = { domain: configured.domain, name };
    for (const runtime of ["claude", "pi"] as const) {
      const root = configured.runtimeRoots[runtime];
      const recordedRootDigest = canonicalNativeRootDigest(root);
      const ref = deriveNativeBindingRef(identity, runtime, recordedRootDigest);
      const tupleBindings=existing.filter(binding=>binding.identity.domain===identity.domain&&binding.identity.name===identity.name&&binding.runtime===runtime&&binding.recordedRootDigest===recordedRootDigest);
      if(tupleBindings.length>1)throw new MpxError({code:"SESSION_NATIVE_BINDING_DUPLICATE",message:"Multiple native binding records claim the same identity, runtime, and root."});
      const prior=existing.find(binding=>binding.ref===ref)??tupleBindings[0];
      if (prior && (prior.identity.domain !== identity.domain || prior.identity.name !== identity.name || prior.runtime !== runtime || prior.recordedRootDigest !== recordedRootDigest)) throw new MpxError({ code: "SESSION_BINDING_MISMATCH", message: "A stable native binding reference is inconsistent with its exact identity, runtime, or root." });
      const resolvedAccountBindingRef = accountResolver ? await accountResolver.resolve(identity, runtime, root) : prior?.accountBindingRef ?? null;
      const timestamp = new Date().toISOString();
      const binding = prior
        ? (resolvedAccountBindingRef === prior.accountBindingRef ? prior : { ...prior, accountBindingRef: resolvedAccountBindingRef, updatedAt: timestamp })
        : { schemaVersion: 1 as const, ref, identity, runtime, recordedRootDigest, accountBindingRef: resolvedAccountBindingRef, createdAt: timestamp, updatedAt: timestamp };
      if (!prior || binding !== prior) await store.saveNativeBinding(binding);
      if (runtime === "pi") {
        // Active Pi discovery is admitted only for an enrolled, exact configured root.
        // The scanner receives that root directly; it never infers or scans a home directory.
        if (binding.accountBindingRef !== null) result.push({
          scanner: new PiV2ActiveRegistryScanner(root, path.join(root, "agent-resurrect", "active-sessions"), piProcessInspector, { ...(options.clock ? { clock: options.clock } : {}), missingDirectory: "available-empty" }),
          context: { identity, nativeBindingRef: binding.ref, runtime },
        });
        continue;
      }
      const scanner: RuntimeDiscovery = new ClaudeActiveScanner(async command => {
            const executable = environment.MPX_CLAUDE_EXECUTABLE;
            if (!executable || !path.isAbsolute(executable) || command.join("\0") !== "claude\0agents\0--json") return { available: false, exitCode: 1, stdout: "" };
            return new Promise(resolve => execFile(executable, ["agents", "--json"], { env: { ...environment, CLAUDE_CONFIG_DIR: root }, shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ available: !error, exitCode: typeof (error as { code?: unknown } | null)?.code === "number" ? (error as { code: number }).code : error ? 1 : 0, stdout, stderr })));
          });
      result.push({ scanner, context: { identity, nativeBindingRef: binding.ref, runtime } });
    }
  }
  return result;
}

export function installer(context: CliContext, cwd: string): InstallerService {
  if (context.installerService) return context.installerService;
  const root = stateRoot(context);
  if (context.installerServiceFactory) return context.installerServiceFactory(root);
  const tasks = new WindowsScheduledTaskAdapter();
  const prohibited = [context.env.MPX_PROJECTS, context.env.MPX_WORK, context.env.MPX_CLONED].filter((value): value is string => Boolean(value));
  return new InstallerService({
    tasks,
    store: new NodeReceiptStore(path.join(root, "installer", "receipts")),
    files: new NodeRunnerFileVerifier([cwd, ...prohibited]),
    currentUser: context.env.USERNAME ?? context.env.USER ?? "",
    cwd,
    prohibitedRoots: prohibited,
  });
}

export function immutableInstaller(context: CliContext): InstallOrchestrator {
  if (context.installOrchestrator) return context.installOrchestrator;
  const appsRoot = context.env.MPX_APPS, appData = context.env.APPDATA, localAppData = context.env.LOCALAPPDATA;
  if (![appsRoot, appData, localAppData].every(root => root && path.isAbsolute(root))) throw new MpxError({ code: "INSTALL_ROOT_UNAVAILABLE", message: "APPDATA, LOCALAPPDATA, and MPX_APPS must be absolute paths." });
  const adapter = context.installerOperationAdapter ?? new ProductionInstallerOperationAdapter(context.env, context.env.USERDOMAIN && context.env.USERNAME ? `${context.env.USERDOMAIN}\\${context.env.USERNAME}` : context.env.USERNAME ?? context.env.USER ?? "");
  const store = context.installerTransactionStore ?? new NodeTransactionStore(path.join(localAppData!, "mpx", "installer"));
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  return new InstallOrchestrator({ adapter, store, releases: new NodeCurrentReleaseBuilder({ repositoryRoot, appsRoot: appsRoot! }) });
}

export function ports(context: CliContext): CliPortService {
  if (context.portService) return context.portService;
  const root = stateRoot(context);
  return context.portServiceFactory?.(root) ?? new PortService({
    store: new RegistryStore(root),
    git: new RealGitWorktreeAdapter(),
    platform: new WindowsPortPlatformAdapter(),
  });
}

interface CliPreparationRuntime {
  run(request: { key: string; plan: PreparationPlan; worktreeRoot: string; packageManager: ConfiguredPackageManager; exactApproval?: string; validateOnly?: boolean }): Promise<unknown>;
  retry(request: { key: string; plan: PreparationPlan; worktreeRoot: string; packageManager: ConfiguredPackageManager; exactApproval?: string }): Promise<unknown>;
  cancel(key: string): Promise<{ status: string }>;
  reconcile(key: string): Promise<{ status: string }>;
}

interface PreparationRuntime extends CliPreparationRuntime {
  adapters: PreparationAdapters;
  engine: PreparationEngine;
}

export function windowsProcessIdentityInspector(windows: Pick<WindowsProcessCapabilities, "inspect">) {
  return { inspect: async (pid: number) => {
    try { const identity = await windows.inspect(pid); return identity ? { status: "present" as const, pid, startFingerprint: identity.startFingerprint } : { status: "absent" as const, pid }; }
    catch { return { status: "unknown" as const, pid }; }
  } };
}

export function productionSessionProcessInspector(): SessionProcessInspector {
  return windowsProcessIdentityInspector(new WindowsProcessCapabilities());
}

export function preparationRuntime(root: string, environment: NodeJS.ProcessEnv, workerEntry = fileURLToPath(new URL("./main.js", import.meta.url))): PreparationRuntime {
  const preparationRoot = path.join(root, "worktrees", "preparation");
  const windowsProcesses = new WindowsProcessCapabilities();
  const processAdapter = new NodePreparationProcessAdapter(windowsProcesses, preparationRoot);
  const adapters: PreparationAdapters = {
    evidence: new NodePreparationEvidenceAdapter(),
    store: new NodePreparationStore(preparationRoot, { processIdentityInspector: windowsProcessIdentityInspector(windowsProcesses) }),
    process: processAdapter,
    execution: new NodePreparationExecutionAdapter({ process: processAdapter, stateRoot: preparationRoot, workerEntry, environment: environment as Readonly<Record<string, string>> }),
    clock: { now: Date.now, sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) },
    paths: nodePreparationPaths,
  };
  const engine = new PreparationEngine(adapters);
  const approvedRequest = async (request: { key: string; plan: PreparationPlan; worktreeRoot: string; packageManager: ConfiguredPackageManager; exactApproval?: string; validateOnly?: boolean }) => {
    const logDirectory = path.join(preparationRoot, "logs", sha256Canonical(request.key as unknown as JsonValue));
    const packageManager = await resolvePreparationPackageManager(request.worktreeRoot, request.plan, request.packageManager);
    const approval = await createPreparationApproval({ ...request, packageManager, environment }, adapters); const expectedApprovals = preparationApprovalPhrases(approval);
    const expectedApproval = JSON.stringify(expectedApprovals);
    if (request.exactApproval === undefined) return { response: { schemaVersion: 1, owner: "mpx", status: "approval-required", expectedApproval, expectedApprovals, approval } };
    let supplied: unknown; try { supplied = JSON.parse(request.exactApproval); } catch { supplied = undefined; }
    if (JSON.stringify(supplied) !== expectedApproval) throw new MpxError({ code: "PREPARATION_APPROVAL_STALE", message: "Separate exact package-automation and explicit-executable approvals are required for the current evidence.", details: { expectedApprovals } });
    return { engineRequest: { ...request, ...expectedApprovals, packageManager, approval, environment, logDirectory }, expectedApproval, approval };
  };
  return { adapters, engine, cancel: key => engine.cancel(key), reconcile: key => engine.reconcile(key), run: async request => {
    if (request.plan.execution === "none") return { status: "ready" };
    const approved = await approvedRequest(request);
    if (approved.response) return approved.response;
    if (request.validateOnly) return { status: "approved", expectedApproval: approved.expectedApproval, approval: approved.approval };
    return engine.prepare(approved.engineRequest!);
  }, retry: async request => {
    const approved = await approvedRequest(request);
    return approved.response ?? engine.retry(approved.engineRequest!);
  } };
}

export function verifyPreparationWorkerHandshake(state: { worker?: { pid: number; startFingerprint: string; ownerToken?: string }; owner?: string; runId?: string; status?: string } | undefined, inspection: { startFingerprint: string; owner: "mpx" | "other"; ownerToken?: string } | undefined, pid: number, runId: string): boolean {
  return state?.owner === "mpx" && state.runId === runId && state.status === "preparing" && state.worker?.pid === pid && typeof state.worker.startFingerprint === "string" && state.worker.startFingerprint.length > 0 && state.worker.ownerToken !== undefined && inspection?.owner === "mpx" && inspection.startFingerprint === state.worker.startFingerprint && inspection.ownerToken === state.worker.ownerToken;
}

export async function requireRepositoryBoundLifecycleState(key: string, cwd: string, foundation: ReturnType<typeof createNodeLifecycleFoundation>) {
  const state = await foundation.state.load(key);
  if (!state) throw new MpxError({ code: "WORKTREE_LIFECYCLE_STATE_MISSING", message: "The lifecycle key does not exist." });
  assertLifecycleStateIdentity(state);
  if (key !== deriveLifecycleKey(state.repositoryIdentity, state.branch)) throw new MpxError({ code: "WORKTREE_LIFECYCLE_STATE_INVALID", message: "The lifecycle key identity is invalid." });
  const repository = await foundation.repository.resolve(cwd);
  if (!sameLifecyclePath(repository.commonGitDirectory, state.repositoryIdentity) || !sameLifecyclePath(repository.mainRoot, state.mainRoot)) throw new MpxError({ code: "WORKTREE_REPOSITORY_MISMATCH", message: "The lifecycle key belongs to another repository." });
  if (repository.config.project.id !== state.repositoryId) throw new MpxError({ code: "WORKTREE_REPOSITORY_MISMATCH", message: "The lifecycle key belongs to another repository." });
  const inventoryEntry = (await foundation.git.list(repository.mainRoot)).find(entry => sameLifecyclePath(entry.path, state.worktreePath));
  if (!inventoryEntry || inventoryEntry.branch !== state.branch) throw new MpxError({ code: "WORKTREE_REPOSITORY_MISMATCH", message: "The lifecycle key is not bound to this repository worktree and branch." });
  return { state, repository };
}

export async function executeInternalPreparationWorker(requestFile: string, workerToken: string | undefined): Promise<void> {
  const preparationRoot = path.dirname(path.dirname(path.resolve(requestFile)));
  const request = await awaitBackgroundPreparationActivation(requestFile, preparationRoot, workerToken);
  delete process.env.MPX_PREPARATION_WORKER_TOKEN;
  const runtime = preparationRuntime(path.dirname(path.dirname(preparationRoot)), process.env);
  const store = runtime.adapters.store;
  const processAdapter = runtime.adapters.process;
  let persistedWorker: { pid: number; startFingerprint: string; ownerToken?: string } | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await store.load(request.key);
    const inspection = await processAdapter.inspect(process.pid);
    if (verifyPreparationWorkerHandshake(state, inspection, process.pid, request.runId)) { persistedWorker = state!.worker; break; }
    if (attempt === 199) throw new MpxError({ code: "PREPARATION_WORKER_HANDSHAKE_FAILED", message: "The worker was not durably registered by its parent." });
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const foreground = { ...request.plan, execution: "foreground" as const };
  await runtime.engine.resume({ key: request.key, runId: request.runId, plan: foreground, approval: request.approval, ...(request.packageAutomationApproval === undefined ? {} : { packageAutomationApproval: request.packageAutomationApproval }), ...(request.explicitExecutableApproval === undefined ? {} : { explicitExecutableApproval: request.explicitExecutableApproval }), worktreeRoot: request.worktreeRoot, packageManager: request.packageManager, environment: process.env, logDirectory: request.logDirectory, ...(persistedWorker === undefined ? {} : { worker: persistedWorker }) });
}

export function worktrees(context: CliContext, operationCwd = process.cwd()): CliWorktreeService {
  if (context.worktreeService) return context.worktreeService;
  const root=stateRoot(context), portService=ports(context);
  if (context.worktreeServiceFactory) return context.worktreeServiceFactory(root,portService,operationCwd);
  const includeDependencies=createNodeWorktreeIncludeDependencies();
  const preparation=context.preparationRuntimeFactory?.(root,context.env) ?? preparationRuntime(root,context.env);
  const windowsProcesses = new WindowsProcessCapabilities();
  const productionPreparation = "adapters" in preparation ? preparation as PreparationRuntime : undefined;
  const foundation=createNodeLifecycleFoundation(path.join(root,"worktrees"), "git", {
    operationCwd,
    processIdentityInspector: windowsProcessIdentityInspector(windowsProcesses),
    ...(productionPreparation === undefined ? {} : { isPreparationWorkerActive: async state => {
      const preparationState = await productionPreparation.adapters.store.load(state.key);
      if (!preparationState || !["preparing", "cancelling"].includes(preparationState.status) || !preparationState.worker) return false;
      try {
        const inspected = await productionPreparation.adapters.process.inspect(preparationState.worker.pid);
        return inspected?.owner === "mpx" && inspected.startFingerprint === preparationState.worker.startFingerprint && inspected.ownerToken === preparationState.worker.ownerToken;
      } catch { return true; }
    } }),
  });
  const lifecycle=new WorktreeLifecycleService({
    ...foundation, ports:portService,
    includes:{
      inspect:async request=>{
        try { await access(path.join(request.mainRoot,".worktreeinclude")); }
        catch(error) { if((error as NodeJS.ErrnoException).code==="ENOENT") return {status:"absent" as const,manifestSha256:sha256Canonical({absent:true} as JsonValue)}; throw error; }
        const plan=await planWorktreeIncludes(request,includeDependencies);
        return {status:request.exactHumanApproval===plan.approval ? "approved" as const : "approval-required" as const,manifestSha256:plan.manifestSha256,expectedApproval:plan.approval};
      },
      copy:async request=>{
        try { await access(path.join(request.mainRoot,".worktreeinclude")); }
        catch(error) { if((error as NodeJS.ErrnoException).code==="ENOENT") return {manifestSha256:sha256Canonical({absent:true} as JsonValue)}; throw error; }
        const plan=await planWorktreeIncludes(request,includeDependencies);
        if(request.expectedManifestSha256!==undefined && request.expectedManifestSha256!==plan.manifestSha256) throw new MpxError({code:"WORKTREE_INCLUDE_APPROVAL_STALE",message:"The durable include manifest no longer matches current files."});
        return executeWorktreeIncludePlan(plan,request.exactHumanApproval??"",includeDependencies,request.allowExistingRecovery??false);
      },
    },
    preparation:{
      prepare:request=>preparation.run(request) as Promise<{status:string}>,
      cancel:key=>preparation.cancel(key), reconcile:key=>preparation.reconcile(key),
    },
    configHash:config=>sha256Canonical(config as unknown as JsonValue),
  });
  const git=foundation.git as GitAdapter;
  const fsAdapter:FileSystemAdapter={realpath,readText:file=>readFile(file,"utf8"),writeText:(file,content)=>writeFile(file,content,"utf8"),mkdir:directory=>mkdir(directory,{recursive:true}).then(()=>undefined),exists:async value=>{try{await access(value);return true}catch{return false}}};
  const mru=new FileMruStore(path.join(root,"worktrees","mru.json"),fsAdapter);
  return {
    create:request=>lifecycle.create(request as never), remove:request=>lifecycle.remove(request as never),
    list:async({cwd})=>{const repository=await resolveRepository(cwd,{git,fs:fsAdapter});return listWorktrees(git,repository.mainRoot)},
    status:request=>lifecycle.status(request), reconcile:async request=>{
      const result=await lifecycle.reconcile({cwd:String(request.cwd)}), orphaned=[...(result.orphaned??[])];
      if(orphaned.length===0) return result;
      const expectedApproval=`APPROVE WORKTREE ORPHAN RELEASE ${sha256Canonical(orphaned as JsonValue)}`;
      if(request.orphanApproval===undefined) return {...result,expectedApproval};
      if(request.orphanApproval!==expectedApproval) throw new MpxError({code:"WORKTREE_ORPHAN_APPROVAL_STALE",message:"Exact trusted approval for the current orphan set is required.",details:{expectedApproval}});
      const resolutions=[]; for(const identity of orphaned) resolutions.push(await portService.resolveOrphan({repositoryCwd:String(request.cwd),identity} as never));
      return {...result,status:"resolved",orphaned:[],resolutions};
    },
    select:async({cwd,path:requested})=>{const repository=await resolveRepository(cwd,{git,fs:fsAdapter});return selectWorktree({repository:repository.commonGitDirectory,path:requested,inventory:await listWorktrees(git,repository.mainRoot),store:mru})},
    prepare:async request=>{
      const key=String(request.key), cwd=String(request.cwd);
      const bound=await requireRepositoryBoundLifecycleState(key,cwd,foundation);
      const release=await foundation.lock.acquire(bound.repository.commonGitDirectory);
      try {
        const {state,repository}=await requireRepositoryBoundLifecycleState(key,cwd,foundation);
        const currentConfigHash=sha256Canonical(repository.config as unknown as JsonValue);
        if(state.configHash!==currentConfigHash) throw new MpxError({code:"WORKTREE_CONFIG_HASH_MISMATCH",message:"The durable creation configuration does not match the current configuration evidence."});
        const configuredPlan=preparationPlan(repository.config), plan=state.preparationExecution===undefined?configuredPlan:{...configuredPlan,execution:state.preparationExecution}, packageManager=(repository.config.tooling?.packageManager??"auto") as ConfiguredPackageManager;
        const result=await preparation.retry({key,plan,worktreeRoot:state.worktreePath,packageManager,...(typeof request.approval==="string"?{exactApproval:request.approval}:{})}) as {status?:string};
        if(result.status && result.status!=="approval-required") {
          state.preparationStatus=result.status;
          state.status=result.status==="ready" ? "ready" : result.status==="preparing" ? "preparing" : result.status==="unknown" ? "unknown" : "failed";
          if(state.status==="ready") delete state.failure;
          else if(state.status!=="preparing") state.failure={phase:"preparation",code:result.status==="cancelled"?"PREPARATION_CANCELLED":result.status==="unknown"?"PREPARATION_UNKNOWN":"PREPARATION_FAILED",message:`Preparation ended with status ${result.status}.`};
          state.updatedAt=Date.now(); await foundation.state.writeAtomic(key,state);
        }
        return result;
      } finally { await release(); }
    },
    cancel:async request=>{
      const key=String(request.key), cwd=String(request.cwd);
      const repository=await foundation.repository.resolve(cwd);
      const release=await foundation.lock.acquire(repository.commonGitDirectory);
      try {
        const bound=await requireRepositoryBoundLifecycleState(key,cwd,foundation);
        let cancellation:{status:string};
        try { cancellation=await preparation.cancel(key); }
        catch (error) {
          const current=await foundation.state.load(key);
          if (current) { current.preparationStatus="unknown"; current.status="unknown"; current.failure={phase:"preparation",code:"PREPARATION_UNKNOWN",message:"Preparation cancellation could not be verified."}; current.updatedAt=Date.now(); await foundation.state.writeAtomic(key,current); }
          throw error;
        }
        bound.state.preparationStatus=cancellation.status;
        if(cancellation.status==="cancelled") { bound.state.status="failed"; bound.state.failure={phase:"preparation",code:"PREPARATION_CANCELLED",message:"Preparation was cancelled."}; }
        else if(cancellation.status==="unknown") { bound.state.status="unknown"; bound.state.failure={phase:"preparation",code:"PREPARATION_UNKNOWN",message:"Preparation ownership or completion could not be verified."}; }
        else if(cancellation.status==="ready") { bound.state.status="ready"; delete bound.state.failure; }
        else { bound.state.status="failed"; bound.state.failure={phase:"preparation",code:"PREPARATION_FAILED",message:`Preparation ended with status ${cancellation.status}.`}; }
        bound.state.updatedAt=Date.now(); await foundation.state.writeAtomic(key,bound.state);
        return cancellation;
      } finally { await release(); }
    },

  };
}

export function status(context: CliContext, service?: CliPortService): StatusProvider {
  if (context.statusProvider) return context.statusProvider;
  const selected = service ?? ports(context);
  return context.statusProviderFactory?.(selected) ?? createStatusProvider({ portService: selected });
}

async function exists(candidate: string): Promise<boolean> {
  try { await access(candidate); return true; } catch { return false; }
}

/** Locate only the application-owned canonical catalog; callers may inject a trusted fixture root. */
export async function catalogPath(context: CliContext, _cwd: string): Promise<string> {
  if (context.catalogRoot) return context.catalogRoot;
  const packaged = fileURLToPath(new URL("../../../content/skills", import.meta.url));
  if (await exists(packaged)) return packaged;
  throw new Error("Canonical skill catalog was not found.");
}
