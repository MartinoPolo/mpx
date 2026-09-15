#!/usr/bin/env node
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigValidationError,
  StrictJsonError,
  discoverProjectConfig,
  type UserConfig,
} from '@mpx/config';
import {
  createProjectApplicationService,
  executionMpxError,
  type ProjectApplicationService,
} from '@mpx/application';
import {
  createNodeLaunchApplicationService,
  createNodeSessionResumeLaunchApplicationService,
  productionSessionProcessInspector,
} from '@mpx/application/node';
import {
  errorEnvelope,
  MpxError,
  successEnvelope,
  type Diagnostic,
  type JsonValue,
} from '@mpx/core';
import { ContentCompilerError } from '@mpx/content-compiler';
import { ExecutionError } from '@mpx/executors';
import { expandBranchTemplate } from '@mpx/worktrees';
import { inventoryCanonical, inventoryProjectSkills, SkillCatalogError } from '@mpx/skills';
import {
  catalogPath,
  defaultContext,
  ports,
  sessions,
  setupApplication,
  status,
  workspaceApplication,
  type CliContext,
} from './context.js';
import { executeSessionCommand } from './session-command.js';
import { executeContentCommand } from './content-command.js';
import { productionSessionResumeDependencies } from '@mpx/application/node';
import { processIo, type CliIo } from './io.js';
import { formatHumanError } from './error-format.js';
import {
  commandGroup,
  renderActionHelp,
  renderAllHelp,
  renderGroupHelp,
  renderRootHelp,
} from './command-metadata.js';

import {
  createDefaultSbxDiagnostics,
  createNodeSessionApplicationService,
  executeInternalPreparationWorker,
} from '@mpx/application/node';

interface Parsed {
  command: string[];
  cwd: string;
  json: boolean;
  help: boolean;
  options: Map<string, string | boolean | string[]>;
}
interface ExecuteResult {
  data: unknown;
  warnings: Diagnostic[];
  exitCode?: number;
  machinePath?: string;
  rawOutput?: string;
  silent?: boolean;
}
class UsageError extends Error {}
const usage = renderRootHelp().trimEnd();

