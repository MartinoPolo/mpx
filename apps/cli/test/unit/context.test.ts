import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createNodeWorktreeIncludeDependencies,
  deriveLifecycleKey,
  deriveWorktreePath,
  planWorktreeIncludes,
} from '@mpx/worktrees';
import type { PreparationPlan } from '@mpx/config';
import { afterEach, expect, it, vi } from 'vitest';
import {
  catalogPath,
  defaultContext,
  immutableInstaller,
  installer,
  installerSourceRoot,
  preparationRuntime,
  productionSessionDiscoveries,
  worktrees,
} from '../../src/context.js';
import { SessionService, SessionStore } from '@mpx/sessions';

const exec = promisify(execFile);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('resolves installer assets from source and bundled immutable releases', () => {
  expect(installerSourceRoot('C:/repo/apps/cli/dist/context.js')).toBe(path.resolve('C:/repo'));
  expect(installerSourceRoot('C:/Apps/mpx/releases/key/bin/mpx.mjs')).toBe(
    path.resolve('C:/Apps/mpx/releases/key'),
  );
});

it('constructs the production installer without injected test adapters', () => {
  const root = path.resolve('C:/temp/mpx-installer-context');
  const orchestrator = immutableInstaller({
    env: {
      MPX_APPS: path.join(root, 'apps'),
      APPDATA: path.join(root, 'roaming'),
      LOCALAPPDATA: path.join(root, 'local'),
      USERPROFILE: path.join(root, 'profile'),
      USERNAME: 'tester',
    },
  });
  expect(orchestrator).toBeDefined();
});

it('wires production session capture to structured installed-runner authority before install', async () => {
  const root = path.resolve('C:/temp/mpx-runner-authority-context'),
    apps = path.join(root, 'apps');
  const service = installer(
    { env: { MPX_APPS: apps, LOCALAPPDATA: path.join(root, 'local'), USERNAME: 'tester' } },
    path.join(root, 'source'),
  );
  await expect(
    service.plan({
      componentId: 'session-capture',
      runner: {
        path: path.join(apps, 'mpx', 'releases', 'a'.repeat(64), 'bin', 'mpx.mjs'),
        sha256: 'b'.repeat(64),
        version: 'a'.repeat(64),
      },
    }),
  ).rejects.toMatchObject({
    code: 'INSTALL_RUNNER_UNAVAILABLE',
    details: { status: 'uninstalled' },
  });
});

it('provides fail-closed Docker resume admission in the production CLI context', async () => {
  expect(defaultContext.sessionDockerResumeAdmission).toBeTypeOf('function');
  await expect(
    defaultContext.sessionDockerResumeAdmission!({
      launch: { executor: { kind: 'docker' } },
    } as never),
  ).resolves.toMatchObject({ admitted: false, hostFallback: false });
});

