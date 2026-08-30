import { describe, expect, it } from 'vitest';
import type {
  ProviderProcessExecutor,
  ProviderProcessRequest,
  ProviderProcessResult,
} from '@mpx/providers';
import { createGitHubAdapters } from './index.js';

class FakeGh implements ProviderProcessExecutor {
  readonly requests: ProviderProcessRequest[] = [];
  async execute(request: ProviderProcessRequest): Promise<ProviderProcessResult> {
    this.requests.push(request);
    return { exitCode: 0, stdout: '[]', stderr: '' };
  }
}

describe('GitHub provider identity', () => {
  it('declares trusted roles, backend, and only supported capabilities', () => {
    const adapters = createGitHubAdapters(new FakeGh());
    expect(adapters).toHaveLength(2);
    expect(
      adapters.map(({ providerId, role, backend, routeRequired }) => ({
        providerId,
        role,
        backend,
        routeRequired,
      })),
    ).toEqual([
      { providerId: 'github', role: 'issues', backend: 'gh', routeRequired: true },
      { providerId: 'github', role: 'repository', backend: 'gh', routeRequired: true },
    ]);
    expect(adapters[0]!.capabilities).toEqual([
      'issue.list',
      'issue.view',
      'issue.create',
      'issue.edit',
      'issue.comment',
      'issue.label',
      'issue.finish',
    ]);
    expect(adapters[1]!.capabilities).toEqual([
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
    ]);
  });

  it('rejects issue.move structurally before invoking gh', async () => {
    const gh = new FakeGh();
    const adapter = createGitHubAdapters(gh)[0];
    await expect(
      adapter.invoke({
        providerId: 'github',
        capability: 'issue.move',
        route: 'personal',
        input: { id: '1', destination: 'Done' },
      }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
      capability: 'issue.move',
      retryable: false,
    });
    expect(gh.requests).toEqual([]);
  });

  it('forwards the configured cwd to issue commands', async () => {
    const gh = new FakeGh();
    await createGitHubAdapters(gh, { cwd: 'C:/repo' })[0].invoke({
      providerId: 'github',
      capability: 'issue.list',
      route: 'personal',
      input: {},
    });
    expect(gh.requests[0]).toEqual({
      argv: ['gh', 'issue', 'list', '--json', 'number,id,title,body,state,labels,url,assignees'],
      route: 'personal',
      cwd: 'C:/repo',
      authExitCodes: [4],
    });
  });

  it('maps the normalized finished list state to GitHub closed state', async () => {
    const gh = new FakeGh();
    await createGitHubAdapters(gh)[0].invoke({
      providerId: 'github',
      capability: 'issue.list',
      route: 'personal',
      input: { state: 'finished' },
    });
    expect(gh.requests[0]?.argv).toEqual([
      'gh',
      'issue',
      'list',
      '--json',
      'number,id,title,body,state,labels,url,assignees',
      '--state',
      'closed',
    ]);
  });

  it('binds issue commands to a validated explicit repository', async () => {
    const gh = new FakeGh();
    await createGitHubAdapters(gh, { repository: 'github.example/acme/project' })[0].invoke({
      providerId: 'github',
      capability: 'issue.list',
      route: 'personal',
      input: {},
    });
    expect(gh.requests[0]?.argv).toEqual([
      'gh',
      'issue',
      'list',
      '--json',
      'number,id,title,body,state,labels,url,assignees',
      '--repo',
      'github.example/acme/project',
    ]);
    expect(() =>
      createGitHubAdapters(gh, { repository: 'https://github.com/acme/project' }),
    ).toThrowError(expect.objectContaining({ code: 'PROVIDER_INVALID' }));
  });

  it('rejects hosted issue identifiers before invoking gh', async () => {
    const gh = new FakeGh();
    const adapter = createGitHubAdapters(gh, { repository: 'acme/project' })[0];
    for (const id of [
      'https://github.com/acme/project/issues/7',
      '-R',
      'acme/project#7',
      '../7',
      '01',
      '0',
    ]) {
      await expect(
        adapter.invoke({ providerId: 'github', capability: 'issue.view', input: { id } }),
      ).rejects.toMatchObject({ code: 'PROVIDER_INVALID', capability: 'issue.view' });
    }
    expect(gh.requests).toEqual([]);
  });

  it.each([
    ['issue.create', { title: 'Title', body: 'Body' }],
    ['issue.comment', { id: '7', body: 'Body' }],
  ] as const)(
    'reports malformed %s mutation output as an unknown non-retryable outcome',
    async (capability, input) => {
      const executor: ProviderProcessExecutor = {
        execute: async () => ({ exitCode: 0, stdout: 'not a URL token=secret', stderr: '' }),
      };
      let failure: unknown;
      try {
        await createGitHubAdapters(executor)[0].invoke({ providerId: 'github', capability, input });
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
      'issue.create',
      { title: 'Title', body: 'Body' },
      'https://github.test/acme/project/issues/17\n',
      17,
    ],
    [
      'issue.comment',
      { id: '7', body: 'Body' },
      'https://github.test/acme/project/issues/7#issuecomment-91\n',
      91,
    ],
  ] as const)(
    'reports uncertain %s read-back without encouraging a duplicate mutation',
    async (capability, input, mutationOutput, confirmedId) => {
      const results = [
        { exitCode: 0, stdout: mutationOutput, stderr: '' },
        { exitCode: 0, stdout: 'malformed token=secret', stderr: '' },
      ];
      const executor: ProviderProcessExecutor = { execute: async () => results.shift()! };
      let failure: unknown;
      try {
        await createGitHubAdapters(executor)[0].invoke({ providerId: 'github', capability, input });
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
});
