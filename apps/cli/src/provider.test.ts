import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MpxError } from '@mpx/core';
import type { ProviderInvocation, ProviderProcessRequest } from '@mpx/providers';
import { captureIo } from './io.js';
import { run } from './main.js';

async function project(config: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-provider-cli-'));
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, 'mpxconfig.json'), JSON.stringify(config));
  return root;
}

async function identityEnv(
  domainRoot: string,
  providerRoutes: Record<string, string>,
): Promise<NodeJS.ProcessEnv> {
  const appdata = await mkdtemp(path.join(tmpdir(), 'mpx-provider-user-'));
  await mkdir(path.join(appdata, 'mpx'));
  await writeFile(
    path.join(appdata, 'mpx', 'config.json'),
    JSON.stringify({
      identities: {
        work: {
          domain: 'work',
          runtimeRoots: { claude: 'C:/claude', pi: 'C:/pi' },
          gitAuthorRoute: 'git-work',
          providerRoutes,
        },
      },
      domains: { work: [domainRoot] },
      contentScopes: {},
      modes: {},
      skillPolicies: {},
      presets: {},
      launchDefaults: { projects: {}, scopes: {} },
      networkPolicies: {},
      executors: { host: {} },
    }),
  );
  return { APPDATA: appdata };
}

const config = (repository = 'github', issues = 'kanbanflow') => ({
  schemaVersion: 1,
  project: { id: 'sample/app' },
  repository: { provider: repository, remote: 'origin' },
  issues:
    issues === 'kanbanflow'
      ? {
          provider: issues,
          boardId: 'board',
          states: { todo: 'todo', wip: 'wip', review: 'review', done: 'done' },
        }
      : { provider: issues },
});

