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
  /^(?![-/])(?!.*(?:\.\.|@\{|\\|[~^:?*[]))(?!.*(?:^|\/)\.\.?($|\/))(?!.*(?:\/$|\.$|\/\/))(?!.*\.lock(?:$|\/))[A-Za-z0-9_./-]{1,255}$/u;
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
): string {
  const value = inputValue[key];
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    /[\u0000\u000d]/u.test(value)
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
  if (
    selector.length > 1024 ||
    parts.length < 2 ||
    !safeHost.test(parts[0]!) ||
    !parts.every((part) => part !== '.' && part !== '..' && safeSegment.test(part))
  ) {
    invalid(capability, 'The Gerrit repository selector is invalid.');
  }
  if (!safeRemote.test(remote) || remote === '.' || remote === '..') {
    invalid(capability, 'The configured Git remote name is invalid.');
  }
  return { host: parts[0]!, project: parts.slice(1).join('/') };
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
    targetBranch: text(change.branch),
    ...(url === undefined ? {} : { url }),
    providerData: { gerrit: { changeNumber: number, patchSet, revision, changeId, wip } },
  };
}
function parseQuery(output: string, project: string): GerritReview {
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
  const result = JSON.parse(lines[0]!) as unknown;
  const stats = object(JSON.parse(lines[1]!) as unknown);
  if (stats.type !== 'stats' || positiveInteger(stats.rowCount) !== 1) {
    throw new Error('stats');
  }
  return normalize(result, project);
}
function commitMetadata(
  output: string,
  capability: string,
): { hash: string; title: string; body: string } {
  const parts = output.split('\u0000');
  if (parts.length !== 3 || !sha.test(parts[0]!)) {
    invalid(capability, 'Git returned invalid commit metadata.');
  }
  return { hash: parts[0]!, title: parts[1]!, body: parts[2]! };
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
  const { host, project } = parseTarget(options.repository, options.remote);
  const ssh = (...args: string[]): [string, ...string[]] => ['ssh', host, 'gerrit', ...args];
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
      ['git', 'show', '-s', '--format=%H%x00%s%x00%b', `${ref}^{commit}`, '--'],
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
    const body = required(inputValue, 'body', request.capability, 65_536, true);
    if (title !== commit.title || body !== commit.body) {
      invalid(
        request.capability,
        'Requested title and body must exactly match the local commit metadata.',
      );
    }
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
          assertMetadata(request, commit, inputValue);
          const localChangeIds = [
            ...commit.body.matchAll(/^Change-Id:\s*(I[0-9a-f]{40})\s*$/gmu),
          ].map((match) => match[1]);
          if (
            localChangeIds.length !== 1 ||
            localChangeIds[0] !== existing.providerData.gerrit.changeId
          ) {
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
          await readAfterMutation(request, `change:${id}`);
          return {
            schemaVersion: 1,
            id: `${id},${review.providerData.gerrit.patchSet}`,
            reviewId: id,
            body,
            providerData: {
              gerrit: { changeNumber: Number(id), patchSet: review.providerData.gerrit.patchSet },
            },
          } satisfies ReviewCommentV1;
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
            `${JSON.stringify({ ready: true, labels: { 'Code-Review': 2 } })}\n`,
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
