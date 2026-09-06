import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProjectConfig } from '@mpx/config';
import type { ProviderProcessRequest } from '@mpx/providers';
import { afterEach, expect, it, vi } from 'vitest';
import {
  NodeProviderProcessExecutor,
  NodeRepositorySelectorResolver,
  classifyProviderProcessResult,
  createNodeProviderService as providerService,
  endProviderProcessStdin,
  parseForgeRepositoryUrl,
  parseGerritRepositoryUrl,
  providerExecutableArguments,
  resolveBuiltInProviderExecutable,
} from '../../src/node/index.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', args, { cwd });
}

it('binds production GitHub and GitLab adapters to the resolved project root', async () => {
  const requests: ProviderProcessRequest[] = [];
  const execute = vi.fn(async (request: ProviderProcessRequest) => {
    requests.push(request);
    return { exitCode: 0, stdout: '[]', stderr: '' };
  });
  const cwd = path.resolve('C:/resolved/project');
  const resolve = vi.fn(async () => 'github.example/remote-owner/remote-repository');
  const dependencies = {
    env: {},
    providerProcessExecutor: { execute },
    repositorySelectorResolver: { resolve },
  };
  const config = {
    schemaVersion: 1,
    project: { id: 'must-not-be-used/as-selector' },
    repository: { provider: 'github', remote: 'upstream' },
    issues: { provider: 'github' },
  } as ProjectConfig;
  const githubService = await providerService(dependencies, config, cwd, {
    providerId: 'github',
    capability: 'issue.list',
  });
  const gitlabService = await providerService(dependencies, config, cwd, {
    providerId: 'gitlab',
    capability: 'issue.list',
  });

  await githubService.invoke({
    providerId: 'github',
    capability: 'issue.list',
    route: 'work-gh',
    input: {},
  });
  await gitlabService.invoke({
    providerId: 'gitlab',
    capability: 'issue.list',
    route: 'work-gl',
    input: {},
  });

  expect(resolve).toHaveBeenNthCalledWith(1, { root: cwd, remote: 'upstream' });
  expect(resolve).toHaveBeenNthCalledWith(2, { root: cwd, remote: 'upstream' });
  expect(requests).toEqual([
    {
      argv: [
        'gh',
        'issue',
        'list',
        '--json',
        'number,id,title,body,state,labels,url,assignees',
        '--repo',
        'github.example/remote-owner/remote-repository',
      ],
      route: 'work-gh',
      cwd,
      authExitCodes: [4],
    },
    {
      argv: [
        'glab',
        'issue',
        'list',
        '--output',
        'json',
        '--repo',
        'github.example/remote-owner/remote-repository',
      ],
      route: 'work-gl',
      cwd,
    },
  ]);
});

