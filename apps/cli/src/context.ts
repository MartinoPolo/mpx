import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AccountAuthVerifier,
  type LifecycleDevService,
  type LifecycleWorktreeService,
  type SetupApplicationService,
  type WorkspaceApplicationService,
} from '@mpx/application';
import {
  createNodeConfiguredProviderApplicationService,
  createNodeSetupApplicationService,
  NodePrivateRouteMaterializer,
  createNodeWorktreeLifecycleService,
  createNodeWorkspaceApplicationService,
  createNodeDevService,
  createProductionSessionDockerResumeAdmission,
  preparationRuntime as nodePreparationRuntime,
  windowsProcessIdentityInspector,
  type CliPreparationRuntime,
  type PreparationRuntime,
  type SbxExecutionDependencies,
  type LaunchExecutionContext,
} from '@mpx/application/node';
import { MpxError } from '@mpx/core';
import { discoverProjectConfig } from '@mpx/config';
import { PortService, RealGitWorktreeAdapter, RegistryStore } from '@mpx/ports';
import { createStatusProvider, type StatusProvider } from '@mpx/status';
import type { ProviderAdapter, ProviderDescriptor, ProviderProcessExecutor } from '@mpx/providers';
import { WindowsPortPlatformAdapter, WindowsProcessCapabilities } from '@mpx/windows';
import { createNodeWorktreeIncludeDependencies, type FileSystemAdapter } from '@mpx/worktrees';
import type { JsonValue } from '@mpx/core';
import type { LaunchDescriptor } from '@mpx/launch';
import {
  FileLaunchAuditStore,
  type F2SandboxSessionResumeAdmission,
  type LaunchAuditStartRecord,
  type LaunchAuditStore,
  type LaunchAuditTerminalRecord,
  type RouteMaterializer,
} from '@mpx/executors';
import {
  SessionStore,
  type BranchArgvExecutionAdapter,
  type ConversationBranchService,
  type IdentityV1,
  type ResumeDependencies,
  type ResumePlanV1,
  type RootAttestationService,
  type RuntimeDiscovery,
  type SessionProcessInspector,
  type SessionRecordV1,
} from '@mpx/sessions';
import {
  activateRelease,
  GitRemotePlanningAdapter,
  InstallIntentBuilder,
  InstallOrchestrator,
  NodeCurrentReleaseBuilder,
  NodeGitCommandPort,
  NodeTransactionStore,
  ProductionInstallerOperationAdapter,
  removeActiveRelease,
  type InstallerOperationAdapter,
  type TransactionStore,
} from '@mpx/installer';

export type CliPortService = Pick<
  PortService,
  | 'ensure'
  | 'resolve'
  | 'list'
  | 'inspect'
  | 'kill'
  | 'release'
  | 'reconcile'
  | 'rebuild'
  | 'captureReleaseIdentity'
  | 'releaseLinkedAfterRemoval'
  | 'resolveOrphan'
>;
export type CliWorktreeService = LifecycleWorktreeService;

export interface CliProviderService {
  invoke(request: {
    providerId: string;
    capability: string;
    route?: string;
    input: JsonValue;
  }): Promise<unknown>;
}

export interface CliRepositorySelectorResolver {
  resolve(request: { root: string; remote: string }): Promise<string>;
}

export interface NativeAccountBindingVerifier {
  verify(accountBindingRef: string): Promise<'verified' | 'unavailable' | 'mismatch' | 'duplicate'>;
}
export interface NativeAccountBindingResolver {
  resolve(
    identity: IdentityV1,
    runtime: 'claude' | 'pi',
    nativeRoot: string,
  ): Promise<string | null>;
}

