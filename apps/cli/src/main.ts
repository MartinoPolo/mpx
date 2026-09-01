#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { access, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigValidationError,
  StrictJsonError,
  discoverProjectConfig,
  resolveKnownLaunchCwdClassification,
  type DiscoveredConfig,
  type UserConfig,
} from '@mpx/config';
import {
  createProjectApplicationService,
  createSkillApplicationService,
  currentLaunchTuple,
  executionMpxError,
  LaunchApplicationService,
  SessionResumeLaunchApplicationService,
  resolveLaunchSkills,
  type AccountApplicationService,
  type MigrationAction,
  type ProjectApplicationService,
  type SkillApplicationService,
} from '@mpx/application';
import {
  createNodeAccountApplicationService,
  createNodeInstallApplicationService,
  createNodeLocalIssueViewRebuilder,
  collectNodeExecutorEvidence,
  createNodeMigrationApplicationService,
  createPiAuthAvailabilityProbe,
  directProcessTty,
  executeResolvedNodeLaunch,
  resolveTrustedRuntimeExecutable,
} from '@mpx/application/node';
import {
  errorEnvelope,
  MpxError,
  sha256Canonical,
  successEnvelope,
  type Diagnostic,
  type JsonValue,
} from '@mpx/core';
import { canonicalNativeRootDigest, resolveLaunch, type ShortLaunchAlias } from '@mpx/launch';
import {
  ExecutionError,
  buildF2ProofPolicyMatrix,
  namedSbxPolicies,
  sanitizeHostReason,
} from '@mpx/executors';
import { createSbxLaunchPlanExportV1 } from '@mpx/runtime-contracts';
import { parseStatusSnapshotV1, type StatusSnapshotV1 } from '@mpx/status';
import { expandBranchTemplate } from '@mpx/worktrees';
import { inventoryCanonical, inventoryProjectSkills, SkillCatalogError } from '@mpx/skills';
import {
  catalogPath,
  configuredProviderApplicationService,
  defaultContext,
  immutableInstaller,
  installIntentBuilder,
  ports,
  productionSessionProcessInspector,
  sessions,
  stateRoot,
  status,
  worktrees,
  type CliContext,
} from './context.js';
import { executeSessionCommand } from './session-command.js';
import { executeInstallCommand } from './install-command.js';
import { executeAccountCommand } from './account-command.js';
import {
  createProductionSessionBranchRuntimeAdapter,
  createWindowsTerminalBranchAdapter,
  diagnoseNodeSessionBranchAdapters,
  diagnoseSessionBranchAdapters,
  ProductionSessionLifecycleBridge,
  productionSessionDiscoveries,
  productionSessionResumeDependencies,
} from '@mpx/application/node';
import { processIo, type CliIo } from './io.js';

function resolveScheduledCaptureAuthority(
  context: CliContext,
): NonNullable<CliContext['scheduledCaptureAuthority']> {
  return (
    context.scheduledCaptureAuthority ?? {
      inspect: async () => {
        const verification = await immutableInstaller(context).verify(true);
        return {
          installed: verification.healthy,
          authorityDigest:
            verification.healthy && verification.releaseKey ? verification.releaseKey : null,
        };
      },
    }
  );
}
import {
  createDefaultSbxDiagnostics,
  createNodeDevService,
  createNodeLifecycleApplicationService,
  createNodeSessionApplicationService,
  createNodeSessionLegacyImport,
  createProductionSbxExecutionAdapter,
  createProductionSessionDockerResumeAdmission,
  diagnoseConfiguredF2Proof,
  executeInternalPreparationWorker,
  loadProductionSbxProofSources,
  planProductionSbxExecution,
  productionProofCreateArgv,
} from '@mpx/application/node';
import {
  BranchLeaseStore,
  BranchLineageStore,
  ConversationBranchService,
  RootAttestationService,
  SessionService,
  RootAttestationStore,
  SessionError,
  createClaudeBranchAdapter,
  createPiBranchAdapter,
  type BranchRequestV1,
  type BranchRuntimeAdapter,
  type ConversationBranchPlanV1,
  type ResumePlanV1,
} from '@mpx/sessions';

interface Parsed {
  command: string[];
  cwd: string;
  json: boolean;
  options: Map<string, string | boolean | string[]>;
}
interface ExecuteResult {
  data: unknown;
  warnings: Diagnostic[];
  exitCode?: number;
  machinePath?: string;
  silent?: boolean;
}
class UsageError extends Error {}
const usage =
  'Usage: mpx [--cwd DIR] [--json] <init [--confirm]|config|doctor|provider|skill|identity|mode|skill-policy|preset|launch|account|session|install|migration reconcile|report|rollback-drill|cutover-plan|view rebuild|issue|review|ci|status|ports|dev start|status|logs|restart|stop|worktree create|remove|list|select|status|prepare|cancel|reconcile>';

const shortLaunchAliases = new Set<ShortLaunchAlias>(['cc', 'ccw', 'pi', 'piw']);
function parse(argv: readonly string[]): Parsed {
  const words: string[] = [],
    options = new Map<string, string | boolean | string[]>();
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    if (!word.startsWith('--')) {
      words.push(word);
      continue;
    }
    const [name, inline] = word.slice(2).split('=', 2);
    if (
      [
        'json',
        'rebuild',
        'confirm',
        'machine',
        'cancel',
        'all-active',
        'strict',
        'dry-run',
        'acknowledge-shared-risk',
        'terminal-tab',
        'legacy-disabled',
      ].includes(name!)
    ) {
      options.set(name!, true);
    } else if (
      [
        'cwd',
        'role',
        'limit',
        'lines',
        'artifact-key',
        'pid',
        'identity',
        'skill-policy',
        'runtime',
        'content-scope',
        'mode',
        'executor',
        'workspace',
        'network-policy',
        'preset',
        'reason',
        'grant',
        'base',
        'branch',
        'template',
        'slug',
        'author',
        'issue',
        'review',
        'execution',
        'approval',
        'package-approval',
        'explicit-executable-approval',
        'include-approval',
        'orphan-approval',
        'path',
        'source',
        'id',
        'title',
        'body',
        'label',
        'destination',
        'dependency-id',
        'revision',
        'source-branch',
        'target-branch',
        'method',
        'run-id',
        'state',
        'status',
        'note',
        'summary',
        'disposition',
        'next-action',
        'priority',
        'related-issue',
        'related-review',
        'capture',
        'confirm-plan',
        'import-legacy',
        'map-account',
        'map-pi-root',
        'intent',
        'request',
        'plan',
        'transaction',
        'external-plan',
        'raycast-post-export',
        'terminal-title',
      ].includes(name!)
    ) {
      const value = inline ?? argv[++i];
      if (
        value === undefined ||
        (value.length === 0 && name !== 'body') ||
        value.startsWith('--')
      ) {
        throw new UsageError(`--${name} requires a value`);
      }
      if (['grant', 'import-legacy', 'map-account', 'map-pi-root'].includes(name!)) {
        options.set(name!, [...((options.get(name!) as string[] | undefined) ?? []), value]);
      } else {
        options.set(name!, value);
      }
    } else {
      throw new UsageError(`Unknown option: --${name}`);
    }
  }
  const command =
    words.length === 1 && shortLaunchAliases.has(words[0] as ShortLaunchAlias)
      ? ['launch', words[0]!]
      : words;
  return {
    command,
    cwd: path.resolve(String(options.get('cwd') ?? process.cwd())),
    json: options.get('json') === true,
    options,
  };
}
function projectApplication(context: CliContext): ProjectApplicationService {
  const sbxDiagnostics = context.sbxDiagnostics
    ? async (_request: { cwd: string }) => context.sbxDiagnostics!()
    : context === defaultContext
      ? ({ cwd }: { cwd: string }) => createDefaultSbxDiagnostics(context.env, cwd)
      : undefined;
  return createProjectApplicationService({
    path: { join: path.join, basename: path.basename, isAbsolute: path.isAbsolute },
    catalogRoot: (cwd) => catalogPath(context, cwd),
    access: context.accessFile ?? access,
    ...(context.discoverProjectConfig
      ? { discoverProjectConfig: context.discoverProjectConfig }
      : {}),
    inventoryCanonical,
    inventoryProjectSkills,
    localIssueViewRebuilder: createNodeLocalIssueViewRebuilder(),
    ...(sbxDiagnostics ? { sbxDiagnostics } : {}),
    sbxProofDiagnostics: () => diagnoseConfiguredF2Proof(context.env),
    branchDiagnostics: () => diagnoseNodeSessionBranchAdapters(context.env),
    statusSnapshot: (request) => status(context, context.portService).snapshot(request),
    ensureProject: (request) => ports(context).ensure(request),
  });
}
function skillApplication(): SkillApplicationService {
  return createSkillApplicationService({
    inventoryCanonical,
    inventoryProjectSkills,
    discoverProjectConfig,
    classifyCwd: resolveKnownLaunchCwdClassification,
  });
}
async function userConfig(context: CliContext): Promise<UserConfig> {
  return projectApplication(context).optionalUserConfig({
    ...(context.env.APPDATA ? { appdata: context.env.APPDATA } : {}),
    environment: context.env,
  });
}
async function requiredUserConfig(context: CliContext): Promise<UserConfig> {
  return projectApplication(context).requiredUserConfig({
    ...(context.env.APPDATA ? { appdata: context.env.APPDATA } : {}),
    environment: context.env,
  });
}
function productionPiAuthProbe(context: CliContext, cwd: string) {
  return createPiAuthAvailabilityProbe({
    cwd,
    environment: context.env,
    resolveTrustedExecutable: () =>
      resolveTrustedRuntimeExecutable({
        runtime: 'pi',
        cwd,
        environment: context.env,
        ...(context.launchExecutableResolver ? { resolver: context.launchExecutableResolver } : {}),
      }),
  });
}
function productionAccountApplication(
  user: UserConfig,
  context: CliContext,
  cwd: string,
): AccountApplicationService {
  return createNodeAccountApplicationService({
    accounts: user.identities,
    stateRoot: stateRoot(context),
    cwd,
    environment: context.env,
    ...(context.rootAttestationService
      ? { rootAttestationService: context.rootAttestationService }
      : {}),
    ...(context.accountAuthVerifier ? { accountAuthVerifier: context.accountAuthVerifier } : {}),
    resolveTrustedExecutable: () =>
      resolveTrustedRuntimeExecutable({
        runtime: 'pi',
        cwd,
        environment: context.env,
        ...(context.launchExecutableResolver ? { resolver: context.launchExecutableResolver } : {}),
      }),
  });
}
function productionAccountServices(user: UserConfig, context: CliContext, cwd: string) {
  const application = productionAccountApplication(user, context, cwd);
  return {
    application,
    resolver: { resolve: application.resolveNativeBinding.bind(application) },
    verifier: { verify: application.verifyNativeBinding.bind(application) },
  };
}
async function project(
  parsed: Parsed,
  context: CliContext = defaultContext,
): Promise<DiscoveredConfig> {
  return projectApplication(context).discover(parsed.cwd);
}

