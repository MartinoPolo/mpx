import {
  ProviderError,
  isMutationCapability,
  runProviderCommand,
  type CiCheckV1,
  type CiLogV1,
  type CiRetryV1,
  type CiStatusV1,
  type IssueCommentV1,
  type IssueV1,
  type ProviderAdapter,
  type ProviderCapability,
  type ProviderInvocation,
  type ProviderProcessExecutor,
  type ReviewCommentV1,
  type ReviewV1,
} from '@mpx/providers';

export const GITLAB_ISSUE_CAPABILITIES = [
  'issue.list',
  'issue.view',
  'issue.create',
  'issue.edit',
  'issue.comment',
  'issue.label',
  'issue.finish',
] as const;
export const GITLAB_REPOSITORY_CAPABILITIES = [
  'review.view',
  'review.create',
  'review.update',
  'review.comment',
  'review.ready',
  'review.merge',
  'ci.status',
  'ci.watch',
  'ci.logs',
  'ci.retry',
] as const;

export const gitlabProvider = Object.freeze({
  providerId: 'gitlab' as const,
  backend: 'glab' as const,
  roles: Object.freeze(['repository', 'issues'] as const),
  capabilities: Object.freeze([...GITLAB_ISSUE_CAPABILITIES, ...GITLAB_REPOSITORY_CAPABILITIES]),
});

type JsonObject = Record<string, unknown>;
type RepositoryTarget = Readonly<{
  selector: string;
  encodedOwnerRepository: string;
  hostname?: string;
}>;

export interface GitLabAdapterOptions {
  readonly cwd?: string;
  readonly repository?: string;
  readonly ciWatchPollIntervalMilliseconds?: number;
  readonly ciWatchTimeoutMilliseconds?: number;
}

function repositoryTarget(selector: string | undefined): RepositoryTarget | undefined {
  if (selector === undefined) {
    return undefined;
  }
  const segments = selector.split('/');
  const validSegment = (segment: string) =>
    segment !== '.' && segment !== '..' && /^[A-Za-z0-9_.][A-Za-z0-9._-]*$/u.test(segment);
  if ((segments.length !== 2 && segments.length !== 3) || !segments.every(validSegment)) {
    throw new ProviderError(
      'PROVIDER_INVALID',
      'GitLab repository selector must be OWNER/REPO or HOST/OWNER/REPO.',
      { details: { providerData: { gitlab: {} } } },
    );
  }
  const ownerRepository = segments.slice(-2).join('/');
  return {
    selector,
    encodedOwnerRepository: encodeURIComponent(ownerRepository),
    ...(segments.length === 3 ? { hostname: segments[0]! } : {}),
  };
}

const object = (value: unknown): JsonObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('object expected');
  }
  return value as JsonObject;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error('array expected');
  }
  return value;
};
const strictText = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new Error('string expected');
  }
  return value;
};
const nonEmptyText = (value: unknown): string => {
  const result = strictText(value);
  if (result.length === 0) {
    throw new Error('non-empty string expected');
  }
  return result;
};
const optionalDescription = (value: unknown): string =>
  value === undefined || value === null ? '' : strictText(value);
const optionalText = (value: unknown): string | undefined =>
  value === undefined || value === null ? undefined : strictText(value);
const positiveInteger = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('positive integer expected');
  }
  return value;
};
const json = (output: string): unknown => JSON.parse(output) as unknown;
const inputObject = (request: ProviderInvocation): JsonObject => {
  try {
    return object(request.input);
  } catch {
    throw new ProviderError('PROVIDER_INVALID', 'The GitLab provider request is invalid.', {
      capability: request.capability,
      details: { providerData: { gitlab: {} } },
    });
  }
};
const required = (input: JsonObject, key: string, capability?: string): string => {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProviderError('PROVIDER_INVALID', `GitLab input requires '${key}'.`, {
      ...(capability === undefined ? {} : { capability }),
      details: { providerData: { gitlab: {} } },
    });
  }
  return value;
};
const issueState = (input: JsonObject, capability: string): 'open' | 'finished' | undefined => {
  const value = input.state;
  if (value === undefined || value === 'open' || value === 'finished') {
    return value;
  }
  throw new ProviderError('PROVIDER_INVALID', 'GitLab issue state must be open or finished.', {
    capability,
    details: { providerData: { gitlab: {} } },
  });
};
const identifier = (input: JsonObject, key: string, capability: string): string => {
  const value = required(input, key, capability);
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new ProviderError(
      'PROVIDER_INVALID',
      `GitLab input '${key}' must be a canonical positive decimal ID.`,
      { capability, details: { providerData: { gitlab: {} } } },
    );
  }
  return value;
};
const optionalInputText = (
  input: JsonObject,
  key: string,
  capability: string,
): string | undefined => {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ProviderError('PROVIDER_INVALID', `GitLab input '${key}' must be a string.`, {
      capability,
      details: { providerData: { gitlab: {} } },
    });
  }
  return value;
};
const route = (request: ProviderInvocation) =>
  request.route === undefined ? {} : { route: request.route };
