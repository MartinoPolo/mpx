import type { ReviewCommentV1, ReviewV1 } from '../contracts.js';
import { runProviderCommand, type ProviderProcessExecutor } from '../process.js';
import { ProviderError, type ProviderCapability } from '../registry.js';
import type { ProviderAdapter, ProviderInvocation } from '../service.js';

export const GERRIT_REPOSITORY_CAPABILITIES = [
  'review.view',
  'review.create',
  'review.update',
  'review.comment',
  'review.ready',
  'review.vote',
  'review.merge',
] as const;

export interface GerritAdapterOptions {
  readonly cwd?: string;
  /** Exact HOST/PROJECT selector resolved from the configured Git remote. */
  readonly repository: string;
  /** Safe configured Git remote name used for uploads. */
  readonly remote: string;
}

type JsonObject = Record<string, unknown>;
type GerritReview = ReviewV1 & {
  readonly providerData: {
    readonly gerrit: {
      readonly changeNumber: number;
      readonly patchSet: number;
      readonly revision: string;
      readonly changeId: string;
      readonly wip: boolean;
    };
  };
};
const providerId = 'gerrit';
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TIMEOUT_MILLISECONDS = 120_000;
const safeSegment = /^[A-Za-z0-9_.][A-Za-z0-9._-]*$/u;
const safeHost = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/u;
const safeRemote = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const safeBranch =
  /^(?![-/.])(?!@$)(?!.*[\u0000-\u001f\u007f ~^:?*%[\\])(?!.*\.\.)(?!.*@\{)(?!.*(?:^|\/)\.)(?!.*(?:\/$|\.$|\/\/))(?!.*\.lock(?:$|\/))[A-Za-z0-9_./-]{1,255}$/u;
const safeSource =
  /^(?![-/])(?!.*[\u0000-\u001f\u007f ~^:?*[\\])(?!.+\.\.)(?!.*@\{)(?!.*(?:\/$|\.$|\/\/))[A-Za-z0-9_./-]{1,255}$/u;
const sha = /^[0-9a-f]{40}$/u;
const gerritChangeId = /^I[0-9a-f]{40}$/u;

function invalid(capability: string, message = 'The Gerrit provider request is invalid.'): never {
  throw new ProviderError('PROVIDER_INVALID', message, {
    capability,
    retryable: false,
    details: { providerData: { gerrit: {} } },
  });
}
function unsupported(
  capability: string,
  message = `Gerrit does not support ${capability}.`,
): never {
  throw new ProviderError('CAPABILITY_UNSUPPORTED', message, { capability, retryable: false });
}
function object(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('object');
  }
  return value as JsonObject;
}
function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('string');
  }
  return value;
}
function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('integer');
  }
  return value;
}
function input(request: ProviderInvocation): JsonObject {
  try {
    return object(request.input);
  } catch {
    return invalid(request.capability);
  }
}
function required(
  inputValue: JsonObject,
  key: string,
  capability: string,
  maximum = 16_384,
  allowEmpty = false,
  allowCarriageReturn = false,
): string {
  const value = inputValue[key];
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    (allowCarriageReturn ? /\u0000/u : /[\u0000\u000d]/u).test(value)
  ) {
    invalid(capability);
  }
  return value;
}
function identifier(inputValue: JsonObject, capability: string): string {
  const value = required(inputValue, 'id', capability, 20);
  if (!/^[1-9]\d{0,19}$/u.test(value)) {
    invalid(capability);
  }
  return value;
}
function parseTarget(selector: string, remote: string, capability = 'review.view') {
  const parts = selector.split('/');
  const authority = /^(?:([A-Za-z0-9][A-Za-z0-9._-]{0,63})@)?([^@:]+)(?::([1-9]\d{0,4}))?$/u.exec(
    parts[0] ?? '',
  );
  const port = authority?.[3] === undefined ? undefined : Number(authority[3]);
  if (
    selector.length > 1024 ||
    parts.length < 2 ||
    authority === null ||
    !safeHost.test(authority[2]!) ||
    (port !== undefined && port > 65_535) ||
    !parts.slice(1).every((part) => part !== '.' && part !== '..' && safeSegment.test(part))
  ) {
    invalid(capability, 'The Gerrit repository selector is invalid.');
  }
  if (!safeRemote.test(remote) || remote === '.' || remote === '..') {
    invalid(capability, 'The configured Git remote name is invalid.');
  }
  const host = `${authority[1] === undefined ? '' : `${authority[1]}@`}${authority[2]}`;
  return { host, port, project: parts.slice(1).join('/') };
}
function normalize(value: unknown, project: string): GerritReview {
  const change = object(value);
  if (text(change.project) !== project) {
    throw new Error('project');
  }
  const number = positiveInteger(change.number);
  const changeId = text(change.id);
  if (!gerritChangeId.test(changeId)) {
    throw new Error('change id');
  }
  const patch = object(change.currentPatchSet);
  const patchSet = positiveInteger(patch.number);
  const revision = text(patch.revision);
  if (!sha.test(revision)) {
    throw new Error('revision');
  }
  const ref = text(patch.ref);
  if (!safeBranch.test(ref)) {
    throw new Error('ref');
  }
  const status = text(change.status);
  const wip = change.wip === true;
  let state: ReviewV1['state'];
  if (status === 'MERGED') {
    state = 'merged';
  } else if (status === 'ABANDONED') {
    state = 'closed';
  } else if (status === 'NEW' || status === 'DRAFT') {
    state = wip || status === 'DRAFT' ? 'draft' : 'open';
  } else {
    throw new Error('status');
  }
  const url = change.url === undefined ? undefined : text(change.url);
  return {
    schemaVersion: 1,
    id: String(number),
    title: text(change.subject),
    state,
    sourceBranch: ref,
    targetBranch: (() => {
      const branch = text(change.branch);
      if (!safeBranch.test(branch)) {
        throw new Error('branch');
      }
      return branch;
    })(),
    ...(url === undefined ? {} : { url }),
    providerData: { gerrit: { changeNumber: number, patchSet, revision, changeId, wip } },
  };
}
function parseQueryRecord(output: string): JsonObject {
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
    throw new Error('oversized');
  }
  const lines = output.split(/\r?\n/u);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  if (lines.length !== 2) {
    throw new Error('lines');
  }
  const result = object(JSON.parse(lines[0]!) as unknown);
  const stats = object(JSON.parse(lines[1]!) as unknown);
  if (stats.type !== 'stats' || positiveInteger(stats.rowCount) !== 1) {
    throw new Error('stats');
  }
  return result;
}
function parseQuery(output: string, project: string): GerritReview {
  return normalize(parseQueryRecord(output), project);
}

