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
  type ProviderInvocation,
  type ProviderProcessExecutor,
  type ReviewCommentV1,
  type ReviewV1,
} from '@mpx/providers';

export const GITHUB_ISSUE_CAPABILITIES = [
  'issue.list',
  'issue.view',
  'issue.create',
  'issue.edit',
  'issue.comment',
  'issue.label',
  'issue.finish',
] as const;
export const GITHUB_REPOSITORY_CAPABILITIES = [
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

const ISSUE_FIELDS = 'number,id,title,body,state,labels,url,assignees';
const REVIEW_FIELDS = 'number,id,title,state,isDraft,headRefName,baseRefName,url';
const CHECK_FIELDS = 'name,state,bucket,link';
const GITHUB_AUTH_EXIT_CODES = [4] as const;
const GITHUB_WATCH_TIMEOUT_MILLISECONDS = 30 * 60 * 1_000;
const providerId = 'github';
type Input = Readonly<Record<string, unknown>>;

type RepositoryTarget = Readonly<{ selector: string; ownerRepository: string; hostname?: string }>;

export interface GitHubAdapterOptions {
  readonly cwd?: string;
  readonly repository?: string;
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
      'GitHub repository selector must be OWNER/REPO or HOST/OWNER/REPO.',
      { details: { providerData: { github: {} } } },
    );
  }
  const hostname = segments.length === 3 ? segments[0]! : undefined;
  const owner = segments.at(-2)!;
  const repository = segments.at(-1)!;
  return {
    selector,
    ownerRepository: `${owner}/${repository}`,
    ...(hostname === undefined ? {} : { hostname }),
  };
}

function inputOf(request: ProviderInvocation): Input {
  if (typeof request.input !== 'object' || request.input === null || Array.isArray(request.input)) {
    invalidInput(request.capability);
  }
  return request.input as Input;
}
function stringAt(input: Input, key: string, capability: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    invalidInput(capability);
  }
  return value;
}
function issueStateAt(input: Input, capability: string): 'open' | 'finished' | undefined {
  const value = input.state;
  if (value === undefined || value === 'open' || value === 'finished') {
    return value;
  }
  return invalidInput(capability);
}
function identifierAt(input: Input, key: string, capability: string): string {
  const value = stringAt(input, key, capability);
  if (!/^[1-9]\d*$/u.test(value)) {
    invalidInput(capability);
  }
  return value;
}
function invalidInput(capability: string): never {
  throw new ProviderError('PROVIDER_INVALID', 'The GitHub provider request is invalid.', {
    capability,
    details: { providerData: { github: {} } },
  });
}
function unsupported(capability: string): never {
  throw new ProviderError('CAPABILITY_UNSUPPORTED', `GitHub does not support ${capability}.`, {
    capability,
    retryable: false,
  });
}
function json(stdout: string): unknown {
  return JSON.parse(stdout) as unknown;
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid object');
  }
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('invalid string');
  }
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('invalid integer');
  }
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error('invalid boolean');
  }
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('invalid array');
  }
  return value;
}

function normalizeIssue(value: unknown): IssueV1 {
  const native = object(value);
  const number = integer(native.number);
  const state = text(native.state);
  if (state !== 'OPEN' && state !== 'CLOSED') {
    throw new Error('invalid state');
  }
  return {
    schemaVersion: 1,
    id: String(number),
    title: text(native.title),
    body: text(native.body),
    state: state === 'OPEN' ? 'open' : 'finished',
    labels: array(native.labels).map((label) => text(object(label).name)),
    url: text(native.url),
    assignees: array(native.assignees).map((assignee) => text(object(assignee).login)),
    providerData: { github: { number, nodeId: text(native.id) } },
  };
}
function normalizeComment(value: unknown, issueId: string): IssueCommentV1 {
  const native = object(value);
  return {
    schemaVersion: 1,
    id: String(integer(native.id)),
    issueId,
    body: text(native.body),
    author: text(object(native.user).login),
    createdAt: text(native.created_at),
    providerData: { github: { nodeId: text(native.node_id) } },
  };
}
function normalizeReviewComment(value: unknown, reviewId: string): ReviewCommentV1 {
  const native = object(value);
  return {
    schemaVersion: 1,
    id: String(integer(native.id)),
    reviewId,
    body: text(native.body),
    author: text(object(native.user).login),
    createdAt: text(native.created_at),
    providerData: { github: { nodeId: text(native.node_id) } },
  };
}
function mutationId(output: string, pattern: RegExp, capability: string): string {
  const id = pattern.exec(output.trim())?.[1];
  if (id) {
    return id;
  }
  throw new ProviderError('INVALID_RESPONSE', 'The provider returned an invalid response.', {
    capability,
    details: { providerData: { github: { outputBytes: Buffer.byteLength(output) } } },
  });
}
async function mutationReadBack<T>(
  capability: string,
  confirmedId: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch {
    throw new ProviderError(
      'MUTATION_OUTCOME_UNKNOWN',
      'The GitHub mutation succeeded, but its result could not be read back.',
      {
        capability,
        retryable: false,
        details: { providerData: { github: { confirmedId: Number(confirmedId) } } },
      },
    );
  }
}