it('discovers enrolled active Pi sessions from only their recorded root and survives restart without reviving stale processes', async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'mpx-production-discovery-'));
  roots.push(state);
  const claudeRoot = path.join(state, 'claude-account'),
    piRoot = path.join(state, 'pi-account'),
    registry = path.join(piRoot, 'agent-resurrect', 'active-sessions'),
    foreignRoot = path.join(state, 'foreign');
  await Promise.all([
    mkdir(claudeRoot),
    mkdir(path.join(piRoot, 'sessions'), { recursive: true }),
    mkdir(registry, { recursive: true }),
    mkdir(foreignRoot),
  ]);
  const sessionFile = path.join(piRoot, 'sessions', 'active.jsonl');
  await writeFile(sessionFile, '{}\n');
  const instant = '2025-06-01T12:00:00.000Z';
  await writeFile(
    path.join(registry, 'active.json'),
    JSON.stringify({
      version: 2,
      agent: 'pi',
      sessionId: 'active',
      sessionFile,
      cwd: 'C:/repo',
      name: 'Private title',
      pid: 42,
      processStartedAt: instant,
      registeredAt: instant,
    }),
  );
  const store = new SessionStore(state),
    user = {
      identities: {
        personal: { domain: 'local', runtimeRoots: { claude: claudeRoot, pi: piRoot } },
      },
    } as never;
  const options = {
    piProcessInspector: {
      inspect: async (pid: number) =>
        pid === 42 || pid === 43 ? { startFingerprint: instant } : null,
    },
    clock: () => Date.parse(instant),
  };
  const first = await productionSessionDiscoveries(
    user,
    store,
    { MPX_CLAUDE_EXECUTABLE: '' },
    { resolve: async () => 'account:enrolled' },
    options,
  );
  expect(first.map((item) => item.scanner.runtime)).toEqual(['claude', 'pi']);
  const observations = await new SessionService(store, () => instant).reconcile(first);
  expect(observations).toMatchObject([
    {
      runtime: 'pi',
      runtimeQualifiedId: 'pi:active',
      title: 'Private title',
      source: 'sessions:pi',
    },
  ]);
  expect(JSON.stringify(observations)).not.toContain(piRoot);
  expect(JSON.stringify(observations)).not.toContain(sessionFile);

  const foreignFile = path.join(foreignRoot, 'foreign.jsonl'),
    foreignEntry = path.join(registry, 'foreign.json');
  await writeFile(foreignFile, '{}\n');
  await writeFile(
    foreignEntry,
    JSON.stringify({
      version: 2,
      agent: 'pi',
      sessionId: 'foreign',
      sessionFile: foreignFile,
      cwd: 'C:/foreign',
      pid: 43,
      processStartedAt: instant,
      registeredAt: instant,
    }),
  );
  await expect(
    first.find((item) => item.scanner.runtime === 'pi')!.scanner.scan(),
  ).rejects.toMatchObject({ code: 'PI_SESSION_ROOT_ESCAPE' });
  await rm(foreignEntry);

  const restarted = await productionSessionDiscoveries(
    user,
    store,
    {},
    { resolve: async () => 'account:enrolled' },
    { ...options, piProcessInspector: { inspect: async () => null } },
  );
  expect(await store.listNativeBindings()).toHaveLength(2);
  expect(
    (await restarted.find((item) => item.scanner.runtime === 'pi')!.scanner.scan()).sessions,
  ).toEqual([]);
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', args, { cwd });
}