function stringOption(parsed: Parsed, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === 'string' ? value : undefined;
}
function requiredOption(parsed: Parsed, name: string): string {
  const value = stringOption(parsed, name);
  if (value === undefined) {
    throw new UsageError(`--${name} is required`);
  }
  return value;
}
function unexpectedCommandError(error: unknown, context: CliContext): MpxError {
  try {
    context.onInternalError?.(error);
  } catch {
    /* A debug sink cannot affect command behavior. */
  }
  return new MpxError({ code: 'COMMAND_FAILED', message: 'Command failed.' });
}
function sanitizePublicMessage(message: string): string {
  return message
    .replace(/[\r\n\t]+/gu, ' ')
    .trim()
    .replace(/[A-Za-z]:[\\/][^\s,;]+/gu, '[path]')
    .replace(/(^|[\s(])\/[^\s,;)]+/gu, '$1[path]')
    .slice(0, 256);
}

function invalidConfigError(): MpxError {
  return new MpxError({ code: 'CONFIG_INVALID', message: 'Configuration is invalid.' });
}

function normalizeConfigError(error: ConfigValidationError): MpxError {
  return new MpxError({
    code: 'CONFIG_INVALID',
    message: 'Configuration is invalid.',
    details: {
      errors: error.errors.map(({ instancePath, keyword }) => ({
        pointer: instancePath || '/',
        keyword,
      })),
    },
  });
}

function human(value: unknown): string {
  if (Array.isArray(value)) {
    return (
      value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n') +
      '\n'
    );
  }
  if (typeof value === 'string') {
    return value + '\n';
  }
  return JSON.stringify(value, null, 2) + '\n';
}
function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function branchAdmissionPlan(input: BranchRequestV1 | ConversationBranchPlanV1): ResumePlanV1 {
  const confirmationDigest =
    'confirmationDigest' in input
      ? input.confirmationDigest
      : sha256Canonical(input as unknown as JsonValue);
  return {
    schemaVersion: 1,
    newLaunchRequired: true,
    previousLaunch: {
      launchKey: input.launchIdentity.launchKey,
      descriptorDigest: input.launchIdentity.descriptorDigest,
    },
    recordId: input.child.runtimeQualifiedId,
    runtimeQualifiedId: input.child.runtimeQualifiedId,
    runtime: input.child.runtime,
    identity: input.launchIdentity.identity,
    nativeBindingRef: input.launchIdentity.nativeBindingRef,
    nativeSessionRef: input.parent.nativeSessionRef,
    cwd: input.workspace.cwd,
    projectId: input.workspace.projectRef,
    repositoryId: input.workspace.repositoryRef,
    launch: {
      launchKey: input.launchIdentity.launchKey,
      descriptorDigest: input.launchIdentity.descriptorDigest,
      mode: input.launchIdentity.mode,
      skillPolicy: input.launchIdentity.skillPolicy,
      contentScope: input.launchIdentity.contentScope,
      executor: { kind: input.launchIdentity.executor },
      workspace: input.launchIdentity.workspace,
      networkPolicy: input.launchIdentity.networkPolicy,
      grants: input.launchIdentity.grants,
      artifactKey: input.launchIdentity.artifactKey,
      manifestKey: input.launchIdentity.manifestKey,
    },
    confirmationDigest,
  };
}

