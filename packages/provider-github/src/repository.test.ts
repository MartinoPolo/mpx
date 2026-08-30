import { describe, expect, it } from 'vitest';
import type {
  ProviderInvocation,
  ProviderProcessExecutor,
  ProviderProcessRequest,
  ProviderProcessResult,
} from '@mpx/providers';
import { createGitHubAdapters } from './index.js';

const nativeReview = {
  number: 7,
  id: 'PR_7',
  title: 'Ship',
  state: 'OPEN',
  isDraft: false,
  headRefName: 'feature',
  baseRefName: 'main',
  url: 'https://github.test/o/r/pull/7',
};
class ScriptedGh implements ProviderProcessExecutor {
  readonly requests: ProviderProcessRequest[] = [];
  constructor(private readonly results: ProviderProcessResult[]) {}
  async execute(request: ProviderProcessRequest): Promise<ProviderProcessResult> {
    this.requests.push(request);
    return this.results.shift() ?? { exitCode: 1, stdout: '', stderr: 'missing fake result' };
  }
}
const ok = (value: unknown): ProviderProcessResult => ({
  exitCode: 0,
  stdout: typeof value === 'string' ? value : JSON.stringify(value),
  stderr: '',
});
const invoke = (
  gh: ScriptedGh,
  capability: Parameters<ReturnType<typeof createGitHubAdapters>[1]['invoke']>[0]['capability'],
  input: Record<string, unknown>,
  cwd?: string,
) =>
  createGitHubAdapters(gh, cwd === undefined ? {} : { cwd })[1].invoke({
    providerId: 'github',
    capability,
    route: 'personal',
    input: input as ProviderInvocation['input'],
  });

describe('GitHub reviews', () => {
  it('views and normalizes a review using explicit fields', async () => {
    const gh = new ScriptedGh([ok(nativeReview)]);
    await expect(invoke(gh, 'review.view', { id: '7' })).resolves.toEqual({
      schemaVersion: 1,
      id: '7',
      title: 'Ship',
      state: 'open',
      sourceBranch: 'feature',
      targetBranch: 'main',
      url: nativeReview.url,
      providerData: { github: { number: 7, nodeId: 'PR_7', isDraft: false } },
    });
    expect(gh.requests[0]).toEqual({
      argv: [
        'gh',
        'pr',
        'view',
        '7',
        '--json',
        'number,id,title,state,isDraft,headRefName,baseRefName,url',
      ],
      route: 'personal',
      authExitCodes: [4],
    });
  });

  it.each([
    [
      'review.create',
      { title: 'Ship', body: 'Body', sourceBranch: 'feature', targetBranch: 'main', draft: true },
      [
        'gh',
        'pr',
        'create',
        '--title',
        'Ship',
        '--body',
        'Body',
        '--head',
        'feature',
        '--base',
        'main',
        '--draft',
      ],
    ],
    [
      'review.update',
      { id: '7', title: 'Ship', body: 'Body' },
      ['gh', 'pr', 'edit', '7', '--title', 'Ship', '--body', 'Body'],
    ],
    ['review.ready', { id: '7' }, ['gh', 'pr', 'ready', '7']],
    ['review.merge', { id: '7', method: 'squash' }, ['gh', 'pr', 'merge', '7', '--squash']],
  ] as const)(
    'executes %s with argv-only mutation and bounded read-back',
    async (capability, input, expected) => {
      const first = capability === 'review.create' ? ok(`${nativeReview.url}\n`) : ok('');
      const gh = new ScriptedGh([first, ok(nativeReview)]);
      await expect(invoke(gh, capability, input)).resolves.toMatchObject({
        id: '7',
        providerData: { github: { nodeId: 'PR_7' } },
      });
      expect(gh.requests.map((request) => request.argv)).toEqual([
        expected,
        [
          'gh',
          'pr',
          'view',
          '7',
          '--json',
          'number,id,title,state,isDraft,headRefName,baseRefName,url',
        ],
      ]);
    },
  );

  it('binds review mutations and API read-back to one explicit repository', async () => {
    const nativeComment = {
      id: 91,
      node_id: 'IC_91',
      body: 'Looks good',
      user: { login: 'reviewer' },
      created_at: '2026-02-03T04:05:06Z',
    };
    const gh = new ScriptedGh([
      ok('https://github.example/acme/project/pull/7#issuecomment-91\n'),
      ok(nativeComment),
    ]);
    const adapter = createGitHubAdapters(gh, { repository: 'github.example/acme/project' })[1];
    await adapter.invoke({
      providerId: 'github',
      capability: 'review.comment',
      route: 'personal',
      input: { id: '7', body: 'Looks good' },
    });
    expect(gh.requests.map((request) => request.argv)).toEqual([
      ['gh', 'pr', 'comment', '7', '--body', 'Looks good', '--repo', 'github.example/acme/project'],
      [
        'gh',
        'api',
        'repos/acme/project/issues/comments/91',
        '--hostname',
        'github.example',
        '--jq',
        '{id,node_id,body,user:{login:.user.login},created_at}',
      ],
    ]);
  });

  it('returns the normalized comment fetched from the mutation URL', async () => {
    const nativeComment = {
      id: 91,
      node_id: 'IC_91',
      body: 'Looks good',
      user: { login: 'reviewer' },
      created_at: '2026-02-03T04:05:06Z',
    };
    const gh = new ScriptedGh([ok(`${nativeReview.url}#issuecomment-91\n`), ok(nativeComment)]);
    await expect(invoke(gh, 'review.comment', { id: '7', body: 'Looks good' })).resolves.toEqual({
      schemaVersion: 1,
      id: '91',
      reviewId: '7',
      body: 'Looks good',
      author: 'reviewer',
      createdAt: '2026-02-03T04:05:06Z',
      providerData: { github: { nodeId: 'IC_91' } },
    });
    expect(gh.requests.map((request) => request.argv)).toEqual([
      ['gh', 'pr', 'comment', '7', '--body', 'Looks good'],
      [
        'gh',
        'api',
        'repos/{owner}/{repo}/issues/comments/91',
        '--jq',
        '{id,node_id,body,user:{login:.user.login},created_at}',
      ],
    ]);
  });
});

