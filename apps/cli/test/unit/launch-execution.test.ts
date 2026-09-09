import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorAdapter, RuntimeAdapter } from '@mpx/executors';
import { defaultContext } from '../../src/context.js';
import { captureIo } from '../../src/io.js';
import { run } from '../../src/main.js';

const canonicalContentRoot = fileURLToPath(new URL('../../../../content/', import.meta.url));
const skillCatalogFixture = fileURLToPath(new URL('../fixtures/skill-catalog/', import.meta.url));
const temporaryRoots: string[] = [];

afterEach(async () => {
  const results = await Promise.allSettled(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Temporary fixture cleanup failed.');
  }
});

async function explicitLaunchFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-cli-explicit-launch-'));
  temporaryRoots.push(root);
  const cwd = path.join(root, 'project');
  const appData = path.join(root, 'roaming');
  const localAppData = path.join(root, 'local');
  const piRoot = path.join(root, 'native-pi');
  const claudeRoot = path.join(root, 'native-claude');
  const contentRoot = path.join(root, 'content');
  const catalogRoot = path.join(contentRoot, 'skills');
  await Promise.all([
    mkdir(path.join(cwd, '.git'), { recursive: true }),
    mkdir(path.join(appData, 'mpx'), { recursive: true }),
    mkdir(localAppData, { recursive: true }),
    mkdir(piRoot, { recursive: true }),
    mkdir(claudeRoot, { recursive: true }),
    cp(skillCatalogFixture, catalogRoot, { recursive: true }),
    cp(path.join(canonicalContentRoot, 'agents'), path.join(contentRoot, 'agents'), {
      recursive: true,
    }),
    cp(
      path.join(canonicalContentRoot, 'instructions', 'shared'),
      path.join(contentRoot, 'instructions', 'shared'),
      { recursive: true },
    ),
    cp(
      path.join(canonicalContentRoot, 'runtime-profiles.json'),
      path.join(contentRoot, 'runtime-profiles.json'),
    ),
  ]);
  await writeFile(
    path.join(cwd, 'mpxconfig.json'),
    JSON.stringify({
      schemaVersion: 1,
      project: { id: 'sample/app' },
      repository: { provider: 'generic', remote: 'origin' },
    }),
  );
  await writeFile(
    path.join(appData, 'mpx', 'config.json'),
    JSON.stringify({
      schemaVersion: 2,
      identities: {
        work: {
          domain: 'work',
          runtimeRoots: { claude: claudeRoot, pi: piRoot },
          gitAuthorRoute: 'git-work',
          allowedSkillPacks: ['development'],
        },
      },
      domains: { work: [cwd] },
      locations: { work: { roots: [cwd], skillPacks: ['development'] } },
      modes: {
        project: { resources: { 'selected-project': 'read-write' } },
        developer: {
          resources: { 'identity-domain': 'read-write', 'cloned-repositories': 'read-only' },
        },
      },
      presets: {
        'work-project': {
          identity: 'work',
          mode: 'project',
          executor: 'docker',
          workspace: 'clone',
          networkPolicy: 'implementation',
        },
      },
      launchDefaults: {
        projects: { 'sample/app': { work: 'work-project' } },
        locations: { work: { work: 'work-project' } },
      },
      networkPolicies: { implementation: { preset: 'balanced' } },
      executors: { host: {}, docker: {} },
    }),
  );
  return {
    cwd,
    catalogRoot,
    piRoot,
    env: { APPDATA: appData, LOCALAPPDATA: localAppData },
  };
}

