import { describe, expect, it, vi } from 'vitest';
import { createGerritAdapter, type ProviderProcessRequest } from '../../src/index.js';

const change = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    project: 'team/platform/service',
    branch: 'main',
    number: 42,
    id: 'I1111111111111111111111111111111111111111',
    subject: 'Exact title',
    status: 'NEW',
    url: 'https://review.example/c/42',
    wip: false,
    currentPatchSet: {
      number: 3,
      revision: '0123456789abcdef0123456789abcdef01234567',
      ref: 'refs/changes/42/42/3',
    },
    ...overrides,
  });
const queryOutput = (overrides: Record<string, unknown> = {}) =>
  `${change(overrides)}\n${JSON.stringify({ type: 'stats', rowCount: 1, runTimeMilliseconds: 2 })}\n`;

function harness(outputs: readonly string[]) {
  const requests: ProviderProcessRequest[] = [];
  let index = 0;
  const execute = vi.fn(async (request: ProviderProcessRequest) => {
    requests.push(request);
    return { exitCode: 0, stdout: outputs[index++] ?? '', stderr: '' };
  });
  const adapter = createGerritAdapter(
    { execute },
    {
      cwd: 'C:/repo',
      repository: 'review.example/team/platform/service',
      remote: 'upstream',
    },
  );
  return { adapter, requests, execute };
}

const invoke = (
  adapter: ReturnType<typeof createGerritAdapter>,
  capability: string,
  input: Record<string, unknown>,
) =>
  adapter.invoke({
    providerId: 'gerrit',
    capability: capability as never,
    route: 'work',
    input: input as never,
  });