function parse(argv: readonly string[]): Parsed {
  const words: string[] = [],
    options = new Map<string, string | boolean | string[]>();
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    if (word === '-h') {
      options.set('help', true);
      continue;
    }
    if (!word.startsWith('--')) {
      words.push(word);
      continue;
    }
    const [name, inline] = word.slice(2).split('=', 2);
    if (
      [
        'json',
        'help',
        'all',
        'confirm',
        'machine',
        'dry-run',
        'approve-host',
        'approve-resurrection',
      ].includes(name!)
    ) {
      options.set(name!, true);
    } else if (
      [
        'cwd',
        'limit',
        'lines',
        'identity',
        'runtime',
        'mode',
        'executor',
        'workspace',
        'network-policy',
        'preset',
        'reason',
        'base',
        'template',
        'slug',
        'author',
        'issue',
        'review',
        'execution',
        'package-approval',
        'explicit-executable-approval',
        'include-approval',
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
        'confirm-plan',
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
      if (name === 'runtime-arg') {
        options.set(name!, [...((options.get(name!) as string[] | undefined) ?? []), value]);
      } else {
        options.set(name!, value);
      }
    } else {
      throw new UsageError(`Unknown option: --${name}`);
    }
  }
  return {
    command: words,
    cwd: path.resolve(String(options.get('cwd') ?? process.cwd())),
    json: options.get('json') === true,
    help: options.get('help') === true,
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
    ...(sbxDiagnostics ? { sbxDiagnostics } : {}),
    statusSnapshot: (request) => status(context, context.portService).snapshot(request),
    ensureProject: (request) => ports(context).ensure(request),
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
function stringOption(parsed: Parsed, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === 'string' ? value : undefined;
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

const safeConfigField = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/u;
const sensitiveConfigField = /(?:secret|token|password|credential|api[._-]?key|private[._-]?key)/iu;

function safeFieldName(value: unknown): string | undefined {
  return typeof value === 'string' &&
    safeConfigField.test(value) &&
    !sensitiveConfigField.test(value)
    ? value
    : undefined;
}

function safeConfigPointer(instancePath: string): string {
  if (!instancePath) {
    return '/';
  }
  const segments = instancePath.split('/').slice(1);
  return segments.length > 0 && segments.every((segment) => safeFieldName(segment) !== undefined)
    ? `/${segments.join('/')}`
    : '/[field]';
}

function invalidConfigError(error: SyntaxError): MpxError {
  return new MpxError({
    code: 'CONFIG_INVALID',
    message: 'Configuration is invalid.',
    details: {
      errors: [
        {
          pointer: '/',
          keyword: 'syntax',
          reason: sanitizePublicMessage(error.message),
        },
      ],
    },
  });
}

function normalizeConfigError(error: ConfigValidationError): MpxError {
  return new MpxError({
    code: 'CONFIG_INVALID',
    message: 'Configuration is invalid.',
    details: {
      errors: error.errors.map(({ instancePath, keyword, message, params }) => {
        const parameter =
          keyword === 'required'
            ? safeFieldName(params.missingProperty)
            : keyword === 'additionalProperties'
              ? safeFieldName(params.additionalProperty)
              : undefined;
        const reason =
          keyword === 'required' && parameter
            ? `missing required field '${parameter}'`
            : keyword === 'additionalProperties' && parameter
              ? `unknown field '${parameter}'`
              : sanitizePublicMessage(message ?? 'does not match the current schema');
        return { pointer: safeConfigPointer(instancePath), keyword, reason };
      }),
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
function workspaceHuman(action: string, value: unknown): string {
  const result = value as Record<string, unknown>;
  if (action === 'list') {
    const workspaces = (result.workspaces ?? []) as Array<Record<string, unknown>>;
    return (
      workspaces.map((item) => `${item.branch ?? '(detached)'}  ${item.path}`).join('\n') +
      (workspaces.length ? '\n' : '')
    );
  }
  if (action === 'show') {
    return `${result.branch ?? '(detached)'}  ${result.path}\n`;
  }
  if (action === 'logs') {
    return `${String(result.text ?? '')}${String(result.text ?? '').endsWith('\n') ? '' : '\n'}`;
  }
  if ('service' in result) {
    const service = result.service as Record<string, unknown>;
    return `${service.id}: ${service.state}\n`;
  }
  return `${String(result.status ?? (result.killed ? `killed ${result.pid}` : 'ok'))}\n`;
}
function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}
function usageGuidance(parsed: Parsed | undefined): string {
  const [groupName, actionName] = parsed?.command ?? [];
  const group = groupName ? commandGroup(groupName) : undefined;
  const action = actionName ? group?.actions.find((item) => item.name === actionName) : undefined;
  if (group && action) {
    return `Usage: ${action.usage}\n`;
  }
  if (group) {
    return renderGroupHelp(group);
  }
  return renderRootHelp();
}

function productionSessionResumeLaunch(
  context: CliContext,
  authority: { readonly approveHost?: boolean } = {},
) {
  return createNodeSessionResumeLaunchApplicationService(
    {
      store: sessions(context),
      environment: context.env,
      context,
      catalogRoot: (cwd) => catalogPath(context, cwd),
      status: () => status(context),
      readUserConfig: () => userConfig(context),
      ...(context.sessionResumeDependencies
        ? { resumeDependencies: context.sessionResumeDependencies }
        : {}),
      ...(context.discoverProjectConfig
        ? { discoverProjectConfig: context.discoverProjectConfig }
        : {}),
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
    },
    authority,
  );
}
async function execute(parsed: Parsed, context: CliContext, io: CliIo): Promise<ExecuteResult> {
  const [group, action, ...args] = parsed.command;
  const runtimeArgOption = parsed.options.get('runtime-arg');
  const runtimeArgs = Array.isArray(runtimeArgOption) ? runtimeArgOption : undefined;
  const runtimeLaunchAction = group === 'launch' && (action === 'claude' || action === 'pi');
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
  if (group === 'content') {
    if (!action || !['inspect', 'check'].includes(action)) {
      throw new UsageError('content requires inspect or check');
    }
    const result = await executeContentCommand({ action, args, env: context.env });
    return { ...result, warnings: [] };
  }
  if (parsed.options.get('confirm') === true && (group !== 'init' || action !== undefined)) {
    throw new UsageError('--confirm is valid only for init');
  }
  let data: unknown;
  let warnings: Diagnostic[] = [];
  if (group === 'session') {
    const user = await userConfig(context);
    const sessionStore = sessions(context);
    const resolveIdentity = async (name: string) => {
      const identity = user.identities[name];
      if (!identity) {
        throw new MpxError({ code: 'IDENTITY_UNKNOWN', message: `Unknown identity '${name}'.` });
      }
      return { domain: identity.domain, name };
    };
    const resumeDependencies =
      action === 'resume'
        ? (context.sessionResumeDependencies ??
          productionSessionResumeDependencies({
            user,
            store: sessionStore,
            environment: context.env,
            cwd: parsed.cwd,
            ...(context.exactNativeRootVerifier
              ? { exactNativeRootVerifier: context.exactNativeRootVerifier }
              : {}),
            ...(context.piAuthVerifier ? { piAuthVerifier: context.piAuthVerifier } : {}),
          }))
        : undefined;
    const application = createNodeSessionApplicationService({
      store: sessionStore,
      planCurrentResume:
        context.sessionResumePlanner ??
        ((seed) => productionSessionResumeLaunch(context).plan(seed, user)),
      ...(action === 'list' || action === 'resurrect-export' || action === 'resume'
        ? {
            processInspector:
              context.sessionProcessInspector ?? productionSessionProcessInspector(),
          }
        : {}),
      ...(resumeDependencies ? { resumeDependencies } : {}),
      ...(action === 'resume'
        ? {
            executeConfirmedResume:
              context.sessionResumeExecutor ??
              (async (plan, authority) => {
                const launch = productionSessionResumeLaunch(context, authority);
                return launch.execute(await launch.prepare(plan, user));
              }),
          }
        : {}),
    });
    const result = await executeSessionCommand(
      { action, args, options: parsed.options },
      { application, resolveIdentity },
    );
    return { ...result, warnings: [...result.warnings] };
  }
  if (group === 'setup') {
    if (action || args.length) {
      throw new UsageError('setup accepts no positional arguments');
    }
    const unsupported = [...parsed.options.keys()].filter(
      (name) => name !== 'json' && name !== 'help',
    );
    if (unsupported.length) {
      throw new UsageError('setup accepts no command options');
    }
    const data = await setupApplication(context).execute();
    return {
      data,
      warnings,
      ...(parsed.json ? {} : { rawOutput: `Setup complete (${data.releaseKey}).\n` }),
    };
  }
  if (group === 'workspace') {
    if (
      !action ||
      !['list', 'show', 'create', 'remove', 'start', 'stop', 'logs'].includes(action)
    ) {
      throw new UsageError(
        'workspace requires one of: list, show, create, remove, start, stop, logs',
      );
    }
    const application = workspaceApplication(context, parsed.cwd);
    if (action === 'list') {
      if (args.length) {
        throw new UsageError('workspace list accepts no arguments');
      }
      data = await application.list({ schemaVersion: 1, cwd: parsed.cwd });
    } else if (action === 'show') {
      if (args.length > 1) {
        throw new UsageError('workspace show accepts at most one path');
      }
      const result = await application.show({
        schemaVersion: 1,
        cwd: parsed.cwd,
        ...(args[0] ? { path: args[0] } : {}),
      });
      if (parsed.options.get('machine') === true) {
        return { data: result, warnings, machinePath: result.path };
      }
      data = result;
    } else if (action === 'create') {
      const template = stringOption(parsed, 'template');
      if (args.length > 1 || (args.length === 0 && !template)) {
        throw new UsageError('workspace create requires one branch or a complete --template');
      }
      const author = stringOption(parsed, 'author'),
        issue = stringOption(parsed, 'issue'),
        slug = stringOption(parsed, 'slug');
      const branch =
        args[0] ??
        expandBranchTemplate(template!, {
          ...(author ? { author } : {}),
          ...(issue ? { issue } : {}),
          ...(slug ? { slug } : {}),
        });
      const execution = stringOption(parsed, 'execution');
      if (execution !== undefined && !['foreground', 'background', 'none'].includes(execution)) {
        throw new UsageError('--execution must be foreground, background, or none');
      }
      const packageApproval = stringOption(parsed, 'package-approval'),
        executableApproval = stringOption(parsed, 'explicit-executable-approval');
      const approval =
        packageApproval === undefined && executableApproval === undefined
          ? undefined
          : JSON.stringify({
              ...(packageApproval ? { packageAutomationApproval: packageApproval } : {}),
              ...(executableApproval ? { explicitExecutableApproval: executableApproval } : {}),
            });
      const base = stringOption(parsed, 'base'),
        includeApproval = stringOption(parsed, 'include-approval'),
        sourceRoot = stringOption(parsed, 'source');
      data = await application.create({
        schemaVersion: 1,
        cwd: parsed.cwd,
        branch,
        ...(base ? { base } : {}),
        ...(execution ? { execution: execution as 'foreground' | 'background' | 'none' } : {}),
        ...(approval ? { approval } : {}),
        ...(includeApproval ? { includeApproval } : {}),
        ...(sourceRoot ? { sourceRoot } : {}),
      });
    } else if (action === 'remove') {
      if (args.length !== 1) {
        throw new UsageError('workspace remove requires exactly one path');
      }
      data = await application.remove({ schemaVersion: 1, cwd: parsed.cwd, path: args[0]! });
    } else {
      if (args.length < 1 || args.length > 2) {
        throw new UsageError(`workspace ${action} requires a service id and optional path`);
      }
      const request = {
        schemaVersion: 1 as const,
        cwd: parsed.cwd,
        serviceId: args[0]!,
        ...(args[1] ? { path: args[1] } : {}),
      };
      if (action === 'start') {
        data = await application.start(request);
      } else if (action === 'stop') {
        data = await application.stop(request);
      } else {
        const rawLines = stringOption(parsed, 'lines'),
          lines = rawLines === undefined ? undefined : Number(rawLines);
        if (lines !== undefined && (!Number.isInteger(lines) || lines < 1 || lines > 500)) {
          throw new UsageError('--lines must be an integer from 1 through 500');
        }
        data = await application.logs({ ...request, ...(lines === undefined ? {} : { lines }) });
      }
    }
    return { data, warnings, ...(parsed.json ? {} : { rawOutput: workspaceHuman(action, data) }) };
  }
  if (group === 'port') {
    if (
      action !== 'kill' ||
      args.length !== 1 ||
      !/^\d+$/u.test(args[0]!) ||
      !Number.isSafeInteger(Number(args[0])) ||
      Number(args[0]) < 1
    ) {
      throw new UsageError('port kill requires one positive integer PID');
    }
    data = await workspaceApplication(context, parsed.cwd).killPort({
      schemaVersion: 1,
      pid: Number(args[0]),
    });
    return { data, warnings, ...(parsed.json ? {} : { rawOutput: workspaceHuman(action, data) }) };
  }
  if (group === 'launch' && (action === 'claude' || action === 'pi')) {
    if (args.length) {
      throw new UsageError(`launch ${action} accepts no positional arguments`);
    }
    const user = await requiredUserConfig(context);
    const projectDiscovery = context.discoverProjectConfig ?? discoverProjectConfig;
    const stringOption = (name: string): string | undefined => {
      const value = parsed.options.get(name);
      return typeof value === 'string' ? value : undefined;
    };
    const runtime = action;
    const identityOption = stringOption('identity'),
      modeOption = stringOption('mode');
    const presetOption = stringOption('preset'),
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
    if (approveHost && (executorOption !== 'host' || !reasonOption?.trim())) {
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
    if (!identityOption) {
      throw new MpxError({
        code: 'IDENTITY_REQUIRED',
        message: 'Launch identity must be supplied explicitly.',
      });
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
    });
    const prepared = await service.prepare({
      operation: 'launch',
      cwd: parsed.cwd,
      catalogRoot: canonicalRoot,
      userConfig: user,
      runtime,
      ...(identityOption ? { identity: identityOption } : {}),
      ...(modeOption ? { mode: modeOption } : {}),
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
      ...(runtimeArgs ? { runtimeArgs } : {}),
    });
    const resolved = await service.resolve(prepared, reasonOption ? { reason: reasonOption } : {});
    const descriptor = service.descriptor(resolved);
    const prelaunchWarnings = descriptor.diagnostics.filter(
      (diagnostic) => diagnostic.code === 'PROJECT_CONFIG_MISSING_DEVELOPER_FALLBACK',
    );
    if (!parsed.json) {
      for (const warning of prelaunchWarnings) {
        io.stderr(`${warning.code}: ${warning.message}\n`);
      }
    }
    const result = await service.execute(resolved);
    return { ...result, warnings: [...result.warnings] };
  }
  if (group === 'init' && !action) {
    const result = await projectApplication(context).init({
      cwd: parsed.cwd,
      confirm: parsed.options.get('confirm') === true,
    });
    return { data: result.data, warnings: [...(result.warnings ?? [])] };
  }
  if (group === 'doctor' && !action) {
    const result = await projectApplication(context).doctor({
      cwd: parsed.cwd,
      ...(context.env.APPDATA ? { appdata: context.env.APPDATA } : {}),
      environment: context.env,
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
    const [groupName, actionName] = parsed.command;
    if (groupName === 'help') {
      if (actionName) {
        throw new UsageError(`Unknown command: help ${actionName}`);
      }
      io.stdout(parsed.options.get('all') === true ? renderAllHelp() : renderRootHelp());
      return 0;
    }
    if (parsed.options.get('all') === true) {
      throw new UsageError('--all is valid only for help');
    }
    const group = groupName ? commandGroup(groupName) : undefined;
    const hasActionSpecificOptions = [...parsed.options.keys()].some(
      (name) => !['cwd', 'json', 'help'].includes(name),
    );
    if (
      !groupName ||
      parsed.help ||
      (group && !actionName && !group.defaultOperation && !hasActionSpecificOptions)
    ) {
      if (!groupName) {
        io.stdout(renderRootHelp());
        return 0;
      }
      if (!group) {
        throw new UsageError(`Unknown command: ${groupName}`);
      }
      if (!actionName) {
        io.stdout(renderGroupHelp(group));
        return 0;
      }
      const action = group.actions.find((item) => item.name === actionName);
      if (!action) {
        throw new UsageError(`Unknown command: ${groupName} ${actionName}`);
      }
      io.stdout(renderActionHelp(group, action));
      return 0;
    }
    if (groupName && !group) {
      throw new UsageError(`Unknown command: ${groupName}`);
    }
    if (group && actionName && !group.actions.some((item) => item.name === actionName)) {
      throw new UsageError(`Unknown command: ${groupName} ${actionName}`);
    }
    const result = await execute(parsed, context, io);
    if (result.machinePath !== undefined) {
      io.stdout(`${result.machinePath}\n`);
    } else if (result.silent && parsed.json && result.warnings.length > 0) {
      io.stdout(JSON.stringify(successEnvelope(asJson(result.data), result.warnings)) + '\n');
    } else if (!result.silent) {
      if (parsed.json) {
        io.stdout(JSON.stringify(successEnvelope(asJson(result.data), result.warnings)) + '\n');
      } else if (result.rawOutput !== undefined) {
        io.stdout(result.rawOutput);
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
            : error instanceof ContentCompilerError
              ? new MpxError({
                  code: 'CONTENT_COMPILATION_FAILED',
                  message: sanitizePublicMessage(error.message),
                })
              : error instanceof StrictJsonError
                ? invalidConfigError(error)
                : error instanceof ConfigValidationError
                  ? normalizeConfigError(error)
                  : unexpectedCommandError(error, context);
    if (parsed?.json || argv.includes('--json')) {
      io.stdout(JSON.stringify(errorEnvelope(normalized)) + '\n');
    } else {
      io.stderr(
        formatHumanError(normalized.toPublic(), usageError ? usageGuidance(parsed) : undefined, {
          color: io.supportsColor === true,
        }),
      );
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