export interface CliContext extends LaunchExecutionContext {
  env: NodeJS.ProcessEnv;
  catalogRoot?: string;
  discoverProjectConfig?: typeof discoverProjectConfig;
  accessFile?: (file: string) => Promise<void>;
  /** Debug/test-only sink for unexpected errors. Never included in public CLI output. */
  onInternalError?: (error: unknown) => void;
  portService?: CliPortService;
  portServiceFactory?: (stateRoot: string) => CliPortService;
  statusProvider?: StatusProvider;
  statusProviderFactory?: (portService: CliPortService) => StatusProvider;
  worktreeService?: CliWorktreeService;
  worktreeServiceFactory?: (
    stateRoot: string,
    portService: CliPortService,
    operationCwd: string,
  ) => CliWorktreeService;
  preparationRuntimeFactory?: (
    stateRoot: string,
    environment: NodeJS.ProcessEnv,
  ) => CliPreparationRuntime;
  providerService?: CliProviderService;
  devService?: LifecycleDevService;
  providerProcessExecutor?: ProviderProcessExecutor;
  repositorySelectorResolver?: CliRepositorySelectorResolver;
  /** Test seam for the standalone-sbx process transport; production requires no injection. */
  launchSbxExecutionDependencies?: SbxExecutionDependencies;
  /** Optional read-only standalone sbx probe. It must never start or reset the daemon. */
  sbxDiagnostics?: () => Promise<{
    readonly available: boolean;
    readonly failureCodes: readonly string[];
    readonly readOnly: boolean;
  }>;
  sessionStore?: SessionStore;
  sessionStoreFactory?: (stateRoot: string) => SessionStore;
  sessionDiscoveries?: () => Promise<
    readonly {
      scanner: RuntimeDiscovery;
      context?: { identity: IdentityV1; nativeBindingRef: string; runtime: 'claude' | 'pi' };
    }[]
  >;
  sessionProcessInspector?: SessionProcessInspector;
  sessionResumeDependencies?: (record: SessionRecordV1) => Promise<ResumeDependencies>;
  nativeAccountBindingVerifier?: NativeAccountBindingVerifier;
  nativeAccountBindingResolver?: NativeAccountBindingResolver;
  rootAttestationService?: RootAttestationService;
  accountAuthVerifier?: AccountAuthVerifier;
  sessionResumeExecutor?: (
    plan: ResumePlanV1,
    execution: { readonly approveHost?: boolean },
  ) => Promise<unknown>;
  sessionBranchService?: ConversationBranchService;
  /** Argv-only process transports. No command strings or shell execution are accepted. */
  sessionBranchRuntimeAdapter?: BranchArgvExecutionAdapter;
  sessionBranchTerminalAdapter?: BranchArgvExecutionAdapter;
  /** Application-owned F2 proof/state adapter. It plans admission before any resume side effect. */
  sessionDockerResumeAdmission?: (plan: ResumePlanV1) => Promise<F2SandboxSessionResumeAdmission>;
  installOrchestrator?: InstallOrchestrator;
  installIntentBuilder?: InstallIntentBuilder;
  setupService?: SetupApplicationService;
  setupServiceFactory?: () => SetupApplicationService;
  workspaceApplication?: WorkspaceApplicationService;
  installerOperationAdapter?: InstallerOperationAdapter;
  installerTransactionStore?: TransactionStore;
  /** Application-owned trusted extensions; never populated from project configuration. */
  trustedProviderComposition?: Readonly<{
    descriptors: readonly ProviderDescriptor[];
    adapters: readonly ProviderAdapter[];
  }>;
}

export function configuredProviderApplicationService(context: CliContext) {
  return createNodeConfiguredProviderApplicationService(context);
}

class EnvironmentRouteMaterializer implements RouteMaterializer {
  constructor(readonly environment: NodeJS.ProcessEnv) {}
  materialize(
    descriptor: LaunchDescriptor,
    projectRoot?: string,
  ): Promise<Readonly<Record<string, string>>> {
    return new NodePrivateRouteMaterializer(stateRoot({ env: this.environment })).materialize(
      descriptor,
      projectRoot,
    );
  }
}
class EnvironmentLaunchAuditStore implements LaunchAuditStore {
  constructor(readonly environment: NodeJS.ProcessEnv) {}
  #store(): FileLaunchAuditStore {
    return new FileLaunchAuditStore(stateRoot({ env: this.environment }));
  }
  start(record: LaunchAuditStartRecord): Promise<string> {
    return this.#store().start(record);
  }
  terminal(attemptId: string, record: LaunchAuditTerminalRecord): Promise<void> {
    return this.#store().terminal(attemptId, record);
  }
}