const apiFields = (fields: readonly (readonly [string, string | undefined])[]): string[] =>
  fields.flatMap(([name, value]) =>
    value === undefined ? [] : ['--raw-field', `${name}=${value}`],
  );
const runIdentifier = (input: JsonObject, capability: string): string =>
  input.runId === undefined
    ? identifier(input, 'id', capability)
    : identifier(input, 'runId', capability);
const bind = (
  argv: [string, ...string[]],
  repository: RepositoryTarget | undefined,
): [string, ...string[]] => {
  if (repository !== undefined) {
    argv.push('--repo', repository.selector);
  }
  return argv;
};
const projectPath = (repository: RepositoryTarget | undefined, suffix: string): string =>
  `projects/${repository?.encodedOwnerRepository ?? ':fullpath'}/${suffix}`;
const api = (
  repository: RepositoryTarget | undefined,
  suffix: string,
  ...arguments_: string[]
): [string, ...string[]] => [
  'glab',
  'api',
  projectPath(repository, suffix),
  ...(repository?.hostname === undefined ? [] : ['--hostname', repository.hostname]),
  ...arguments_,
];

function normalizeLabels(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  return array(value).map(nonEmptyText);
}
function normalizeAssignees(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  return array(value).map((item) => {
    const assignee = object(item);
    const candidate = assignee.username ?? assignee.name;
    return nonEmptyText(candidate);
  });
}
function optionalUrl(value: unknown): { url?: string } {
  const url = optionalText(value);
  return url === undefined ? {} : { url };
}

function normalizeIssue(value: unknown): IssueV1 {
  const issue = object(value);
  const iid = positiveInteger(issue.iid);
  const nativeState = strictText(issue.state);
  if (nativeState !== 'opened' && nativeState !== 'closed') {
    throw new Error('invalid issue state');
  }
  const assignees = normalizeAssignees(issue.assignees);
  return {
    schemaVersion: 1,
    id: String(iid),
    title: nonEmptyText(issue.title),
    body: optionalDescription(issue.description),
    state: nativeState === 'closed' ? 'finished' : 'open',
    labels: normalizeLabels(issue.labels),
    ...optionalUrl(issue.web_url),
    ...(assignees.length === 0 ? {} : { assignees }),
    providerData: {
      gitlab: {
        iid,
        ...(typeof issue.project_id === 'number'
          ? { projectId: positiveInteger(issue.project_id) }
          : {}),
      },
    },
  };
}

function normalizeReview(value: unknown): ReviewV1 {
  const review = object(value);
  const iid = positiveInteger(review.iid);
  const rawTitle = nonEmptyText(review.title);
  if (review.draft !== undefined && typeof review.draft !== 'boolean') {
    throw new Error('boolean expected');
  }
  const draft = review.draft === true || /^draft:\s*/i.test(rawTitle);
  const title = nonEmptyText(rawTitle.replace(/^draft:\s*/i, ''));
  const nativeState = strictText(review.state);
  let state: ReviewV1['state'];
  if (nativeState === 'merged') {
    state = 'merged';
  } else if (nativeState === 'closed') {
    state = 'closed';
  } else if (nativeState === 'opened') {
    state = draft ? 'draft' : 'open';
  } else {
    throw new Error('invalid review state');
  }
  return {
    schemaVersion: 1,
    id: String(iid),
    title,
    state,
    sourceBranch: nonEmptyText(review.source_branch),
    targetBranch: nonEmptyText(review.target_branch),
    ...optionalUrl(review.web_url),
    providerData: {
      gitlab: {
        iid,
        ...(typeof review.project_id === 'number'
          ? { projectId: positiveInteger(review.project_id) }
          : {}),
        draft,
      },
    },
  };
}

