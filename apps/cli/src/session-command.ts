import { SessionError, type SessionListFilter, type WorkflowStatus } from '@mpx/sessions';
import type { Diagnostic } from '@mpx/core';
import type { SessionApplication } from '@mpx/application';

export interface SessionCommandInput {
  readonly action: string | undefined;
  readonly args: readonly string[];
  readonly options: ReadonlyMap<string, string | boolean | string[]>;
}
export interface SessionCommandContext {
  readonly application: SessionApplication;
  readonly resolveIdentity?: (name: string) => Promise<NonNullable<SessionListFilter['identity']>>;
}
export interface SessionCommandResult {
  readonly data: unknown;
  readonly warnings: readonly Diagnostic[];
  readonly exitCode?: number;
}

const text = (input: SessionCommandInput, name: string): string | undefined => {
  const value = input.options.get(name);
  return typeof value === 'string' ? value : undefined;
};
const usage = (message: string): never => {
  throw new SessionError('SESSION_USAGE_ERROR', message);
};
function runtimeOption(input: SessionCommandInput): 'claude' | 'pi' | undefined {
  const runtime = text(input, 'runtime');
  if (runtime !== undefined && runtime !== 'claude' && runtime !== 'pi') {
    usage('--runtime must be claude or pi');
  }
  return runtime as 'claude' | 'pi' | undefined;
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
  if (identityName && !context.resolveIdentity) {
    usage('identity filtering is unavailable');
  }
  return {
    ...(runtime ? { runtime } : {}),
    ...(state === 'active' || state === 'unknown' ? { liveness: state } : {}),
    ...(state !== undefined && state !== 'active' && state !== 'unknown'
      ? { workflowStatus: state as WorkflowStatus }
      : {}),
    ...(status ? { workflowStatus: status as WorkflowStatus } : {}),
    ...(identityName ? { identity: await context.resolveIdentity!(identityName) } : {}),
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
  if (input.action === 'resurrect-export') {
    const commandOptions = [...input.options.keys()].filter(
      (name) => name !== 'json' && name !== 'cwd',
    );
    if (input.args.length || commandOptions.length) {
      usage('session resurrect-export accepts no positional arguments or options');
    }
    return { data: await application.resurrectionExport(), warnings: [] };
  }
  if (input.action === 'list') {
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
  if (input.action !== 'resume') {
    usage('session requires list or resume');
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
  const data = await application.resume({
    id: input.args[0]!,
    ...(text(input, 'confirm-plan') ? { confirmation: text(input, 'confirm-plan')! } : {}),
    ...(approveResurrection ? { approveResurrection: true } : {}),
    dryRun: input.options.get('dry-run') === true,
  });
  const result =
    typeof data === 'object' &&
    data !== null &&
    'kind' in data &&
    data.kind === 'session-resume' &&
    'result' in data
      ? data.result
      : undefined;
  return {
    data,
    warnings: [],
    ...(typeof result === 'object' &&
    result !== null &&
    'exitCode' in result &&
    typeof result.exitCode === 'number'
      ? { exitCode: result.exitCode }
      : {}),
  };
}