describe('provider CLI', () => {
  it('selects the strict issues role and delegates with the explicit identity route', async () => {
    const cwd = await project(config()),
      env = await identityEnv(cwd, { kanbanflow: 'work-kf' }),
      io = captureIo();
    const invoke = vi.fn(async (_request: ProviderInvocation) => [{ schemaVersion: 1, id: '1' }]);
    expect(
      await run(['--json', '--cwd', cwd, 'issue', 'list', '--identity', 'work'], io, {
        env,
        providerService: { invoke },
      }),
      io.out.join('\n'),
    ).toBe(0);
    expect(invoke).toHaveBeenCalledWith({
      providerId: 'kanbanflow',
      capability: 'issue.list',
      route: 'work-kf',
      input: {},
    });
    expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ apiVersion: 1, ok: true, data: [{ id: '1' }] });
  });

  it('delegates a normalized noninteractive issue-list state filter', async () => {
    const cwd = await project(config()),
      env = await identityEnv(cwd, { kanbanflow: 'work-kf' }),
      io = captureIo();
    const invoke = vi.fn(async () => []);
    expect(
      await run(
        ['--json', '--cwd', cwd, 'issue', 'list', '--state', 'finished', '--identity', 'work'],
        io,
        { env, providerService: { invoke } },
      ),
    ).toBe(0);
    expect(invoke).toHaveBeenCalledWith({
      providerId: 'kanbanflow',
      capability: 'issue.list',
      route: 'work-kf',
      input: { state: 'finished' },
    });
  });

  it('rejects provider actions without an explicit configured identity', async () => {
    const cwd = await project(config()),
      io = captureIo(),
      invoke = vi.fn();
    expect(
      await run(['--json', '--cwd', cwd, 'issue', 'list'], io, {
        env: {},
        providerService: { invoke },
      }),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'IDENTITY_REQUIRED' },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects an identity without a route for the selected provider', async () => {
    const cwd = await project(config()),
      env = await identityEnv(cwd, { github: 'work-gh' }),
      io = captureIo(),
      invoke = vi.fn();
    expect(
      await run(['--json', '--cwd', cwd, 'issue', 'list', '--identity', 'work'], io, {
        env,
        providerService: { invoke },
      }),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'PROVIDER_ROUTE_REQUIRED' },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns structured unsupported errors before adapter or process invocation', async () => {
    const cwd = await project(config('github', 'github')),
      env = await identityEnv(cwd, { github: 'work-gh' }),
      io = captureIo(),
      invoke = vi.fn();
    expect(
      await run(
        [
          '--json',
          '--cwd',
          cwd,
          'issue',
          'move',
          '--identity',
          'work',
          '--id',
          '3',
          '--destination',
          'done',
        ],
        io,
        { env, providerService: { invoke } },
      ),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_UNSUPPORTED', capability: 'issue.move' },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['ready', 'markReady'],
    ['merge', 'merge'],
  ] as const)('enforces the human workflow ceiling for review %s', async (action, ceiling) => {
    const value = config('github', 'none');
    (value as Record<string, unknown>).workflow = { codeReview: { [ceiling]: 'human' } };
    const cwd = await project(value),
      env = await identityEnv(cwd, { github: 'work-gh' }),
      io = captureIo(),
      invoke = vi.fn();
    expect(
      await run(['--json', '--cwd', cwd, 'review', action, '--identity', 'work', '--id', '8'], io, {
        env,
        providerService: { invoke },
      }),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'WORKFLOW_POLICY_DENIED', capability: `review.${action}` },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('validates required explicit provider arguments in one error envelope', async () => {
    const cwd = await project(config('github', 'github')),
      env = await identityEnv(cwd, { github: 'work-gh' }),
      io = captureIo(),
      invoke = vi.fn();
    expect(
      await run(
        ['--json', '--cwd', cwd, 'issue', 'create', '--identity', 'work', '--body', 'body'],
        io,
        { env, providerService: { invoke } },
      ),
    ).toBe(2);
    expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: false,
      error: { code: 'USAGE_ERROR', message: '--title is required' },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('selects a caller-supplied trusted provider composition without project command injection', async () => {
    const cwd = await project(config('generic', 'trusted-issues')),
      env = await identityEnv(cwd, { 'trusted-issues': 'work-trusted' }),
      io = captureIo();
    const invoke = vi.fn(async () => []);
    const descriptor = {
      id: 'trusted-issues',
      roles: ['issues'],
      capabilities: ['issue.list'],
      backend: 'trusted-sdk',
      schema: { type: 'object', properties: {}, additionalProperties: false },
    } as const;
    const adapter = {
      providerId: 'trusted-issues',
      role: 'issues',
      backend: 'trusted-sdk',
      capabilities: ['issue.list'],
      routeRequired: true,
      invoke,
    } as const;
    expect(
      await run(['--json', '--cwd', cwd, 'issue', 'list', '--identity', 'work'], io, {
        env,
        trustedProviderComposition: { descriptors: [descriptor], adapters: [adapter] },
      }),
    ).toBe(0);
    expect(invoke).toHaveBeenCalledWith({
      providerId: 'trusted-issues',
      capability: 'issue.list',
      route: 'work-trusted',
      input: {},
    });
  });

  it('rejects project-supplied provider executable and command templates', async () => {
    const value = config('github', 'github');
    (value.repository as Record<string, unknown>).executable = 'evil.exe';
    (value.issues as Record<string, unknown>).command = ['evil.exe', 'steal'];
    const cwd = await project(value),
      env = await identityEnv(cwd, { github: 'work-gh' }),
      io = captureIo(),
      invoke = vi.fn();
    expect(
      await run(['--json', '--cwd', cwd, 'issue', 'list', '--identity', 'work'], io, {
        env,
        providerService: { invoke },
      }),
    ).toBe(1);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: 'CONFIG_INVALID' } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    {
      providerId: 'github',
      repository: 'github',
      issues: 'github',
      route: 'work-gh',
      argv: [
        'gh',
        'issue',
        'list',
        '--json',
        'number,id,title,body,state,labels,url,assignees',
        '--repo',
        'forge.example/remote-owner/remote-repository',
      ],
    },
    {
      providerId: 'gitlab',
      repository: 'gitlab',
      issues: 'gitlab',
      route: 'work-gl',
      argv: [
        'glab',
        'issue',
        'list',
        '--output',
        'json',
        '--repo',
        'forge.example/remote-owner/remote-repository',
      ],
    },
    {
      providerId: 'kanbanflow',
      repository: 'github',
      issues: 'kanbanflow',
      route: 'work-kf',
      argv: ['kf', 'issue', 'list', '--json'],
    },
  ])(
    'composes the real $providerId service with an explicit project cwd and identity route',
    async ({ providerId, repository, issues, route, argv }) => {
      const cwd = await project(config(repository, issues));
      const env = await identityEnv(cwd, { [providerId]: route });
      const io = captureIo();
      const execute = vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '[]' }));

      const resolve = vi.fn(async () => 'forge.example/remote-owner/remote-repository');
      expect(
        await run(['--json', '--cwd', cwd, 'issue', 'list', '--identity', 'work'], io, {
          env,
          providerProcessExecutor: { execute },
          repositorySelectorResolver: { resolve },
        }),
        io.out.join('\n'),
      ).toBe(0);
      if (providerId === 'kanbanflow') {
        expect(resolve).not.toHaveBeenCalled();
      } else {
        expect(resolve).toHaveBeenCalledWith({ root: cwd, remote: 'origin' });
      }
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ argv, route, cwd }));
    },
  );

  it.each(['REPOSITORY_REMOTE_UNAVAILABLE', 'REPOSITORY_REMOTE_INVALID'])(
    'fails structurally on configured remote resolution error %s before provider execution',
    async (code) => {
      const value = config('github', 'github');
      value.repository.remote = 'configured-upstream';
      const cwd = await project(value),
        env = await identityEnv(cwd, { github: 'work-gh' }),
        io = captureIo(),
        execute = vi.fn();
      const resolve = vi.fn(async (): Promise<string> => {
        throw new MpxError({ code, message: 'Remote resolution failed.' });
      });
      expect(
        await run(['--json', '--cwd', cwd, 'issue', 'list', '--identity', 'work'], io, {
          env,
          providerProcessExecutor: { execute },
          repositorySelectorResolver: { resolve },
        }),
      ).toBe(1);
      expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code } });
      expect(io.out[0]).not.toContain('configured-upstream');
      expect(resolve).toHaveBeenCalledWith({ root: cwd, remote: 'configured-upstream' });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      provider: 'github',
      route: 'work-gh',
      command: ['review', 'view', '--id', '7'],
      expectedRequests: [
        [
          'gh',
          'pr',
          'view',
          '7',
          '--json',
          'number,id,title,state,isDraft,headRefName,baseRefName,url',
          '--repo',
          'forge.example/acme/remote-repository',
        ],
      ],
      expected: {
        id: '7',
        title: 'GitHub Review',
        state: 'open',
        sourceBranch: 'feature',
        targetBranch: 'main',
      },
    },
    {
      provider: 'gitlab',
      route: 'work-gl',
      command: ['review', 'view', '--id', '7'],
      expectedRequests: [
        [
          'glab',
          'mr',
          'view',
          '7',
          '--output',
          'json',
          '--repo',
          'forge.example/acme/remote-repository',
        ],
      ],
      expected: {
        id: '7',
        title: 'GitLab Review',
        state: 'open',
        sourceBranch: 'feature',
        targetBranch: 'main',
      },
    },
    {
      provider: 'github',
      route: 'work-gh',
      command: ['ci', 'status', '--id', '7'],
      expectedRequests: [
        [
          'gh',
          'pr',
          'checks',
          '7',
          '--json',
          'name,state,bucket,link',
          '--repo',
          'forge.example/acme/remote-repository',
        ],
      ],
      expected: { state: 'passed', checks: [{ id: 'test', name: 'test', state: 'passed' }] },
    },
    {
      provider: 'gitlab',
      route: 'work-gl',
      command: ['ci', 'status', '--id', '70'],
      expectedRequests: [
        [
          'glab',
          'api',
          'projects/acme%2Fremote-repository/pipelines/70',
          '--hostname',
          'forge.example',
        ],
        [
          'glab',
          'api',
          'projects/acme%2Fremote-repository/pipelines/70/jobs',
          '--hostname',
          'forge.example',
        ],
      ],
      expected: { state: 'passed', checks: [{ id: '44', name: 'test', state: 'passed' }] },
    },
  ])(
    'composes and normalizes $provider $command production Review or CI',
    async ({ provider, route, command, expectedRequests, expected }) => {
      const value = config(provider, 'none');
      value.project.id = 'must-not-be-used/as-selector';
      value.repository.remote = 'upstream';
      const cwd = await project(value),
        env = await identityEnv(cwd, { [provider]: route }),
        io = captureIo();
      const execute = vi.fn(async (request: ProviderProcessRequest) => {
        const argv = request.argv;
        if (argv[0] === 'gh' && argv[2] === 'view') {
          return {
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({
              number: 7,
              id: 'PR_7',
              title: 'GitHub Review',
              state: 'OPEN',
              isDraft: false,
              headRefName: 'feature',
              baseRefName: 'main',
              url: 'https://forge.example/acme/remote-repository/pull/7',
            }),
          };
        }
        if (argv[0] === 'glab' && argv[1] === 'mr') {
          return {
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({
              iid: 7,
              title: 'GitLab Review',
              state: 'opened',
              draft: false,
              source_branch: 'feature',
              target_branch: 'main',
              web_url: 'https://forge.example/acme/remote-repository/-/merge_requests/7',
              project_id: 9,
            }),
          };
        }
        if (argv[0] === 'gh') {
          return {
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify([{ name: 'test', state: 'SUCCESS', bucket: 'pass', link: '' }]),
          };
        }
        if (argv[2]?.endsWith('/jobs')) {
          return {
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify([
              { id: 44, name: 'test', status: 'success', web_url: 'https://forge.example/jobs/44' },
            ]),
          };
        }
        return { exitCode: 0, stderr: '', stdout: JSON.stringify({ id: 70, status: 'success' }) };
      });
      const resolve = vi.fn(async () => 'forge.example/acme/remote-repository');

      expect(
        await run(['--json', '--cwd', cwd, ...command, '--identity', 'work'], io, {
          env,
          providerProcessExecutor: { execute },
          repositorySelectorResolver: { resolve },
        }),
        io.out.join('\n'),
      ).toBe(0);
      expect(resolve).toHaveBeenCalledWith({ root: cwd, remote: 'upstream' });
      expect(execute.mock.calls.map(([request]) => request)).toEqual(
        expectedRequests.map((argv) => expect.objectContaining({ argv, route, cwd })),
      );
      expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: true, data: expected });
      expect(execute.mock.calls.flatMap(([request]) => request.argv)).not.toContain(
        'must-not-be-used/as-selector',
      );
    },
  );

  it.each([
    ['issue list', ['issue', 'list'], 'kanbanflow', 'issue.list', {}],
    ['issue view', ['issue', 'view', '--id', '1'], 'kanbanflow', 'issue.view', { id: '1' }],
    [
      'issue create',
      ['issue', 'create', '--title', 'T', '--body', 'B'],
      'kanbanflow',
      'issue.create',
      { title: 'T', body: 'B' },
    ],
    [
      'issue edit',
      ['issue', 'edit', '--id', '1', '--title', 'T', '--body', 'B'],
      'kanbanflow',
      'issue.edit',
      { id: '1', title: 'T', body: 'B' },
    ],
    [
      'issue comment',
      ['issue', 'comment', '--id', '1', '--body', 'B'],
      'kanbanflow',
      'issue.comment',
      { id: '1', body: 'B' },
    ],
    [
      'issue label',
      ['issue', 'label', '--id', '1', '--label', 'bug'],
      'kanbanflow',
      'issue.label',
      { id: '1', label: 'bug' },
    ],
    [
      'issue move',
      ['issue', 'move', '--id', '1', '--destination', 'done'],
      'kanbanflow',
      'issue.move',
      { id: '1', destination: 'done' },
    ],
    ['issue finish', ['issue', 'finish', '--id', '1'], 'kanbanflow', 'issue.finish', { id: '1' }],
    ['review view', ['review', 'view', '--id', '2'], 'github', 'review.view', { id: '2' }],
    [
      'review create',
      [
        'review',
        'create',
        '--title',
        'T',
        '--body',
        'B',
        '--source-branch',
        'feature',
        '--target-branch',
        'main',
      ],
      'github',
      'review.create',
      { title: 'T', body: 'B', sourceBranch: 'feature', targetBranch: 'main', draft: false },
    ],
    [
      'review update',
      ['review', 'update', '--id', '2', '--title', 'T', '--body', 'B'],
      'github',
      'review.update',
      { id: '2', title: 'T', body: 'B' },
    ],
    [
      'review comment',
      ['review', 'comment', '--id', '2', '--body', 'B'],
      'github',
      'review.comment',
      { id: '2', body: 'B' },
    ],
    ['review ready', ['review', 'ready', '--id', '2'], 'github', 'review.ready', { id: '2' }],
    [
      'review merge',
      ['review', 'merge', '--id', '2', '--method', 'squash'],
      'github',
      'review.merge',
      { id: '2', method: 'squash' },
    ],
    ['ci status', ['ci', 'status', '--id', '2'], 'github', 'ci.status', { id: '2' }],
    ['ci watch', ['ci', 'watch', '--id', '2'], 'github', 'ci.watch', { id: '2' }],
    ['ci logs', ['ci', 'logs', '--run-id', '9'], 'github', 'ci.logs', { id: '9', runId: '9' }],
    ['ci retry', ['ci', 'retry', '--run-id', '9'], 'github', 'ci.retry', { id: '9', runId: '9' }],
  ] as const)(
    'delegates the provider-neutral %s surface',
    async (_label, command, providerId, capability, input) => {
      const cwd = await project(config()),
        env = await identityEnv(cwd, { github: 'work-gh', kanbanflow: 'work-kf' }),
        io = captureIo();
      const invoke = vi.fn(async () => ({ schemaVersion: 1 }));
      expect(
        await run(['--json', '--cwd', cwd, ...command, '--identity', 'work'], io, {
          env,
          providerService: { invoke },
        }),
      ).toBe(0);
      expect(invoke).toHaveBeenCalledWith({
        providerId,
        capability,
        route: providerId === 'github' ? 'work-gh' : 'work-kf',
        input,
      });
      expect(io.out).toHaveLength(1);
    },
  );

  it('diagnoses the trusted providers selected by strict project roles with real redacted probes', async () => {
    const cwd = await project(config()),
      env = await identityEnv(cwd, { github: 'work-gh', kanbanflow: 'work-kf' }),
      io = captureIo();
    const execute = vi.fn(async (request: ProviderProcessRequest) => ({
      exitCode: 0,
      stderr: 'token=secret',
      stdout: request.argv[0] === 'kf' ? '[]' : '',
    }));
    expect(
      await run(['--json', '--cwd', cwd, 'provider', 'doctor', '--identity', 'work'], io, {
        env,
        providerProcessExecutor: { execute },
      }),
    ).toBe(0);
    expect(JSON.parse(io.out[0]!)).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 1,
        identity: 'work',
        providers: [
          {
            role: 'issues',
            provider: 'kanbanflow',
            backend: 'kf',
            route: 'work-kf',
            status: 'ready',
          },
          {
            role: 'repository',
            provider: 'github',
            backend: 'gh',
            route: 'work-gh',
            status: 'ready',
          },
        ],
      },
    });
    expect(
      execute.mock.calls.map(([request]) => ({
        argv: request.argv,
        route: request.route,
        cwd: request.cwd,
      })),
    ).toEqual([
      { argv: ['kf', 'issue', 'list', '--json'], route: 'work-kf', cwd },
      { argv: ['gh', 'auth', 'status'], route: 'work-gh', cwd },
    ]);
    expect(io.out[0]).not.toContain('secret');
  });
});