function normalizeIssueComment(issueId: string, value: unknown): IssueCommentV1 {
  const note = object(value);
  const noteId = positiveInteger(note.id);
  const author = object(note.author);
  return {
    schemaVersion: 1,
    id: String(noteId),
    issueId,
    body: strictText(note.body),
    author: nonEmptyText(author.username ?? author.name),
    createdAt: nonEmptyText(note.created_at),
    providerData: { gitlab: { noteId } },
  };
}
function normalizeReviewComment(reviewId: string, value: unknown): ReviewCommentV1 {
  const note = object(value);
  const noteId = positiveInteger(note.id);
  const author = object(note.author);
  return {
    schemaVersion: 1,
    id: String(noteId),
    reviewId,
    body: strictText(note.body),
    author: nonEmptyText(author.username ?? author.name),
    createdAt: nonEmptyText(note.created_at),
    providerData: { gitlab: { noteId } },
  };
}

const statusState = (status: unknown): CiCheckV1['state'] => {
  switch (strictText(status)) {
    case 'success':
    case 'passed':
      return 'passed';
    case 'failed':
    case 'failure':
      return 'failed';
    case 'canceled':
    case 'cancelled':
    case 'skipped':
      return 'cancelled';
    case 'running':
      return 'running';
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'manual':
    case 'scheduled':
      return 'pending';
    default:
      throw new Error('invalid CI state');
  }
};
function normalizePipeline(value: unknown): {
  pipeline: JsonObject;
  pipelineId: number;
  state: CiStatusV1['state'];
} {
  const pipeline = object(value);
  return {
    pipeline,
    pipelineId: positiveInteger(pipeline.id),
    state: statusState(pipeline.status),
  };
}
function validateJobs(value: unknown): unknown[] {
  return array(value).map((raw) => {
    const check = object(raw);
    positiveInteger(check.id);
    nonEmptyText(check.name);
    statusState(check.status);
    optionalUrl(check.web_url);
    return raw;
  });
}
function normalizeCi(pipelineValue: unknown, jobsValue: unknown): CiStatusV1 {
  const { pipelineId, state } = normalizePipeline(pipelineValue);
  const checks = array(jobsValue).map((raw): CiCheckV1 => {
    const check = object(raw);
    const id = positiveInteger(check.id);
    return {
      id: String(id),
      name: nonEmptyText(check.name),
      state: statusState(check.status),
      ...optionalUrl(check.web_url),
      providerData: { gitlab: { jobId: id, pipelineId } },
    };
  });
  return {
    schemaVersion: 1,
    state,
    checks,
    providerData: { gitlab: { checkCount: checks.length, pipelineId } },
  };
}

const command = <T>(
  executor: ProviderProcessExecutor,
  options: GitLabAdapterOptions,
  request: ProviderInvocation,
  argv: [string, ...string[]],
  parse?: (output: string) => T,
): Promise<T> =>
  runProviderCommand(
    {
      providerId: 'gitlab',
      argv,
      ...route(request),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(isMutationCapability(request.capability) ? { mutation: true } : {}),
    },
    executor,
    parse ?? ((output) => output as T),
  );
const structured = <T>(
  executor: ProviderProcessExecutor,
  options: GitLabAdapterOptions,
  request: ProviderInvocation,
  argv: [string, ...string[]],
  normalize: (value: unknown) => T,
): Promise<T> => command(executor, options, request, argv, (output) => normalize(json(output)));

function unsupported(capability: string): never {
  throw new ProviderError('CAPABILITY_UNSUPPORTED', `GitLab does not support ${capability}.`, {
    capability,
    retryable: false,
    remediation: 'Use a provider with native issue movement support.',
  });
}