export function stateRoot(context: CliContext): string {
  const localAppData = context.env.LOCALAPPDATA;
  if (!localAppData || !path.isAbsolute(localAppData)) {
    throw new MpxError({
      code: 'STATE_ROOT_UNAVAILABLE',
      message: 'LOCALAPPDATA must be an absolute path.',
      remediation: 'Set LOCALAPPDATA to an absolute user-local application data directory.',
    });
  }
  return path.join(localAppData, 'mpx');
}

export const defaultContext: CliContext = {
  env: process.env,
  launchRoutes: new EnvironmentRouteMaterializer(process.env),
  launchAudit: new EnvironmentLaunchAuditStore(process.env),
  sessionDockerResumeAdmission: createProductionSessionDockerResumeAdmission(process.env),
};

export function sessions(context: CliContext): SessionStore {
  if (context.sessionStore) {
    return context.sessionStore;
  }
  const root = stateRoot(context);
  return context.sessionStoreFactory?.(root) ?? new SessionStore(root);
}

export function installerSourceRoot(moduleFile = fileURLToPath(import.meta.url)): string {
  const moduleDirectory = path.dirname(moduleFile);
  return path.basename(moduleDirectory).toLowerCase() === 'bin'
    ? path.resolve(moduleDirectory, '..')
    : path.resolve(moduleDirectory, '../../..');
}

export function installIntentBuilder(context: CliContext): InstallIntentBuilder {
  if (context.installIntentBuilder) {
    return context.installIntentBuilder;
  }
  const appsRoot = context.env.MPX_APPS;
  if (!appsRoot || !path.isAbsolute(appsRoot)) {
    throw new MpxError({
      code: 'INSTALL_ROOT_UNAVAILABLE',
      message: 'MPX_APPS must be an absolute path.',
    });
  }
  const approvedRoots = [
    context.env.MPX_PROJECTS,
    context.env.MPX_WORK,
    context.env.MPX_CLONED,
  ].filter((root): root is string => Boolean(root && path.isAbsolute(root)));
  return new InstallIntentBuilder({
    releases: new NodeCurrentReleaseBuilder({ repositoryRoot: installerSourceRoot(), appsRoot }),
    environment: context.env,
    gitRemotes: new GitRemotePlanningAdapter({
      allowedRoots: approvedRoots,
      git: new NodeGitCommandPort(context.env),
    }),
  });
}

export function setupApplication(context: CliContext): SetupApplicationService {
  if (context.setupService) {
    return context.setupService;
  }
  if (context.setupServiceFactory) {
    return context.setupServiceFactory();
  }
  return createNodeSetupApplicationService({
    environment: context.env,
    builder: installIntentBuilder(context),
    orchestrator: immutableInstaller(context),
  });
}

export function immutableInstaller(context: CliContext): InstallOrchestrator {
  if (context.installOrchestrator) {
    return context.installOrchestrator;
  }
  const appsRoot = context.env.MPX_APPS,
    appData = context.env.APPDATA,
    localAppData = context.env.LOCALAPPDATA;
  if (![appsRoot, appData, localAppData].every((root) => root && path.isAbsolute(root))) {
    throw new MpxError({
      code: 'INSTALL_ROOT_UNAVAILABLE',
      message: 'APPDATA, LOCALAPPDATA, and MPX_APPS must be absolute paths.',
    });
  }
  const adapter =
    context.installerOperationAdapter ??
    new ProductionInstallerOperationAdapter(
      context.env,
      context.env.USERDOMAIN && context.env.USERNAME
        ? `${context.env.USERDOMAIN}\\${context.env.USERNAME}`
        : (context.env.USERNAME ?? context.env.USER ?? ''),
    );
  const store =
    context.installerTransactionStore ??
    new NodeTransactionStore(path.join(localAppData!, 'mpx', 'installer'));
  const repositoryRoot = installerSourceRoot();
  return new InstallOrchestrator({
    adapter,
    store,
    releases: new NodeCurrentReleaseBuilder({ repositoryRoot, appsRoot: appsRoot! }),
    activate: (releaseKey, expectedPriorReleaseKey) =>
      activateRelease(localAppData!, expectedPriorReleaseKey, releaseKey),
    deactivate: (releaseKey) => removeActiveRelease(localAppData!, releaseKey),
  });
}