function bind(
  argv: readonly [string, ...string[]],
  repository: RepositoryTarget | undefined,
): [string, ...string[]] {
  const bound = [...argv] as [string, ...string[]];
  if (repository !== undefined) {
    bound.push('--repo', repository.selector);
  }
  return bound;
}
function apiArgv(
  repository: RepositoryTarget | undefined,
  suffix: string,
  jq?: string,
): [string, ...string[]] {
  const path =
    repository === undefined
      ? `repos/{owner}/{repo}/${suffix}`
      : `repos/${repository.ownerRepository}/${suffix}`;
  const argv: [string, ...string[]] = ['gh', 'api', path];
  if (repository?.hostname !== undefined) {
    argv.push('--hostname', repository.hostname);
  }
  if (jq !== undefined) {
    argv.push('--jq', jq);
  }
  return argv;
}
function command<T>(
  executor: ProviderProcessExecutor,
  options: GitHubAdapterOptions,
  request: ProviderInvocation,
  argv: readonly [string, ...string[]],
  parse: (stdout: string) => T,
  acceptedExitCodes?: readonly number[],
  timeoutMilliseconds?: number,
): Promise<T> {
  return runProviderCommand(
    {
      providerId,
      argv,
      authExitCodes: GITHUB_AUTH_EXIT_CODES,
      ...(request.route === undefined ? {} : { route: request.route }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(acceptedExitCodes === undefined ? {} : { acceptedExitCodes }),
      ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
      ...(isMutationCapability(request.capability) ? { mutation: true } : {}),
    },
    executor,
    parse,
  );
}
function issueView(
  executor: ProviderProcessExecutor,
  options: GitHubAdapterOptions,
  repository: RepositoryTarget | undefined,
  request: ProviderInvocation,
  id: string,
): Promise<IssueV1> {
  return command(
    executor,
    options,
    request,
    bind(['gh', 'issue', 'view', id, '--json', ISSUE_FIELDS], repository),
    (output) => normalizeIssue(json(output)),
  );
}

function issueInvoker(
  executor: ProviderProcessExecutor,
  options: GitHubAdapterOptions,
  repository: RepositoryTarget | undefined,
): ProviderAdapter['invoke'] {
  return async (request) => {
    if (request.capability === 'issue.move') {
      unsupported(request.capability);
    }
    if (
      !GITHUB_ISSUE_CAPABILITIES.includes(
        request.capability as (typeof GITHUB_ISSUE_CAPABILITIES)[number],
      )
    ) {
      unsupported(request.capability);
    }
    const input = inputOf(request);
    switch (request.capability) {
      case 'issue.list': {
        const state = issueStateAt(input, request.capability);
        const argv: [string, ...string[]] = ['gh', 'issue', 'list', '--json', ISSUE_FIELDS];
        if (state !== undefined) {
          argv.push('--state', state === 'finished' ? 'closed' : 'open');
        }
        return command(executor, options, request, bind(argv, repository), (output) =>
          array(json(output))
            .map(normalizeIssue)
            .filter((issue) => state === undefined || issue.state === state),
        );
      }
      case 'issue.view':
        return issueView(
          executor,
          options,
          repository,
          request,
          identifierAt(input, 'id', request.capability),
        );
      case 'issue.create': {
        const title = stringAt(input, 'title', request.capability);
        const body = stringAt(input, 'body', request.capability);
        const id = await command(
          executor,
          options,
          request,
          bind(['gh', 'issue', 'create', '--title', title, '--body', body], repository),
          (output) => mutationId(output, /\/issues\/(\d+)$/u, request.capability),
        );
        return mutationReadBack(request.capability, id, () =>
          issueView(executor, options, repository, request, id),
        );
      }
      case 'issue.edit': {
        const id = identifierAt(input, 'id', request.capability);
        await command(
          executor,
          options,
          request,
          bind(
            [
              'gh',
              'issue',
              'edit',
              id,
              '--title',
              stringAt(input, 'title', request.capability),
              '--body',
              stringAt(input, 'body', request.capability),
            ],
            repository,
          ),
          () => undefined,
        );
        return issueView(executor, options, repository, request, id);
      }
      case 'issue.comment': {
        const id = identifierAt(input, 'id', request.capability);
        const body = stringAt(input, 'body', request.capability);
        const commentId = await command(
          executor,
          options,
          request,
          bind(['gh', 'issue', 'comment', id, '--body', body], repository),
          (output) => mutationId(output, /#issuecomment-(\d+)$/u, request.capability),
        );
        return mutationReadBack(request.capability, commentId, () =>
          command(
            executor,
            options,
            request,
            apiArgv(
              repository,
              `issues/comments/${commentId}`,
              '{id,node_id,body,user:{login:.user.login},created_at}',
            ),
            (output) => normalizeComment(json(output), id),
          ),
        );
      }
      case 'issue.label': {
        const id = identifierAt(input, 'id', request.capability);
        await command(
          executor,
          options,
          request,
          bind(
            [
              'gh',
              'issue',
              'edit',
              id,
              '--add-label',
              stringAt(input, 'label', request.capability),
            ],
            repository,
          ),
          () => undefined,
        );
        return issueView(executor, options, repository, request, id);
      }
      case 'issue.finish': {
        const id = identifierAt(input, 'id', request.capability);
        await command(
          executor,
          options,
          request,
          bind(['gh', 'issue', 'close', id], repository),
          () => undefined,
        );
        return issueView(executor, options, repository, request, id);
      }
    }
    return unsupported(request.capability);
  };
}

function normalizeReview(value: unknown): ReviewV1 {
  const native = object(value);
  const number = integer(native.number);
  const nativeState = text(native.state);
  const draft = boolean(native.isDraft);
  const state =
    nativeState === 'MERGED'
      ? 'merged'
      : nativeState === 'CLOSED'
        ? 'closed'
        : nativeState === 'OPEN'
          ? draft
            ? 'draft'
            : 'open'
          : undefined;
  if (!state) {
    throw new Error('invalid review state');
  }
  return {
    schemaVersion: 1,
    id: String(number),
    title: text(native.title),
    state,
    sourceBranch: text(native.headRefName),
    targetBranch: text(native.baseRefName),
    url: text(native.url),
    providerData: { github: { number, nodeId: text(native.id), isDraft: draft } },
  };
}
function reviewView(
  executor: ProviderProcessExecutor,
  options: GitHubAdapterOptions,
  repository: RepositoryTarget | undefined,
  request: ProviderInvocation,
  id: string,
): Promise<ReviewV1> {
  return command(
    executor,
    options,
    request,
    bind(['gh', 'pr', 'view', id, '--json', REVIEW_FIELDS], repository),
    (output) => normalizeReview(json(output)),
  );
}
function checkState(nativeState: string, bucket: string): CiCheckV1['state'] {
  if (bucket === 'pass') {
    return 'passed';
  }
  if (bucket === 'fail') {
    return 'failed';
  }
  if (bucket === 'cancel') {
    return 'cancelled';
  }
  if (nativeState === 'IN_PROGRESS') {
    return 'running';
  }
  return 'pending';
}
function normalizeStatus(value: unknown, reviewId: string): CiStatusV1 {
  const checks = array(value).map((item): CiCheckV1 => {
    const native = object(item);
    const name = text(native.name);
    const nativeState = text(native.state);
    const bucket = text(native.bucket);
    const link = text(native.link);
    return {
      id: name,
      name,
      state: checkState(nativeState, bucket),
      ...(link.length === 0 ? {} : { url: link }),
      providerData: { github: { state: nativeState, bucket } },
    };
  });
  const states = new Set(checks.map((check) => check.state));
  const state: CiStatusV1['state'] = states.has('failed')
    ? 'failed'
    : states.has('cancelled')
      ? 'cancelled'
      : states.has('running')
        ? 'running'
        : states.has('pending') || checks.length === 0
          ? 'pending'
          : 'passed';
  return {
    schemaVersion: 1,
    state,
    checks,
    providerData: { github: { reviewNumber: Number(reviewId) } },
  };
}
function ciStatus(
  executor: ProviderProcessExecutor,
  options: GitHubAdapterOptions,
  repository: RepositoryTarget | undefined,
  request: ProviderInvocation,
  id: string,
  watch: boolean,
): Promise<CiStatusV1> {
  const argv: [string, ...string[]] = ['gh', 'pr', 'checks', id, '--json', CHECK_FIELDS];
  if (watch) {
    argv.push('--watch');
  }
  return command(
    executor,
    options,
    request,
    bind(argv, repository),
    (output) => normalizeStatus(json(output), id),
    [1, 8],
    watch ? GITHUB_WATCH_TIMEOUT_MILLISECONDS : undefined,
  );
}
function repositoryInvoker(
  executor: ProviderProcessExecutor,
  options: GitHubAdapterOptions,
  repository: RepositoryTarget | undefined,
): ProviderAdapter['invoke'] {
  return async (request) => {
    if (
      !GITHUB_REPOSITORY_CAPABILITIES.includes(
        request.capability as (typeof GITHUB_REPOSITORY_CAPABILITIES)[number],
      )
    ) {
      unsupported(request.capability);
    }
    const input = inputOf(request);
    switch (request.capability) {
      case 'review.view':
        return reviewView(
          executor,
          options,
          repository,
          request,
          identifierAt(input, 'id', request.capability),
        );
      case 'review.create': {
        const argv: [string, ...string[]] = [
          'gh',
          'pr',
          'create',
          '--title',
          stringAt(input, 'title', request.capability),
          '--body',
          stringAt(input, 'body', request.capability),
          '--head',
          stringAt(input, 'sourceBranch', request.capability),
          '--base',
          stringAt(input, 'targetBranch', request.capability),
        ];
        if (input.draft === true) {
          argv.push('--draft');
        }
        const id = await command(executor, options, request, bind(argv, repository), (output) =>
          mutationId(output, /\/pull\/(\d+)$/u, request.capability),
        );
        return mutationReadBack(request.capability, id, () =>
          reviewView(executor, options, repository, request, id),
        );
      }
      case 'review.update': {
        const id = identifierAt(input, 'id', request.capability);
        await command(
          executor,
          options,
          request,
          bind(
            [
              'gh',
              'pr',
              'edit',
              id,
              '--title',
              stringAt(input, 'title', request.capability),
              '--body',
              stringAt(input, 'body', request.capability),
            ],
            repository,
          ),
          () => undefined,
        );
        return reviewView(executor, options, repository, request, id);
      }
      case 'review.comment': {
        const id = identifierAt(input, 'id', request.capability);
        const commentId = await command(
          executor,
          options,
          request,
          bind(
            ['gh', 'pr', 'comment', id, '--body', stringAt(input, 'body', request.capability)],
            repository,
          ),
          (output) => mutationId(output, /#issuecomment-(\d+)$/u, request.capability),
        );
        return mutationReadBack(request.capability, commentId, () =>
          command(
            executor,
            options,
            request,
            apiArgv(
              repository,
              `issues/comments/${commentId}`,
              '{id,node_id,body,user:{login:.user.login},created_at}',
            ),
            (output) => normalizeReviewComment(json(output), id),
          ),
        );
      }
      case 'review.ready': {
        const id = identifierAt(input, 'id', request.capability);
        await command(
          executor,
          options,
          request,
          bind(['gh', 'pr', 'ready', id], repository),
          () => undefined,
        );
        return reviewView(executor, options, repository, request, id);
      }
      case 'review.merge': {
        const id = identifierAt(input, 'id', request.capability);
        const method =
          input.method === undefined ? 'merge' : stringAt(input, 'method', request.capability);
        if (!['merge', 'squash', 'rebase'].includes(method)) {
          invalidInput(request.capability);
        }
        await command(
          executor,
          options,
          request,
          bind(['gh', 'pr', 'merge', id, `--${method}`], repository),
          () => undefined,
        );
        return reviewView(executor, options, repository, request, id);
      }
      case 'ci.status':
        return ciStatus(
          executor,
          options,
          repository,
          request,
          identifierAt(input, 'id', request.capability),
          false,
        );
      case 'ci.watch':
        return ciStatus(
          executor,
          options,
          repository,
          request,
          identifierAt(input, 'id', request.capability),
          true,
        );
      case 'ci.logs': {
        const id = identifierAt(input, 'runId', request.capability);
        return command(
          executor,
          options,
          request,
          bind(['gh', 'run', 'view', id, '--log-failed'], repository),
          (content): CiLogV1 => ({
            schemaVersion: 1,
            id,
            content,
            providerData: { github: { runId: id } },
          }),
        );
      }
      case 'ci.retry': {
        const id = identifierAt(input, 'runId', request.capability);
        await command(
          executor,
          options,
          request,
          bind(['gh', 'run', 'rerun', id, '--failed'], repository),
          () => undefined,
        );
        return {
          schemaVersion: 1,
          id,
          providerData: { github: { retried: true } },
        } satisfies CiRetryV1;
      }
    }
    return unsupported(request.capability);
  };
}

export function createGitHubAdapters(
  executor: ProviderProcessExecutor,
  options: GitHubAdapterOptions = {},
): readonly [ProviderAdapter, ProviderAdapter] {
  const repository = repositoryTarget(options.repository);
  return [
    {
      providerId,
      role: 'issues',
      backend: 'gh',
      capabilities: GITHUB_ISSUE_CAPABILITIES,
      routeRequired: true,
      invoke: issueInvoker(executor, options, repository),
    },
    {
      providerId,
      role: 'repository',
      backend: 'gh',
      capabilities: GITHUB_REPOSITORY_CAPABILITIES,
      routeRequired: true,
      invoke: repositoryInvoker(executor, options, repository),
    },
  ];
}