function createIssueAdapter(
  executor: ProviderProcessExecutor,
  options: GitLabAdapterOptions,
  repository: RepositoryTarget | undefined,
): ProviderAdapter {
  return {
    providerId: 'gitlab',
    role: 'issues',
    backend: 'glab',
    capabilities: GITLAB_ISSUE_CAPABILITIES,
    routeRequired: true,
    async invoke(request) {
      if (request.capability === 'issue.move') {
        unsupported('issue.move');
      }
      if (
        !(GITLAB_ISSUE_CAPABILITIES as readonly ProviderCapability[]).includes(request.capability)
      ) {
        unsupported(request.capability);
      }
      const input = inputObject(request);
      switch (request.capability) {
        case 'issue.list': {
          const state = issueState(input, request.capability);
          const argv: [string, ...string[]] = ['glab', 'issue', 'list', '--output', 'json'];
          if (state !== undefined) {
            argv.push('--state', state === 'finished' ? 'closed' : 'opened');
          }
          return structured(executor, options, request, bind(argv, repository), (value) =>
            array(value)
              .map(normalizeIssue)
              .filter((issue) => state === undefined || issue.state === state),
          );
        }
        case 'issue.view':
          return structured(
            executor,
            options,
            request,
            bind(
              [
                'glab',
                'issue',
                'view',
                identifier(input, 'id', request.capability),
                '--output',
                'json',
              ],
              repository,
            ),
            normalizeIssue,
          );
        case 'issue.create':
          return structured(
            executor,
            options,
            request,
            api(
              repository,
              'issues',
              '--method',
              'POST',
              ...apiFields([
                ['title', required(input, 'title', request.capability)],
                ['description', optionalInputText(input, 'body', request.capability) ?? ''],
              ]),
            ),
            normalizeIssue,
          );
        case 'issue.edit':
          return structured(
            executor,
            options,
            request,
            api(
              repository,
              `issues/${identifier(input, 'id', request.capability)}`,
              '--method',
              'PUT',
              ...apiFields([
                ['title', optionalInputText(input, 'title', request.capability)],
                ['description', optionalInputText(input, 'body', request.capability)],
              ]),
            ),
            normalizeIssue,
          );
        case 'issue.comment': {
          const id = identifier(input, 'id', request.capability);
          return structured(
            executor,
            options,
            request,
            api(
              repository,
              `issues/${id}/notes`,
              '--method',
              'POST',
              ...apiFields([['body', required(input, 'body', request.capability)]]),
            ),
            (value) => normalizeIssueComment(id, value),
          );
        }
        case 'issue.label':
          return structured(
            executor,
            options,
            request,
            api(
              repository,
              `issues/${identifier(input, 'id', request.capability)}`,
              '--method',
              'PUT',
              ...apiFields([['add_labels', required(input, 'label', request.capability)]]),
            ),
            normalizeIssue,
          );
        case 'issue.finish': {
          const id = identifier(input, 'id', request.capability);
          await command(
            executor,
            options,
            request,
            bind(['glab', 'issue', 'close', id], repository),
          );
          return structured(
            executor,
            options,
            request,
            bind(['glab', 'issue', 'view', id, '--output', 'json'], repository),
            normalizeIssue,
          );
        }
      }
    },
  };
}