describe('GitHub CI', () => {
  const checks = [
    { name: 'build', state: 'SUCCESS', bucket: 'pass', link: 'https://ci.test/1' },
    { name: 'test', state: 'IN_PROGRESS', bucket: 'pending', link: 'https://ci.test/2' },
  ];
  it.each([
    ['ci.status', false],
    ['ci.watch', true],
  ] as const)('normalizes %s checks and aggregate state', async (capability, watch) => {
    const gh = new ScriptedGh([ok(checks)]);
    await expect(invoke(gh, capability, { id: '7' })).resolves.toEqual({
      schemaVersion: 1,
      state: 'running',
      checks: [
        {
          id: 'build',
          name: 'build',
          state: 'passed',
          url: 'https://ci.test/1',
          providerData: { github: { state: 'SUCCESS', bucket: 'pass' } },
        },
        {
          id: 'test',
          name: 'test',
          state: 'running',
          url: 'https://ci.test/2',
          providerData: { github: { state: 'IN_PROGRESS', bucket: 'pending' } },
        },
      ],
      providerData: { github: { reviewNumber: 7 } },
    });
    expect(gh.requests[0]!.argv).toEqual([
      'gh',
      'pr',
      'checks',
      '7',
      '--json',
      'name,state,bucket,link',
      ...(watch ? ['--watch'] : []),
    ]);
    expect(gh.requests[0]!.timeoutMilliseconds).toBe(watch ? 1_800_000 : undefined);
    expect(gh.requests[0]!.authExitCodes).toEqual([4]);
  });

  it('binds CI commands to the explicit repository after the validated numeric ID', async () => {
    const gh = new ScriptedGh([ok('safe log\n')]);
    const adapter = createGitHubAdapters(gh, { repository: 'acme/project' })[1];
    await adapter.invoke({ providerId: 'github', capability: 'ci.logs', input: { runId: '22' } });
    expect(gh.requests[0]?.argv).toEqual([
      'gh',
      'run',
      'view',
      '22',
      '--log-failed',
      '--repo',
      'acme/project',
    ]);
  });

  it('rejects URL, flag-like, compact, and path-like repository identifiers before invocation', async () => {
    for (const [capability, key] of [
      ['review.view', 'id'],
      ['ci.status', 'id'],
      ['ci.logs', 'runId'],
    ] as const) {
      for (const id of ['https://github.test/acme/project/7', '-R', 'other/project#7', '../7']) {
        const gh = new ScriptedGh([]);
        await expect(invoke(gh, capability, { [key]: id })).rejects.toMatchObject({
          code: 'PROVIDER_INVALID',
          capability,
        });
        expect(gh.requests).toEqual([]);
      }
    }
  });

  it('returns normalized failed-run logs through an argv-only request', async () => {
    const gh = new ScriptedGh([ok('safe log\n')]);
    await expect(invoke(gh, 'ci.logs', { runId: '22' })).resolves.toEqual({
      schemaVersion: 1,
      id: '22',
      content: 'safe log\n',
      providerData: { github: { runId: '22' } },
    });
    expect(gh.requests[0]!.argv).toEqual(['gh', 'run', 'view', '22', '--log-failed']);
  });

  it.each([
    [8, [{ name: 'test', state: 'QUEUED', bucket: 'pending', link: '' }], 'pending'],
    [1, [{ name: 'test', state: 'FAILURE', bucket: 'fail', link: '' }], 'failed'],
  ] as const)(
    'normalizes checks returned with accepted exit code %s',
    async (exitCode, output, state) => {
      const gh = new ScriptedGh([{ exitCode, stdout: JSON.stringify(output), stderr: '' }]);
      await expect(invoke(gh, 'ci.status', { id: '7' })).resolves.toMatchObject({
        schemaVersion: 1,
        state,
      });
    },
  );

  it('rejects malformed check JSON even on an accepted nonzero exit', async () => {
    const gh = new ScriptedGh([{ exitCode: 8, stdout: 'not-json', stderr: '' }]);
    await expect(invoke(gh, 'ci.status', { id: '7' })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('returns a normalized retry result without fabricating a status response', async () => {
    const gh = new ScriptedGh([ok('')]);
    await expect(invoke(gh, 'ci.retry', { runId: '22' })).resolves.toEqual({
      schemaVersion: 1,
      id: '22',
      providerData: { github: { retried: true } },
    });
    expect(gh.requests[0]!.argv).toEqual(['gh', 'run', 'rerun', '22', '--failed']);
  });

  it('forwards the configured cwd to repository commands', async () => {
    const gh = new ScriptedGh([ok(nativeReview)]);
    await invoke(gh, 'review.view', { id: '7' }, 'C:/repo');
    expect(gh.requests[0]).toMatchObject({ cwd: 'C:/repo' });
  });
});

describe('GitHub provider failures', () => {
  it.each([
    [
      'review.create',
      { title: 'Ship', body: 'Body', sourceBranch: 'feature', targetBranch: 'main' },
    ],
    ['review.comment', { id: '7', body: 'Looks good' }],
  ] as const)(
    'reports malformed %s mutation output as an unknown non-retryable outcome',
    async (capability, input) => {
      const gh = new ScriptedGh([ok('not a URL token=secret')]);
      let failure: unknown;
      try {
        await invoke(gh, capability, input);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: 'MUTATION_OUTCOME_UNKNOWN',
        retryable: false,
        remediation: 'Inspect remote state before attempting the mutation again.',
        details: { providerData: { github: { outputBytes: expect.any(Number) } } },
      });
      expect(JSON.stringify(failure)).not.toContain('secret');
    },
  );

  it.each([
    [
      'review.create',
      { title: 'Ship', body: 'Body', sourceBranch: 'feature', targetBranch: 'main' },
      `${nativeReview.url}\n`,
      7,
    ],
    [
      'review.comment',
      { id: '7', body: 'Looks good' },
      `${nativeReview.url}#issuecomment-91\n`,
      91,
    ],
  ] as const)(
    'reports uncertain %s read-back with only the confirmed numeric ID',
    async (capability, input, mutationOutput, confirmedId) => {
      const gh = new ScriptedGh([ok(mutationOutput), ok('malformed token=secret')]);
      let failure: unknown;
      try {
        await invoke(gh, capability, input);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: 'MUTATION_OUTCOME_UNKNOWN',
        capability,
        retryable: false,
        details: { providerData: { github: { confirmedId } } },
      });
      expect(JSON.stringify(failure)).not.toContain('secret');
    },
  );

  it.each([
    [{ exitCode: 0, stdout: '{token:secret}', stderr: '' }, 'INVALID_RESPONSE'],
    [{ exitCode: 9, stdout: '', stderr: 'token=secret body=private' }, 'COMMAND_FAILURE'],
    [
      { exitCode: 4, stdout: '', stderr: 'token=secret body=private', failure: 'auth' as const },
      'AUTH_FAILURE',
    ],
  ])('sanitizes malformed, exit, and auth failures', async (result, code) => {
    const gh = new ScriptedGh([result]);
    let failure: unknown;
    try {
      await invoke(gh, 'review.view', { id: '7', body: 'private' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code });
    expect(JSON.stringify(failure)).not.toMatch(/secret|private/);
  });
});
