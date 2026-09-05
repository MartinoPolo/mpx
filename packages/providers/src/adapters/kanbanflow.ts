import {
  CI_CAPABILITIES,
  ISSUE_CAPABILITIES,
  ProviderError,
  REVIEW_CAPABILITIES,
} from '../registry.js';
import {
  isMutationCapability,
  runProviderCommand,
  type ProviderCommandRequest,
  type ProviderProcessExecutor,
} from '../process.js';
import { type IssueCommentV1, type IssueV1 } from '../contracts.js';
import type { ProviderAdapter, ProviderInvocation } from '../service.js';

export interface KanbanFlowStateMapping {
  readonly todo?: string;
  readonly wip?: string;
  readonly review?: string;
  readonly done?: string;
  readonly archive?: string;
}

export interface KanbanFlowAdapterOptions {
  readonly states?: KanbanFlowStateMapping;
  readonly cwd?: string;
}

type ObjectValue = Record<string, unknown>;

const declared = new Set<string>(ISSUE_CAPABILITIES);
const knownUnsupported = new Set<string>([...REVIEW_CAPABILITIES, ...CI_CAPABILITIES]);

export function createKanbanFlowAdapter(
  executor: ProviderProcessExecutor,
  options: KanbanFlowAdapterOptions = {},
): ProviderAdapter {
  const adapter: ProviderAdapter = {
    providerId: 'kanbanflow',
    role: 'issues',
    backend: 'kf',
    capabilities: ISSUE_CAPABILITIES,
    routeRequired: true,
    async invoke(request: ProviderInvocation): Promise<unknown> {
      assertInvocation(request);
      const input = objectInput(request.input);
      switch (request.capability) {
        case 'issue.list': {
          const state = optionalIssueState(input);
          return command(['kf', 'issue', 'list', '--json'], request, executor, options, (stdout) =>
            parseTaskList(stdout)
              .map((task) => normalizeTask(task, options.states))
              .filter((issue) => state === undefined || issue.state === state),
          );
        }
        case 'issue.view':
          return view(requiredString(input, 'id'), request, executor, options);
        case 'issue.create': {
          const argv = [
            'kf',
            'issue',
            'create',
            '--name',
            requiredString(input, 'title'),
            '--description',
            optionalString(input, 'body') ?? '',
            '--json',
          ] as [string, ...string[]];
          const outcome = await command(argv, request, executor, options, parseCreateOutcome);
          return view(outcome.issueId, request, executor, options);
        }
        case 'issue.edit': {
          const id = requiredString(input, 'id');
          const argv: [string, ...string[]] = ['kf', 'issue', 'edit', id];
          addOptional(argv, '--name', optionalString(input, 'title'));
          addOptional(argv, '--description', optionalString(input, 'body'));
          argv.push('--json');
          return command(argv, request, executor, options, (stdout) =>
            normalizeTask(parseTask(stdout), options.states),
          );
        }
        case 'issue.comment': {
          const id = requiredString(input, 'id');
          const body = requiredString(input, 'body');
          const commentId = await command(
            ['kf', 'comment', 'add', id, '--text', body],
            request,
            executor,
            options,
            parseCommentId,
          );
          const comment: IssueCommentV1 = {
            schemaVersion: 1,
            id: commentId,
            issueId: id,
            body,
            providerData: { kanbanflow: { nativeId: commentId } },
          };
          return comment;
        }
        case 'issue.label': {
          const id = requiredString(input, 'id');
          const label = requiredString(input, 'label');
          return command(
            ['kf', 'issue', 'edit', id, '--add-label', label, '--json'],
            request,
            executor,
            options,
            (stdout) => normalizeTask(parseTask(stdout), options.states),
          );
        }
        case 'issue.move': {
          const id = requiredString(input, 'id');
          const destination = mappedState(options.states, requiredString(input, 'destination'));
          await command(
            ['kf', 'issue', 'move', id, '--to', destination],
            request,
            executor,
            options,
          );
          return view(id, request, executor, options);
        }
        case 'issue.finish': {
          const id = requiredString(input, 'id');
          await command(
            ['kf', 'issue', 'finish', id, '--to', mappedState(options.states, 'done')],
            request,
            executor,
            options,
          );
          return view(id, request, executor, options);
        }
      }
    },
  };
  return Object.freeze(adapter);
}

function mappedState(states: KanbanFlowStateMapping | undefined, state: string): string {
  const canonical = state.toLowerCase();
  if (
    !(['todo', 'wip', 'review', 'done', 'archive'] as const).includes(
      canonical as keyof KanbanFlowStateMapping,
    )
  ) {
    throw new ProviderError('PROVIDER_INVALID', `Unknown KanbanFlow issue state '${state}'.`);
  }
  const columnId = states?.[canonical as keyof KanbanFlowStateMapping];
  if (!columnId) {
    throw new ProviderError(
      'PROVIDER_INVALID',
      `KanbanFlow issue state '${canonical}' is not configured.`,
    );
  }
  return columnId;
}

function assertInvocation(request: ProviderInvocation): void {
  const capability = request.capability as string;
  if (request.providerId !== 'kanbanflow') {
    throw new ProviderError(
      'PROVIDER_ADAPTER_MISMATCH',
      'The KanbanFlow adapter received a request for another provider.',
    );
  }
  if (!declared.has(capability)) {
    throw new ProviderError(
      knownUnsupported.has(capability) ? 'CAPABILITY_UNSUPPORTED' : 'CAPABILITY_UNKNOWN',
      knownUnsupported.has(capability)
        ? `KanbanFlow does not support ${capability}.`
        : `Unknown capability: ${capability}`,
      { capability },
    );
  }
}