function createRepositoryAdapter(
  executor: ProviderProcessExecutor,
  options: GitLabAdapterOptions,
  repository: RepositoryTarget | undefined,
): ProviderAdapter {
  const view = (request: ProviderInvocation, id: string) =>
    structured(
      executor,
      options,
      request,
      bind(['glab', 'mr', 'view', id, '--output', 'json'], repository),
      normalizeReview,
    );
  const pipeline = (request: ProviderInvocation, id: string) =>
    structured(executor, options, request, api(repository, `pipelines/${id}`), (value) => {
      normalizePipeline(value);
      return value;
    });
  const jobs = (request: ProviderInvocation, id: string) =>
    structured(executor, options, request, api(repository, `pipelines/${id}/jobs`), validateJobs);
  const ci = async (request: ProviderInvocation, id: string): Promise<CiStatusV1> => {
    const [pipelineValue, jobsValue] = await Promise.all([
      pipeline(request, id),
      jobs(request, id),
    ]);
    return normalizeCi(pipelineValue, jobsValue);
  };
  const watch = async (request: ProviderInvocation, id: string): Promise<CiStatusV1> => {
    const pollInterval = options.ciWatchPollIntervalMilliseconds ?? 1_000;
    const timeout = options.ciWatchTimeoutMilliseconds ?? 300_000;
    const deadline = Date.now() + timeout;
    while (true) {
      const pipelineValue = await pipeline(request, id);
      const status = normalizePipeline(pipelineValue).state;
      if (status !== 'pending' && status !== 'running') {
        return normalizeCi(pipelineValue, await jobs(request, id));
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ProviderError('COMMAND_FAILURE', 'Timed out waiting for the GitLab pipeline.', {
          capability: request.capability,
          retryable: true,
          details: { providerData: { gitlab: { pipelineId: id } } },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollInterval, remaining)));
    }
  };
  return {
    providerId: 'gitlab',
    role: 'repository',
    backend: 'glab',
    capabilities: GITLAB_REPOSITORY_CAPABILITIES,
    routeRequired: true,
    async invoke(request) {
      if (
        !(GITLAB_REPOSITORY_CAPABILITIES as readonly ProviderCapability[]).includes(
          request.capability,
        )
      ) {
        unsupported(request.capability);
      }
      const input = inputObject(request);
      switch (request.capability) {
        case 'review.view':
          return view(request, identifier(input, 'id', request.capability));
        case 'review.create': {
          const requestedTitle = required(input, 'title', request.capability);
          const title =
            input.draft === true && !/^draft:\s*/i.test(requestedTitle)
              ? `Draft: ${requestedTitle}`
              : requestedTitle;
          return structured(
            executor,
            options,
            request,
            api(
              repository,
              'merge_requests',
              '--method',
              'POST',
              ...apiFields([
                ['title', title],
                ['description', optionalInputText(input, 'body', request.capability) ?? ''],
                ['source_branch', required(input, 'sourceBranch', request.capability)],
                ['target_branch', required(input, 'targetBranch', request.capability)],
              ]),
            ),
            normalizeReview,
          );
        }
        case 'review.update':
          return structured(
            executor,
            options,
            request,
            api(
              repository,
              `merge_requests/${identifier(input, 'id', request.capability)}`,
              '--method',
              'PUT',
              ...apiFields([
                ['title', optionalInputText(input, 'title', request.capability)],
                ['description', optionalInputText(input, 'body', request.capability)],
                ['target_branch', optionalInputText(input, 'targetBranch', request.capability)],
              ]),
            ),
            normalizeReview,
          );
        case 'review.comment': {
          const id = identifier(input, 'id', request.capability);
          return structured(
            executor,
            options,
            request,
            api(
              repository,
              `merge_requests/${id}/notes`,
              '--method',
              'POST',
              ...apiFields([['body', required(input, 'body', request.capability)]]),
            ),
            (value) => normalizeReviewComment(id, value),
          );
        }
        case 'review.ready': {
          const id = identifier(input, 'id', request.capability);
          await command(
            executor,
            options,
            request,
            bind(['glab', 'mr', 'update', id, '--ready', '--yes'], repository),
          );
          return view(request, id);
        }
        case 'review.merge': {
          const id = identifier(input, 'id', request.capability);
          const method =
            input.method === undefined ? 'merge' : required(input, 'method', request.capability);
          if (method !== 'merge' && method !== 'squash' && method !== 'rebase') {
            throw new ProviderError(
              'PROVIDER_INVALID',
              'GitLab merge method must be merge, squash, or rebase.',
              { capability: request.capability, details: { providerData: { gitlab: {} } } },
            );
          }
          const argv: [string, ...string[]] = ['glab', 'mr', 'merge', id, '--yes'];
          if (method !== 'merge') {
            argv.push(`--${method}`);
          }
          await command(executor, options, request, bind(argv, repository));
          return view(request, id);
        }
        case 'ci.status':
          return ci(request, identifier(input, 'id', request.capability));
        case 'ci.watch':
          return watch(request, identifier(input, 'id', request.capability));
        case 'ci.logs': {
          const id = runIdentifier(input, request.capability);
          const content = await command<string>(
            executor,
            options,
            request,
            bind(['glab', 'ci', 'trace', id], repository),
          );
          return {
            schemaVersion: 1,
            id,
            content,
            providerData: { gitlab: { jobId: id } },
          } satisfies CiLogV1;
        }
        case 'ci.retry': {
          const id = runIdentifier(input, request.capability);
          await command(executor, options, request, bind(['glab', 'ci', 'retry', id], repository));
          return {
            schemaVersion: 1,
            id,
            providerData: { gitlab: { jobId: id, retried: true } },
          } satisfies CiRetryV1;
        }
      }
    },
  };
}

export function createGitLabAdapters(
  executor: ProviderProcessExecutor,
  options: GitLabAdapterOptions = {},
): readonly [ProviderAdapter, ProviderAdapter] {
  const repository = repositoryTarget(options.repository);
  return Object.freeze([
    createIssueAdapter(executor, options, repository),
    createRepositoryAdapter(executor, options, repository),
  ]);
}