describe('canonical launch dispatch', () => {
  it.each([false, true])(
    'emits missing-config warning around silent launch (json=%s)',
    async (json) => {
      const fixture = await explicitLaunchFixture();
      const events: string[] = [];
      const captured = captureIo();
      const io = {
        ...captured,
        stdout: (text: string) => {
          events.push('stdout');
          captured.stdout(text);
        },
        stderr: (text: string) => {
          events.push('warning');
          captured.stderr(text);
        },
      };
      const host: ExecutorAdapter = {
        name: 'host',
        assertReady: async () => undefined,
        execute: async () => {
          events.push('child');
          return { exitCode: 0, stdout: '', stderr: '', truncated: false };
        },
      };
      const argv = [
        ...(json ? ['--json'] : []),
        '--cwd',
        fixture.cwd,
        'launch',
        'pi',
        '--identity',
        'work',
        '--executor',
        'host',
        '--workspace',
        'direct',
        '--reason',
        'Fallback test',
        '--approve-host',
      ];
      expect(
        await run(argv, io, {
          env: fixture.env,
          catalogRoot: fixture.catalogRoot,
          discoverProjectConfig: async () => undefined,
          launchExecutorAdapters: [host],
          launchRuntimeAdapters: [
            {
              runtime: 'pi',
              prepare: async () => ({
                executable: path.join(fixture.piRoot, 'pi.exe'),
                argv: [],
                environment: {},
              }),
            },
          ],
          launchRoutes: { materialize: async () => ({ 'git:git-work': 'C:/test/git-work' }) },
          exactNativeRootVerifier: { verify: async () => undefined },
          piAuthVerifier: { verify: async () => undefined },
        }),
      ).toBe(0);
      if (json) {
        expect(events.indexOf('stdout')).toBeGreaterThan(events.indexOf('child'));
        expect(JSON.parse(captured.out.join('')).warnings).toEqual([
          expect.objectContaining({ code: 'PROJECT_CONFIG_MISSING_DEVELOPER_FALLBACK' }),
        ]);
      } else {
        expect(events.indexOf('warning')).toBeLessThan(events.indexOf('child'));
        expect(captured.err.join('')).toContain('PROJECT_CONFIG_MISSING_DEVELOPER_FALLBACK');
      }
    },
  );

  it('provides production route and audit services on the default context', () => {
    expect(defaultContext.launchRoutes).toBeDefined();
    expect(defaultContext.launchAudit).toBeDefined();
  });

  it('executes explicit Pi launch with each runtime argument preserved as one argv element', async () => {
    const fixture = await explicitLaunchFixture();
    const runtimeArgs = ['--no-session', '--print', 'Reply with only: exact argv'];
    const execute = vi.fn(async (_request: Parameters<ExecutorAdapter['execute']>[0]) => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
    }));
    const host: ExecutorAdapter = {
      name: 'host',
      assertReady: async () => undefined,
      execute,
    };
    const prepare = vi.fn<RuntimeAdapter['prepare']>(async ({ descriptor }) => ({
      executable: path.join(fixture.piRoot, 'pi.exe'),
      argv: ['wrapper-entry.js', ...(descriptor.runtimeArgs ?? [])],
      environment: {},
    }));
    const verifyRoot = vi.fn(async (_root: string) => undefined);
    const verifyAccount = vi.fn(async () => undefined);
    const io = captureIo();

    const exitCode = await run(
      [
        '--json',
        '--cwd',
        fixture.cwd,
        'launch',
        'pi',
        '--identity',
        'work',
        '--executor',
        'host',
        '--workspace',
        'direct',
        '--reason',
        'Exact argv test',
        '--approve-host',
        ...runtimeArgs.flatMap((argument) => ['--runtime-arg', argument]),
      ],
      io,
      {
        env: fixture.env,
        catalogRoot: fixture.catalogRoot,
        launchExecutorAdapters: [host],
        launchRuntimeAdapters: [{ runtime: 'pi', prepare }],
        launchRoutes: { materialize: async () => ({ 'git:git-work': 'C:/test/git-work' }) },
        exactNativeRootVerifier: { verify: verifyRoot },
        piAuthVerifier: { verify: verifyAccount },
      },
    );
    expect(exitCode, `${io.out.join('')}\n${io.err.join('')}`).toBe(0);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptor: expect.objectContaining({
          identity: { domain: 'work', name: 'work' },
          runtimeArgs,
        }),
      }),
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0]).toMatchObject({
      executable: path.join(fixture.piRoot, 'pi.exe'),
      argv: ['wrapper-entry.js', ...runtimeArgs],
    });
    expect(verifyRoot).toHaveBeenNthCalledWith(1, fixture.piRoot);
    expect(verifyRoot).toHaveBeenNthCalledWith(2, fixture.piRoot);
    expect(verifyAccount).toHaveBeenCalledTimes(2);
    expect(verifyAccount).toHaveBeenNthCalledWith(1, fixture.piRoot);
    expect(verifyAccount).toHaveBeenNthCalledWith(2, fixture.piRoot);
  });

  it('fails explicit Docker launch without executing or falling back to host', async () => {
    const fixture = await explicitLaunchFixture();
    const execute = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
    }));
    const prepare = vi.fn<RuntimeAdapter['prepare']>();
    const io = captureIo();

    const exitCode = await run(
      [
        '--json',
        '--cwd',
        fixture.cwd,
        'launch',
        'pi',
        '--identity',
        'work',
        '--executor',
        'docker',
        '--workspace',
        'clone',
      ],
      io,
      {
        env: fixture.env,
        catalogRoot: fixture.catalogRoot,
        launchExecutorAdapters: [
          {
            name: 'docker',
            assertReady: async () => undefined,
            execute,
          },
        ],
        launchRuntimeAdapters: [{ runtime: 'pi', prepare }],
      },
    );

    expect(exitCode).toBe(1);
    expect(`${io.out.join('')}\n${io.err.join('')}`).toContain('EXECUTOR_UNAVAILABLE');
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['claude', 'pi'] as const)('admits launch %s through routing', async (runtime) => {
    const io = captureIo();

    expect(await run(['launch', runtime, '--runtime-arg', '--version'], io, { env: {} })).toBe(1);
    expect(io.err.join('')).not.toContain('RUNTIME_ARGS_SCOPE_INVALID');
  });

  it('rejects runtime arguments outside canonical launch execution', async () => {
    const io = captureIo();

    expect(await run(['doctor', '--runtime-arg', '--version'], io, { env: {} })).toBe(1);
    expect(io.err.join('')).toContain('RUNTIME_ARGS_SCOPE_INVALID');
  });

  it('rejects host approval outside canonical launch execution', async () => {
    const io = captureIo();

    expect(await run(['doctor', '--approve-host'], io, { env: {} })).toBe(1);
    expect(io.err.join('')).toContain('HOST_APPROVAL_SCOPE_INVALID');
  });
});