async function view(
  id: string,
  request: ProviderInvocation,
  executor: ProviderProcessExecutor,
  options: KanbanFlowAdapterOptions,
): Promise<IssueV1> {
  return command(['kf', 'issue', 'view', id, '--json'], request, executor, options, (stdout) =>
    normalizeTask(parseAggregate(stdout), options.states),
  );
}

function command<T = string>(
  argv: [string, ...string[]],
  request: ProviderInvocation,
  executor: ProviderProcessExecutor,
  options: KanbanFlowAdapterOptions,
  parse?: (stdout: string) => T,
): Promise<T> {
  const processRequest: ProviderCommandRequest = {
    providerId: 'kanbanflow',
    argv,
    ...(request.route === undefined ? {} : { route: request.route }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(isMutationCapability(request.capability) ? { mutation: true } : {}),
  };
  return runProviderCommand(processRequest, executor, parse);
}

function normalizeTask(task: ObjectValue, states: KanbanFlowStateMapping = {}): IssueV1 {
  const nativeId = stringField(task, '_id');
  const columnId = stringField(task, 'columnId');
  const workflowState = (Object.keys(states) as (keyof KanbanFlowStateMapping)[]).find(
    (state) => states[state] === columnId,
  );
  const labels = arrayField(task, 'labels').map((label) => stringField(objectValue(label), 'name'));
  const people = [
    optionalStringField(task, 'responsibleUserId'),
    ...arrayField(task, 'collaborators').map((item) =>
      optionalStringField(objectValue(item), 'userId'),
    ),
  ].filter((person): person is string => person !== undefined);
  const assignees = [...new Set(people)];
  const numberValue = task.number === undefined ? undefined : objectValue(task.number);
  const number =
    numberValue === undefined
      ? undefined
      : `${optionalStringField(numberValue, 'prefix') ?? ''}${numberField(numberValue, 'value')}`;
  const color = optionalStringField(task, 'color');
  return {
    schemaVersion: 1,
    id: nativeId,
    title: stringField(task, 'name'),
    body: optionalStringField(task, 'description') ?? '',
    state: workflowState === 'done' || workflowState === 'archive' ? 'finished' : 'open',
    labels,
    ...(assignees.length === 0 ? {} : { assignees }),
    providerData: {
      kanbanflow: {
        nativeId,
        ...(number === undefined ? {} : { number }),
        columnId,
        ...(workflowState === undefined ? {} : { workflowState }),
        ...(color === undefined ? {} : { color }),
      },
    },
  };
}

function parseJson(stdout: string): unknown {
  return JSON.parse(stdout) as unknown;
}
function parseTask(stdout: string): ObjectValue {
  return taskValue(parseJson(stdout));
}
function parseTaskList(stdout: string): ObjectValue[] {
  const value = parseJson(stdout);
  if (!Array.isArray(value)) {
    throw new Error('expected task array');
  }
  return value.map(taskValue);
}
function parseAggregate(stdout: string): ObjectValue {
  return taskValue(objectValue(parseJson(stdout)).issue);
}
function parseCreateOutcome(stdout: string): { issueId: string } {
  return { issueId: stringField(objectValue(parseJson(stdout)), 'issueId') };
}
function parseCommentId(stdout: string): string {
  const id = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!id) {
    throw new Error('missing comment id');
  }
  return id;
}
function taskValue(value: unknown): ObjectValue {
  const task = objectValue(value);
  stringField(task, '_id');
  stringField(task, 'name');
  stringField(task, 'columnId');
  return task;
}
function objectInput(value: unknown): ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProviderError('PROVIDER_INVALID', 'KanbanFlow input must be an object.');
  }
  return value as ObjectValue;
}
function objectValue(value: unknown): ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected object');
  }
  return value as ObjectValue;
}
function arrayField(value: ObjectValue, key: string): unknown[] {
  const field = value[key];
  if (field === undefined) {
    return [];
  }
  if (!Array.isArray(field)) {
    throw new Error(`expected ${key} array`);
  }
  return field;
}
function stringField(value: ObjectValue, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') {
    throw new Error(`expected ${key} string`);
  }
  return field;
}
function optionalStringField(value: ObjectValue, key: string): string | undefined {
  const field = value[key];
  if (field === undefined || field === null) {
    return undefined;
  }
  if (typeof field !== 'string') {
    throw new Error(`expected ${key} string`);
  }
  return field;
}
function numberField(value: ObjectValue, key: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isFinite(field)) {
    throw new Error(`expected ${key} number`);
  }
  return field;
}
function requiredString(input: ObjectValue, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProviderError(
      'PROVIDER_INVALID',
      `KanbanFlow ${key} input must be a non-empty string.`,
    );
  }
  return value;
}
function optionalIssueState(input: ObjectValue): 'open' | 'finished' | undefined {
  const value = input.state;
  if (value === undefined || value === 'open' || value === 'finished') {
    return value;
  }
  throw new ProviderError('PROVIDER_INVALID', 'KanbanFlow issue state must be open or finished.');
}
function optionalString(input: ObjectValue, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ProviderError('PROVIDER_INVALID', `KanbanFlow ${key} input must be a string.`);
  }
  return value;
}
function addOptional(argv: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) {
    argv.push(flag, value);
  }
}
