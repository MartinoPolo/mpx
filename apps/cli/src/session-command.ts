import {
  SessionError,
  type IdentityV1,
  type SessionListFilter,
  type WorkflowStatus,
} from '@mpx/sessions';
import type { Diagnostic } from '@mpx/core';
import type { SessionApplication, SessionLegacyImportRequest } from '@mpx/application';

export interface SessionCommandInput {
  readonly action: string | undefined;
  readonly args: readonly string[];
  readonly options: ReadonlyMap<string, string | boolean | string[]>;
}
export interface SessionCommandContext {
  readonly application: SessionApplication;
  readonly terminalExecutable?: string;
}
export interface SessionCommandResult {
  readonly data: unknown;
  readonly warnings: readonly Diagnostic[];
}

const text = (input: SessionCommandInput, name: string): string | undefined => {
  const value = input.options.get(name);
  return typeof value === 'string' ? value : undefined;
};
const repeated = (input: SessionCommandInput, name: string): string[] => {
  const value = input.options.get(name);
  return Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
};
const usage = (message: string): never => {
  throw new SessionError('SESSION_USAGE_ERROR', message);
};
function mappings(
  input: SessionCommandInput,
  name: 'map-account' | 'map-pi-root',
): ReadonlyArray<Readonly<{ source: string; target: string }>> {
  return repeated(input, name).map((value) => {
    const separator = value.indexOf('=');
    if (separator < 1 || separator === value.length - 1) {
      usage(`--${name} requires SOURCE=TARGET`);
    }
    return { source: value.slice(0, separator), target: value.slice(separator + 1) };
  });
}
function runtimeOption(input: SessionCommandInput): 'claude' | 'pi' | undefined {
  const runtime = text(input, 'runtime');
  if (runtime !== undefined && runtime !== 'claude' && runtime !== 'pi') {
    usage('--runtime must be claude or pi');
  }
  return runtime as 'claude' | 'pi' | undefined;
}
async function requiredIdentity(
  input: SessionCommandInput,
  context: SessionCommandContext,
  action: string,
): Promise<IdentityV1> {
  const name = text(input, 'identity');
  if (!name) {
    usage(`session ${action} requires --identity`);
  }
  return context.application.resolveIdentity(name as string);
}
const confirmationOption = (input: SessionCommandInput): string | undefined =>
  text(input, 'confirm-plan');
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
function requiredSafeText(input: SessionCommandInput, name: string): string {
  const candidate = text(input, name);
  if (candidate === undefined) {
    throw new SessionError('SESSION_USAGE_ERROR', `--${name} is required`);
  }
  const value: string = candidate;
  if (value.length === 0) {
    usage(`--${name} is required`);
  }
  if (value.length > 512) {
    usage(`--${name} must be at most 512 characters`);
  }
  if (CONTROL.test(value) || value !== value.normalize('NFC')) {
    usage(`--${name} contains invalid characters`);
  }
  return value;
}
async function filter(
  input: SessionCommandInput,
  context: SessionCommandContext,
): Promise<SessionListFilter> {
  const runtime = runtimeOption(input);
  const state = text(input, 'state');
  const states = [
    'active',
    'paused',
    'unfinished',
    'needs-review',
    'completed',
    'abandoned',
    'unknown',
  ] as const;
  if (state !== undefined && !states.includes(state as (typeof states)[number])) {
    usage('--state is invalid');
  }
  const status = text(input, 'status');
  if (
    status !== undefined &&
    !['unfinished', 'needs-review', 'completed', 'abandoned', 'paused'].includes(status)
  ) {
    usage('--status is invalid');
  }
  if (state !== undefined && status !== undefined) {
    usage('--state and --status cannot be combined');
  }
  const identityName = text(input, 'identity');
  return {
    ...(runtime ? { runtime: runtime } : {}),
    ...(state === 'active' || state === 'unknown' ? { liveness: state } : {}),
    ...(state !== undefined && state !== 'active' && state !== 'unknown'
      ? { workflowStatus: state as WorkflowStatus }
      : {}),
    ...(status ? { workflowStatus: status as WorkflowStatus } : {}),
    ...(identityName ? { identity: await context.application.resolveIdentity(identityName) } : {}),
  };
}
function limit(input: SessionCommandInput): number | undefined {
  const raw = text(input, 'limit');
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    usage('--limit must be an integer from 1 to 10000');
  }
  return value;
}
export async function executeSessionCommand(
  input: SessionCommandInput,
  context: SessionCommandContext,
): Promise<SessionCommandResult> {
  const application = context.application;
  const actions = [
    'list',
    'show',
    'save',
    'resume',
    'resurrect-export',
    'branch',
    'mark',
    'handoff',
    'complete',
    'completion',
    'inbox',
    'reconcile',
  ] as const;
  if (!input.action || !actions.includes(input.action as (typeof actions)[number])) {
    usage(`session requires ${actions.join(', ')}`);
  }
  const action = input.action as (typeof actions)[number];
  if (action === 'resurrect-export') {
    const commandOptions = [...input.options.keys()].filter(
      (name) => name !== 'json' && name !== 'cwd',
    );
    if (input.args.length || commandOptions.length) {
      usage('session resurrect-export accepts no positional arguments or options');
    }
    return { data: await application.resurrectionExport(), warnings: [] };
  }
  if (action === 'list') {
    if (input.args.length) {
      usage('session list accepts no positional arguments');
    }
    const selectedLimit = limit(input);
    return {
      data: await application.list({
        filter: await filter(input, context),
        ...(selectedLimit === undefined ? {} : { limit: selectedLimit }),
      }),
      warnings: [],
    };
  }
  if (action === 'show') {
    if (input.args.length !== 1) {
      usage('session show requires one id');
    }
    return {
      data: await application.show(input.args[0]!),
      warnings: [],
    };
  }
  if (action === 'handoff' || action === 'complete' || action === 'completion') {
    if (input.args.length !== 1) {
      usage(`session ${action} requires one id`);
    }
    const identity = await requiredIdentity(input, context, action);
    const runtime = runtimeOption(input);
    const disposition = text(input, 'disposition');
    const allowed =
      action === 'handoff' ? ['paused', 'unfinished'] : ['paused', 'unfinished', 'completed'];
    if (!disposition || !allowed.includes(disposition)) {
      usage(`--disposition must be ${allowed.join(', ')}`);
    }
    const request = {
      identity,
      ...(runtime ? { runtime: runtime } : {}),
      summary: requiredSafeText(input, 'summary'),
      nextAction: requiredSafeText(input, 'next-action'),
      disposition: disposition as 'paused' | 'unfinished' | 'completed',
    };
    const observation =
      action === 'handoff'
        ? await application.handoff(input.args[0]!, {
            ...request,
            disposition: request.disposition as 'paused' | 'unfinished',
          })
        : await application.complete(input.args[0]!, request);
    return { data: observation, warnings: [] };
  }
  if (action === 'mark') {
    if (input.args.length !== 2) {
      usage('session mark requires <id> <status>');
    }
    const status = input.args[1] as WorkflowStatus;
    if (!['unfinished', 'needs-review', 'completed', 'abandoned', 'paused'].includes(status)) {
      usage('session mark status is invalid');
    }
    const rawPriority = text(input, 'priority');
    const priority = rawPriority === undefined ? undefined : Number(rawPriority);
    if (
      priority !== undefined &&
      (!Number.isSafeInteger(priority) || priority < 0 || priority > 9)
    ) {
      usage('--priority must be from 0 to 9');
    }
    const workflowOptions = {
      ...(priority === undefined ? {} : { priority }),
      ...(text(input, 'next-action') === undefined
        ? {}
        : { nextAction: text(input, 'next-action')! }),
      ...(text(input, 'note') === undefined ? {} : { note: text(input, 'note')! }),
      ...(text(input, 'related-issue') === undefined
        ? {}
        : { relatedIssue: text(input, 'related-issue')! }),
      ...(text(input, 'related-review') === undefined
        ? {}
        : { relatedReview: text(input, 'related-review')! }),
    };
    return { data: await application.mark(input.args[0]!, status, workflowOptions), warnings: [] };
  }
  if (action === 'inbox') {
    if (input.args.length) {
      usage('session inbox accepts no positional arguments');
    }
    const runtime = text(input, 'runtime'),
      status = text(input, 'status'),
      selectedLimit = limit(input);
    return {
      data: await application.inbox({
        ...(runtime ? { runtime } : {}),
        ...(status ? { status } : {}),
        ...(selectedLimit === undefined ? {} : { limit: selectedLimit }),
      }),
      warnings: [],
    };
  }
  if (action === 'save') {
    const all = input.options.get('all-active') === true;
    if (all && input.args.length) {
      usage('--all-active cannot be combined with ids');
    }
    if (!all && input.args.length === 0) {
      usage('session save requires ids or --all-active');
    }
    return {
      data: {
        schemaVersion: 1,
        kind: 'session-capture',
        captures: (await application.save(all ? undefined : input.args)).captures,
      },
      warnings: [],
    };
  }
  if (action === 'reconcile') {
    if (input.args.length) {
      usage('session reconcile accepts no positional arguments');
    }
    if (text(input, 'capture') !== undefined) {
      usage('session reconcile does not accept --capture');
    }
    const prepared = await application.prepareReconcile();
    const sources = repeated(input, 'import-legacy');
    let legacy: SessionLegacyImportRequest | undefined;
    if (sources.length) {
      const accountMappings = mappings(input, 'map-account').map(({ source, target }) => ({
        source,
        identity: target,
      }));
      const piRootMappings = mappings(input, 'map-pi-root').map(({ source, target }) => ({
        identity: source,
        nativeRoot: target,
      }));
      if (!accountMappings.length) {
        usage('legacy import requires explicit --map-account mappings');
      }
      legacy = {
        sources,
        accountMappings,
        piRootMappings,
        ...(confirmationOption(input) ? { confirmation: confirmationOption(input)! } : {}),
      };
    }
    return application.reconcile(prepared, legacy ? { legacy } : {});
  }
  if (action === 'branch') {
    if (input.args.length !== 1) {
      usage('session branch requires one parent id');
    }
    const prepared = await application.prepareBranch(input.args[0]!);
    const selected = text(input, 'workspace') ?? 'default';
    if (!['default', 'isolated', 'shared'].includes(selected)) {
      usage('--workspace must be default, isolated, or shared');
    }
    const intent = text(input, 'intent') ?? 'modify';
    if (intent !== 'read' && intent !== 'modify') {
      usage('--intent must be read or modify');
    }
    const terminalEnabled = input.options.get('terminal-tab') === true;
    const terminal = terminalEnabled
      ? {
          ...(context.terminalExecutable ? { executable: context.terminalExecutable } : {}),
          ...(text(input, 'terminal-title') ? { title: text(input, 'terminal-title')! } : {}),
        }
      : undefined;
    return {
      data: await application.branch(prepared, {
        workspace: selected as 'default' | 'isolated' | 'shared',
        intent: intent as 'read' | 'modify',
        ...(text(input, 'branch') ? { branch: text(input, 'branch')! } : {}),
        ...(terminal ? { terminal } : {}),
        acknowledgeSharedRisk: input.options.get('acknowledge-shared-risk') === true,
        ...(confirmationOption(input) ? { confirmation: confirmationOption(input)! } : {}),
        dryRun: input.options.get('dry-run') === true,
      }),
      warnings: [],
    };
  }
  if (input.args.length !== 1) {
    usage('session resume requires one id');
  }
  const approveResurrection = input.options.get('approve-resurrection') === true;
  if (
    approveResurrection &&
    (input.options.has('confirm-plan') || input.options.get('dry-run') === true)
  ) {
    usage('--approve-resurrection cannot be combined with --confirm-plan or --dry-run');
  }
  return {
    data: await application.resume({
      id: input.args[0]!,
      ...(confirmationOption(input) ? { confirmation: confirmationOption(input)! } : {}),
      ...(approveResurrection ? { approveResurrection: true } : {}),
      dryRun: input.options.get('dry-run') === true,
    }),
    warnings: [],
  };
}
