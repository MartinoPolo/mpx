#!/usr/bin/env node
import { access } from 'node:fs/promises';
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
  type AccountApplicationService,
  type MigrationAction,
  type ProjectApplicationService,
  type SkillApplicationService,
} from '@mpx/application';
import {
  createNodeAccountApplicationService,
  createNodeInstallApplicationService,
  createNodeLocalIssueViewRebuilder,
  createNodeLaunchApplicationService,
  createNodeMigrationApplicationService,
  executeNodeSessionResumeLaunch,
  resolveTrustedRuntimeExecutable,
} from '@mpx/application/node';
import {
  errorEnvelope,
  MpxError,
  successEnvelope,
  type Diagnostic,
  type JsonValue,
} from '@mpx/core';
import type { ShortLaunchAlias } from '@mpx/launch';
import { ExecutionError } from '@mpx/executors';
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
  diagnoseNodeSessionBranchAdapters,
  productionSessionDiscoveries,
  productionSessionResumeDependencies,
} from '@mpx/application/node';
import { processIo, type CliIo } from './io.js';

import {
  createDefaultSbxDiagnostics,
  createNodeDevService,
  createNodeLifecycleApplicationService,
  createNodeSessionApplicationService,
  createNodeSessionBranchProduction,
  createNodeSessionLegacyImport,
  diagnoseConfiguredF2Proof,
  executeInternalPreparationWorker,
} from '@mpx/application/node';
import type { ResumePlanV1 } from '@mpx/sessions';

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
        'approve-host',
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
        'terminal-title',
        'runtime-arg',
      ].includes(name!)
    ) {
      const value = inline ?? argv[++i];
      if (
        value === undefined ||
        (value.length === 0 && name !== 'body') ||
        (value.startsWith('--') && name !== 'runtime-arg')
      ) {
        throw new UsageError(`--${name} requires a value`);
      }
      if (['grant', 'import-legacy', 'map-account', 'map-pi-root', 'runtime-arg'].includes(name!)) {
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
function portsApplication(context: CliContext) {
  const projects = projectApplication(context);
  return createNodeLifecycleApplicationService({
    ports: ports(context),
    projects: {
      discover: (cwd) => projects.discover(cwd),
      userConfig: () =>
        projects.optionalUserConfig({
          ...(context.env.APPDATA ? { appdata: context.env.APPDATA } : {}),
          environment: context.env,
        }),
    },
  });
}
async function requiredUserConfig(context: CliContext): Promise<UserConfig> {
  return projectApplication(context).requiredUserConfig({
    ...(context.env.APPDATA ? { appdata: context.env.APPDATA } : {}),
    environment: context.env,
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

async function executeProductionSessionResume(
  plan: ResumePlanV1,
  user: UserConfig,
  context: CliContext,
  branchInvocation?: { readonly executable: string; readonly argv: readonly string[] },
): Promise<unknown> {
  return executeNodeSessionResumeLaunch(
    {
      store: sessions(context),
      environment: context.env,
      context,
      catalogRoot: (cwd) => catalogPath(context, cwd),
      status: () => status(context),
      stateRoot: () => stateRoot(context),
      executionRoots: async () => {
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
      ...(branchInvocation ? { branchInvocation } : {}),
    },
    plan,
    user,
  );
}
async function execute(parsed: Parsed, context: CliContext): Promise<ExecuteResult> {
  const [group, action, ...args] = parsed.command;
  const runtimeArgOption = parsed.options.get('runtime-arg');
  const runtimeArgs = Array.isArray(runtimeArgOption) ? runtimeArgOption : undefined;
  const runtimeLaunchAction =
    group === 'launch' &&
    (action === 'claude' || action === 'pi' || shortLaunchAliases.has(action as ShortLaunchAlias));
  if (runtimeArgs && !runtimeLaunchAction) {
    throw new MpxError({
      code: 'RUNTIME_ARGS_SCOPE_INVALID',
      message: '--runtime-arg is valid only for launch execution.',
    });
  }
  const approveHostOption = parsed.options.get('approve-host') === true;
  if (approveHostOption && !runtimeLaunchAction) {
    throw new MpxError({
      code: 'HOST_APPROVAL_SCOPE_INVALID',
      message: '--approve-host is valid only for runtime launch execution.',
    });
  }
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
    const account = context.env.LOCALAPPDATA
      ? productionAccountServices(user, context, parsed.cwd)
      : undefined;
    const branchProduction = await createNodeSessionBranchProduction({
      enabled: action === 'branch',
      cwd: parsed.cwd,
      user,
      store: sessionStore,
      environment: context.env,
      stateRoot: () => stateRoot(context),
      worktrees: () => worktrees(context, parsed.cwd),
      launchContext: context,
      catalogRoot: (cwd) => catalogPath(context, cwd),
      status: () => status(context),
      executionRoots: async () => {
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
      ...(context.sessionBranchService ? { branchService: context.sessionBranchService } : {}),
      ...(context.sessionBranchRuntimeAdapter
        ? { runtimeAdapter: context.sessionBranchRuntimeAdapter }
        : {}),
      ...(context.sessionBranchTerminalAdapter
        ? { terminalAdapter: context.sessionBranchTerminalAdapter }
        : {}),
      ...(context.sessionDockerResumeAdmission
        ? { dockerAdmission: context.sessionDockerResumeAdmission }
        : {}),
      ...(context.sessionProcessInspector
        ? { processInspector: context.sessionProcessInspector }
        : {}),
      ...(context.rootAttestationService
        ? { rootAttestationService: context.rootAttestationService }
        : {}),
      ...(context.accountAuthVerifier ? { accountAuthVerifier: context.accountAuthVerifier } : {}),
      ...(context.nativeAccountBindingResolver
        ? { nativeAccountBindingResolver: context.nativeAccountBindingResolver }
        : {}),
      ...(context.launchExecutableResolver
        ? { launchExecutableResolver: context.launchExecutableResolver }
        : {}),
    });
    const branchService = branchProduction.branchService;
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
    });
    const result = await executeSessionCommand(
      { action, args, options: parsed.options },
      {
        application,
        ...(branchProduction.terminalExecutable
          ? { terminalExecutable: branchProduction.terminalExecutable }
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
      networkPolicyOption = stringOption('network-policy'),
      approveHost = approveHostOption;
    if (executorOption !== undefined && executorOption !== 'host' && executorOption !== 'docker') {
      throw new MpxError({
        code: 'EXECUTOR_UNAVAILABLE',
        message: `Executor '${executorOption}' is unavailable.`,
      });
    }
    if (
      approveHost &&
      (action === 'explain' ||
        action === 'sbx-plan-export' ||
        executorOption !== 'host' ||
        !reasonOption?.trim())
    ) {
      throw new MpxError({
        code: 'HOST_APPROVAL_SCOPE_INVALID',
        message: '--approve-host requires an explicit host launch and a nonempty --reason.',
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
      const candidateService = createNodeLaunchApplicationService({
        cwd: parsed.cwd,
        userConfig: user,
        environment: context.env,
        context,
        interaction: { json: parsed.json },
        discoverProjectConfig: projectDiscovery,
        status: () => status(context),
        sessions: () => sessions(context),
        stateRoot: () => stateRoot(context),
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
      const selectionService = createNodeLaunchApplicationService({
        cwd: parsed.cwd,
        userConfig: user,
        environment: context.env,
        context,
        interaction: { json: parsed.json },
        discoverProjectConfig: projectDiscovery,
        status: () => status(context),
        sessions: () => sessions(context),
        stateRoot: () => stateRoot(context),
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
    const canonicalRoot = await catalogPath(context, parsed.cwd);
    const service = createNodeLaunchApplicationService({
      cwd: parsed.cwd,
      catalogRoot: canonicalRoot,
      userConfig: user,
      environment: context.env,
      context,
      interaction: {
        json: parsed.json,
        ...(reasonOption ? { reason: reasonOption } : {}),
        ...(approveHost ? { approveHost: true } : {}),
        ...(context.launchTty ? { tty: context.launchTty } : {}),
      },
      discoverProjectConfig: projectDiscovery,
      status: () => status(context),
      sessions: () => sessions(context),
      stateRoot: () => stateRoot(context),
      ...(action !== 'explain' && action !== 'sbx-plan-export' && context.sbxDiagnostics
        ? { sbxDiagnostics: context.sbxDiagnostics }
        : {}),
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
      ...(runtimeArgs ? { runtimeArgs } : {}),
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
    const application = portsApplication(context);
    if (action === 'list') {
      if (args.length) {
        throw new UsageError('ports list accepts no arguments');
      }
      data = await application.listPorts();
    } else if (action === 'inspect') {
      if (args.length) {
        throw new UsageError('ports inspect accepts no arguments');
      }
      const result = await application.port('inspect', { cwd: parsed.cwd });
      data = result.data;
      warnings = [...result.warnings];
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
      data = await application.killPortProcess(pid);
    } else if (action === 'release') {
      if (args.length) {
        throw new UsageError('ports release accepts no arguments');
      }
      data = await application.releasePorts({ cwd: parsed.cwd });
    } else if (action === 'reconcile') {
      if (args.length) {
        throw new UsageError('ports reconcile accepts no arguments');
      }
      const result = await application.port('reconcile', {
        cwd: parsed.cwd,
        rebuild: parsed.options.get('rebuild') === true,
      });
      data = result.data;
      warnings = [...result.warnings];
    } else {
      if (args.length) {
        throw new UsageError(`ports ${action} accepts no arguments`);
      }
      const operation = action === 'ensure' ? 'ensure' : 'resolve';
      const result = await application.port(operation, { cwd: parsed.cwd });
      data = result.data;
      warnings = [...result.warnings];
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