async function includeLifecycleFixture(branch: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-context-include-'));
  roots.push(root);
  const mainRoot = path.join(root, 'main repo');
  const sourceRoot = path.join(root, 'source repo');
  const stateRoot = path.join(root, 'state');
  await Promise.all([mkdir(mainRoot), mkdir(sourceRoot), mkdir(stateRoot)]);
  for (const repository of [mainRoot, sourceRoot]) {
    await git(repository, 'init', '-b', 'main');
  }

  await writeFile(
    path.join(mainRoot, 'mpxconfig.json'),
    JSON.stringify({
      schemaVersion: 1,
      project: { id: 'context/include' },
      repository: { provider: 'generic', remote: 'origin' },
    }),
  );
  await writeFile(path.join(mainRoot, '.worktreeinclude'), 'local data/**\n');
  await git(mainRoot, 'add', 'mpxconfig.json', '.worktreeinclude');
  await git(
    mainRoot,
    '-c',
    'user.name=MPX Test',
    '-c',
    'user.email=mpx@example.invalid',
    'commit',
    '-m',
    'fixture',
  );

  await mkdir(path.join(sourceRoot, 'local data'));
  await writeFile(path.join(sourceRoot, 'local data', 'approved secret.txt'), 'approved bytes');
  await writeFile(path.join(sourceRoot, 'local data', 'tracked.txt'), 'tracked bytes');
  await writeFile(path.join(sourceRoot, 'unapproved.txt'), 'unapproved bytes');
  await git(sourceRoot, 'add', 'local data/tracked.txt');
  await git(
    sourceRoot,
    '-c',
    'user.name=MPX Test',
    '-c',
    'user.email=mpx@example.invalid',
    'commit',
    '-m',
    'tracked fixture',
  );

  const destinationRoot = deriveWorktreePath(mainRoot, branch);
  const effects: string[] = [];
  const approvedDestination = path.join(destinationRoot, 'local data', 'approved secret.txt');
  const unexpectedPortCall = async (): Promise<never> => {
    throw new Error('Unexpected fake port call.');
  };
  const portService = {
    ensure: async () => {
      effects.push((await exists(approvedDestination)) ? 'ports-after-copy' : 'ports-before-copy');
      return {
        lease: {
          leaseId: 'fake-lease',
          projectId: 'context/include',
          repositoryId: 'fake-repository',
          worktreeId: branch,
          worktreePath: destinationRoot,
          role: 'linked' as const,
          slot: 1,
          configHash: 'fake-config',
          services: {},
          claims: [],
          updatedAt: 1,
        },
        warnings: [],
      };
    },
    resolve: unexpectedPortCall,
    list: unexpectedPortCall,
    inspect: unexpectedPortCall,
    kill: unexpectedPortCall,
    release: unexpectedPortCall,
    rebuild: unexpectedPortCall,
    captureReleaseIdentity: unexpectedPortCall,
    releaseLinkedAfterRemoval: unexpectedPortCall,
    resolveOrphan: unexpectedPortCall,
    reconcile: async () => ({ orphaned: [], removed: [], repaired: [] }),
  };
  const service = worktrees({
    env: { LOCALAPPDATA: stateRoot },
    portService,
    preparationRuntimeFactory: () => ({
      run: async () => {
        effects.push(
          effects.at(-1) === 'ports-after-copy'
            ? 'preparation-after-ports'
            : 'preparation-before-ports',
        );
        return { status: 'ready' };
      },
      retry: async () => ({ status: 'ready' }),
      cancel: async () => ({ status: 'cancelled' }),
      reconcile: async () => ({ status: 'ready' }),
    }),
  });
  const request = { cwd: mainRoot, branch, base: 'main', sourceRoot };
  return {
    mainRoot,
    sourceRoot,
    destinationRoot,
    stateRoot,
    effects,
    service,
    portService,
    request,
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function currentIncludeApproval(
  fixture: Awaited<ReturnType<typeof includeLifecycleFixture>>,
): Promise<string> {
  const plan = await planWorktreeIncludes(
    {
      repositoryId: 'context/include',
      sourceRoot: fixture.sourceRoot,
      mainRoot: fixture.mainRoot,
      destinationRoot: fixture.destinationRoot,
    },
    createNodeWorktreeIncludeDependencies(),
  );
  return plan.approval;
}

it('selects only the packaged trusted catalog instead of a malicious cwd ancestor', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-catalog-ancestor-'));
  roots.push(root);
  const maliciousRoot = path.join(root, 'malicious');
  const nested = path.join(maliciousRoot, 'packages', 'app');
  await mkdir(path.join(maliciousRoot, 'content', 'skills'), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(maliciousRoot, 'content', 'skills', 'shadow.txt'), 'shadowed');

  const packaged = fileURLToPath(new URL('../../../../content/skills', import.meta.url));
  await expect(catalogPath({ env: {} }, nested)).resolves.toBe(packaged);
});

it('skips package-manager resolution when preparation execution is none', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-context-none-'));
  roots.push(root);
  const noLockfilesRoot = path.join(root, 'no-lockfiles');
  const multipleLockfilesRoot = path.join(root, 'multiple-lockfiles');
  await mkdir(noLockfilesRoot);
  await mkdir(multipleLockfilesRoot);
  await writeFile(
    path.join(noLockfilesRoot, 'mpxconfig.json'),
    JSON.stringify({ schemaVersion: 1 }),
  );
  await writeFile(
    path.join(multipleLockfilesRoot, 'mpxconfig.json'),
    JSON.stringify({ schemaVersion: 1 }),
  );
  await writeFile(path.join(multipleLockfilesRoot, 'package-lock.json'), '{}');
  await writeFile(path.join(multipleLockfilesRoot, 'yarn.lock'), 'lock');
  const runtime = preparationRuntime(root, {});
  for (const worktreeRoot of [noLockfilesRoot, multipleLockfilesRoot]) {
    await expect(
      runtime.run({
        key: `lifecycle-none:${path.basename(worktreeRoot)}`,
        plan: {
          execution: 'none',
          steps: [],
          order: [],
          logging: { maxOutputBytes: 65536, redactEnvironmentValues: true },
        },
        worktreeRoot,
        packageManager: 'none',
      }),
    ).resolves.toMatchObject({ status: 'ready' });
  }
});