function parseCommentReadback(
  output: string,
  project: string,
  expectedBody: string,
): ReviewCommentV1 {
  const change = parseQueryRecord(output);
  const review = normalize(change, project);
  if (!Array.isArray(change.comments) || change.comments.length > 10_000) {
    throw new Error('comments');
  }
  const matches = change.comments.filter((value) => {
    try {
      return text(object(value).message) === expectedBody;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    throw new Error('ambiguous comment');
  }
  const comment = object(matches[0]);
  const timestamp = text(comment.timestamp);
  const timestampMatch = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{3,9}))?$/u.exec(
    timestamp,
  );
  if (timestampMatch === null || timestamp.length > 40) {
    throw new Error('timestamp');
  }
  const createdAt = `${timestampMatch[1]}T${timestampMatch[2]}.${(timestampMatch[3] ?? '000')
    .slice(0, 3)
    .padEnd(3, '0')}Z`;
  const parsedDate = new Date(createdAt);
  if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString() !== createdAt) {
    throw new Error('timestamp');
  }
  const reviewer = object(comment.reviewer);
  const authorValue = reviewer.username ?? reviewer.email ?? reviewer.name;
  const author = text(authorValue);
  if (author.length === 0 || author.length > 256 || /[\u0000-\u001f\u007f]/u.test(author)) {
    throw new Error('reviewer');
  }
  return {
    schemaVersion: 1,
    id: `gerrit:${review.id}:${encodeURIComponent(timestamp)}:${encodeURIComponent(author)}`,
    reviewId: review.id,
    body: expectedBody,
    author,
    createdAt,
    providerData: {
      gerrit: {
        changeNumber: Number(review.id),
        patchSet: review.providerData.gerrit.patchSet,
        timestamp,
        reviewer: author,
      },
    },
  };
}
function commitMetadata(
  output: string,
  capability: string,
): { hash: string; title: string; body: string } {
  const record = output.endsWith('\u0000\n') ? output.slice(0, -1) : output;
  const parts = record.split('\u0000');
  if (parts.length !== 4 || parts[3] !== '' || !sha.test(parts[0]!)) {
    invalid(capability, 'Git returned invalid commit metadata.');
  }
  return { hash: parts[0]!, title: parts[1]!, body: parts[2]! };
}

