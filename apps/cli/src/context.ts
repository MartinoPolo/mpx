import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MpxError } from "@mpx/core";
import { preparationPlan, type PreparationPlan } from "@mpx/config";
import { PortService, RealGitWorktreeAdapter, RegistryStore } from "@mpx/ports";
import { createStatusProvider, type StatusProvider } from "@mpx/status";
import { WindowsPortPlatformAdapter, WindowsProcessCapabilities } from "@mpx/windows";
import { FileMruStore, NodePreparationEvidenceAdapter, NodePreparationExecutionAdapter, NodePreparationProcessAdapter, NodePreparationStore, PreparationEngine, WorktreeLifecycleService, awaitBackgroundPreparationActivation, createNodeLifecycleFoundation, createNodeWorktreeIncludeDependencies, assertLifecycleStateIdentity, deriveLifecycleKey, sameLifecyclePath, createPreparationApproval, executeWorktreeIncludePlan, listWorktrees, nodePreparationPaths, planWorktreeIncludes, preparationApprovalPhrases, resolvePreparationPackageManager, resolveRepository, selectWorktree, type ConfiguredPackageManager, type FileSystemAdapter, type GitAdapter, type PackageManager, type PreparationAdapters } from "@mpx/worktrees";
import { sha256Canonical, type JsonValue } from "@mpx/core";

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

export interface CliContext {
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
}
export const defaultContext: CliContext = { env: process.env };

export function stateRoot(context: CliContext): string {
  const localAppData = context.env.LOCALAPPDATA;
  if (!localAppData || !path.isAbsolute(localAppData)) throw new MpxError({
    code: "STATE_ROOT_UNAVAILABLE",
    message: "LOCALAPPDATA must be an absolute path.",
    remediation: "Set LOCALAPPDATA to an absolute user-local application data directory.",
  });
  return path.join(localAppData, "mpx");
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
          if (current) { current.preparationStatus="unknown"; current.status="unknown"; current.failure={phase:"preparation",code:"PREPARATION_UNKNOWN",message:error instanceof Error?error.message:String(error)}; current.updatedAt=Date.now(); await foundation.state.writeAtomic(key,current); }
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

/** Locate only the repository-owned canonical catalog; callers may inject a fixture root. */
export async function catalogPath(context: CliContext, cwd: string): Promise<string> {
  if (context.catalogRoot) return context.catalogRoot;
  let directory = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(directory, "content", "skills");
    if (await exists(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  // The package is normally two levels below the repository root.
  const packaged = fileURLToPath(new URL("../../../content/skills", import.meta.url));
  if (await exists(packaged)) return packaged;
  throw new Error("Canonical skill catalog was not found.");
}