describe('Gerrit review adapter', () => {
  it('views one exact nested-project change using bounded JSON-lines query output', async () => {
    const { adapter, requests } = harness([queryOutput()]);
    await expect(invoke(adapter, 'review.view', { id: '42' })).resolves.toEqual({
      schemaVersion: 1,
      id: '42',
      title: 'Exact title',
      state: 'open',
      sourceBranch: 'refs/changes/42/42/3',
      targetBranch: 'main',
      url: 'https://review.example/c/42',
      providerData: {
        gerrit: {
          changeNumber: 42,
          patchSet: 3,
          revision: '0123456789abcdef0123456789abcdef01234567',
          changeId: 'I1111111111111111111111111111111111111111',
          wip: false,
        },
      },
    });
    expect(requests).toEqual([
      {
        argv: [
          'ssh',
          'review.example',
          'gerrit',
          'query',
          '--format=JSON',
          '--current-patch-set',
          '--',
          'limit:2',
          'project:team/platform/service',
          'change:42',
        ],
        route: 'work',
        cwd: 'C:/repo',
        timeoutMilliseconds: 120000,
      },
    ]);
  });

  it('creates a WIP by validating exact commit metadata, pushing the configured remote, and reading back the exact commit', async () => {
    const hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const { adapter, requests } = harness([
      `${hash}\u0000Exact title\u0000Exact body\n`,
      '',
      queryOutput({
        currentPatchSet: { number: 1, revision: hash, ref: 'refs/changes/42/42/1' },
        wip: true,
      }),
    ]);
    await invoke(adapter, 'review.create', {
      title: 'Exact title',
      body: 'Exact body\n',
      sourceBranch: 'topic/x',
      targetBranch: 'main',
      draft: true,
    });
    expect(requests.map((request) => request.argv)).toEqual([
      ['git', 'show', '-s', '--format=%H%x00%s%x00%b', 'topic/x^{commit}', '--'],
      ['git', 'push', 'upstream', `${hash}:refs/for/main%wip`],
      [
        'ssh',
        'review.example',
        'gerrit',
        'query',
        '--format=JSON',
        '--current-patch-set',
        '--',
        'limit:2',
        'project:team/platform/service',
        `commit:${hash}`,
      ],
    ]);
  });

  it('updates by querying the target, matching HEAD metadata, and uploading HEAD as a patchset', async () => {
    const hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const { adapter, requests } = harness([
      queryOutput(),
      `${hash}\u0000Exact title\u0000Exact body\n\nChange-Id: I1111111111111111111111111111111111111111`,
      '',
      queryOutput({ currentPatchSet: { number: 4, revision: hash, ref: 'refs/changes/42/42/4' } }),
    ]);
    await invoke(adapter, 'review.update', {
      id: '42',
      title: 'Exact title',
      body: 'Exact body\n\nChange-Id: I1111111111111111111111111111111111111111',
    });
    expect(requests.map((request) => request.argv)).toEqual([
      [
        'ssh',
        'review.example',
        'gerrit',
        'query',
        '--format=JSON',
        '--current-patch-set',
        '--',
        'limit:2',
        'project:team/platform/service',
        'change:42',
      ],
      ['git', 'show', '-s', '--format=%H%x00%s%x00%b', 'HEAD^{commit}', '--'],
      ['git', 'push', 'upstream', `${hash}:refs/for/main`],
      [
        'ssh',
        'review.example',
        'gerrit',
        'query',
        '--format=JSON',
        '--current-patch-set',
        '--',
        'limit:2',
        'project:team/platform/service',
        `commit:${hash}`,
      ],
    ]);
  });

  it('rejects requested commit metadata mismatch before upload', async () => {
    const { adapter, requests } = harness([
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\u0000Actual\u0000Body',
    ]);
    await expect(
      invoke(adapter, 'review.create', {
        title: 'Requested',
        body: 'Body',
        sourceBranch: 'topic',
        targetBranch: 'main',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID' });
    expect(requests).toHaveLength(1);
  });

  it('posts an argv-only review comment and returns only known acknowledgement fields', async () => {
    const { adapter, requests } = harness([queryOutput(), '', queryOutput()]);
    await expect(
      invoke(adapter, 'review.comment', { id: '42', body: 'Looks good' }),
    ).resolves.toMatchObject({ schemaVersion: 1, id: '42,3', reviewId: '42', body: 'Looks good' });
    expect(requests[1]?.argv).toEqual([
      'ssh',
      'review.example',
      'gerrit',
      'review',
      '--message',
      "'Looks good'",
      '--project',
      'team/platform/service',
      '--',
      '42,3',
    ]);
  });

  it('publishes and applies Code-Review +2 atomically with structured review input', async () => {
    const { adapter, requests } = harness([
      queryOutput({ wip: true }),
      '',
      queryOutput({ wip: false }),
    ]);
    await invoke(adapter, 'review.ready', { id: '42' });
    expect(requests[1]).toEqual({
      argv: [
        'ssh',
        'review.example',
        'gerrit',
        'review',
        '--json',
        '--project',
        'team/platform/service',
        '--',
        '42,3',
      ],
      route: 'work',
      cwd: 'C:/repo',
      timeoutMilliseconds: 120000,
      stdin: '{"ready":true,"labels":{"Code-Review":2}}\n',
    });
  });

  it('submits without overriding server strategy and rejects client-selected methods', async () => {
    const first = harness([queryOutput(), '', queryOutput({ status: 'MERGED' })]);
    await invoke(first.adapter, 'review.merge', { id: '42' });
    expect(first.requests[1]?.argv).toEqual([
      'ssh',
      'review.example',
      'gerrit',
      'review',
      '--submit',
      '--project',
      'team/platform/service',
      '--',
      '42,3',
    ]);
    const second = harness([]);
    await expect(
      invoke(second.adapter, 'review.merge', { id: '42', method: 'squash' }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(second.requests).toHaveLength(0);
  });

  it.each([
    ['malformed', '{bad}\n'],
    [
      'multiple',
      `${change()}\n${change({ number: 43 })}\n${JSON.stringify({ type: 'stats', rowCount: 2 })}\n`,
    ],
    ['oversized', `${'x'.repeat(1024 * 1024 + 1)}`],
  ])('rejects %s query responses', async (_name, output) => {
    const { adapter } = harness([output]);
    await expect(invoke(adapter, 'review.view', { id: '42' })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it.each([
    [{ id: '--help' }, 'review.view'],
    [{ id: '42', body: 'bad\u0000message' }, 'review.comment'],
    [{ title: 'x', body: '', sourceBranch: '--all', targetBranch: 'main' }, 'review.create'],
  ])('rejects option and control-character injection', async (input, capability) => {
    const { adapter, requests } = harness([]);
    await expect(invoke(adapter, capability, input)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID',
    });
    expect(requests).toHaveLength(0);
  });

  it('reports failed mutations and failed post-mutation reads as unknown without retry', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: queryOutput({ project: 'team/project' }),
        stderr: '',
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 9, stdout: '', stderr: 'private route' });
    const adapter = createGerritAdapter(
      { execute },
      { cwd: 'C:/repo', repository: 'review.example/team/project', remote: 'upstream' },
    );
    await expect(
      invoke(adapter, 'review.comment', { id: '42', body: 'hello' }),
    ).rejects.toMatchObject({ code: 'MUTATION_OUTCOME_UNKNOWN', retryable: false });
  });
});