async function executeProductionSessionResume(
  plan: ResumePlanV1,
  user: UserConfig,
  context: CliContext,
  branchInvocation?: { readonly executable: string; readonly argv: readonly string[] },
): Promise<unknown> {
  const store = sessions(context);
  const application = new SessionResumeLaunchApplicationService({
    dockerAdmission: (resumePlan) =>
      (
        context.sessionDockerResumeAdmission ??
        createProductionSessionDockerResumeAdmission(context.env)
      )(resumePlan),
    piPreflight: async (resumePlan, userConfig) => {
      let nativeBinding: Awaited<ReturnType<typeof store.readNativeBinding>>;
      try {
        nativeBinding = await store.readNativeBinding(resumePlan.nativeBindingRef);
      } catch {
        throw new SessionError(
          'SESSION_RESUME_ACCOUNT_UNAVAILABLE',
          'The recorded Pi account binding is unavailable.',
        );
      }
      const configured = userConfig.identities[resumePlan.identity.name];
      const accountRef = nativeBinding.accountBindingRef;
      if (
        !configured ||
        configured.domain !== resumePlan.identity.domain ||
        nativeBinding.runtime !== 'pi' ||
        nativeBinding.identity.domain !== resumePlan.identity.domain ||
        nativeBinding.identity.name !== resumePlan.identity.name
      ) {
        throw new SessionError(
          'SESSION_RESUME_ACCOUNT_MISMATCH',
          'The recorded Pi account binding does not match the configured identity.',
        );
      }
      if (accountRef === null) {
        throw new SessionError(
          'SESSION_RESUME_ACCOUNT_UNAVAILABLE',
          'The recorded Pi account binding is unavailable.',
        );
      }
      const accountService =
        context.rootAttestationService ??
        new RootAttestationService(new RootAttestationStore(stateRoot(context)));
      const auth = context.accountAuthVerifier ?? productionPiAuthProbe(context, resumePlan.cwd);
      return {
        nativeBinding,
        reverify: async () => {
          try {
            const matchingRefs = await accountService.store?.list();
            if (
              matchingRefs &&
              matchingRefs.filter((record) => record.ref === accountRef).length > 1
            ) {
              throw Object.assign(new Error('duplicate'), { code: 'ACCOUNT_ROOT_DUPLICATE' });
            }
            await accountService.verify(
              resumePlan.identity,
              configured.runtimeRoots.pi,
              accountRef,
            );
            await auth.verify(configured.runtimeRoots.pi);
          } catch (error) {
            const code = (error as { code?: unknown }).code;
            if (code === 'ACCOUNT_ROOT_DUPLICATE' || code === 'ACCOUNT_IDENTITY_DUPLICATE') {
              throw new SessionError(
                'SESSION_RESUME_ACCOUNT_DUPLICATE',
                'The recorded Pi account binding is duplicated.',
              );
            }
            if (code === 'ACCOUNT_ROOT_CHANGED' || code === 'ACCOUNT_BINDING_MISMATCH') {
              throw new SessionError(
                'SESSION_RESUME_ACCOUNT_MISMATCH',
                'The recorded Pi account binding no longer matches the configured identity and root.',
              );
            }
            throw new SessionError(
              'SESSION_RESUME_ACCOUNT_UNAVAILABLE',
              'The recorded Pi account binding or live OAuth is unavailable.',
            );
          }
        },
      };
    },
    isAbsolutePath: path.isAbsolute,
    discoverProjectConfig: (cwd) => discoverProjectConfig(cwd),
    canonicalRoot: (cwd) => catalogPath(context, cwd),
    rebuildSkills: async ({ plan: resumePlan, userConfig, project, repositoryId, canonicalRoot }) =>
      resolveLaunchSkills(
        {
          userConfig,
          ...(project ? { project } : {}),
          repositoryId,
          canonicalRoot,
          identity: resumePlan.identity.name,
          skillPolicy: resumePlan.launch.skillPolicy,
          contentScope: resumePlan.launch.contentScope,
          runtime: resumePlan.runtime,
        },
        { inventoryCanonical, inventoryProjectSkills },
      ),
    prepareExecutor: async ({
      plan: resumePlan,
      userConfig,
      project,
      repositoryId,
      selection,
      dockerAdmission,
    }) => {
      let resumeContext = context;
      if (
        resumePlan.launch.executor.kind === 'docker' &&
        context.launchExecutorAdapters === undefined &&
        context.env.LOCALAPPDATA
      ) {
        try {
          const snapshot = project
            ? await status(context).snapshot({
                cwd: resumePlan.cwd,
                projectRoot: project.root,
                config: project.config,
                configHash: sha256Canonical(project.config as unknown as JsonValue),
              })
            : parseStatusSnapshotV1({
                schemaVersion: 1,
                project: { id: repositoryId, cwd: resumePlan.cwd },
                worktree: { id: null, path: null, role: null, branch: null },
                portResolution: 'missing',
                services: [],
                diagnostics: [],
              });
          const configured = userConfig.identities[resumePlan.identity.name]!;
          const network =
            namedSbxPolicies[selection.networkPolicy.name as keyof typeof namedSbxPolicies] ??
            namedSbxPolicies['deny-all'];
          const adapter = await createProductionSbxExecutionAdapter(
            {
              environment: context.env,
              cwd: resumePlan.cwd,
              stateRoot: path.join(context.env.LOCALAPPDATA, 'mpx'),
              runtime: resumePlan.runtime,
              identity: {
                name: resumePlan.identity.name,
                domain: resumePlan.identity.domain === 'personal' ? 'personal' : 'work',
              },
              workspaceMode: selection.workspace,
              worktreeRole: selection.workspace === 'host-worktree' ? 'linked' : 'main',
              ...(selection.workspace === 'direct' ? { directCompatibility: true } : {}),
              workspaceRoot: resumePlan.cwd,
              gitCommonDir: path.join(resumePlan.cwd, '.git'),
              nativeRoots: Object.values(userConfig.identities).flatMap((identity) =>
                Object.values(identity.runtimeRoots),
              ),
              credentialRoots: [],
              oppositeDomainRoots: Object.values(userConfig.identities)
                .filter((identity) => identity.domain !== configured.domain)
                .flatMap((identity) => Object.values(identity.runtimeRoots)),
              network: {
                name:
                  selection.networkPolicy.name in namedSbxPolicies
                    ? selection.networkPolicy.name
                    : 'deny-all',
                allow: network.allow,
              },
              ports: snapshot.services.flatMap((service) =>
                service.port === null ? [] : [service.port],
              ),
            },
            context.launchSbxExecutionDependencies,
          );
          if (dockerAdmission?.admitted) {
            adapter.setResumeAction(dockerAdmission.action);
          }
          resumeContext = {
            ...context,
            launchExecutorAdapters: [adapter],
            ...(adapter.bridge ? { launchSbxBridge: adapter.bridge } : {}),
          };
        } catch {
          /* Exact production proof remains unavailable and the typed Docker gate denies resume. */
        }
      }
      const evidence = await collectNodeExecutorEvidence(
        resumeContext,
        resumePlan.launch.executor.kind,
      );
      return {
        evidence,
        execute: async (input) => {
          const nativeBinding = input.nativeBinding as Awaited<
            ReturnType<typeof store.readNativeBinding>
          >;
          const launchContext =
            resumeContext.launchLifecycleBridge || resumeContext.launchRuntimeAdapters
              ? resumeContext
              : {
                  ...resumeContext,
                  launchLifecycleBridge: new ProductionSessionLifecycleBridge({
                    store,
                    ...(resumeContext.nativeAccountBindingResolver
                      ? {
                          accountBindingRef: (name: string, runtime: 'claude' | 'pi') =>
                            resumeContext.nativeAccountBindingResolver!.resolve(
                              { domain: userConfig.identities[name]!.domain, name },
                              runtime,
                              userConfig.identities[name]!.runtimeRoots[runtime],
                            ),
                        }
                      : {}),
                  }),
                };
          const snapshot = project
            ? async (): Promise<StatusSnapshotV1> =>
                status(context).snapshot({
                  cwd: resumePlan.cwd,
                  projectRoot: project.root,
                  config: project.config,
                  configHash: sha256Canonical(project.config as unknown as JsonValue),
                })
            : async (): Promise<StatusSnapshotV1> =>
                parseStatusSnapshotV1({
                  schemaVersion: 1,
                  project: { id: repositoryId, cwd: resumePlan.cwd },
                  worktree: { id: null, path: null, role: null, branch: null },
                  portResolution: 'missing',
                  services: [],
                  diagnostics: [],
                });
          return executeResolvedNodeLaunch({
            descriptor: input.descriptor,
            manifest: input.manifest,
            artifact: input.artifact,
            catalog: input.catalog,
            canonicalRoot: input.canonicalRoot,
            agentsRoot: path.join(path.dirname(input.canonicalRoot), 'agents'),
            artifactsRoot: input.roots.artifactsRoot,
            stateRoot: input.roots.stateRoot,
            cwd: input.cwd,
            environment: context.env,
            context: launchContext,
            tty: context.launchTty ?? directProcessTty(),
            nativeRuntimeRoot: input.nativeRuntimeRoot,
            statusSnapshot: snapshot,
            ...(input.beforeChildExecution
              ? { beforeChildExecution: input.beforeChildExecution }
              : {}),
            ...(branchInvocation
              ? { branch: { nativeBinding, invocation: branchInvocation } }
              : { resume: { nativeBinding, nativeSessionRef: resumePlan.nativeSessionRef } }),
          });
        },
      };
    },
    resolveDescriptor: async ({
      plan: resumePlan,
      userConfig,
      projectId,
      repositoryId,
      skills,
      evidence,
    }) =>
      resolveLaunch({
        userConfig,
        cwd: resumePlan.cwd,
        runtime: resumePlan.runtime,
        identity: resumePlan.identity.name,
        mode: resumePlan.launch.mode,
        skillPolicy: resumePlan.launch.skillPolicy,
        contentScope: resumePlan.launch.contentScope,
        executor: resumePlan.launch.executor.kind,
        workspace: resumePlan.launch.workspace as 'clone' | 'host-worktree' | 'direct',
        networkPolicy: resumePlan.launch.networkPolicy,
        grants: resumePlan.launch.grants.map((grant) => `${grant.access}:${grant.resource}`),
        ...(resumePlan.launch.executor.kind === 'host'
          ? {
              reason: 'confirmed session resume',
              hostApproval: {
                reason: 'confirmed session resume',
                approvalKey: sha256Canonical({
                  confirmationDigest: resumePlan.confirmationDigest,
                } as unknown as JsonValue),
              },
            }
          : {}),
        skillArtifact: skills.skillArtifact,
        selectedNativeRuntimeRoot:
          userConfig.identities[resumePlan.identity.name]!.runtimeRoots[resumePlan.runtime],
        ...(projectId ? { projectId } : {}),
        repositoryId,
        dockerAvailability:
          evidence.status === 'verified'
            ? 'available'
            : evidence.status === 'unavailable'
              ? 'unavailable'
              : 'unverified',
        executorVerification: evidence,
        policyInputs: {
          schemaVersion: 1,
          manifestKey: skills.manifest.manifestKey,
          skillArtifactKey: skills.skillArtifact.artifactKey,
        },
      }),
    descriptorDigest: (descriptor) => sha256Canonical(descriptor as unknown as JsonValue),
    requireExecutionRoots: async () => {
      const appData = context.env.APPDATA;
      const localAppData = context.env.LOCALAPPDATA;
      if (!appData || !localAppData) {
        throw new MpxError({
          code: 'STATE_ROOT_UNAVAILABLE',
          message: 'APPDATA and LOCALAPPDATA are required for resume execution.',
        });
      }
      return {
        artifactsRoot: path.join(appData, 'mpx', 'runtime-artifacts'),
        stateRoot: path.join(localAppData, 'mpx'),
      };
    },
    readNativeBinding: (ref) => store.readNativeBinding(ref),
  });
  const prepared = await application.prepare(plan, user);
  return application.execute(prepared);
}
async function execute(parsed: Parsed, context: CliContext): Promise<ExecuteResult> {
  const [group, action, ...args] = parsed.command;
  if (!group) {
    throw new UsageError(usage);
  }
  if (parsed.options.get('rebuild') === true && (group !== 'ports' || action !== 'reconcile')) {
    throw new UsageError('--rebuild is valid only for ports reconcile');
  }
  if (group === 'migration') {
    if (
      !action ||
      !['reconcile', 'report', 'rollback-drill', 'cutover-plan'].includes(action) ||
      args.length
    ) {
      throw new UsageError(usage);
    }
    return {
      data: await createNodeMigrationApplicationService().execute({
        action: action as MigrationAction,
        repoRoot: parsed.cwd,
        env: context.env,
        legacyDisabled: parsed.options.get('legacy-disabled') === true,
      }),
      warnings: [],
    };
  }
  if (parsed.options.get('confirm') === true && (group !== 'init' || action !== undefined)) {
    throw new UsageError('--confirm is valid only for init');
  }
  let data: unknown;
  let warnings: Diagnostic[] = [];
  if (group === 'account') {
    if (
      !action ||
      !['enroll', 're-enroll', 'list', 'status', 'verify'].includes(action) ||
      args.length !== 0
    ) {
      throw new UsageError(
        'Usage: mpx account <enroll|re-enroll|list|status|verify> [--identity NAME] [--confirm-plan DIGEST]',
      );
    }
    const user = await requiredUserConfig(context);
    const { application } = productionAccountServices(user, context, parsed.cwd);
    const identityName = stringOption(parsed, 'identity'),
      confirmationDigest = stringOption(parsed, 'confirm-plan');
    data = await executeAccountCommand(
      {
        action: action as 'enroll' | 're-enroll' | 'list' | 'status' | 'verify',
        ...(identityName ? { identityName } : {}),
        ...(confirmationDigest ? { confirmationDigest } : {}),
      },
      application,
    );
    return { data, warnings };
  }
  if (group === 'session') {
    const user = await userConfig(context);
    const sessionStore = sessions(context);
    const trustedTerminalRoots = [
      context.env.WINDIR,
      context.env.LOCALAPPDATA
        ? path.join(context.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps')
        : undefined,
    ].filter((value): value is string => Boolean(value && path.isAbsolute(value)));
    const terminalCandidate =
      context.env.MPX_WINDOWS_TERMINAL_EXECUTABLE ??
      (context.env.LOCALAPPDATA
        ? path.join(context.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe')
        : undefined);
    const terminalAvailability = await diagnoseSessionBranchAdapters({
      runtimeAvailable: true,
      ...(terminalCandidate ? { terminalCandidate } : {}),
      trustedRoots: trustedTerminalRoots,
    });
    const account = context.env.LOCALAPPDATA
      ? productionAccountServices(user, context, parsed.cwd)
      : undefined;
    let branchService = context.sessionBranchService;
    if (action === 'branch' && !branchService) {
      const runtimeAdapter = (runtime: 'claude' | 'pi'): BranchRuntimeAdapter => ({
        plan: async (parent, cwd, selectedRoot) => {
          const trusted = await resolveTrustedRuntimeExecutable({
            runtime,
            cwd,
            environment: context.env,
            ...(context.launchExecutableResolver
              ? { resolver: context.launchExecutableResolver }
              : {}),
          });
          if (trusted.argvPrefix.length !== 0) {
            throw new SessionError(
              'SESSION_BRANCH_EXECUTABLE_WRAPPER_UNSUPPORTED',
              'Native branch adapters require a direct trusted runtime executable.',
            );
          }
          return (
            runtime === 'claude'
              ? createClaudeBranchAdapter(trusted.executable)
              : createPiBranchAdapter(trusted.executable)
          ).plan(parent, cwd, selectedRoot);
        },
      });
      const lifecycle = worktrees(context);
      const productionBranchRuntime = createProductionSessionBranchRuntimeAdapter({
        executeNormalLaunch: async ({ invocation, plan }) => {
          let resolveLifecycle!: (event: {
            runtimeQualifiedId: string;
            nativeSessionRef: typeof plan.parent.nativeSessionRef;
          }) => void;
          let rejectLifecycle!: (error: unknown) => void;
          const childLifecycle = new Promise<{
            runtimeQualifiedId: string;
            nativeSessionRef: typeof plan.parent.nativeSessionRef;
          }>((resolve, reject) => {
            resolveLifecycle = resolve;
            rejectLifecycle = reject;
          });
          const bridge = new ProductionSessionLifecycleBridge({
            store: sessionStore,
            ...(context.nativeAccountBindingResolver
              ? {
                  accountBindingRef: (name: string, runtime: 'claude' | 'pi') =>
                    context.nativeAccountBindingResolver!.resolve(
                      { domain: user.identities[name]!.domain, name },
                      runtime,
                      user.identities[name]!.runtimeRoots[runtime],
                    ),
                }
              : {}),
            onSessionsChanged: async () => {
              const records = await new SessionService(sessionStore).list({
                runtime: plan.child.runtime,
              });
              const child = records.find(
                (record) =>
                  record.runtimeQualifiedId !== plan.parent.runtimeQualifiedId &&
                  record.location.cwd === invocation.cwd &&
                  record.nativeBindingRef === plan.launchIdentity.nativeBindingRef,
              );
              if (child) {
                resolveLifecycle({
                  runtimeQualifiedId: child.runtimeQualifiedId,
                  nativeSessionRef: child.nativeSessionRef,
                });
              }
            },
          });
          const synthetic: ResumePlanV1 = {
            schemaVersion: 1,
            newLaunchRequired: true,
            previousLaunch: {
              launchKey: plan.launchIdentity.launchKey,
              descriptorDigest: plan.launchIdentity.descriptorDigest,
            },
            recordId: plan.child.runtimeQualifiedId,
            runtimeQualifiedId: plan.child.runtimeQualifiedId,
            runtime: plan.child.runtime,
            identity: plan.launchIdentity.identity,
            nativeBindingRef: plan.launchIdentity.nativeBindingRef,
            nativeSessionRef: plan.parent.nativeSessionRef,
            cwd: invocation.cwd,
            projectId: plan.workspace.projectRef,
            repositoryId: plan.workspace.repositoryRef,
            launch: {
              launchKey: plan.launchIdentity.launchKey,
              descriptorDigest: plan.launchIdentity.descriptorDigest,
              mode: plan.launchIdentity.mode,
              skillPolicy: plan.launchIdentity.skillPolicy,
              contentScope: plan.launchIdentity.contentScope,
              executor: { kind: plan.launchIdentity.executor },
              workspace: plan.launchIdentity.workspace,
              networkPolicy: plan.launchIdentity.networkPolicy,
              grants: plan.launchIdentity.grants,
              artifactKey: plan.launchIdentity.artifactKey,
              manifestKey: plan.launchIdentity.manifestKey,
            },
            confirmationDigest: plan.confirmationDigest,
          };
          const exited = executeProductionSessionResume(
            synthetic,
            user,
            { ...context, launchLifecycleBridge: bridge },
            invocation,
          ).catch((error) => {
            rejectLifecycle(error);
            throw error;
          });
          return { lifecycle: childLifecycle, exited };
        },
      });
      const productionTerminal =
        !context.sessionBranchTerminalAdapter && terminalAvailability.terminal.available
          ? await createWindowsTerminalBranchAdapter({
              candidate: terminalAvailability.terminal.executable,
              trustedRoots: trustedTerminalRoots,
              run: async (request) => {
                const before = new Set(
                  (await new SessionService(sessionStore).list()).map(
                    (record) => record.runtimeQualifiedId,
                  ),
                );
                let settleExit!: (value: unknown) => void, rejectExit!: (error: unknown) => void;
                const exited = new Promise<unknown>((resolve, reject) => {
                  settleExit = resolve;
                  rejectExit = reject;
                });
                execFile(
                  request.executable,
                  [...request.argv],
                  { cwd: request.cwd, env: context.env, shell: false, windowsHide: true },
                  (error, stdout, stderr) =>
                    error ? rejectExit(error) : settleExit({ exitCode: 0, stdout, stderr }),
                );
                const lifecycle = (async () => {
                  const deadline = Date.now() + 120_000;
                  while (Date.now() < deadline) {
                    const child = (await new SessionService(sessionStore).list()).find(
                      (record) =>
                        !before.has(record.runtimeQualifiedId) &&
                        record.location.cwd === request.cwd,
                    );
                    if (child) {
                      return {
                        runtimeQualifiedId: child.runtimeQualifiedId,
                        nativeSessionRef: child.nativeSessionRef,
                      };
                    }
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                  throw new SessionError(
                    'SESSION_BRANCH_LIFECYCLE_TIMEOUT',
                    'The terminal child did not publish a lifecycle event.',
                  );
                })();
                return { lifecycle, exited };
              },
            })
          : null;
      const dockerAdmission =
        context.sessionDockerResumeAdmission ??
        createProductionSessionDockerResumeAdmission(context.env);
      const leaseProcessInspector =
        context.sessionProcessInspector ?? productionSessionProcessInspector();
      const controller = await leaseProcessInspector.inspect(process.pid);
      const branchLeaseStore = new BranchLeaseStore(
        path.join(stateRoot(context), 'session-branch-leases'),
        {
          processId: process.pid,
          controllerStartFingerprint:
            controller.status === 'present'
              ? controller.startFingerprint
              : `unverified-${process.pid}`,
          processInspector: leaseProcessInspector,
          observeSession: async (lease) => {
            const records = await new SessionService(sessionStore).list();
            const candidates = records.filter(
              (record) =>
                record.runtimeQualifiedId === lease.session.runtimeQualifiedId ||
                (record.location.cwd === lease.workspace.cwd &&
                  record.nativeBindingRef === lease.session.nativeBindingRef &&
                  (!lease.launch.launchKey || record.launch?.launchKey === lease.launch.launchKey)),
            );
            if (candidates.length === 0) {
              return 'absent';
            }
            if (candidates.every((record) => record.liveness === 'inactive')) {
              return 'inactive';
            }
            for (const record of candidates.filter((value) => value.liveness === 'active')) {
              if (!record.process) {
                return 'unknown';
              }
              const observed = await leaseProcessInspector.inspect(record.process.pid);
              if (observed.status === 'unknown') {
                return 'unknown';
              }
              if (
                observed.status === 'present' &&
                observed.startFingerprint === record.process.startFingerprint
              ) {
                return 'active';
              }
            }
            return 'inactive';
          },
        },
      );
      await branchLeaseStore.reconcile();
      branchService = new ConversationBranchService(
        {
          inspectWorkspace: async (workspace) => {
            try {
              const info = await lstat(workspace.cwd);
              return {
                exists: info.isDirectory() && !info.isSymbolicLink(),
                collisionDisclosure:
                  workspace.repositoryRef === null
                    ? []
                    : ['repository refs and external fixed services remain shared'],
              };
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return { exists: false, collisionDisclosure: [] };
              }
              throw error;
            }
          },
          createIsolatedWorktree: async (workspace) => {
            if (!workspace.branch) {
              throw new SessionError(
                'SESSION_BRANCH_WORKTREE_BRANCH_REQUIRED',
                'An isolated branch requires a worktree branch ref.',
              );
            }
            const created = (await lifecycle.create({
              cwd: workspace.cwd,
              branch: workspace.branch,
              execution: 'none',
            })) as { worktreePath?: unknown };
            if (
              typeof created.worktreePath !== 'string' ||
              !path.isAbsolute(created.worktreePath)
            ) {
              throw new SessionError(
                'SESSION_BRANCH_WORKTREE_CREATE_FAILED',
                'The worktree service did not return a canonical worktree path.',
              );
            }
            return { cwd: created.worktreePath, worktreeRef: workspace.branch };
          },
          removeIsolatedWorktree: async (workspace) => {
            await lifecycle.remove({ cwd: parsed.cwd, worktreePath: workspace.cwd });
          },
          validateNativeBinding: async (plan) => {
            const configured = user.identities[plan.launchIdentity.identity.name];
            if (!configured || configured.domain !== plan.launchIdentity.identity.domain) {
              throw new SessionError(
                'SESSION_BRANCH_IDENTITY_MISMATCH',
                'The branch identity is no longer configured.',
              );
            }
            const binding = await sessionStore.readNativeBinding(
              plan.launchIdentity.nativeBindingRef,
            );
            const root = configured.runtimeRoots[plan.child.runtime];
            if (
              binding.ref !== plan.launchIdentity.nativeBindingRef ||
              binding.runtime !== plan.child.runtime ||
              binding.identity.domain !== plan.launchIdentity.identity.domain ||
              binding.identity.name !== plan.launchIdentity.identity.name ||
              binding.recordedRootDigest !== plan.launchIdentity.rootDigest ||
              canonicalNativeRootDigest(root) !== binding.recordedRootDigest
            ) {
              throw new SessionError(
                'SESSION_BRANCH_NATIVE_BINDING_MISMATCH',
                'The recorded session binding no longer matches the configured identity root.',
              );
            }
            if (plan.child.runtime === 'pi') {
              const attestation =
                context.rootAttestationService ??
                new RootAttestationService(new RootAttestationStore(stateRoot(context)));
              await attestation.verify(
                plan.launchIdentity.identity,
                root,
                binding.accountBindingRef ?? undefined,
              );
              await (
                context.accountAuthVerifier ?? productionPiAuthProbe(context, parsed.cwd)
              ).verify(root);
            }
            return root;
          },
          adapters: { claude: runtimeAdapter('claude'), pi: runtimeAdapter('pi') },
          runtime: context.sessionBranchRuntimeAdapter ?? productionBranchRuntime,
          ...((context.sessionBranchTerminalAdapter ?? productionTerminal)
            ? { terminal: (context.sessionBranchTerminalAdapter ?? productionTerminal)! }
            : {}),
          lineage: new BranchLineageStore(
            path.join(stateRoot(context), 'sessions', 'v1', 'private', 'branch-lineage'),
          ),
          admitExecutor: async (branch) =>
            branch.launchIdentity.executor === 'host' ||
            (await dockerAdmission(branchAdmissionPlan(branch))).admitted,
        },
        branchLeaseStore,
      );
    }
    const scheduledCaptureAuthority = resolveScheduledCaptureAuthority(context);
    const resolveIdentity = async (name: string) => {
      const identity = user.identities[name];
      if (!identity) {
        throw new MpxError({ code: 'IDENTITY_UNKNOWN', message: `Unknown identity '${name}'.` });
      }
      return { domain: identity.domain, name };
    };
    const resumeDependencies =
      context.sessionResumeDependencies ??
      productionSessionResumeDependencies({
        user,
        store: sessionStore,
        ...((context.nativeAccountBindingVerifier ?? account?.verifier)
          ? { verifier: (context.nativeAccountBindingVerifier ?? account?.verifier)! }
          : {}),
        environment: context.env,
      });
    const application = createNodeSessionApplicationService({
      store: sessionStore,
      processInspector: context.sessionProcessInspector ?? productionSessionProcessInspector(),
      resumeDependencies,
      executeConfirmedResume:
        context.sessionResumeExecutor ??
        ((plan) => executeProductionSessionResume(plan, user, context)),
      resolveIdentity,
      discoveries:
        context.sessionDiscoveries ??
        (() =>
          productionSessionDiscoveries({
            user,
            store: sessionStore,
            environment: context.env,
            ...((context.nativeAccountBindingResolver ?? account?.resolver)
              ? { accountResolver: (context.nativeAccountBindingResolver ?? account?.resolver)! }
              : {}),
          })),
      legacyImport: createNodeSessionLegacyImport({ store: sessionStore, resolveIdentity }),
      ...(branchService ? { branchService } : {}),
      ...(scheduledCaptureAuthority ? { scheduledCaptureAuthority } : {}),
    });
    const result = await executeSessionCommand(
      { action, args, options: parsed.options },
      {
        application,
        ...(terminalAvailability.terminal.available
          ? { terminalExecutable: terminalAvailability.terminal.executable }
          : {}),
      },
    );
    return { data: result.data, warnings: [...result.warnings] };
  }
  if (group === 'install') {
    const application = createNodeInstallApplicationService({
      orchestrator: immutableInstaller(context),
      builder: () => installIntentBuilder(context),
    });
    const result = await executeInstallCommand(
      { action, args, options: parsed.options },
      { application },
    );
    return { data: result.data, warnings };
  }
  if (
    ['identity', 'mode', 'skill-policy', 'preset'].includes(group) &&
    ['list', 'show'].includes(action ?? '')
  ) {
    const user = await requiredUserConfig(context);
    if (action === 'list' && args.length) {
      throw new UsageError(`${group} list accepts no arguments`);
    }
    if (action === 'show' && args.length !== 1) {
      throw new UsageError(`${group} show requires exactly one name`);
    }
    const result = projectApplication(context).configurationItem({
      kind: group as 'identity' | 'mode' | 'skill-policy' | 'preset',
      action: action as 'list' | 'show',
      user,
      ...(args[0] ? { name: args[0] } : {}),
    });
    return { ...result, warnings };
  }
  if (group === 'dev') {
    if (
      !action ||
      !['start', 'status', 'logs', 'restart', 'stop'].includes(action) ||
      args.length
    ) {
      throw new UsageError('dev requires one of: start, status, logs, restart, stop');
    }
    const found = await project(parsed, context),
      id = stringOption(parsed, 'id'),
      rawLines = stringOption(parsed, 'lines');
    if (action !== 'status' && id === undefined) {
      throw new UsageError(`--id is required for dev ${action}`);
    }
    const lines = rawLines === undefined ? undefined : Number(rawLines);
    if (lines !== undefined && (!Number.isInteger(lines) || lines < 1 || lines > 500)) {
      throw new UsageError('--lines must be an integer from 1 through 500');
    }
    if (lines !== undefined && action !== 'logs') {
      throw new UsageError('--lines is valid only for dev logs');
    }
    let executor: 'host' | 'docker' = 'host';
    if (context.env.MPX_RUNTIME_CONTEXT !== undefined) {
      const selected = context.env.MPX_RUNTIME_EXECUTOR;
      if (selected !== 'host' && selected !== 'docker') {
        throw new MpxError({
          code: 'DEV_EXECUTOR_BINDING_REQUIRED',
          message:
            'Launch-bound development services require an exact executor binding and never fall back to host.',
        });
      }
      executor = selected;
    }
    const service =
      context.devService ??
      (executor === 'docker' ? undefined : createNodeDevService(context.env, found.root));
    if (!service || (executor === 'docker' && service.runtimeKind !== 'docker')) {
      throw new MpxError({
        code: 'DEV_EXECUTOR_UNSUPPORTED',
        message:
          'Docker development services require an injected matching Docker runtime adapter; host fallback is forbidden.',
      });
    }
    if (service.runtimeKind !== undefined && service.runtimeKind !== executor) {
      throw new MpxError({
        code: 'DEV_EXECUTOR_BINDING_REQUIRED',
        message: 'The development-service adapter does not match the selected executor.',
      });
    }
    data = await createNodeLifecycleApplicationService({
      devService: service,
      ...(action === 'start' ? { ports: ports(context) } : {}),
    }).dev({
      action,
      ...(id ? { id } : {}),
      cwd: parsed.cwd,
      config: found.config,
      projectRoot: found.root,
      executor,
      ...(lines === undefined ? {} : { lines }),
    });
    return { data, warnings };
  }
  if (group === 'view') {
    if (action !== 'rebuild' || args.length) {
      throw new UsageError('view requires rebuild');
    }
    const result = await projectApplication(context).rebuildLocalIssueView({
      cwd: parsed.cwd,
      ...(context.env.APPDATA ? { appdata: context.env.APPDATA } : {}),
      environment: context.env,
    });
    return { ...result, warnings };
  }
  if (['issue', 'review', 'ci'].includes(group)) {
    const actions =
      group === 'issue'
        ? [
            'list',
            'view',
            'show',
            'create',
            'edit',
            'update',
            'comment',
            'label',
            'move',
            'finish',
            'close',
            'dependency',
          ]
        : group === 'review'
          ? ['view', 'create', 'update', 'comment', 'ready', 'merge']
          : ['status', 'watch', 'logs', 'retry'];
    if (!action || !actions.includes(action)) {
      throw new UsageError(`${group} requires one of: ${actions.join(', ')}`);
    }
    if (args.length && action !== 'dependency') {
      throw new UsageError(`${group} ${action} accepts only explicit flags`);
    }
    const dependencyAction = group === 'issue' && action === 'dependency' ? args[0] : undefined;
    if (
      action === 'dependency' &&
      (!dependencyAction || !['add', 'remove'].includes(dependencyAction) || args.length !== 1)
    ) {
      throw new UsageError('issue dependency requires add or remove');
    }
    const normalizedAction =
      group === 'issue'
        ? (({ show: 'view', update: 'edit', close: 'finish' } as Record<string, string>)[action] ??
          action)
        : action;
    const capability =
      action === 'dependency'
        ? `issue.dependency.${dependencyAction}`
        : `${group}.${normalizedAction}`;
    const role = group === 'issue' ? 'issues' : 'repository';
    const found = await project(parsed, context);
    const identityName = stringOption(parsed, 'identity');
    const identity =
      identityName === undefined
        ? undefined
        : (await requiredUserConfig(context)).identities[identityName];
    const applicationService = configuredProviderApplicationService(context);
    const prepared = applicationService.prepareInvocation({
      project: found.config,
      role,
      capability,
      ...(identityName === undefined ? {} : { identityName }),
      ...(identity === undefined ? {} : { identity }),
      cwd: found.root,
    });
    let input: Record<string, unknown> = {};
    if (group === 'issue') {
      if (action === 'list') {
        const state = stringOption(parsed, 'state');
        if (state !== undefined && state !== 'open' && state !== 'finished') {
          throw new UsageError('--state must be open or finished');
        }
        input = state === undefined ? {} : { state };
      } else if (
        action === 'view' ||
        action === 'show' ||
        action === 'finish' ||
        action === 'close'
      ) {
        input = {
          id: requiredOption(parsed, 'id'),
          ...(stringOption(parsed, 'revision')
            ? { revision: stringOption(parsed, 'revision') }
            : {}),
        };
      } else if (action === 'create') {
        input = { title: requiredOption(parsed, 'title'), body: requiredOption(parsed, 'body') };
      } else if (action === 'edit' || action === 'update') {
        input = {
          id: requiredOption(parsed, 'id'),
          title: requiredOption(parsed, 'title'),
          body: requiredOption(parsed, 'body'),
          ...(stringOption(parsed, 'revision')
            ? { revision: stringOption(parsed, 'revision') }
            : {}),
        };
      } else if (action === 'comment') {
        input = { id: requiredOption(parsed, 'id'), body: requiredOption(parsed, 'body') };
      } else if (action === 'label') {
        input = { id: requiredOption(parsed, 'id'), label: requiredOption(parsed, 'label') };
      } else if (action === 'move') {
        input = {
          id: requiredOption(parsed, 'id'),
          destination: requiredOption(parsed, 'destination'),
        };
      } else if (action === 'dependency') {
        input = {
          id: requiredOption(parsed, 'id'),
          dependencyId: requiredOption(parsed, 'dependency-id'),
          ...(stringOption(parsed, 'revision')
            ? { revision: stringOption(parsed, 'revision') }
            : {}),
        };
      }
    } else if (group === 'review') {
      if (action === 'view' || action === 'ready') {
        input = { id: requiredOption(parsed, 'id') };
      } else if (action === 'create') {
        input = {
          title: requiredOption(parsed, 'title'),
          body: requiredOption(parsed, 'body'),
          sourceBranch: requiredOption(parsed, 'source-branch'),
          targetBranch: requiredOption(parsed, 'target-branch'),
          draft: found.config.workflow?.codeReview?.openAsDraft ?? false,
        };
      } else if (action === 'update') {
        input = {
          id: requiredOption(parsed, 'id'),
          title: requiredOption(parsed, 'title'),
          body: requiredOption(parsed, 'body'),
        };
      } else if (action === 'comment') {
        input = { id: requiredOption(parsed, 'id'), body: requiredOption(parsed, 'body') };
      } else if (action === 'merge') {
        const method = stringOption(parsed, 'method') ?? 'merge';
        if (!['merge', 'squash', 'rebase'].includes(method)) {
          throw new UsageError('--method must be merge, squash, or rebase');
        }
        input = { id: requiredOption(parsed, 'id'), method };
      }
    } else if (action === 'status' || action === 'watch') {
      input = { id: requiredOption(parsed, 'id') };
    } else {
      const id = requiredOption(parsed, 'run-id');
      input = { id, runId: id };
    }
    const result = await applicationService.invokePrepared(prepared, asJson(input));
    return { ...result, warnings };
  }
  if (group === 'launch' && action === 'resolve') {
    throw new UsageError("launch resolve was replaced by 'mpx launch explain'");
  }
  if (group === 'launch' && action === 'current') {
    if (args.length) {
      throw new UsageError('launch current accepts no arguments');
    }
    return { data: currentLaunchTuple(context.env), warnings };
  }
  if (group === 'runtime' && (action === 'claude' || action === 'pi')) {
    if (args.length) {
      throw new UsageError(`runtime ${action} accepts no arguments`);
    }
    const tuple = currentLaunchTuple(context.env),
      bound = JSON.parse(context.env.MPX_RUNTIME_CONTEXT!) as {
        runtimeArtifact?: { runtime?: string };
      };
    if (bound.runtimeArtifact?.runtime !== action) {
      throw new MpxError({
        code: 'RUNTIME_CONTEXT_MISMATCH',
        message: 'The process-bound runtime does not match the requested runtime entry.',
        remediation: 'Relaunch and restart the runtime process.',
      });
    }
    return { data: tuple, warnings };
  }
  if (
    group === 'launch' &&
    (action === 'explain' ||
      action === 'sbx-plan-export' ||
      action === 'claude' ||
      action === 'pi' ||
      shortLaunchAliases.has(action as ShortLaunchAlias))
  ) {
    if (args.length) {
      throw new UsageError(`launch ${action} accepts no positional arguments`);
    }
    const alias = shortLaunchAliases.has(action as ShortLaunchAlias)
      ? (action as ShortLaunchAlias)
      : undefined;
    const user = await requiredUserConfig(context);
    const projectDiscovery = context.discoverProjectConfig ?? discoverProjectConfig;
    const stringOption = (name: string): string | undefined => {
      const value = parsed.options.get(name);
      return typeof value === 'string' ? value : undefined;
    };
    const runtimeOption = action === 'claude' || action === 'pi' ? action : stringOption('runtime');
    if (runtimeOption !== undefined && runtimeOption !== 'claude' && runtimeOption !== 'pi') {
      throw new MpxError({ code: 'RUNTIME_INVALID', message: "Runtime must be 'claude' or 'pi'." });
    }
    const identityOption = stringOption('identity'),
      modeOption = stringOption('mode'),
      skillPolicyOption = stringOption('skill-policy');
    const contentScopeOption = stringOption('content-scope'),
      presetOption = stringOption('preset'),
      reasonOption = stringOption('reason');
    const executorOption = stringOption('executor'),
      workspaceOption = stringOption('workspace'),
      networkPolicyOption = stringOption('network-policy');
    if (executorOption !== undefined && executorOption !== 'host' && executorOption !== 'docker') {
      throw new MpxError({
        code: 'EXECUTOR_UNAVAILABLE',
        message: `Executor '${executorOption}' is unavailable.`,
      });
    }
    if (
      workspaceOption !== undefined &&
      workspaceOption !== 'clone' &&
      workspaceOption !== 'host-worktree' &&
      workspaceOption !== 'direct'
    ) {
      throw new MpxError({
        code: 'WORKSPACE_INVALID',
        message: `Workspace strategy '${workspaceOption}' is invalid.`,
      });
    }
    if (action === 'explain' && !identityOption) {
      if (
        modeOption ||
        skillPolicyOption ||
        contentScopeOption ||
        executorOption ||
        workspaceOption ||
        networkPolicyOption ||
        presetOption ||
        parsed.options.has('grant') ||
        reasonOption
      ) {
        throw new MpxError({
          code: 'IDENTITY_REQUIRED',
          message:
            'Direct launch overrides require --identity; candidate explanation never infers one.',
        });
      }
      const candidateService = new LaunchApplicationService({
        discoverProjectConfig: projectDiscovery,
        inventoryCanonical,
        inventoryProjectSkills,
        statusSnapshot: async () => {
          throw new Error('candidate status is unreachable');
        },
        executorEvidence: async () => {
          throw new Error('candidate evidence is unreachable');
        },
      });
      const result = await candidateService.prepareCandidates({
        operation: 'explain',
        cwd: parsed.cwd,
        userConfig: user,
        ...(runtimeOption ? { runtime: runtimeOption } : {}),
      });
      return { data: result.data, warnings };
    }
    if (!identityOption && !alias) {
      throw new MpxError({
        code: 'IDENTITY_REQUIRED',
        message: 'Launch identity must be supplied explicitly.',
      });
    }
    if (action === 'sbx-plan-export' && runtimeOption === undefined) {
      throw new MpxError({
        code: 'RUNTIME_REQUIRED',
        message: 'A sandbox plan export requires an explicit runtime.',
      });
    }
    if (action === 'sbx-plan-export' && executorOption === 'host') {
      throw new MpxError({
        code: 'EXECUTOR_UNAVAILABLE',
        message: 'A sandbox plan export is always bound to the Docker executor.',
      });
    }
    const runtime = runtimeOption ?? (alias ? undefined : 'pi');
    if (action === 'explain' && runtimeOption === undefined) {
      const selectionService = new LaunchApplicationService({
        discoverProjectConfig: projectDiscovery,
        inventoryCanonical,
        inventoryProjectSkills,
        statusSnapshot: async () => {
          throw new Error('selection status is unreachable');
        },
        executorEvidence: async () => {
          throw new Error('selection evidence is unreachable');
        },
      });
      const result = await selectionService.explainSelection({
        userConfig: user,
        cwd: parsed.cwd,
        ...(identityOption ? { identity: identityOption } : {}),
        ...(alias ? { alias } : {}),
        ...(modeOption ? { mode: modeOption } : {}),
        ...(skillPolicyOption ? { skillPolicy: skillPolicyOption } : {}),
        ...(contentScopeOption ? { contentScope: contentScopeOption } : {}),
        ...(executorOption === 'host' || executorOption === 'docker'
          ? { executor: executorOption }
          : {}),
        ...(workspaceOption === 'clone' ||
        workspaceOption === 'host-worktree' ||
        workspaceOption === 'direct'
          ? { workspace: workspaceOption }
          : {}),
        ...(networkPolicyOption ? { networkPolicy: networkPolicyOption } : {}),
        ...(presetOption ? { preset: presetOption } : {}),
      });
      return { data: result.data, warnings: [...warnings, ...result.warnings] };
    }
    let executionContext = context;
    let piAttestation: Awaited<ReturnType<RootAttestationService['verify']>> | undefined;
    const requirePiAccountPreflight =
      context.env.LOCALAPPDATA !== undefined &&
      (context.launchExecutorAdapters === undefined ||
        context.rootAttestationService !== undefined ||
        context.accountAuthVerifier !== undefined);
    const canonicalRoot = await catalogPath(context, parsed.cwd);
    const tty = context.launchTty ?? directProcessTty();
    const service = new LaunchApplicationService({
      discoverProjectConfig: projectDiscovery,
      inventoryCanonical,
      inventoryProjectSkills,
      statusSnapshot: ({ cwd, projectRoot, config }) =>
        status(context).snapshot({
          cwd,
          projectRoot,
          config,
          configHash: sha256Canonical(config as unknown as JsonValue),
        }),
      ...(action !== 'explain' && action !== 'sbx-plan-export' && context.sbxDiagnostics
        ? {
            dockerDiagnostics: async () => {
              const sbx = await context.sbxDiagnostics!(),
                code = sbx.failureCodes[0];
              if (!sbx.readOnly) {
                throw new MpxError({
                  code: 'SBX_DIAGNOSTICS_UNSAFE',
                  message: 'Sandbox diagnostics must be read-only.',
                });
              }
              if (code) {
                throw new MpxError({
                  code,
                  message: `Standalone sbx launch diagnostic: ${code}.`,
                  details: { executor: 'docker' },
                });
              }
            },
          }
        : {}),
      dockerAdmission: async ({ selection, statusSnapshot }) => {
        if (context.launchExecutorAdapters !== undefined || !context.env.LOCALAPPDATA) {
          return;
        }
        try {
          const snapshot = await statusSnapshot();
          const configured = user.identities[selection.identity.name]!;
          const network =
            namedSbxPolicies[selection.networkPolicy.name as keyof typeof namedSbxPolicies] ??
            namedSbxPolicies['deny-all'];
          const adapter = await createProductionSbxExecutionAdapter(
            {
              environment: context.env,
              cwd: parsed.cwd,
              stateRoot: path.join(context.env.LOCALAPPDATA, 'mpx'),
              runtime: selection.runtime,
              identity: {
                name: selection.identity.name,
                domain: configured.domain === 'personal' ? 'personal' : 'work',
              },
              workspaceMode: selection.workspace,
              worktreeRole: selection.workspace === 'host-worktree' ? 'linked' : 'main',
              ...(selection.workspace === 'direct' ? { directCompatibility: true } : {}),
              workspaceRoot: parsed.cwd,
              gitCommonDir: path.join(parsed.cwd, '.git'),
              nativeRoots: Object.values(user.identities).flatMap((identity) =>
                Object.values(identity.runtimeRoots),
              ),
              credentialRoots: [],
              oppositeDomainRoots: Object.values(user.identities)
                .filter((identity) => identity.domain !== configured.domain)
                .flatMap((identity) => Object.values(identity.runtimeRoots)),
              network: {
                name:
                  selection.networkPolicy.name in namedSbxPolicies
                    ? selection.networkPolicy.name
                    : 'deny-all',
                allow: network.allow,
              },
              ports: snapshot.services.flatMap((entry) =>
                entry.port === null ? [] : [entry.port],
              ),
            },
            context.launchSbxExecutionDependencies,
          );
          executionContext = {
            ...context,
            launchExecutorAdapters: [adapter],
            ...(adapter.bridge ? { launchSbxBridge: adapter.bridge } : {}),
          };
        } catch (failure) {
          if (failure instanceof MpxError) {
            throw failure;
          }
          const message =
            failure instanceof Error ? failure.message : 'Docker admission setup failed.';
          const matched = /^([A-Z][A-Z0-9_]+)(?::|\b)/u.exec(message);
          throw new MpxError({
            code: matched?.[1] ?? 'DOCKER_ADMISSION_SETUP_FAILED',
            message: 'Docker admission setup failed closed.',
            details: {
              executor: 'docker',
              diagnostic: matched?.[1] ?? 'DOCKER_ADMISSION_SETUP_FAILED',
            },
          });
        }
      },
      executorEvidence: (executor) => collectNodeExecutorEvidence(executionContext, executor),
      approveHost: async (selection) => {
        if (parsed.json || !tty.direct) {
          throw new MpxError({
            code: 'HOST_TTY_REQUIRED',
            message: 'Host approval requires a current direct interactive TTY.',
            remediation: 'Run the explicit host launch interactively, or use Docker.',
          });
        }
        if (!reasonOption?.trim()) {
          throw new MpxError({
            code: 'HOST_REASON_REQUIRED',
            message: 'Host execution requires a nonempty reason.',
          });
        }
        if (
          !(await tty.confirm(
            `Approve elevated host compatibility execution — ${sanitizeHostReason(reasonOption)}`,
          ))
        ) {
          throw new MpxError({
            code: 'HOST_APPROVAL_DENIED',
            message: 'Host execution was not approved.',
          });
        }
        return {
          reason: reasonOption,
          approvalKey: sha256Canonical({
            cwd: parsed.cwd,
            runtime: selection.runtime,
            identity: selection.identity.name,
            reason: reasonOption,
          } as unknown as JsonValue),
        };
      },
      accountPreflight: async ({ runtimeRoot, identity }) => {
        if (!requirePiAccountPreflight) {
          return;
        }
        const accountService =
          context.rootAttestationService ??
          new RootAttestationService(new RootAttestationStore(stateRoot(context)));
        const auth = context.accountAuthVerifier ?? productionPiAuthProbe(context, parsed.cwd);
        piAttestation = await accountService.verify(identity, runtimeRoot);
        await auth.verify(runtimeRoot);
        return async () => {
          await accountService.verify(identity, runtimeRoot, piAttestation!.ref);
          await auth.verify(runtimeRoot);
        };
      },
      sandboxExport: async ({ descriptor, selection, artifact }) => {
        if (!context.env.LOCALAPPDATA) {
          throw new MpxError({
            code: 'STATE_ROOT_REQUIRED',
            message: 'LOCALAPPDATA is required to plan a production sandbox.',
          });
        }
        const configured = user.identities[selection.identity.name]!;
        const network =
          namedSbxPolicies[selection.networkPolicy.name as keyof typeof namedSbxPolicies] ??
          namedSbxPolicies['deny-all'];
        const sources = await loadProductionSbxProofSources(context.env);
        const planned = planProductionSbxExecution({
          environment: context.env,
          cwd: parsed.cwd,
          stateRoot: path.join(context.env.LOCALAPPDATA, 'mpx'),
          runtime: selection.runtime,
          identity: {
            name: selection.identity.name,
            domain: selection.identity.domain === 'personal' ? 'personal' : 'work',
          },
          workspaceMode: selection.workspace,
          worktreeRole: selection.workspace === 'host-worktree' ? 'linked' : 'main',
          ...(selection.workspace === 'direct' ? { directCompatibility: true } : {}),
          workspaceRoot: parsed.cwd,
          gitCommonDir: path.join(parsed.cwd, '.git'),
          nativeRoots: Object.values(user.identities).flatMap((identity) =>
            Object.values(identity.runtimeRoots),
          ),
          credentialRoots: [],
          oppositeDomainRoots: Object.values(user.identities)
            .filter((identity) => identity.domain !== configured.domain)
            .flatMap((identity) => Object.values(identity.runtimeRoots)),
          network: {
            name:
              selection.networkPolicy.name in namedSbxPolicies
                ? selection.networkPolicy.name
                : 'deny-all',
            allow: network.allow,
          },
          ports: [],
          sources,
        });
        return createSbxLaunchPlanExportV1({
          launchKey: descriptor.launchKey,
          descriptorSha256: sha256Canonical(descriptor as unknown as JsonValue),
          runtime: selection.runtime,
          identity: {
            name: selection.identity.name,
            domain: selection.identity.domain === 'personal' ? 'personal' : 'work',
          },
          artifact: {
            manifestKey: artifact.reference.manifestKey,
            artifactKey: artifact.reference.artifactKey,
            fileMapHash: artifact.reference.fileMapHash,
          },
          evidence: {
            sbxPinSha256: sources.sbxPinSha256,
            runtimeToolInventorySha256: sources.runtimeToolInventorySha256,
            executorEvidenceSha256: sources.executorEvidenceSha256,
          },
          sandbox: {
            planKey: planned.plan.planKey,
            profile: planned.plan.networkPolicy.name,
            proofSandboxName: `mpx-proof-${planned.plan.planKey.slice(0, 12)}`,
            createArgv: productionProofCreateArgv(planned.plan),
          },
          policyMatrix: buildF2ProofPolicyMatrix(
            planned.plan.networkPolicy.name as keyof typeof namedSbxPolicies,
          ),
        });
      },
      launchExecution: async ({
        descriptor,
        manifest,
        artifact,
        catalog,
        canonicalRoot,
        cwd,
        nativeRuntimeRoot,
        statusSnapshot,
        project: bound,
        beforeChildExecution,
      }) => {
        const appData = context.env.APPDATA;
        if (!appData) {
          throw new MpxError({
            code: 'USER_CONFIG_ROOT_MISSING',
            message: 'APPDATA is required to publish immutable runtime projections.',
          });
        }
        const launchContext =
          executionContext.launchLifecycleBridge ||
          executionContext.launchRuntimeAdapters ||
          !executionContext.env.LOCALAPPDATA
            ? executionContext
            : {
                ...executionContext,
                launchLifecycleBridge: new ProductionSessionLifecycleBridge({
                  store: sessions(executionContext),
                  accountBindingRef: async (name, selectedRuntime) =>
                    selectedRuntime === 'pi' &&
                    piAttestation &&
                    name === piAttestation.identity.name
                      ? piAttestation.ref
                      : (executionContext.nativeAccountBindingResolver?.resolve(
                          { domain: user.identities[name]!.domain, name },
                          selectedRuntime,
                          user.identities[name]!.runtimeRoots[selectedRuntime],
                        ) ?? null),
                }),
              };
        return executeResolvedNodeLaunch({
          descriptor,
          manifest,
          artifact,
          catalog,
          canonicalRoot,
          agentsRoot: path.join(path.dirname(canonicalRoot), 'agents'),
          artifactsRoot: path.join(appData, 'mpx', 'runtime-artifacts'),
          stateRoot: context.env.LOCALAPPDATA ? path.join(context.env.LOCALAPPDATA, 'mpx') : '',
          cwd,
          environment: context.env,
          context: launchContext,
          tty,
          nativeRuntimeRoot,
          statusSnapshot,
          ...(bound ? { projectConfig: bound.config, projectRoot: bound.root } : {}),
          ...(beforeChildExecution ? { beforeChildExecution } : {}),
        });
      },
    });
    const prepared = await service.prepare({
      operation:
        action === 'explain'
          ? 'explain'
          : action === 'sbx-plan-export'
            ? 'sbx-plan-export'
            : 'launch',
      cwd: parsed.cwd,
      catalogRoot: canonicalRoot,
      userConfig: user,
      ...(runtime ? { runtime } : {}),
      ...(identityOption ? { identity: identityOption } : {}),
      ...(alias ? { alias } : {}),
      ...(modeOption ? { mode: modeOption } : {}),
      ...(skillPolicyOption ? { skillPolicy: skillPolicyOption } : {}),
      ...(contentScopeOption ? { contentScope: contentScopeOption } : {}),
      ...(action === 'sbx-plan-export'
        ? { executor: 'docker' as const }
        : executorOption === 'host' || executorOption === 'docker'
          ? { executor: executorOption }
          : {}),
      ...(workspaceOption === 'clone' ||
      workspaceOption === 'host-worktree' ||
      workspaceOption === 'direct'
        ? { workspace: workspaceOption }
        : {}),
      ...(networkPolicyOption ? { networkPolicy: networkPolicyOption } : {}),
      ...(presetOption ? { preset: presetOption } : {}),
    });
    const grantOptions = parsed.options.get('grant');
    const resolved = await service.resolve(prepared, {
      ...(Array.isArray(grantOptions) ? { grants: grantOptions } : {}),
      ...(reasonOption ? { reason: reasonOption } : {}),
    });
    const result = await service.execute(resolved);
    return { ...result, warnings };
  }
  if (
    group === 'worktree' &&
    ['create', 'remove', 'list', 'select', 'status', 'prepare', 'cancel', 'reconcile'].includes(
      action ?? '',
    )
  ) {
    const service = createNodeLifecycleApplicationService({
      worktrees: worktrees(context, parsed.cwd),
    });
    const stringOption = (name: string): string | undefined => {
      const value = parsed.options.get(name);
      return typeof value === 'string' ? value : undefined;
    };
    if (action === 'select' && parsed.options.get('cancel') === true) {
      if (args.length || stringOption('path')) {
        throw new UsageError('worktree select cancellation accepts no path');
      }
      return { data: null, warnings, silent: true };
    }
    const preparationApproval = (): string | undefined => {
      const packageAutomationApproval = stringOption('package-approval'),
        explicitExecutableApproval = stringOption('explicit-executable-approval');
      if (stringOption('approval')) {
        throw new UsageError(
          '--approval is not valid for preparation; use separate --package-approval and --explicit-executable-approval options',
        );
      }
      return packageAutomationApproval === undefined && explicitExecutableApproval === undefined
        ? undefined
        : JSON.stringify({
            ...(packageAutomationApproval === undefined ? {} : { packageAutomationApproval }),
            ...(explicitExecutableApproval === undefined ? {} : { explicitExecutableApproval }),
          });
    };
    if (action === 'create') {
      const template = stringOption('template');
      if (args.length > 1 || (args.length === 0 && !template)) {
        throw new UsageError('worktree create requires one branch or a complete --template');
      }
      const author = stringOption('author'),
        issue = stringOption('issue'),
        slug = stringOption('slug');
      const expanded = template
        ? expandBranchTemplate(template, {
            ...(author ? { author } : {}),
            ...(issue ? { issue } : {}),
            ...(slug ? { slug } : {}),
          })
        : undefined;
      const branch = args[0] ?? expanded!;
      const executionOption = stringOption('execution');
      if (
        executionOption !== undefined &&
        executionOption !== 'foreground' &&
        executionOption !== 'background' &&
        executionOption !== 'none'
      ) {
        throw new UsageError('--execution must be foreground, background, or none');
      }
      const base = stringOption('base');
      const approval = preparationApproval();
      const includeApproval = stringOption('include-approval');
      const sourceRoot = stringOption('source');
      data = await service.worktree('create', {
        cwd: parsed.cwd,
        branch,
        ...(base ? { base } : {}),
        ...(executionOption ? { execution: executionOption } : {}),
        ...(approval ? { approval } : {}),
        ...(includeApproval ? { includeApproval } : {}),
        ...(sourceRoot ? { sourceRoot } : {}),
      });
    } else if (action === 'remove') {
      if (args.length !== 1) {
        throw new UsageError('worktree remove requires exactly one path');
      }
      data = await service.worktree('remove', { cwd: parsed.cwd, worktreePath: args[0]! });
    } else if (action === 'list') {
      if (args.length) {
        throw new UsageError('worktree list accepts no arguments');
      }
      data = await service.worktree('list', { cwd: parsed.cwd });
    } else if (action === 'status') {
      if (args.length) {
        throw new UsageError('worktree status accepts no arguments');
      }
      data = await service.worktree('status', { cwd: parsed.cwd });
    } else if (action === 'prepare') {
      if (args.length !== 1) {
        throw new UsageError('worktree prepare requires exactly one lifecycle key');
      }
      const approval = preparationApproval();
      data = await service.worktree('prepare', {
        cwd: parsed.cwd,
        key: args[0]!,
        ...(approval ? { approval } : {}),
      });
    } else if (action === 'cancel') {
      if (args.length !== 1) {
        throw new UsageError('worktree cancel requires exactly one lifecycle key');
      }
      data = await service.worktree('cancel', { cwd: parsed.cwd, key: args[0]! });
    } else if (action === 'reconcile') {
      if (args.length) {
        throw new UsageError('worktree reconcile accepts no arguments');
      }
      const orphanApproval = stringOption('orphan-approval');
      data = await service.worktree('reconcile', {
        cwd: parsed.cwd,
        ...(orphanApproval ? { orphanApproval } : {}),
      });
    } else {
      const selectedPath = stringOption('path') ?? args[0];
      if (args.length > (stringOption('path') ? 0 : 1) || !selectedPath) {
        throw new UsageError('worktree select requires exactly one explicit path');
      }
      const selected = await service.worktree('select', {
        cwd: parsed.cwd,
        path: selectedPath,
      });
      data = selected;
      if (parsed.options.get('machine') === true) {
        return { data, warnings, machinePath: selected.path };
      }
    }
    return { data, warnings };
  }
  if (
    group === 'ports' &&
    ['ensure', 'resolve', 'list', 'inspect', 'kill', 'release', 'reconcile'].includes(action ?? '')
  ) {
    const service = ports(context);
    if (action === 'list') {
      if (args.length) {
        throw new UsageError('ports list accepts no arguments');
      }
      data = await createNodeLifecycleApplicationService({ ports: service }).listPorts();
    } else if (action === 'inspect') {
      if (args.length) {
        throw new UsageError('ports inspect accepts no arguments');
      }
      data = await service.inspect();
    } else if (action === 'kill') {
      const optionPid = parsed.options.get('pid');
      if (args.length > 1 || (optionPid !== undefined && args.length !== 0)) {
        throw new UsageError('ports kill accepts one PID, either positionally or with --pid');
      }
      const raw = optionPid ?? args[0];
      if (
        typeof raw !== 'string' ||
        !/^\d+$/u.test(raw) ||
        !Number.isSafeInteger(Number(raw)) ||
        Number(raw) < 1
      ) {
        throw new UsageError('ports kill requires a positive integer PID');
      }
      const pid = Number(raw);
      data = await createNodeLifecycleApplicationService({ ports: service }).killPortProcess(pid);
    } else if (action === 'release') {
      if (args.length) {
        throw new UsageError('ports release accepts no arguments');
      }
      data = await createNodeLifecycleApplicationService({ ports: service }).releasePorts({
        cwd: parsed.cwd,
      });
    } else if (action === 'reconcile') {
      if (args.length) {
        throw new UsageError('ports reconcile accepts no arguments');
      }
      if (parsed.options.get('rebuild') === true) {
        const [user, found] = await Promise.all([userConfig(context), project(parsed, context)]);
        const roots = [
          ...new Set(
            [...Object.values(user.domains).flat(), found.root].map((root) => path.resolve(root)),
          ),
        ];
        data = await service.rebuild({ roots });
      } else {
        data = await service.reconcile({ cwd: parsed.cwd });
      }
    } else {
      if (args.length) {
        throw new UsageError(`ports ${action} accepts no arguments`);
      }
      const found = await project(parsed, context);
      const request = {
        cwd: parsed.cwd,
        projectRoot: found.root,
        config: found.config,
        configHash: sha256Canonical(found.config as unknown as JsonValue),
      };
      if (action === 'ensure') {
        const result = await service.ensure(request);
        data = result.lease;
        warnings = result.warnings.map((warning) => ({
          code: warning.code,
          message: warning.message,
          severity: 'warning',
          ...(warning.port === undefined ? {} : { details: { port: warning.port } }),
        }));
      } else {
        data = await service.resolve(request);
      }
    }
    return { data, warnings };
  }
  if (group === 'status' && !action) {
    const found = await project(parsed, context);
    data = await createNodeLifecycleApplicationService({
      status: status(context, context.portService),
    }).currentStatus({ cwd: parsed.cwd, projectRoot: found.root, config: found.config });
    return { data, warnings };
  }
  if (group === 'init' && !action) {
    const result = await projectApplication(context).init({
      cwd: parsed.cwd,
      confirm: parsed.options.get('confirm') === true,
    });
    return { data: result.data, warnings: [...(result.warnings ?? [])] };
  }
  if (group === 'config' && ['show', 'resolve', 'explain', 'validate'].includes(action ?? '')) {
    const service = projectApplication(context);
    const result =
      action === 'resolve' || action === 'explain'
        ? await service.config({ cwd: parsed.cwd, action, user: await userConfig(context) })
        : action === 'show'
          ? await service.config({ cwd: parsed.cwd, action })
          : await service.config({ cwd: parsed.cwd, action: 'validate' });
    return { ...result, warnings };
  }
  if (group === 'doctor' && !action) {
    const result = await projectApplication(context).doctor({
      cwd: parsed.cwd,
      ...(context.env.APPDATA ? { appdata: context.env.APPDATA } : {}),
      environment: context.env,
    });
    return { ...result, warnings };
  }
  if (group === 'provider' && ['list', 'explain', 'doctor'].includes(action ?? '')) {
    if (action === 'list') {
      const role = parsed.options.get('role');
      if (role !== undefined && role !== 'repository' && role !== 'issues') {
        throw new UsageError('--role must be repository or issues');
      }
      const result = configuredProviderApplicationService(context).list(
        role === undefined ? {} : { role },
      );
      return { ...result, warnings };
    }
    if (action === 'doctor') {
      if (args.length) {
        throw new UsageError('provider doctor accepts no arguments');
      }
      const identityName = stringOption(parsed, 'identity');
      const found = await project(parsed, context);
      const identity =
        identityName === undefined
          ? undefined
          : (await requiredUserConfig(context)).identities[identityName];
      const result = await configuredProviderApplicationService(context).doctor({
        project: found.config,
        ...(identityName === undefined ? {} : { identityName }),
        ...(identity === undefined ? {} : { identity }),
        cwd: found.root,
      });
      return { ...result, warnings };
    }
    const role = args[0];
    if (role !== 'repository' && role !== 'issues') {
      throw new UsageError('provider explain requires repository or issues');
    }
    const found = await project(parsed, context);
    const result = configuredProviderApplicationService(context).explain({
      project: found.config,
      role,
    });
    return { ...result, warnings };
  }
  if (
    group === 'skill' &&
    ['list', 'search', 'show', 'explain', 'complete'].includes(action ?? '')
  ) {
    const identityOption = parsed.options.get('identity');
    if (typeof identityOption !== 'string') {
      throw new MpxError({
        code: 'IDENTITY_REQUIRED',
        message: 'Skill resolution requires an explicit launch identity.',
      });
    }
    const user = await requiredUserConfig(context);
    const service = skillApplication();
    service.assertConfiguredBindings({ user, identity: identityOption });
    const runtimeOption = parsed.options.get('runtime');
    if (runtimeOption === undefined) {
      throw new MpxError({
        code: 'SKILL_RUNTIME_REQUIRED',
        message: 'Skill resolution requires an explicit runtime.',
      });
    }
    if (runtimeOption !== 'claude' && runtimeOption !== 'pi') {
      throw new MpxError({
        code: 'SKILL_RUNTIME_INVALID',
        message: "Skill runtime must be 'claude' or 'pi'.",
      });
    }
    const skillPolicyOption = parsed.options.get('skill-policy');
    if (typeof skillPolicyOption !== 'string') {
      throw new MpxError({
        code: 'SKILL_POLICY_REQUIRED',
        message: 'Skill resolution requires an explicit skill policy.',
      });
    }
    service.assertConfiguredBindings({ user, skillPolicy: skillPolicyOption });
    if (action === 'list' && args.length) {
      throw new UsageError('skill list accepts no arguments');
    }
    if (action !== 'list' && !args[0]) {
      throw new UsageError(
        `skill ${action} requires ${action === 'search' ? 'a query' : action === 'complete' ? 'a prefix' : 'an id'}`,
      );
    }
    const limit = Number(parsed.options.get('limit') ?? 20);
    if (action === 'search' && !Number.isInteger(limit)) {
      throw new UsageError('--limit must be an integer');
    }
    const contentScope = parsed.options.get('content-scope');
    const artifactKey = parsed.options.get('artifact-key');
    const result = await service.execute({
      action: action as 'list' | 'search' | 'show' | 'explain' | 'complete',
      cwd: parsed.cwd,
      catalogRoot: await catalogPath(context, parsed.cwd),
      user,
      identity: identityOption,
      runtime: runtimeOption,
      skillPolicy: skillPolicyOption,
      ...(typeof contentScope === 'string' ? { contentScope } : {}),
      ...(args.length ? { value: args.join(' ') } : {}),
      ...(action === 'search' ? { limit } : {}),
      ...(typeof artifactKey === 'string' ? { artifactKey } : {}),
    });
    return { ...result, warnings };
  }
  throw new UsageError(usage);
}

export async function run(
  argv: string[] = process.argv.slice(2),
  io: CliIo = processIo,
  context: CliContext = defaultContext,
): Promise<number> {
  let parsed: Parsed | undefined;
  try {
    parsed = parse(argv);
    const result = await execute(parsed, context);
    if (result.machinePath !== undefined) {
      io.stdout(`${result.machinePath}\n`);
    } else if (!result.silent) {
      if (parsed.json) {
        io.stdout(JSON.stringify(successEnvelope(asJson(result.data), result.warnings)) + '\n');
      } else {
        io.stdout(human(result.data));
        for (const warning of result.warnings) {
          io.stderr(`${warning.code}: ${warning.message}\n`);
        }
      }
    }
    return result.exitCode ?? 0;
  } catch (error) {
    const usageError = error instanceof UsageError;
    const skillDiagnostic = error instanceof SkillCatalogError ? error.diagnostics[0] : undefined;
    const normalized = usageError
      ? new MpxError({ code: 'USAGE_ERROR', message: error.message })
      : error instanceof MpxError
        ? error
        : error instanceof ExecutionError
          ? executionMpxError(error)
          : skillDiagnostic
            ? new MpxError({
                code: skillDiagnostic.code,
                message: sanitizePublicMessage(skillDiagnostic.message),
              })
            : error instanceof StrictJsonError
              ? invalidConfigError()
              : error instanceof ConfigValidationError
                ? normalizeConfigError(error)
                : unexpectedCommandError(error, context);
    if (parsed?.json || argv.includes('--json')) {
      io.stdout(JSON.stringify(errorEnvelope(normalized)) + '\n');
    } else {
      io.stderr(`${normalized.code}: ${normalized.message}\n${usageError ? usage + '\n' : ''}`);
    }
    return usageError ? 2 : 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  if (process.argv[2] === '__preparation-worker' && process.argv.length === 4) {
    try {
      await executeInternalPreparationWorker(
        process.argv[3]!,
        process.env.MPX_PREPARATION_WORKER_TOKEN,
      );
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
  } else {
    process.exitCode = await run();
  }
}