export function ports(context: CliContext): CliPortService {
  if (context.portService) {
    return context.portService;
  }
  const root = stateRoot(context);
  return (
    context.portServiceFactory?.(root) ??
    new PortService({
      store: new RegistryStore(root),
      git: new RealGitWorktreeAdapter(),
      platform: new WindowsPortPlatformAdapter(),
    })
  );
}

export function productionSessionProcessInspector(): SessionProcessInspector {
  return windowsProcessIdentityInspector(new WindowsProcessCapabilities());
}

export function preparationRuntime(
  root: string,
  environment: NodeJS.ProcessEnv,
  // The CLI module is intentionally the worker entry; it imports this module to build
  // the production context, but the worker path is only resolved when this function runs.
  // fallow-ignore-next-line circular-dependency
  workerEntry = fileURLToPath(new URL('./main.js', import.meta.url)),
): PreparationRuntime {
  return nodePreparationRuntime(root, environment, workerEntry);
}

export function worktrees(context: CliContext, operationCwd = process.cwd()): CliWorktreeService {
  if (context.worktreeService) {
    return context.worktreeService;
  }
  const root = stateRoot(context);
  const portService = ports(context);
  if (context.worktreeServiceFactory) {
    return context.worktreeServiceFactory(root, portService, operationCwd);
  }
  const preparation =
    context.preparationRuntimeFactory?.(root, context.env) ?? preparationRuntime(root, context.env);
  const fileSystem: FileSystemAdapter = {
    realpath,
    readText: (file) => readFile(file, 'utf8'),
    writeText: (file, content) => writeFile(file, content, 'utf8'),
    mkdir: (directory) => mkdir(directory, { recursive: true }).then(() => undefined),
    exists: async (value) => {
      try {
        await access(value);
        return true;
      } catch {
        return false;
      }
    },
  };
  return createNodeWorktreeLifecycleService({
    stateRoot: root,
    operationCwd,
    ports: portService,
    preparation,
    includes: createNodeWorktreeIncludeDependencies(),
    fileSystem,
    processIdentityInspector: windowsProcessIdentityInspector(new WindowsProcessCapabilities()),
  });
}

export function workspaceApplication(
  context: CliContext,
  operationCwd: string,
): WorkspaceApplicationService {
  if (context.workspaceApplication) {
    return context.workspaceApplication;
  }
  const portService = ports(context);
  const worktreeService = worktrees(context, operationCwd);
  return createNodeWorkspaceApplicationService({
    worktrees: worktreeService,
    ports: portService,
    projects: {
      async discover(cwd) {
        const found = await (context.discoverProjectConfig ?? discoverProjectConfig)(cwd);
        if (!found) {
          throw new MpxError({ code: 'PROJECT_NOT_FOUND', message: 'No MPX project was found.' });
        }
        return found;
      },
    },
    status: status(context, portService),
    services: {
      forWorkspace(root) {
        return context.devService ?? createNodeDevService(context.env, root);
      },
    },
  });
}

export function status(context: CliContext, service?: CliPortService): StatusProvider {
  if (context.statusProvider) {
    return context.statusProvider;
  }
  const selected = service ?? ports(context);
  return (
    context.statusProviderFactory?.(selected) ?? createStatusProvider({ portService: selected })
  );
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Locate only the application-owned canonical catalog; callers may inject a trusted fixture root. */
export async function catalogPath(context: CliContext, _cwd: string): Promise<string> {
  if (context.catalogRoot) {
    return context.catalogRoot;
  }
  const packaged = path.join(installerSourceRoot(), 'content', 'skills');
  if (await exists(packaged)) {
    return packaged;
  }
  throw new Error('Canonical skill catalog was not found.');
}