it('returns exact approval and content-bound evidence when validateOnly follows exact approval', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-context-preparation-'));
  roots.push(root);
  const repository = path.join(root, 'repository');
  await mkdir(repository);
  await git(repository, 'init', '-b', 'main');
  await writeFile(
    path.join(repository, 'mpxconfig.json'),
    JSON.stringify({
      schemaVersion: 1,
      project: { id: 'context/preparation' },
      repository: { provider: 'generic', remote: 'origin' },
    }),
  );
  await git(repository, 'add', 'mpxconfig.json');
  await git(
    repository,
    '-c',
    'user.name=MPX Test',
    '-c',
    'user.email=mpx@example.invalid',
    'commit',
    '-m',
    'fixture',
  );
  const plan: PreparationPlan = {
    execution: 'foreground',
    steps: [{ id: 'verify', uses: 'executable', argv: ['node', '--version'], required: true }],
    order: ['verify'],
    logging: { maxOutputBytes: 65536, redactEnvironmentValues: true },
  };
  const runtime = preparationRuntime(root, {});
  const request = {
    key: 'preparation-boundary',
    plan,
    worktreeRoot: repository,
    packageManager: 'none' as const,
    validateOnly: true,
  };
  const pending = (await runtime.run(request)) as {
    expectedApproval: string;
    approval: unknown;
    status: string;
  };
  expect(pending.status).toBe('approval-required');
  await expect(
    runtime.run({ ...request, exactApproval: pending.expectedApproval }),
  ).resolves.toEqual({
    status: 'approved',
    expectedApproval: pending.expectedApproval,
    approval: pending.approval,
  });
}, 15_000);

it('rejects manual preparation when repository configuration changed without retrying', async () => {
  const fixture = await includeLifecycleFixture('config-mismatch');
  await expect(fixture.service.create(fixture.request)).rejects.toMatchObject({
    code: 'WORKTREE_INCLUDE_APPROVAL_REQUIRED',
  });
  const retry = vi.fn(async () => ({ status: 'ready' }));
  const service = worktrees({
    env: { LOCALAPPDATA: fixture.stateRoot },
    portService: fixture.portService,
    preparationRuntimeFactory: () => ({
      run: async () => ({ status: 'ready' }),
      retry,
      cancel: async () => ({ status: 'cancelled' }),
      reconcile: async () => ({ status: 'ready' }),
    }),
  } as never);
  await writeFile(
    path.join(fixture.mainRoot, 'mpxconfig.json'),
    JSON.stringify({
      schemaVersion: 1,
      project: { id: 'context/include' },
      repository: { provider: 'generic', remote: 'origin' },
      tooling: { packageManager: 'pnpm' },
    }),
  );
  const key = deriveLifecycleKey(path.join(fixture.mainRoot, '.git'), fixture.request.branch);
  await expect(service.prepare({ key, cwd: fixture.mainRoot })).rejects.toMatchObject({
    code: 'WORKTREE_CONFIG_HASH_MISMATCH',
  });
  expect(retry).not.toHaveBeenCalled();
}, 15_000);

it('copies nothing and stops before ports or preparation when include approval is missing', async () => {
  const fixture = await includeLifecycleFixture('missing-approval');

  await expect(fixture.service.create(fixture.request)).rejects.toMatchObject({
    code: 'WORKTREE_INCLUDE_APPROVAL_REQUIRED',
  });

  await expect(
    exists(path.join(fixture.destinationRoot, 'local data', 'approved secret.txt')),
  ).resolves.toBe(false);
  expect(fixture.effects).toEqual([]);
}, 15_000);

