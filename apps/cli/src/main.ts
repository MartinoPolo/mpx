#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { access, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigValidationError,
  StrictJsonError,
  discoverProjectConfig,
  resolveEffectiveSkillPacks,
  resolveKnownLaunchCwdClassification,
  type DiscoveredConfig,
  type UserConfig,
} from '@mpx/config';
import {
  createProjectApplicationService,
  createSkillApplicationService,
  resolveProjectSkillOptions,
  type ProjectApplicationService,
  type SkillApplicationService,
} from '@mpx/application';
import {
  createSkillArtifactReference,
  errorEnvelope,
  MpxError,
  sha256Canonical,
  successEnvelope,
  type Diagnostic,
  type JsonValue,
} from '@mpx/core';
import {
  canonicalNativeRootDigest,
  resolveLaunch,
  resolveLaunchSelection,
  serializeLaunchPublic,
  type ResolveLaunchSelectionInput,
  type ShortLaunchAlias,
} from '@mpx/launch';
import {
  ExecutionError,
  buildF2ProofPolicyMatrix,
  namedSbxPolicies,
  sanitizeHostReason,
} from '@mpx/executors';
import { createSbxLaunchPlanExportV1 } from '@mpx/runtime-contracts';
import { LocalIssueStore, rebuildObsidianIssueViews } from '@mpx/provider-local';
import { parseStatusSnapshotV1, type StatusSnapshotV1 } from '@mpx/status';
import { expandBranchTemplate } from '@mpx/worktrees';
import {
  createRuntimeSkillArtifact,
  inventoryCanonical,
  inventoryProjectSkills,
  resolveManifest,
  SkillCatalogError,
} from '@mpx/skills';
import {
  catalogPath,
  configuredProviderApplicationService,
  createDefaultSbxDiagnostics,
  defaultContext,
  executeInternalPreparationWorker,
  immutableInstaller,
  installIntentBuilder,
  ports,
  productionSessionDiscoveries,
  productionSessionProcessInspector,
  productionSessionResumeDependencies,
  sessions,
  stateRoot,
  status,
  worktrees,
  type CliContext,
} from './context.js';
import { executeSessionCommand } from './session-command.js';
import { executeInstallCommand } from './install-command.js';
import { executeAccountCommand, productionPiAuthProbe } from './account-command.js';
import { ProductionSessionLifecycleBridge } from './session-lifecycle-bridge.js';
import {
  createProductionSessionBranchRuntimeAdapter,
  createWindowsTerminalBranchAdapter,
  diagnoseSessionBranchAdapters,
} from './session-branch-adapters.js';
import {
  currentLaunchTuple,
  directProcessTty,
  executeResolvedLaunch,
  executionMpxError,
  executorEvidence,
  resolveTrustedRuntimeExecutable,
} from './launch-execution.js';
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
import { defaultDevService, executeDevCommand } from './dev-command.js';
import { createProductionSessionDockerResumeAdmission } from './session-docker-resume.js';
import {
  createProductionSbxExecutionAdapter,
  diagnoseConfiguredF2Proof,
  loadProductionSbxProofSources,
  planProductionSbxExecution,
  productionProofCreateArgv,
} from './sbx-execution.js';
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
import { executeMigrationCommand } from './migration.js';

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
  return createProjectApplicationService({
    path: { join: path.join, basename: path.basename, isAbsolute: path.isAbsolute },
    access: context.accessFile ?? access,
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
function productionAccountServices(user: UserConfig, context: CliContext, cwd: string) {
  const service =
    context.rootAttestationService ??
    new RootAttestationService(new RootAttestationStore(stateRoot(context)));
  const auth =
    context.accountAuthVerifier ??
    productionPiAuthProbe({
      cwd,
      environment: context.env,
      ...(context.launchExecutableResolver ? { resolver: context.launchExecutableResolver } : {}),
    });
  const resolver = {
    resolve: async (
      identity: { domain: string; name: string },
      runtime: 'claude' | 'pi',
      root: string,
    ): Promise<string | null> =>
      runtime === 'claude' ? null : (await service.verify(identity, root)).ref,
  };
  const verifier = {
    verify: async (ref: string): Promise<'verified' | 'unavailable' | 'mismatch' | 'duplicate'> => {
      try {
        const matches = (await service.store.list()).filter((record) => record.ref === ref);
        if (matches.length > 1) {
          return 'duplicate';
        }
        const record = matches[0];
        if (!record) {
          return 'unavailable';
        }
        const configured = user.identities[record.identity.name];
        if (!configured || configured.domain !== record.identity.domain) {
          return 'mismatch';
        }
        await service.verify(record.identity, configured.runtimeRoots.pi, ref);
        await auth.verify(configured.runtimeRoots.pi);
        return 'verified';
      } catch (error) {
        return (error as { code?: unknown }).code === 'ACCOUNT_ROOT_CHANGED' ||
          (error as { code?: unknown }).code === 'ACCOUNT_BINDING_MISMATCH'
          ? 'mismatch'
          : 'unavailable';
      }
    },
  };
  return { service, auth, resolver, verifier };
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
const resolveOptions = resolveProjectSkillOptions;

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
  const dockerAdmission =
    plan.launch.executor.kind === 'docker'
      ? await (
          context.sessionDockerResumeAdmission ??
          createProductionSessionDockerResumeAdmission(context.env)
        )(plan)
      : undefined;
  if (dockerAdmission && !dockerAdmission.admitted) {
    throw new SessionError(
      'SESSION_RESUME_F2_ADMISSION_DENIED',
      'Docker resume requires matching persisted F2 proof, plan, inventory, attestation, and identity; recreate in Docker is required.',
      { hostFallback: false, action: 'recreate', admissionCode: dockerAdmission.code },
    );
  }
  const store = sessions(context);
  let nativeBinding: Awaited<ReturnType<typeof store.readNativeBinding>> | undefined;
  let reverifyPiAccount: (() => Promise<void>) | undefined;
  if (plan.runtime === 'pi') {
    try {
      nativeBinding = await store.readNativeBinding(plan.nativeBindingRef);
    } catch {
      throw new SessionError(
        'SESSION_RESUME_ACCOUNT_UNAVAILABLE',
        'The recorded Pi account binding is unavailable.',
      );
    }
    const configured = user.identities[plan.identity.name];
    const accountRef = nativeBinding.accountBindingRef;
    if (
      !configured ||
      configured.domain !== plan.identity.domain ||
      nativeBinding.runtime !== 'pi' ||
      nativeBinding.identity.domain !== plan.identity.domain ||
      nativeBinding.identity.name !== plan.identity.name
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
    const configuredRoot = configured.runtimeRoots.pi;
    const accountService =
      context.rootAttestationService ??
      new RootAttestationService(new RootAttestationStore(stateRoot(context)));
    const auth =
      context.accountAuthVerifier ??
      productionPiAuthProbe({
        cwd: plan.cwd,
        environment: context.env,
        ...(context.launchExecutableResolver ? { resolver: context.launchExecutableResolver } : {}),
      });
    reverifyPiAccount = async () => {
      try {
        const matchingRefs = await accountService.store?.list();
        if (matchingRefs && matchingRefs.filter((record) => record.ref === accountRef).length > 1) {
          throw Object.assign(new Error('duplicate'), { code: 'ACCOUNT_ROOT_DUPLICATE' });
        }
        await accountService.verify(plan.identity, configuredRoot, accountRef);
        await auth.verify(configuredRoot);
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
    };
    await reverifyPiAccount();
  }
  const cwd = plan.cwd;
  if (!path.isAbsolute(cwd)) {
    throw new MpxError({
      code: 'SESSION_RESUME_LAUNCH_SNAPSHOT_INCOMPLETE',
      message: 'The recorded workspace is not an absolute launch cwd.',
    });
  }
  const found = await discoverProjectConfig(cwd);
  const projectId = plan.projectId ?? undefined;
  if ((found?.config.project.id ?? null) !== plan.projectId) {
    throw new MpxError({
      code: 'SESSION_RESUME_LAUNCH_BINDING_MISMATCH',
      message: 'The current project binding does not match the recorded launch.',
    });
  }
  if (plan.repositoryId === null) {
    throw new MpxError({
      code: 'SESSION_RESUME_LAUNCH_SNAPSHOT_INCOMPLETE',
      message: 'The recorded launch lacks a repository binding.',
    });
  }
  const repositoryId = plan.repositoryId;
  const selectionInput: ResolveLaunchSelectionInput = {
    userConfig: user,
    cwd,
    runtime: plan.runtime,
    identity: plan.identity.name,
    mode: plan.launch.mode,
    skillPolicy: plan.launch.skillPolicy,
    contentScope: plan.launch.contentScope,
    executor: plan.launch.executor.kind,
    workspace: plan.launch.workspace as 'clone' | 'host-worktree' | 'direct',
    networkPolicy: plan.launch.networkPolicy,
    ...(projectId ? { projectId } : {}),
  };
  if (
    !(['clone', 'host-worktree', 'direct'] as const).includes(
      plan.launch.workspace as 'clone' | 'host-worktree' | 'direct',
    )
  ) {
    throw new MpxError({
      code: 'SESSION_RESUME_LAUNCH_SNAPSHOT_INCOMPLETE',
      message: 'The recorded launch lacks a valid workspace strategy.',
    });
  }
  const selection = await resolveLaunchSelection(selectionInput);
  if (selection.identity.domain !== plan.identity.domain) {
    throw new MpxError({
      code: 'SESSION_RESUME_IDENTITY_MISMATCH',
      message: 'The current launch identity does not match the recorded domain.',
    });
  }
  const opts = resolveOptions(user, {
    identity: plan.identity.name,
    skillPolicy: plan.launch.skillPolicy,
    contentScope: plan.launch.contentScope,
    repositoryId,
    ...(projectId ? { projectId } : {}),
  });
  const canonicalRoot = await catalogPath(context, cwd),
    canonicalCatalog = await inventoryCanonical(canonicalRoot);
  const projectInventory = found
    ? await inventoryProjectSkills(found.root, canonicalCatalog)
    : { skills: [], diagnostics: [] };
  if (projectInventory.diagnostics.length) {
    throw new SkillCatalogError(projectInventory.diagnostics);
  }
  const catalog = [...canonicalCatalog, ...projectInventory.skills].sort((left, right) =>
    left.identity.localeCompare(right.identity),
  );
  const manifest = resolveManifest(catalog, opts),
    artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: plan.runtime });
  const scope = user.contentScopes[plan.launch.contentScope],
    projectOverride = projectId ? user.projects?.[projectId] : undefined;
  if (!scope) {
    throw new MpxError({
      code: 'SESSION_RESUME_LAUNCH_SNAPSHOT_INCOMPLETE',
      message: 'The recorded content scope is no longer configured.',
    });
  }
  const skillArtifact = createSkillArtifactReference({
    runtime: plan.runtime,
    identity: plan.identity.name,
    skillPolicy: plan.launch.skillPolicy,
    contentScope: plan.launch.contentScope,
    projectId: projectId ?? null,
    catalogHash: sha256Canonical(
      catalog.map((skill) => ({
        identity: skill.identity,
        contentHash: skill.contentHash,
        ...('directoryHash' in skill
          ? {
              origin: 'project',
              directoryHash: skill.directoryHash,
              realPath: skill.realPath,
              realProjectRoot: skill.realProjectRoot,
            }
          : { origin: 'canonical' }),
      })) as unknown as JsonValue,
    ),
    enabledPacks: resolveEffectiveSkillPacks({
      contentScopeSkillPacks: scope.skillPacks,
      projectSkillPacks: projectOverride?.skillPacks,
      skillPolicySkillPacks: selection.skillPolicy.declaration.skillPacks,
    }),
    skillPolicyConfig: selection.skillPolicy.declaration as unknown as JsonValue,
    contentScopeExposure: (scope.skillExposure ?? {}) as unknown as JsonValue,
    projectExposure: (projectOverride?.skillExposure ?? null) as unknown as JsonValue,
  });
  let resumeContext = context;
  if (
    plan.launch.executor.kind === 'docker' &&
    context.launchExecutorAdapters === undefined &&
    context.env.LOCALAPPDATA
  ) {
    try {
      const snapshot = found
        ? await status(context).snapshot({
            cwd,
            projectRoot: found.root,
            config: found.config,
            configHash: sha256Canonical(found.config as unknown as JsonValue),
          })
        : parseStatusSnapshotV1({
            schemaVersion: 1,
            project: { id: repositoryId, cwd },
            worktree: { id: null, path: null, role: null, branch: null },
            portResolution: 'missing',
            services: [],
            diagnostics: [],
          });
      const configured = user.identities[plan.identity.name]!,
        network =
          namedSbxPolicies[selection.networkPolicy.name as keyof typeof namedSbxPolicies] ??
          namedSbxPolicies['deny-all'];
      const adapter = await createProductionSbxExecutionAdapter(
        {
          environment: context.env,
          cwd,
          stateRoot: path.join(context.env.LOCALAPPDATA, 'mpx'),
          runtime: plan.runtime,
          identity: {
            name: plan.identity.name,
            domain: plan.identity.domain === 'personal' ? 'personal' : 'work',
          },
          workspaceMode: selection.workspace,
          worktreeRole: selection.workspace === 'host-worktree' ? 'linked' : 'main',
          ...(selection.workspace === 'direct' ? { directCompatibility: true } : {}),
          workspaceRoot: cwd,
          gitCommonDir: path.join(cwd, '.git'),
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
  const evidence = await executorEvidence(resumeContext, plan.launch.executor.kind);
  const descriptor = await resolveLaunch({
    ...selectionInput,
    grants: plan.launch.grants.map((grant) => `${grant.access}:${grant.resource}`),
    ...(plan.launch.executor.kind === 'host'
      ? {
          reason: 'confirmed session resume',
          hostApproval: {
            reason: 'confirmed session resume',
            approvalKey: sha256Canonical({
              confirmationDigest: plan.confirmationDigest,
            } as unknown as JsonValue),
          },
        }
      : {}),
    skillArtifact,
    selectedNativeRuntimeRoot: user.identities[plan.identity.name]!.runtimeRoots[plan.runtime],
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
      manifestKey: manifest.manifestKey,
      skillArtifactKey: skillArtifact.artifactKey,
    },
  });
  const descriptorDigest = sha256Canonical(descriptor as unknown as JsonValue);
  const currentLaunch = {
    launchKey: descriptor.launchKey,
    descriptorDigest,
    mode: descriptor.mode,
    skillPolicy: descriptor.skillPolicy,
    contentScope: descriptor.contentScope.name,
    executor: { kind: descriptor.executor.name },
    workspace: descriptor.workspace,
    networkPolicy: descriptor.networkPolicy.name,
    grants: descriptor.grants,
    artifactKey: artifact.reference.artifactKey,
    manifestKey: manifest.manifestKey,
  };
  const {
    launchKey: currentLaunchKey,
    descriptorDigest: currentDescriptorDigest,
    ...currentPolicyAxes
  } = currentLaunch;
  const {
    launchKey: previousLaunchKey,
    descriptorDigest: previousDescriptorDigest,
    ...recordedPolicyAxes
  } = plan.launch;
  if (
    previousLaunchKey !== plan.previousLaunch.launchKey ||
    previousDescriptorDigest !== plan.previousLaunch.descriptorDigest ||
    descriptor.runtime !== plan.runtime ||
    descriptor.identity.domain !== plan.identity.domain ||
    descriptor.identity.name !== plan.identity.name ||
    sha256Canonical(currentPolicyAxes as unknown as JsonValue) !==
      sha256Canonical(recordedPolicyAxes as unknown as JsonValue)
  ) {
    throw new SessionError(
      'SESSION_RESUME_PLAN_STALE',
      'Current capability, policy, grant, artifact, or manifest evidence differs from the explicitly confirmed resume plan.',
    );
  }
  const appData = context.env.APPDATA,
    localAppData = context.env.LOCALAPPDATA;
  if (!appData || !localAppData) {
    throw new MpxError({
      code: 'STATE_ROOT_UNAVAILABLE',
      message: 'APPDATA and LOCALAPPDATA are required for resume execution.',
    });
  }
  nativeBinding = nativeBinding ?? (await store.readNativeBinding(plan.nativeBindingRef));
  const beforeChildExecution = reverifyPiAccount;
  const launchContext =
    resumeContext.launchLifecycleBridge || resumeContext.launchRuntimeAdapters
      ? resumeContext
      : {
          ...resumeContext,
          launchLifecycleBridge: new ProductionSessionLifecycleBridge(
            store,
            resumeContext.nativeAccountBindingResolver
              ? (name, runtime) =>
                  resumeContext.nativeAccountBindingResolver!.resolve(
                    { domain: user.identities[name]!.domain, name },
                    runtime,
                    user.identities[name]!.runtimeRoots[runtime],
                  )
              : undefined,
          ),
        };
  const snapshot = found
    ? async (): Promise<StatusSnapshotV1> =>
        status(context).snapshot({
          cwd,
          projectRoot: found.root,
          config: found.config,
          configHash: sha256Canonical(found.config as unknown as JsonValue),
        })
    : async (): Promise<StatusSnapshotV1> =>
        parseStatusSnapshotV1({
          schemaVersion: 1,
          project: { id: repositoryId, cwd },
          worktree: { id: null, path: null, role: null, branch: null },
          portResolution: 'missing',
          services: [],
          diagnostics: [],
        });
  const result = await executeResolvedLaunch({
    descriptor,
    manifest,
    artifact,
    catalog,
    canonicalRoot,
    agentsRoot: path.join(path.dirname(canonicalRoot), 'agents'),
    artifactsRoot: path.join(appData, 'mpx', 'runtime-artifacts'),
    stateRoot: path.join(localAppData, 'mpx'),
    cwd,
    environment: context.env,
    context: launchContext,
    tty: context.launchTty ?? directProcessTty(),
    nativeRuntimeRoot: user.identities[plan.identity.name]!.runtimeRoots[plan.runtime],
    statusSnapshot: snapshot,
    ...(branchInvocation
      ? { branch: { nativeBinding, invocation: branchInvocation } }
      : { resume: { nativeBinding, nativeSessionRef: plan.nativeSessionRef } }),
    ...(beforeChildExecution ? { beforeChildExecution } : {}),
  });
  return {
    ...result,
    resumeLaunch: {
      previousLaunchKey,
      previousDescriptorDigest,
      newLaunchKey: currentLaunchKey,
      newDescriptorDigest: currentDescriptorDigest,
    },
  };
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
      data: await executeMigrationCommand({
        action,
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
    const accountStateRoot = stateRoot(context);
    const service =
      context.rootAttestationService ??
      new RootAttestationService(new RootAttestationStore(accountStateRoot));
    const auth =
      context.accountAuthVerifier ??
      productionPiAuthProbe({
        cwd: parsed.cwd,
        environment: context.env,
        ...(context.launchExecutableResolver ? { resolver: context.launchExecutableResolver } : {}),
      });
    const identityName = stringOption(parsed, 'identity'),
      confirmationDigest = stringOption(parsed, 'confirm-plan');
    data = await executeAccountCommand(
      {
        action: action as 'enroll' | 're-enroll' | 'list' | 'status' | 'verify',
        ...(identityName ? { identityName } : {}),
        ...(confirmationDigest ? { confirmationDigest } : {}),
      },
      { user, service, auth },
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
          const bridge = new ProductionSessionLifecycleBridge(
            sessionStore,
            context.nativeAccountBindingResolver
              ? (name, runtime) =>
                  context.nativeAccountBindingResolver!.resolve(
                    { domain: user.identities[name]!.domain, name },
                    runtime,
                    user.identities[name]!.runtimeRoots[runtime],
                  )
              : undefined,
            async () => {
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
          );
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
                context.accountAuthVerifier ??
                productionPiAuthProbe({
                  cwd: parsed.cwd,
                  environment: context.env,
                  ...(context.launchExecutableResolver
                    ? { resolver: context.launchExecutableResolver }
                    : {}),
                })
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
    const result = await executeSessionCommand(
      { action, args, options: parsed.options },
      {
        store: sessionStore,
        resolveIdentity: async (name) => {
          const identity = user.identities[name];
          if (!identity) {
            throw new MpxError({
              code: 'IDENTITY_UNKNOWN',
              message: `Unknown identity '${name}'.`,
            });
          }
          return { domain: identity.domain, name };
        },
        discoveries:
          context.sessionDiscoveries ??
          (() =>
            productionSessionDiscoveries(
              user,
              sessionStore,
              context.env,
              context.nativeAccountBindingResolver ?? account?.resolver,
            )),
        processInspector: context.sessionProcessInspector ?? productionSessionProcessInspector(),
        resumeDependencies:
          context.sessionResumeDependencies ??
          productionSessionResumeDependencies(
            user,
            sessionStore,
            context.nativeAccountBindingVerifier ?? account?.verifier,
            context.env,
          ),
        executeResume:
          context.sessionResumeExecutor ??
          ((plan) => executeProductionSessionResume(plan, user, context)),
        ...(branchService ? { branchService } : {}),
        ...(terminalAvailability.terminal.available
          ? { terminalExecutable: terminalAvailability.terminal.executable }
          : {}),
        ...(scheduledCaptureAuthority ? { scheduledCaptureAuthority } : {}),
      },
    );
    return { data: result.data, warnings: [...result.warnings] };
  }
  if (group === 'install') {
    const needsBuilder =
      action === 'intent' ||
      action === 'prepare' ||
      (action === 'verify' && typeof parsed.options.get('external-plan') === 'string');
    const result = await executeInstallCommand(
      { action, args, options: parsed.options },
      {
        orchestrator: immutableInstaller(context),
        ...(needsBuilder ? { builder: installIntentBuilder(context) } : {}),
      },
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
      (executor === 'docker' ? undefined : defaultDevService(context.env, found.root));
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
    data = await executeDevCommand({
      action,
      ...(id ? { id } : {}),
      cwd: parsed.cwd,
      config: found.config,
      projectRoot: found.root,
      ...(action === 'start' ? { portService: ports(context) as never } : {}),
      service,
      executor,
      ...(lines === undefined ? {} : { lines }),
    });
    return { data, warnings };
  }
  if (group === 'view') {
    if (action !== 'rebuild' || args.length) {
      throw new UsageError('view requires rebuild');
    }
    const found = await project(parsed, context),
      issues = found.config.issues;
    if (issues?.provider !== 'local' || !issues.store || !issues.view) {
      throw new MpxError({
        code: 'LOCAL_VIEW_UNAVAILABLE',
        message: 'The project must select logical local store and view registrations.',
      });
    }
    const user = await requiredUserConfig(context),
      storeRegistration = user.localIssueStores?.[issues.store],
      view = user.localViews?.[issues.view];
    if (!storeRegistration || !view) {
      throw new MpxError({
        code: 'LOCAL_VIEW_UNAVAILABLE',
        message: 'The selected logical local store or view is not registered.',
      });
    }
    data = await rebuildObsidianIssueViews(
      new LocalIssueStore(storeRegistration.root, { projectId: found.config.project.id }),
      {
        vaultRoot: view.vaultRoot,
        outputRoot: view.outputRoot,
        projectId: found.config.project.id,
        resumeBaseUrl: view.resumeBaseUrl,
      },
    );
    return { data, warnings };
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
    const found = await discoverProjectConfig(parsed.cwd);
    const projectId = found?.config.project.id,
      repositoryId = projectId ?? 'unbound/runtime';
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
    const common = (runtime?: 'claude' | 'pi', identity?: string): ResolveLaunchSelectionInput => ({
      userConfig: user,
      cwd: parsed.cwd,
      ...(runtime ? { runtime } : {}),
      ...(identity ? { identity } : {}),
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
      ...(projectId ? { projectId } : {}),
    });
    const publicSelection = (selection: Awaited<ReturnType<typeof resolveLaunchSelection>>) => ({
      mode: { name: selection.mode.name },
      skillPolicy: { name: selection.skillPolicy.name },
      contentScope: selection.contentScope,
      executor: selection.executor,
      workspace: selection.workspace,
      networkPolicy: { name: selection.networkPolicy.name },
      preset: selection.preset,
      provenance: selection.provenance,
      cwdClassification: selection.cwdClassification,
    });
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
      const candidates = [];
      for (const identity of Object.keys(user.identities).sort()) {
        const selection = await resolveLaunchSelection(common(runtimeOption ?? 'pi', identity));
        candidates.push({
          identity,
          ...publicSelection(selection),
          identityDomainCompatible:
            selection.identity.domain === selection.cwdClassification.domain,
        });
      }
      return {
        data: { schemaVersion: 1, identity: null, runtime: runtimeOption ?? null, candidates },
        warnings,
      };
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
    const launchInput = common(runtime, identityOption);
    const selection = await resolveLaunchSelection(launchInput);
    let piAttestation: Awaited<ReturnType<RootAttestationService['verify']>> | undefined;
    let beforeChildExecution: (() => Promise<void>) | undefined;
    const requirePiAccountPreflight =
      context.env.LOCALAPPDATA !== undefined &&
      (context.launchExecutorAdapters === undefined ||
        context.rootAttestationService !== undefined ||
        context.accountAuthVerifier !== undefined);
    if (action === 'explain' && runtimeOption === undefined) {
      if (projectId && selection.identity.domain !== selection.cwdClassification.domain) {
        throw new MpxError({
          code: 'IDENTITY_DOMAIN_MISMATCH',
          message: `Identity '${selection.identity.name}' cannot launch in domain '${selection.cwdClassification.domain}' without an explicit grant.`,
        });
      }
      return {
        data: {
          schemaVersion: 1,
          runtime: null,
          identity: selection.identity,
          selection: publicSelection(selection),
        },
        warnings,
      };
    }
    if (
      action !== 'explain' &&
      action !== 'sbx-plan-export' &&
      selection.executor === 'docker' &&
      context.sbxDiagnostics
    ) {
      const sbx = await context.sbxDiagnostics(),
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
    }
    const opts = resolveOptions(user, {
      identity: selection.identity.name,
      skillPolicy: selection.skillPolicy.name,
      contentScope: selection.contentScope.name,
      repositoryId,
      ...(projectId ? { projectId } : {}),
    });
    const canonicalRoot = await catalogPath(context, parsed.cwd),
      canonicalCatalog = await inventoryCanonical(canonicalRoot);
    const projectInventory = found
      ? await inventoryProjectSkills(found.root, canonicalCatalog)
      : { skills: [], diagnostics: [] };
    if (projectInventory.diagnostics.length) {
      throw new SkillCatalogError(projectInventory.diagnostics);
    }
    const catalog = [...canonicalCatalog, ...projectInventory.skills].sort((left, right) =>
      left.identity.localeCompare(right.identity),
    );
    const manifest = resolveManifest(catalog, opts),
      artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: selection.runtime });
    const scope = user.contentScopes[selection.contentScope.name]!,
      projectOverride = projectId ? user.projects?.[projectId] : undefined;
    const skillArtifact = createSkillArtifactReference({
      runtime: selection.runtime,
      identity: selection.identity.name,
      skillPolicy: selection.skillPolicy.name,
      contentScope: selection.contentScope.name,
      projectId: projectId ?? null,
      catalogHash: sha256Canonical(
        catalog.map((skill) => ({
          identity: skill.identity,
          contentHash: skill.contentHash,
          ...('directoryHash' in skill
            ? {
                origin: 'project',
                directoryHash: skill.directoryHash,
                realPath: skill.realPath,
                realProjectRoot: skill.realProjectRoot,
              }
            : { origin: 'canonical' }),
        })) as unknown as JsonValue,
      ),
      enabledPacks: resolveEffectiveSkillPacks({
        contentScopeSkillPacks: scope.skillPacks,
        projectSkillPacks: projectOverride?.skillPacks,
        skillPolicySkillPacks: selection.skillPolicy.declaration.skillPacks,
      }),
      skillPolicyConfig: selection.skillPolicy.declaration as unknown as JsonValue,
      contentScopeExposure: (scope.skillExposure ?? {}) as unknown as JsonValue,
      projectExposure: (projectOverride?.skillExposure ?? null) as unknown as JsonValue,
    });
    const statusSnapshot = found
      ? async (): Promise<StatusSnapshotV1> =>
          status(context).snapshot({
            cwd: parsed.cwd,
            projectRoot: found.root,
            config: found.config,
            configHash: sha256Canonical(found.config as unknown as JsonValue),
          })
      : async (): Promise<StatusSnapshotV1> =>
          parseStatusSnapshotV1({
            schemaVersion: 1,
            project: { id: repositoryId, cwd: parsed.cwd },
            worktree: { id: null, path: null, role: null, branch: null },
            portResolution: 'missing',
            services: [],
            diagnostics: [],
          });
    let executionContext = context;
    if (
      action !== 'explain' &&
      action !== 'sbx-plan-export' &&
      selection.executor === 'docker' &&
      context.launchExecutorAdapters === undefined &&
      context.env.LOCALAPPDATA
    ) {
      try {
        const snapshot = await statusSnapshot(),
          configured = user.identities[selection.identity.name]!,
          network =
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
            ports: snapshot.services.flatMap((service) =>
              service.port === null ? [] : [service.port],
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
            failure instanceof Error ? failure.message : 'Docker admission setup failed.',
          matched = /^([A-Z][A-Z0-9_]+)(?::|\b)/u.exec(message);
        throw new MpxError({
          code: matched?.[1] ?? 'DOCKER_ADMISSION_SETUP_FAILED',
          message: 'Docker admission setup failed closed.',
          details: {
            executor: 'docker',
            diagnostic: matched?.[1] ?? 'DOCKER_ADMISSION_SETUP_FAILED',
          },
        });
      }
    }
    const readOnlyPlan = action === 'explain' || action === 'sbx-plan-export';
    const evidence = readOnlyPlan
        ? {
            status: 'unverified' as const,
            verifier: 'launch-explain',
            evidenceDigest: sha256Canonical({
              executor: selection.executor,
              operation: action,
            } as unknown as JsonValue),
          }
        : await executorEvidence(executionContext, selection.executor),
      tty = context.launchTty ?? directProcessTty();
    let hostApproval: { reason: string; approvalKey: string } | undefined;
    if (selection.executor === 'host' && !readOnlyPlan) {
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
      hostApproval = {
        reason: reasonOption,
        approvalKey: sha256Canonical({
          cwd: parsed.cwd,
          runtime: selection.runtime,
          identity: selection.identity.name,
          reason: reasonOption,
        } as unknown as JsonValue),
      };
    }
    const grantOptions = parsed.options.get('grant');
    const descriptor = await resolveLaunch({
      ...launchInput,
      ...(Array.isArray(grantOptions) ? { grants: grantOptions } : {}),
      ...(reasonOption ? { reason: reasonOption } : {}),
      ...(hostApproval ? { hostApproval } : {}),
      skillArtifact,
      selectedNativeRuntimeRoot:
        user.identities[selection.identity.name]!.runtimeRoots[selection.runtime],
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
        manifestKey: manifest.manifestKey,
        skillArtifactKey: skillArtifact.artifactKey,
      },
    });
    if (action === 'explain') {
      return { data: serializeLaunchPublic(descriptor), warnings };
    }
    if (action === 'sbx-plan-export') {
      if (!context.env.LOCALAPPDATA) {
        throw new MpxError({
          code: 'STATE_ROOT_REQUIRED',
          message: 'LOCALAPPDATA is required to plan a production sandbox.',
        });
      }
      const configured = user.identities[selection.identity.name]!,
        network =
          namedSbxPolicies[selection.networkPolicy.name as keyof typeof namedSbxPolicies] ??
          namedSbxPolicies['deny-all'],
        sources = await loadProductionSbxProofSources(context.env);
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
      const portableArgv = productionProofCreateArgv(planned.plan);
      const exportPlan = createSbxLaunchPlanExportV1({
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
          createArgv: portableArgv,
        },
        policyMatrix: buildF2ProofPolicyMatrix(
          planned.plan.networkPolicy.name as keyof typeof namedSbxPolicies,
        ),
      });
      return { data: exportPlan, warnings };
    }
    if (selection.runtime === 'pi' && evidence.status === 'verified' && requirePiAccountPreflight) {
      const accountService =
        context.rootAttestationService ??
        new RootAttestationService(new RootAttestationStore(stateRoot(context)));
      const configured = user.identities[selection.identity.name]!,
        auth =
          context.accountAuthVerifier ??
          productionPiAuthProbe({
            cwd: parsed.cwd,
            environment: context.env,
            ...(context.launchExecutableResolver
              ? { resolver: context.launchExecutableResolver }
              : {}),
          });
      piAttestation = await accountService.verify(selection.identity, configured.runtimeRoots.pi);
      await auth.verify(configured.runtimeRoots.pi);
      const attestationRef = piAttestation.ref;
      beforeChildExecution = async () => {
        await accountService.verify(selection.identity, configured.runtimeRoots.pi, attestationRef);
        await auth.verify(configured.runtimeRoots.pi);
      };
    }
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
            launchLifecycleBridge: new ProductionSessionLifecycleBridge(
              sessions(executionContext),
              async (name, runtime) =>
                runtime === 'pi' && piAttestation && name === piAttestation.identity.name
                  ? piAttestation.ref
                  : (executionContext.nativeAccountBindingResolver?.resolve(
                      { domain: user.identities[name]!.domain, name },
                      runtime,
                      user.identities[name]!.runtimeRoots[runtime],
                    ) ?? null),
            ),
          };
    const processResult = await executeResolvedLaunch({
      descriptor,
      manifest,
      artifact,
      catalog,
      canonicalRoot,
      agentsRoot: path.join(path.dirname(canonicalRoot), 'agents'),
      artifactsRoot: path.join(appData, 'mpx', 'runtime-artifacts'),
      stateRoot: context.env.LOCALAPPDATA ? path.join(context.env.LOCALAPPDATA, 'mpx') : '',
      cwd: parsed.cwd,
      environment: context.env,
      context: launchContext,
      tty,
      nativeRuntimeRoot: user.identities[selection.identity.name]!.runtimeRoots[selection.runtime],
      statusSnapshot,
      ...(found ? { projectConfig: found.config, projectRoot: found.root } : {}),
      ...(beforeChildExecution ? { beforeChildExecution } : {}),
    });
    return { data: null, warnings, silent: true, exitCode: processResult.exitCode };
  }
  if (
    group === 'worktree' &&
    ['create', 'remove', 'list', 'select', 'status', 'prepare', 'cancel', 'reconcile'].includes(
      action ?? '',
    )
  ) {
    const service = worktrees(context, parsed.cwd);
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
      const execution = stringOption('execution');
      if (execution !== undefined && !['foreground', 'background', 'none'].includes(execution)) {
        throw new UsageError('--execution must be foreground, background, or none');
      }
      data = await service.create({
        cwd: parsed.cwd,
        branch,
        ...(stringOption('base') ? { base: stringOption('base') } : {}),
        ...(template ? { template } : {}),
        ...(stringOption('slug') ? { slug: stringOption('slug') } : {}),
        ...(stringOption('author') ? { author: stringOption('author') } : {}),
        ...(stringOption('issue') ? { issue: stringOption('issue') } : {}),
        ...(execution ? { execution } : {}),
        ...(preparationApproval() ? { approval: preparationApproval() } : {}),
        ...(stringOption('include-approval')
          ? { includeApproval: stringOption('include-approval') }
          : {}),
        ...(stringOption('source') ? { sourceRoot: stringOption('source') } : {}),
      });
    } else if (action === 'remove') {
      if (args.length !== 1) {
        throw new UsageError('worktree remove requires exactly one path');
      }
      data = await service.remove({ cwd: parsed.cwd, worktreePath: args[0]! });
    } else if (action === 'list') {
      if (args.length) {
        throw new UsageError('worktree list accepts no arguments');
      }
      data = await service.list({ cwd: parsed.cwd });
    } else if (action === 'status') {
      if (args.length) {
        throw new UsageError('worktree status accepts no arguments');
      }
      data = await service.status({ cwd: parsed.cwd });
    } else if (action === 'prepare') {
      if (args.length !== 1) {
        throw new UsageError('worktree prepare requires exactly one lifecycle key');
      }
      data = await service.prepare({
        cwd: parsed.cwd,
        key: args[0]!,
        ...(preparationApproval() ? { approval: preparationApproval() } : {}),
      });
    } else if (action === 'cancel') {
      if (args.length !== 1) {
        throw new UsageError('worktree cancel requires exactly one lifecycle key');
      }
      data = await service.cancel({ cwd: parsed.cwd, key: args[0]! });
    } else if (action === 'reconcile') {
      if (args.length) {
        throw new UsageError('worktree reconcile accepts no arguments');
      }
      data = await service.reconcile({
        cwd: parsed.cwd,
        ...(stringOption('orphan-approval')
          ? { orphanApproval: stringOption('orphan-approval') }
          : {}),
      });
    } else {
      const selectedPath = stringOption('path') ?? args[0];
      if (args.length > (stringOption('path') ? 0 : 1) || !selectedPath) {
        throw new UsageError('worktree select requires exactly one explicit path');
      }
      const selected = await service.select({ cwd: parsed.cwd, path: selectedPath });
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
      data = [...(await service.list())].sort((a, b) => a.leaseId.localeCompare(b.leaseId));
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
      await service.kill(pid);
      data = { killed: true, pid };
    } else if (action === 'release') {
      if (args.length) {
        throw new UsageError('ports release accepts no arguments');
      }
      await service.release({ cwd: parsed.cwd });
      data = { released: true };
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
    data = await status(context, context.portService).snapshot({
      cwd: parsed.cwd,
      projectRoot: found.root,
      config: found.config,
      configHash: sha256Canonical(found.config as unknown as JsonValue),
    });
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
    const found = await project(parsed, context),
      user = await userConfig(context);
    const catalog = await inventoryCanonical(await catalogPath(context, parsed.cwd));
    const local = await inventoryProjectSkills(found.root, catalog);
    const diagnostics: Diagnostic[] = [];
    const sbxProbe =
      context.sbxDiagnostics ??
      (context === defaultContext
        ? () => createDefaultSbxDiagnostics(context.env, parsed.cwd)
        : undefined);
    if (sbxProbe) {
      const sbx = await sbxProbe();
      if (!sbx.readOnly) {
        throw new MpxError({
          code: 'SBX_DIAGNOSTICS_UNSAFE',
          message: 'Sandbox diagnostics must be read-only.',
        });
      }
      for (const code of [...new Set(sbx.failureCodes)].sort()) {
        diagnostics.push({
          code,
          message: `Standalone sbx diagnostic: ${code}.`,
          severity: 'warning',
          details: { executor: 'docker' },
        });
      }
      for (const code of await diagnoseConfiguredF2Proof(context.env)) {
        diagnostics.push({
          code,
          message: `Standalone sbx proof diagnostic: ${code}.`,
          severity: 'warning',
          details: { executor: 'docker' },
        });
      }
    }
    const branchAdapters = await diagnoseSessionBranchAdapters({
      runtimeAvailable: true,
      ...(context.env.MPX_WINDOWS_TERMINAL_EXECUTABLE
        ? { terminalCandidate: context.env.MPX_WINDOWS_TERMINAL_EXECUTABLE }
        : {}),
      trustedRoots: [
        context.env.WINDIR,
        context.env.LOCALAPPDATA
          ? path.join(context.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps')
          : undefined,
      ].filter((value): value is string => Boolean(value && path.isAbsolute(value))),
    });
    if (!branchAdapters.runtime.available) {
      diagnostics.push({
        code: branchAdapters.runtime.code,
        message: 'Production session branch runtime execution is unavailable.',
        severity: 'warning',
      });
    }
    if (context.env.MPX_WINDOWS_TERMINAL_EXECUTABLE && !branchAdapters.terminal.available) {
      diagnostics.push({
        code: branchAdapters.terminal.code,
        message:
          'Configured Windows Terminal is unavailable or untrusted; side-by-side tabs are disabled.',
        severity: 'warning',
      });
    }
    const services = Object.entries(found.config.development?.services ?? {}).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    for (const [name, service] of services) {
      if (service.port.mode === 'fixed-shared') {
        diagnostics.push({
          code: 'FIXED_SHARED_LIMITATION',
          message: `Service ${name} uses a fixed-shared port that MPX cannot reserve exclusively.`,
          severity: 'warning',
          details: {
            service: name,
            ...(service.port.preferred === undefined ? {} : { port: service.port.preferred }),
          },
        });
      }
    }
    if (services.some(([, service]) => service.port.mode === 'managed')) {
      const request = {
        cwd: parsed.cwd,
        projectRoot: found.root,
        config: found.config,
        configHash: sha256Canonical(found.config as unknown as JsonValue),
      };
      const snapshot = await status(context, ports(context)).snapshot(request);
      diagnostics.push(
        ...snapshot.diagnostics.map(({ code, message, severity, serviceId }) => ({
          code,
          message,
          severity,
          ...(serviceId ? { details: { service: serviceId } } : {}),
        })),
      );
    }
    const result = await projectApplication(context).doctor({
      cwd: parsed.cwd,
      user,
      canonical: catalog,
      projectInventory: local,
      additionalDiagnostics: diagnostics,
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