function changeIdTrailers(body: string): readonly string[] {
  const lines = body.split(/\r?\n/u);
  while (lines.at(-1) === '') {
    lines.pop();
  }
  let start = lines.length - 1;
  while (start >= 0 && /^[A-Za-z0-9-]+:\s*.*$/u.test(lines[start]!)) {
    start -= 1;
  }
  return lines
    .slice(start + 1)
    .map((line) => /^Change-Id:\s*(I[0-9a-f]{40})\s*$/u.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
}
function remoteArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function command<T>(
  executor: ProviderProcessExecutor,
  options: GerritAdapterOptions,
  request: ProviderInvocation,
  argv: [string, ...string[]],
  parse?: (output: string) => T,
  mutation = false,
  stdin?: string,
): Promise<T> {
  return runProviderCommand(
    {
      providerId,
      argv,
      ...(request.route === undefined ? {} : { route: request.route }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      timeoutMilliseconds: TIMEOUT_MILLISECONDS,
      ...(mutation ? { mutation: true } : {}),
      ...(stdin === undefined ? {} : { stdin }),
    },
    executor,
    parse ?? ((output) => output as T),
  );
}
function unknown(capability: string): ProviderError {
  return new ProviderError(
    'MUTATION_OUTCOME_UNKNOWN',
    'The Gerrit mutation succeeded, but its result could not be read back.',
    {
      capability,
      retryable: false,
      remediation: 'Inspect remote state before attempting the mutation again.',
      details: { providerData: { gerrit: {} } },
    },
  );
}

export function createGerritAdapter(
  executor: ProviderProcessExecutor,
  options: GerritAdapterOptions,
): ProviderAdapter {
  const { host, port, project } = parseTarget(options.repository, options.remote);
  const ssh = (...args: string[]): [string, ...string[]] => [
    'ssh',
    ...(port === undefined ? [] : ['-p', String(port)]),
    host,
    'gerrit',
    ...args,
  ];
  const query = (request: ProviderInvocation, term: string) =>
    command(
      executor,
      options,
      request,
      ssh(
        'query',
        '--format=JSON',
        '--current-patch-set',
        '--',
        'limit:2',
        `project:${project}`,
        term,
      ),
      (output) => parseQuery(output, project),
    );
  const readAfterMutation = async (request: ProviderInvocation, term: string) => {
    try {
      return await query(request, term);
    } catch {
      throw unknown(request.capability);
    }
  };
  const metadata = (request: ProviderInvocation, ref: string) =>
    command(
      executor,
      options,
      request,
      ['git', 'show', '-s', '--format=%H%x00%s%x00%b%x00', `${ref}^{commit}`, '--'],
      (output) => commitMetadata(output, request.capability),
    );
  const assertMetadata = (
    request: ProviderInvocation,
    commit: { title: string; body: string },
    inputValue: JsonObject,
  ) => {
    const title = required(inputValue, 'title', request.capability, 512);
    if (title.includes('\n')) {
      invalid(request.capability);
    }
    const body = required(inputValue, 'body', request.capability, 65_536, true, true);
    if (title !== commit.title || body !== commit.body) {
      invalid(
        request.capability,
        'Requested title and body must exactly match the local commit metadata.',
      );
    }
    const changeIds = changeIdTrailers(commit.body);
    if (changeIds.length !== 1) {
      invalid(
        request.capability,
        'The local commit must contain exactly one valid Change-Id trailer.',
      );
    }
    return changeIds[0]!;
  };
  const mutateReview = (request: ProviderInvocation, args: string[], review: GerritReview) =>
    command(
      executor,
      options,
      request,
      ssh(
        'review',
        ...args,
        '--project',
        project,
        '--',
        `${review.id},${review.providerData.gerrit.patchSet}`,
      ),
      undefined,
      true,
    );

  return {
    providerId,
    role: 'repository',
    backend: 'git-ssh',
    capabilities: GERRIT_REPOSITORY_CAPABILITIES,
    routeRequired: true,
    async invoke(request) {
      if (
        !(GERRIT_REPOSITORY_CAPABILITIES as readonly ProviderCapability[]).includes(
          request.capability,
        )
      ) {
        unsupported(request.capability);
      }
      const inputValue = input(request);
      switch (request.capability) {
        case 'review.view':
          return query(request, `change:${identifier(inputValue, request.capability)}`);
        case 'review.create': {
          const source = required(inputValue, 'sourceBranch', request.capability, 255);
          const target = required(inputValue, 'targetBranch', request.capability, 255);
          if (!safeSource.test(source) || !safeBranch.test(target)) {
            invalid(request.capability);
          }
          if (inputValue.draft !== undefined && typeof inputValue.draft !== 'boolean') {
            invalid(request.capability);
          }
          const commit = await metadata(request, source);
          assertMetadata(request, commit, inputValue);
          const suffix = inputValue.draft === true ? '%wip' : '%ready';
          await command(
            executor,
            options,
            request,
            ['git', 'push', options.remote, `${commit.hash}:refs/for/${target}${suffix}`],
            undefined,
            true,
          );
          return readAfterMutation(request, `commit:${commit.hash}`);
        }
        case 'review.update': {
          const id = identifier(inputValue, request.capability);
          const existing = await query(request, `change:${id}`);
          const commit = await metadata(request, 'HEAD');
          const localChangeId = assertMetadata(request, commit, inputValue);
          if (localChangeId !== existing.providerData.gerrit.changeId) {
            invalid(
              request.capability,
              'The local commit Change-Id does not match the requested Gerrit change.',
            );
          }
          await command(
            executor,
            options,
            request,
            ['git', 'push', options.remote, `${commit.hash}:refs/for/${existing.targetBranch}`],
            undefined,
            true,
          );
          return readAfterMutation(request, `commit:${commit.hash}`);
        }
        case 'review.comment': {
          const id = identifier(inputValue, request.capability);
          const body = required(inputValue, 'body', request.capability, 65_536);
          const review = await query(request, `change:${id}`);
          await mutateReview(request, ['--message', remoteArgument(body)], review);
          try {
            return await command(
              executor,
              options,
              request,
              ssh(
                'query',
                '--format=JSON',
                '--current-patch-set',
                '--comments',
                '--',
                'limit:2',
                `project:${project}`,
                `change:${id}`,
              ),
              (output) => parseCommentReadback(output, project, body),
            );
          } catch {
            throw unknown(request.capability);
          }
        }
        case 'review.ready': {
          const id = identifier(inputValue, request.capability);
          const review = await query(request, `change:${id}`);
          await command(
            executor,
            options,
            request,
            ssh(
              'review',
              '--json',
              '--project',
              project,
              '--',
              `${review.id},${review.providerData.gerrit.patchSet}`,
            ),
            undefined,
            true,
            `${JSON.stringify({ ready: true })}\n`,
          );
          return readAfterMutation(request, `change:${id}`);
        }
        case 'review.vote': {
          const id = identifier(inputValue, request.capability);
          if (
            inputValue.label !== 'Code-Review' ||
            typeof inputValue.value !== 'number' ||
            ![-2, -1, 0, 1, 2].includes(inputValue.value)
          ) {
            invalid(request.capability);
          }
          const review = await query(request, `change:${id}`);
          await command(
            executor,
            options,
            request,
            ssh(
              'review',
              '--json',
              '--project',
              project,
              '--',
              `${review.id},${review.providerData.gerrit.patchSet}`,
            ),
            undefined,
            true,
            `${JSON.stringify({ labels: { 'Code-Review': inputValue.value } })}\n`,
          );
          return readAfterMutation(request, `change:${id}`);
        }
        case 'review.merge': {
          if (inputValue.method !== undefined) {
            unsupported(
              request.capability,
              'Gerrit uses its server-configured submit strategy; client-selected merge methods are unsupported.',
            );
          }
          const id = identifier(inputValue, request.capability);
          const review = await query(request, `change:${id}`);
          await mutateReview(request, ['--submit'], review);
          return readAfterMutation(request, `change:${id}`);
        }
      }
    },
  };
}