it('selects the fixed Gerrit adapter with the configured remote name', async () => {
  const requests: ProviderProcessRequest[] = [];
  const execute = vi.fn(async (request: ProviderProcessRequest) => {
    requests.push(request);
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ project: 'team/platform/service', branch: 'main', number: 42, id: 'I1111111111111111111111111111111111111111', subject: 'Change', status: 'NEW', wip: false, currentPatchSet: { number: 1, revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ref: 'refs/changes/42/42/1' } })}\n${JSON.stringify({ type: 'stats', rowCount: 1 })}\n`,
      stderr: '',
    };
  });
  const resolve = vi.fn(async () => 'review.example/team/platform/service');
  const service = await providerService(
    { env: {}, providerProcessExecutor: { execute }, repositorySelectorResolver: { resolve } },
    {
      schemaVersion: 1,
      project: { id: 'sample' },
      repository: { provider: 'gerrit', remote: 'review-upstream' },
    } as ProjectConfig,
    'C:/repo',
    { providerId: 'gerrit', capability: 'review.view' },
  );
  await service.invoke({
    providerId: 'gerrit',
    capability: 'review.view',
    route: 'work',
    input: { id: '42' },
  });
  expect(resolve).toHaveBeenCalledWith({
    root: 'C:/repo',
    remote: 'review-upstream',
    providerId: 'gerrit',
  });
  expect(requests[0]?.argv).toEqual([
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
  ]);
});

it('rejects an operation-cwd provider executable found on PATH', async () => {
  const operationCwd = await mkdtemp(path.join(tmpdir(), 'mpx-provider-hijack-'));
  roots.push(operationCwd);
  const candidate = path.join(operationCwd, process.platform === 'win32' ? 'gh.EXE' : 'gh');
  await writeFile(candidate, 'hijack');

  await expect(
    resolveBuiltInProviderExecutable('gh', operationCwd, { PATH: operationCwd, PATHEXT: '.EXE' }),
  ).rejects.toMatchObject({ code: 'EACCES' });
});

it.each(['git', 'ssh'] as const)(
  'resolves trusted %s outside the project and rejects a project-local shim',
  async (name) => {
    const root = await mkdtemp(path.join(tmpdir(), `mpx-provider-${name}-`));
    roots.push(root);
    const operationCwd = path.join(root, 'project');
    const trustedDirectory = path.join(root, 'trusted-bin');
    await Promise.all([mkdir(operationCwd), mkdir(trustedDirectory)]);
    const filename = `${name}${process.platform === 'win32' ? '.EXE' : ''}`;
    const trusted = path.join(trustedDirectory, filename);
    const shim = path.join(operationCwd, filename);
    await Promise.all([writeFile(trusted, 'trusted'), writeFile(shim, 'shim')]);
    await expect(
      resolveBuiltInProviderExecutable(name, operationCwd, {
        PATH: trustedDirectory,
        PATHEXT: '.EXE',
      }),
    ).resolves.toBe(await realpath(trusted));
    await expect(
      resolveBuiltInProviderExecutable(name, operationCwd, { PATH: operationCwd, PATHEXT: '.EXE' }),
    ).rejects.toMatchObject({ code: 'EACCES' });
  },
);

it('uses only the exact runtime SSH route config and leaves native SSH argv unchanged outside runtime', () => {
  const route = path.resolve('C:/runtime/routes/ssh/work');
  expect(
    providerExecutableArguments('ssh', ['review.example', 'gerrit', 'version'], {
      MPX_RUNTIME_CONTEXT: '{}',
      MPX_RUNTIME_ROUTE_SSH: route,
    }),
  ).toEqual(['-F', path.join(route, 'config'), 'review.example', 'gerrit', 'version']);
  expect(providerExecutableArguments('ssh', ['review.example'], { APPDATA: 'C:/ambient' })).toEqual(
    ['review.example'],
  );
  expect(() =>
    providerExecutableArguments('ssh', ['review.example'], {
      MPX_RUNTIME_CONTEXT: '{}',
      MPX_RUNTIME_ROUTE_SSH: '../other-route',
    }),
  ).toThrowError(expect.objectContaining({ code: 'EINVAL' }));
});

it('resolves a trusted built-in from an absolute PATH directory to its canonical path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-provider-resolution-'));
  roots.push(root);
  const operationCwd = path.join(root, 'project');
  const trustedDirectory = path.join(root, 'trusted-bin');
  await Promise.all([mkdir(operationCwd), mkdir(trustedDirectory)]);
  const candidate = path.join(trustedDirectory, process.platform === 'win32' ? 'glab.CMD' : 'glab');
  await writeFile(candidate, 'trusted');

  await expect(
    resolveBuiltInProviderExecutable('glab', operationCwd, {
      PATH: trustedDirectory,
      PATHEXT: '.CMD',
    }),
  ).resolves.toBe(await realpath(candidate));
  await expect(
    resolveBuiltInProviderExecutable('custom', operationCwd, {
      PATH: trustedDirectory,
      PATHEXT: '.CMD',
    }),
  ).rejects.toMatchObject({ code: 'EINVAL' });
});

it('binds native provider authentication to isolated safe route environments without mutating process.env', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-provider-route-'));
  roots.push(root);
  const operationCwd = path.join(root, 'project');
  const trustedDirectory = path.join(root, 'trusted-bin');
  const appData = path.join(root, 'appdata');
  await Promise.all([mkdir(operationCwd), mkdir(trustedDirectory), mkdir(appData)]);
  const extension = process.platform === 'win32' ? '.EXE' : '';
  for (const executable of ['gh', 'glab', 'kf']) {
    await copyFile(process.execPath, path.join(trustedDirectory, `${executable}${extension}`));
  }
  const environment = {
    PATH: trustedDirectory,
    PATHEXT: '.EXE',
    APPDATA: appData,
    gh_config_dir: 'C:/ambient-gh',
    Glab_Config_Dir: 'C:/ambient-glab',
    mpx_provider_route: 'ambient',
  };
  const originalProcessRoute = process.env.MPX_PROVIDER_ROUTE;
  const executor = new NodeProviderProcessExecutor(environment);
  const expression =
    'process.stdout.write(JSON.stringify({route:process.env.MPX_PROVIDER_ROUTE,gh:process.env.GH_CONFIG_DIR,glab:process.env.GLAB_CONFIG_DIR}))';
  const githubWork = JSON.parse(
    (
      await executor.execute({
        argv: ['gh', '-e', expression],
        route: 'github-work',
        cwd: operationCwd,
      })
    ).stdout,
  ) as Record<string, string>;
  const githubPersonal = JSON.parse(
    (
      await executor.execute({
        argv: ['gh', '-e', expression],
        route: 'github-personal',
        cwd: operationCwd,
      })
    ).stdout,
  ) as Record<string, string>;
  const gitlabWork = JSON.parse(
    (
      await executor.execute({
        argv: ['glab', '-e', expression],
        route: 'gitlab-work',
        cwd: operationCwd,
      })
    ).stdout,
  ) as Record<string, string>;
  const kanbanWork = JSON.parse(
    (
      await executor.execute({
        argv: ['kf', '-e', expression],
        route: 'kanban-work',
        cwd: operationCwd,
      })
    ).stdout,
  ) as Record<string, string>;

  expect(githubWork).toEqual({
    route: 'github-work',
    gh: path.join(appData, 'mpx', 'provider-routes', 'github', 'github-work'),
  });
  expect(githubPersonal.gh).toBe(
    path.join(appData, 'mpx', 'provider-routes', 'github', 'github-personal'),
  );
  expect(githubPersonal.gh).not.toBe(githubWork.gh);
  expect(gitlabWork).toEqual({
    route: 'gitlab-work',
    glab: path.join(appData, 'mpx', 'provider-routes', 'gitlab', 'gitlab-work'),
  });
  expect(kanbanWork).toEqual({ route: 'kanban-work' });
  expect(process.env.MPX_PROVIDER_ROUTE).toBe(originalProcessRoute);
});

it('writes bounded structured stdin to the trusted child without a shell', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-provider-stdin-'));
  roots.push(root);
  const operationCwd = path.join(root, 'project');
  const trustedDirectory = path.join(root, 'trusted-bin');
  const appData = path.join(root, 'appdata');
  await Promise.all([mkdir(operationCwd), mkdir(trustedDirectory), mkdir(appData)]);
  const executable = path.join(trustedDirectory, process.platform === 'win32' ? 'gh.EXE' : 'gh');
  await copyFile(process.execPath, executable);
  const executor = new NodeProviderProcessExecutor({
    PATH: trustedDirectory,
    PATHEXT: '.EXE',
    APPDATA: appData,
  });
  const result = await executor.execute({
    argv: ['gh', '-e', "process.stdin.on('data',d=>process.stdout.write(d))"],
    stdin: '{"ready":true}\n',
    route: 'work',
    cwd: operationCwd,
  });
  expect(result).toMatchObject({ exitCode: 0, stdout: '{"ready":true}\n' });
  await expect(
    executor.execute({
      argv: ['gh', '--version'],
      stdin: 'x'.repeat(64 * 1024 + 1),
      route: 'work',
      cwd: operationCwd,
    }),
  ).rejects.toMatchObject({ code: 'EINVAL' });
});

it('uses the exact launch-injected provider route instead of ambient or requested identity paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-provider-runtime-route-'));
  roots.push(root);
  const operationCwd = path.join(root, 'project'),
    trustedDirectory = path.join(root, 'trusted-bin'),
    injected = path.join(root, 'runtime', 'github-work');
  await Promise.all([
    mkdir(operationCwd),
    mkdir(trustedDirectory),
    mkdir(injected, { recursive: true }),
  ]);
  const executable = path.join(trustedDirectory, process.platform === 'win32' ? 'gh.EXE' : 'gh');
  await copyFile(process.execPath, executable);
  const environment = {
    PATH: trustedDirectory,
    PATHEXT: '.EXE',
    APPDATA: path.join(root, 'ambient'),
    GH_CONFIG_DIR: path.join(root, 'other-identity'),
    MPX_RUNTIME_CONTEXT: '{}',
    MPX_RUNTIME_ROUTE_PROVIDER_GITHUB: injected,
  };
  const expression = "process.stdout.write(process.env.GH_CONFIG_DIR??'')";
  const result = await new NodeProviderProcessExecutor(environment).execute({
    argv: ['gh', '-e', expression],
    route: 'github-personal',
    cwd: operationCwd,
  });
  expect(result.stdout).toBe(injected);
});

it.each([undefined, '../secret', 'C:/private', 'token-route', 'route.pem'])(
  'fails closed before executable resolution for unsafe provider route %s',
  async (route) => {
    const operationCwd = await mkdtemp(path.join(tmpdir(), 'mpx-provider-route-reject-'));
    roots.push(operationCwd);
    const resolve = vi.fn(async () => process.execPath);
    const executor = new NodeProviderProcessExecutor(
      { APPDATA: path.join(operationCwd, 'appdata') },
      resolve,
    );
    await expect(
      executor.execute({
        argv: ['gh', '--version'],
        ...(route === undefined ? {} : { route }),
        cwd: operationCwd,
      }),
    ).rejects.toMatchObject({ code: 'EINVAL' });
    expect(resolve).not.toHaveBeenCalled();
  },
);

it('fails closed when APPDATA is unavailable', async () => {
  const operationCwd = await mkdtemp(path.join(tmpdir(), 'mpx-provider-appdata-reject-'));
  roots.push(operationCwd);
  const resolve = vi.fn(async () => process.execPath);
  await expect(
    new NodeProviderProcessExecutor({}, resolve).execute({
      argv: ['kf', '--version'],
      route: 'kanban-work',
      cwd: operationCwd,
    }),
  ).rejects.toMatchObject({ code: 'EINVAL' });
  expect(resolve).not.toHaveBeenCalled();
});

it('memoizes only successful executable resolution for canonical cwd and path inputs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-provider-cache-'));
  roots.push(root);
  const operationCwd = path.join(root, 'project');
  const trustedDirectory = path.join(root, 'trusted-bin');
  const appData = path.join(root, 'appdata');
  await Promise.all([mkdir(operationCwd), mkdir(trustedDirectory), mkdir(appData)]);
  const executable = path.join(trustedDirectory, process.platform === 'win32' ? 'gh.EXE' : 'gh');
  await copyFile(process.execPath, executable);
  const resolve = vi.fn(async () => {
    if (resolve.mock.calls.length === 1) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
    return executable;
  });
  const executor = new NodeProviderProcessExecutor(
    { PATH: trustedDirectory, PATHEXT: '.EXE', APPDATA: appData },
    resolve,
  );
  const request = {
    argv: ['gh', '-e', "process.stdout.write('ok')"] as [string, ...string[]],
    route: 'github-work',
    cwd: operationCwd,
  };
  await expect(executor.execute(request)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(executor.execute(request)).resolves.toMatchObject({ exitCode: 0, stdout: 'ok' });
  await expect(executor.execute(request)).resolves.toMatchObject({ exitCode: 0, stdout: 'ok' });
  expect(resolve).toHaveBeenCalledTimes(2);
});

it('honors provider operation timeouts and rejects signalled execution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-provider-timeout-'));
  roots.push(root);
  const operationCwd = path.join(root, 'project');
  const trustedDirectory = path.join(root, 'trusted-bin');
  const appData = path.join(root, 'appdata');
  await Promise.all([mkdir(operationCwd), mkdir(trustedDirectory), mkdir(appData)]);
  const executable = path.join(trustedDirectory, process.platform === 'win32' ? 'gh.EXE' : 'gh');
  await copyFile(process.execPath, executable);
  const executor = new NodeProviderProcessExecutor({
    PATH: trustedDirectory,
    PATHEXT: '.EXE',
    APPDATA: appData,
  });
  await expect(
    executor.execute({
      argv: ['gh', '-e', 'setTimeout(() => {}, 5000)'],
      route: 'github-work',
      cwd: operationCwd,
      timeoutMilliseconds: 20,
    }),
  ).rejects.toMatchObject({ killed: true });
});

it('preserves safe Gerrit SSH users and ports while supporting standard remote forms', () => {
  expect(
    parseGerritRepositoryUrl('ssh://user@review.example:29418/team/platform/service.git'),
  ).toBe('user@review.example:29418/team/platform/service');
  expect(parseGerritRepositoryUrl('ssh://review.example:29418/project')).toBe(
    'review.example:29418/project',
  );
  expect(parseGerritRepositoryUrl('user@review.example:team/platform/service')).toBe(
    'user@review.example/team/platform/service',
  );
  expect(parseGerritRepositoryUrl('https://review.example/team/platform/service.git')).toBe(
    'review.example/team/platform/service',
  );
  expect(parseGerritRepositoryUrl('https://review.example:8443/team/platform/service.git')).toBe(
    'review.example/team/platform/service',
  );
});

it('rejects unsafe Gerrit SSH usernames and ports without weakening forge selectors', () => {
  for (const remote of [
    'ssh://bad%20user@review.example:29418/project',
    'ssh://user@review.example:0/project',
    'ssh://user@review.example:65536/project',
    'ssh://user@review.example:abc/project',
    'user name@review.example:project',
  ]) {
    expect(() => parseGerritRepositoryUrl(remote)).toThrowError(
      expect.objectContaining({ code: 'REPOSITORY_REMOTE_INVALID' }),
    );
  }
  expect(() =>
    parseForgeRepositoryUrl('https://github.example/team/platform/service.git'),
  ).toThrowError(expect.objectContaining({ code: 'REPOSITORY_REMOTE_INVALID' }));
  expect(() =>
    parseForgeRepositoryUrl('ssh://git@github.example:29418/acme/project.git'),
  ).toThrowError(expect.objectContaining({ code: 'REPOSITORY_REMOTE_INVALID' }));
});

it.each([
  ['https://github.example/acme/project.git', 'github.example/acme/project'],
  ['ssh://git@gitlab.example/acme/project.git', 'gitlab.example/acme/project'],
  ['git@github.example:acme/project.git', 'github.example/acme/project'],
] as const)('parses a strict forge repository remote %s', (remote, selector) => {
  expect(parseForgeRepositoryUrl(remote)).toBe(selector);
});

it.each([
  'https://user:secret@github.example/acme/project.git',
  'ssh://other@github.example/acme/project.git',
  'https://github.example/acme/project.git?token=secret',
  'https://github.example/acme/project.git#fragment',
  'https://github.example/acme/../project.git',
  'https://github.example/group/subgroup/project.git',
  'git@github.example:acme/%2e%2e.git',
  'file:///C:/private/repository',
])('rejects unsafe forge repository remote %s', (remote) => {
  expect(() => parseForgeRepositoryUrl(remote)).toThrowError(
    expect.objectContaining({ code: 'REPOSITORY_REMOTE_INVALID' }),
  );
});

it('resolves only the configured Git remote into the production repository selector', async () => {
  const repository = await mkdtemp(path.join(tmpdir(), 'mpx-provider-remote-'));
  roots.push(repository);
  await git(repository, 'init', '-b', 'main');
  await git(repository, 'remote', 'add', 'origin', 'https://github.example/ambient/default.git');
  await git(
    repository,
    'remote',
    'add',
    'configured-upstream',
    'git@gitlab.example:acme/selected.git',
  );
  const resolver = new NodeRepositorySelectorResolver(process.env);
  await expect(resolver.resolve({ root: repository, remote: 'configured-upstream' })).resolves.toBe(
    'gitlab.example/acme/selected',
  );
  await expect(resolver.resolve({ root: repository, remote: 'missing' })).rejects.toMatchObject({
    code: 'REPOSITORY_REMOTE_UNAVAILABLE',
  });
});

it('attaches the stdin error handler before end and rejects EPIPE exactly once', async () => {
  const calls: string[] = [];
  const epipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
  let onError: ((error: Error) => void) | undefined;
  const operation = new Promise<void>((_resolve, reject) => {
    endProviderProcessStdin(
      {
        once(event, listener) {
          calls.push(event);
          onError = listener;
        },
        end(input) {
          calls.push(`end:${input}`);
          onError?.(epipe);
          onError?.(new Error('late duplicate'));
        },
      },
      'payload',
      reject,
    );
  });
  await expect(operation).rejects.toBe(epipe);
  expect(calls).toEqual(['error', 'end:payload']);
});

it('classifies SSH public-key denial as authentication failure without confusing connectivity errors', () => {
  const denied = Object.assign(new Error('ssh'), { code: 255 });
  expect(
    classifyProviderProcessResult(
      denied,
      '',
      'user@host: Permission denied (publickey).',
      [],
      'ssh',
    ),
  ).toEqual({
    exitCode: 255,
    stdout: '',
    stderr: 'user@host: Permission denied (publickey).',
    failure: 'auth',
  });
  expect(
    classifyProviderProcessResult(
      denied,
      '',
      'ssh: connect to host review.example port 22: Connection timed out',
      [],
      'ssh',
    ),
  ).toEqual({
    exitCode: 255,
    stdout: '',
    stderr: 'ssh: connect to host review.example port 22: Connection timed out',
  });
});

it.each([
  "fatal: Authentication failed for 'https://review.example/team/platform/service.git'",
  "fatal: Authentication failed for 'ssh://git@review.example/team/platform/service.git': Permission denied (publickey).",
  "fatal: could not read Username for 'https://review.example/team/platform/service.git': terminal prompts disabled",
  'remote: HTTP Basic: Access denied',
  "fatal: unable to access 'https://review.example/team/platform/service.git/': The requested URL returned error: 401",
  "fatal: unable to access 'https://review.example/team/platform/service.git/': The requested URL returned error: 403",
])('classifies git transport authentication diagnostics as auth', (stderr) => {
  expect(
    classifyProviderProcessResult(
      Object.assign(new Error('git'), { code: 128 }),
      '',
      stderr,
      [],
      'git',
    ),
  ).toEqual({
    exitCode: 128,
    stdout: '',
    stderr,
    failure: 'auth',
  });
});

it('keeps non-auth git transport failures unclassified', () => {
  expect(
    classifyProviderProcessResult(
      Object.assign(new Error('git'), { code: 128 }),
      '',
      "fatal: unable to access 'https://review.example/team/platform/service.git/': Failed to connect to review.example port 443 after 0 ms: Connection refused",
      [],
      'git',
    ),
  ).toEqual({
    exitCode: 128,
    stdout: '',
    stderr:
      "fatal: unable to access 'https://review.example/team/platform/service.git/': Failed to connect to review.example port 443 after 0 ms: Connection refused",
  });
});

it('classifies authentication exits only from backend request metadata', () => {
  expect(classifyProviderProcessResult(null, 'output', '')).toEqual({
    exitCode: 0,
    stdout: 'output',
    stderr: '',
  });
  expect(
    classifyProviderProcessResult(Object.assign(new Error('auth'), { code: 4 }), '', 'denied', [4]),
  ).toEqual({ exitCode: 4, stdout: '', stderr: 'denied', failure: 'auth' });
  expect(
    classifyProviderProcessResult(
      Object.assign(new Error('not generic auth'), { code: 4 }),
      '',
      'failed',
    ),
  ).toEqual({ exitCode: 4, stdout: '', stderr: 'failed' });
  expect(
    classifyProviderProcessResult(
      Object.assign(new Error('command'), { code: 9 }),
      '',
      'failed',
      [4],
    ),
  ).toEqual({ exitCode: 9, stdout: '', stderr: 'failed' });
  for (const error of [
    Object.assign(new Error('permission'), { code: 'EACCES' }),
    Object.assign(new Error('signal'), { code: null, signal: 'SIGTERM' }),
    Object.assign(new Error('buffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
  ]) {
    expect(() => classifyProviderProcessResult(error, '', '')).toThrow(error);
  }
});