it('copies nothing when source evidence and the include manifest make an approval stale', async () => {
  const fixture = await includeLifecycleFixture('stale-approval');
  await expect(fixture.service.create(fixture.request)).rejects.toMatchObject({
    code: 'WORKTREE_INCLUDE_APPROVAL_REQUIRED',
  });
  const approval = await currentIncludeApproval(fixture);
  await writeFile(
    path.join(fixture.sourceRoot, 'local data', 'approved secret.txt'),
    'changed bytes',
  );
  await writeFile(path.join(fixture.mainRoot, '.worktreeinclude'), 'local data/**\nother/**\n');

  await expect(
    fixture.service.create({ ...fixture.request, includeApproval: approval }),
  ).rejects.toMatchObject({ code: 'WORKTREE_INCLUDE_APPROVAL_REQUIRED' });

  await expect(
    exists(path.join(fixture.destinationRoot, 'local data', 'approved secret.txt')),
  ).resolves.toBe(false);
  expect(fixture.effects).toEqual([]);
}, 15_000);

it('copies only the exactly approved untracked file with spaces before ports and preparation', async () => {
  const fixture = await includeLifecycleFixture('valid-approval');
  await expect(fixture.service.create(fixture.request)).rejects.toMatchObject({
    code: 'WORKTREE_INCLUDE_APPROVAL_REQUIRED',
  });
  const approval = await currentIncludeApproval(fixture);

  await expect(
    fixture.service.create({ ...fixture.request, includeApproval: approval }),
  ).resolves.toMatchObject({ status: 'ready', leaseId: 'fake-lease' });

  await expect(
    readFile(path.join(fixture.destinationRoot, 'local data', 'approved secret.txt'), 'utf8'),
  ).resolves.toBe('approved bytes');
  await expect(
    exists(path.join(fixture.destinationRoot, 'local data', 'tracked.txt')),
  ).resolves.toBe(false);
  await expect(exists(path.join(fixture.destinationRoot, 'unapproved.txt'))).resolves.toBe(false);
  expect(fixture.effects).toEqual(['ports-after-copy', 'preparation-after-ports']);
}, 15_000);

it('persists only a sanitized cancellation failure message in durable state', async () => {
  const fixture = await includeLifecycleFixture('cancel-sanitized');
  const key = deriveLifecycleKey(path.join(fixture.mainRoot, '.git'), fixture.request.branch);
  await expect(fixture.service.create(fixture.request)).rejects.toMatchObject({
    code: 'WORKTREE_INCLUDE_APPROVAL_REQUIRED',
  });
  await fixture.service.create({
    ...fixture.request,
    includeApproval: await currentIncludeApproval(fixture),
  });
  const appData = { LOCALAPPDATA: fixture.stateRoot };
  const service = worktrees(
    {
      env: appData,
      portService: fixture.portService,
      preparationRuntimeFactory: () => ({
        run: async () => ({ status: 'ready' }),
        retry: async () => ({ status: 'ready' }),
        cancel: async () => {
          throw new Error('token=abc123 path=C:/secret/worktree');
        },
        reconcile: async () => ({ status: 'ready' }),
      }),
    } as never,
    fixture.mainRoot,
  );
  await expect(service.cancel({ cwd: fixture.mainRoot, key })).rejects.toThrow(/token=abc123/);
  const statePath = path.join(
    fixture.stateRoot,
    'mpx',
    'worktrees',
    'lifecycle',
    `${createHash('sha256').update(key).digest('hex')}.json`,
  );
  const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
    failure?: { message?: string };
  };
  expect(persisted.failure?.message).toBe('Preparation cancellation could not be verified.');
  expect(JSON.stringify(persisted)).not.toContain('abc123');
  expect(JSON.stringify(persisted)).not.toContain('C:/secret/worktree');
}, 15_000);
