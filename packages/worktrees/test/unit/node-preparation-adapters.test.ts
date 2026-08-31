import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  NodePreparationEvidenceAdapter,
  NodePreparationExecutionAdapter,
  NodePreparationProcessAdapter,
  NodePreparationStore,
  PreparationStateLock,
  detectPackageManager,
  resolvePreparationPackageManager,
  type PreparationProcessIdentityInspector,
} from '../../src/node-preparation-adapters.js';
import {
  PreparationEngine,
  createPreparationApproval,
  preparationApprovalPhrases,
  type BackgroundPreparationRequest,
  type PreparationAdapters,
  type PreparationState,
} from '../../src/preparation-engine.js';
import { resolveTrustedExecutable, type ResolvedExecutable } from '../../src/trusted-executable.js';
import type { PreparationPlan } from '@mpx/config';

const exec = promisify(execFile);
const roots: string[] = [];
const resolvedExecutable = (command: string): ResolvedExecutable => ({
  path: command,
  sha256: 'executable',
  size: 1,
  modifiedMs: 1,
  trustedPrefixArguments: [],
  supportFiles: [],
});
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const presentInspector = (fingerprint = 'self-start'): PreparationProcessIdentityInspector => ({
  inspect: async (pid) => ({ status: 'present', pid, startFingerprint: fingerprint }),
});
const preparationLockPath = (root: string, key: string) =>
  path.join(root, 'state-locks', `${createHash('sha256').update(key).digest('hex')}.lock`);
const lockOwner = (pid: number, fingerprint: string, token = 'owner-token') => ({
  schemaVersion: 1,
  owner: 'mpx',
  token,
  pid,
  processStartFingerprint: fingerprint,
  acquiredAt: 1,
});
const waitMessage = (child: ChildProcess, type: string) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${type}`));
    }, 5_000);
    const message = (value: unknown) => {
      if (
        typeof value === 'object' &&
        value !== null &&
        (value as Record<string, unknown>).type === type
      ) {
        cleanup();
        resolve(value as Record<string, unknown>);
      }
    };
    const exit = (code: number | null) => {
      cleanup();
      reject(new Error(`Fixture exited ${code} before ${type}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('exit', exit);
    };
    child.on('message', message);
    child.once('exit', exit);
  });

it('captures canonical Git/package approval evidence and atomically bounds state-local logs', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'mpx prepare evidence '));
  roots.push(parent);
  const repository = path.join(parent, 'repo');
  await mkdir(repository);
  await exec('git', ['init', '-b', 'main'], { cwd: repository });
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository });
  await exec('git', ['config', 'user.name', 'MPX Test'], { cwd: repository });
  await writeFile(path.join(repository, 'mpxconfig.json'), '{"schemaVersion":1}');
  await writeFile(
    path.join(repository, 'package.json'),
    '{"name":"fixture","scripts":{"build":"node build.mjs"}}',
  );
  await writeFile(path.join(repository, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'");
  await exec('git', ['add', '.'], { cwd: repository });
  await exec('git', ['commit', '-m', 'fixture'], { cwd: repository });
  const evidence = await new NodePreparationEvidenceAdapter().capture({
    worktreeRoot: repository,
    cwd: repository,
    step: { id: 'build', uses: 'package-script', script: 'build' },
  });
  expect(evidence).toMatchObject({ resolvedPackageScriptBody: 'node build.mjs' });
  expect(evidence.repositoryIdentity).toContain('.git');
  expect(evidence.head).toMatch(/^[0-9a-f]{40}$/u);
  expect(evidence.lockfileHashes).toHaveLength(1);
  expect(await detectPackageManager(repository)).toBe('pnpm');
  const store = new NodePreparationStore(path.join(parent, 'state'), 16);
  await store.writeLogAtomic(
    path.join(parent, 'state', 'logs', 'step.log'),
    '0123456789abcdefghijkl',
  );
  expect(await readFile(path.join(parent, 'state', 'logs', 'step.log'), 'utf8')).toBe(
    '6789abcdefghijkl',
  );
  await expect(store.writeLogAtomic(path.join(parent, 'outside.log'), 'bad')).rejects.toMatchObject(
    { code: 'PREPARATION_LOG_PATH_INVALID' },
  );
});

it('makes a nested cwd lockfile mutation stale an otherwise valid preparation approval', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'mpx prepare nested lockfile '));
  roots.push(parent);
  const repository = path.join(parent, 'repo');
  const nested = path.join(repository, 'packages', 'web');
  await mkdir(nested, { recursive: true });
  await exec('git', ['init', '-b', 'main'], { cwd: repository });
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository });
  await exec('git', ['config', 'user.name', 'MPX Test'], { cwd: repository });
  await writeFile(path.join(repository, '.gitignore'), 'npm-shrinkwrap.json\n');
  await writeFile(path.join(repository, 'mpxconfig.json'), '{}\n');
  await writeFile(path.join(repository, 'package.json'), '{"name":"root"}\n');
  await writeFile(path.join(repository, 'pnpm-lock.yaml'), 'root-lock\n');
  await writeFile(
    path.join(nested, 'package.json'),
    '{"name":"web","scripts":{"build":"vite build"}}\n',
  );
  await exec('git', ['add', '.'], { cwd: repository });
  await exec('git', ['commit', '-m', 'fixture'], { cwd: repository });
  const nestedLockfile = path.join(nested, 'package-lock.json');
  await writeFile(nestedLockfile, 'nested-lock-v1\n');
  await writeFile(path.join(repository, 'npm-shrinkwrap.json'), 'ignored-root-lock-v1\n');
  const evidence = new NodePreparationEvidenceAdapter();
  const store = new Map<string, PreparationState>();
  const adapters: PreparationAdapters = {
    evidence,
    execution: {
      resolveExecutable: async (command) => resolvedExecutable(command),
      spawn: async () => ({ exitCode: 0, output: '' }),
      startBackground: async () => ({ pid: 1, startFingerprint: 'unused', ownerToken: 'unused' }),
    },
    store: {
      load: async (key) => store.get(key),
      compareAndSwap: async (key, revision, next, revalidate) => {
        if (store.get(key)?.revision !== revision) {
          return false;
        }
        await revalidate?.();
        store.set(key, structuredClone(next));
        return true;
      },
      writeLogAtomic: async () => undefined,
    },
    clock: { now: () => 1, sleep: async () => undefined },
    process: { inspect: async () => undefined, terminateTree: async () => undefined },
    paths: { canonicalize: realpath },
  };
  const plan: PreparationPlan = {
    execution: 'foreground',
    steps: [
      {
        id: 'build',
        uses: 'package-script' as const,
        script: 'build',
        cwd: 'packages/web',
        required: true,
      },
    ],
    order: ['build'],
    logging: { maxOutputBytes: 65536, redactEnvironmentValues: true },
  };
  const approval = await createPreparationApproval(
    { plan, worktreeRoot: repository, packageManager: 'pnpm', environment: {} },
    adapters,
  );
  expect(approval.steps).toHaveLength(1);
  const buildStep = plan.steps[0];
  if (!buildStep) {
    throw new Error('preparation plan fixture is empty');
  }
  expect(
    (
      await evidence.capture({ worktreeRoot: repository, cwd: nested, step: buildStep })
    ).lockfileHashes.map((item) => item.path),
  ).toEqual(['npm-shrinkwrap.json', 'packages/web/package-lock.json', 'pnpm-lock.yaml']);
  await writeFile(nestedLockfile, 'nested-lock-v2\n');
  await expect(
    new PreparationEngine(adapters).prepare({
      key: 'nested-lock',
      plan,
      approval,
      ...preparationApprovalPhrases(approval),
      worktreeRoot: repository,
      packageManager: 'pnpm',
      environment: {},
      logDirectory: path.join(parent, 'logs'),
    }),
  ).rejects.toMatchObject({ code: 'PREPARATION_APPROVAL_STALE' });
});

it('reclaims a preparation CAS lock when its PID has been reused', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx prepare reused pid '));
  roots.push(root);
  const key = 'reused';
  const lockPath = path.join(
    root,
    'state-locks',
    `${createHash('sha256').update(key).digest('hex')}.lock`,
  );
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    path.join(lockPath, 'owner.json'),
    JSON.stringify({
      schemaVersion: 1,
      owner: 'mpx',
      token: 'stale',
      pid: 4242,
      processStartFingerprint: 'old-start',
      acquiredAt: 1,
    }),
  );
  const inspector = {
    inspect: async (pid: number) => ({
      status: 'present' as const,
      pid,
      startFingerprint: pid === process.pid ? 'self-start' : 'new-start',
    }),
  };
  const store = new NodePreparationStore(root, {
    processIdentityInspector: inspector,
    lockTimeoutMs: 100,
    lockRetryMs: 1,
  });
  const state: PreparationState = {
    schemaVersion: 2,
    owner: 'mpx',
    key,
    runId: '11111111-1111-4111-8111-111111111111',
    revision: 1,
    status: 'ready',
    execution: 'foreground',
    createdAt: 1,
    updatedAt: 1,
    steps: [] as PreparationState['steps'],
    finishedAt: 1,
  };
  await expect(store.compareAndSwap(key, undefined, state)).resolves.toBe(true);
});

it('refuses to publish a preparation CAS lock without its own inspected start fingerprint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx prepare own unknown '));
  roots.push(root);
  const key = 'own-unknown';
  const state: PreparationState = {
    schemaVersion: 2,
    owner: 'mpx',
    key,
    runId: '11111111-1111-4111-8111-111111111111',
    revision: 1,
    status: 'ready',
    execution: 'foreground',
    createdAt: 1,
    updatedAt: 1,
    steps: [] as PreparationState['steps'],
    finishedAt: 1,
  } as const;
  const store = new NodePreparationStore(root, {
    processIdentityInspector: { inspect: async (pid) => ({ status: 'unknown', pid }) },
  });
  await expect(store.compareAndSwap(key, undefined, state)).rejects.toMatchObject({
    code: 'PREPARATION_STATE_LOCK_IDENTITY_UNKNOWN',
  });
  await expect(stat(preparationLockPath(root, key))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('fails closed on unknown preparation lock inspection and times out for a live owner', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx prepare closed '));
  roots.push(root);
  for (const [key, status] of [
    ['unknown', 'unknown'],
    ['live', 'present'],
  ] as const) {
    const lockPath = preparationLockPath(root, key);
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, 'owner.json'),
      JSON.stringify(lockOwner(4242, 'owner-start')),
    );
    const inspector: PreparationProcessIdentityInspector = {
      inspect: async (pid) =>
        pid === process.pid
          ? { status: 'present', pid, startFingerprint: 'self-start' }
          : status === 'unknown'
            ? { status: 'unknown', pid }
            : { status: 'present', pid, startFingerprint: 'owner-start' },
    };
    const store = new NodePreparationStore(root, {
      processIdentityInspector: inspector,
      lockTimeoutMs: 5,
      lockRetryMs: 1,
    });
    const state: PreparationState = {
      schemaVersion: 2,
      owner: 'mpx',
      key,
      runId: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      status: 'ready',
      execution: 'foreground',
      createdAt: 1,
      updatedAt: 1,
      steps: [],
      finishedAt: 1,
    };
    await expect(store.compareAndSwap(key, undefined, state)).rejects.toMatchObject({
      code: 'PREPARATION_STATE_LOCK_TIMEOUT',
    });
    expect(JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8'))).toMatchObject({
      token: 'owner-token',
    });
  }
});

it('reclaims ownerless and malformed preparation locks only after their bounded grace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx prepare ownerless '));
  roots.push(root);
  for (const [key, malformed] of [
    ['ownerless', false],
    ['malformed', true],
  ] as const) {
    const lockPath = preparationLockPath(root, key);
    await mkdir(lockPath, { recursive: true });
    if (malformed) {
      await writeFile(path.join(lockPath, 'owner.json'), '{partial');
    }
    const modifiedAt = (await stat(malformed ? path.join(lockPath, 'owner.json') : lockPath))
      .mtimeMs;
    let now = modifiedAt + 1;
    const state: PreparationState = {
      schemaVersion: 2,
      owner: 'mpx',
      key,
      runId: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      status: 'ready',
      execution: 'foreground',
      createdAt: 1,
      updatedAt: 1,
      steps: [],
      finishedAt: 1,
    };
    await expect(
      new NodePreparationStore(root, {
        processIdentityInspector: presentInspector(),
        ownerlessGraceMs: 30,
        lockTimeoutMs: 5,
        lockRetryMs: 1,
        now: () => now++,
      }).compareAndSwap(key, undefined, state),
    ).rejects.toMatchObject({ code: 'PREPARATION_STATE_LOCK_TIMEOUT' });
    const old = new Date(modifiedAt - 100);
    if (malformed) {
      await utimes(path.join(lockPath, 'owner.json'), old, old);
    } else {
      await utimes(lockPath, old, old);
    }
    now = modifiedAt + 100;
    await expect(
      new NodePreparationStore(root, {
        processIdentityInspector: presentInspector(),
        ownerlessGraceMs: 30,
        lockTimeoutMs: 100,
        lockRetryMs: 1,
        now: () => now++,
      }).compareAndSwap(key, undefined, state),
    ).resolves.toBe(true);
  }
});

it('does not let a stale preparation lock releaser delete its replacement', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx prepare stale release '));
  roots.push(root);
  const lockPath = preparationLockPath(root, 'stale-release');
  const lock = new PreparationStateLock({
    lockTimeoutMs: 100,
    lockRetryMs: 1,
    ownerlessGraceMs: 0,
    now: Date.now,
    token: (() => {
      let value = 0;
      return () => `token-${++value}`;
    })(),
    processIdentityInspector: presentInspector(),
  });
  const staleRelease = await lock.acquire(lockPath);
  await rm(lockPath, { recursive: true, force: true });
  const replacementRelease = await lock.acquire(lockPath);
  const replacement = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8'));
  await staleRelease();
  expect(JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8'))).toEqual(
    replacement,
  );
  await replacementRelease();
});

it('waits out ownerless grace after a process crashes before publishing CAS ownership', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx prepare ownerless crash '));
  roots.push(root);
  const fixture = path.resolve(import.meta.dirname, '../fixtures/preparation-cas-worker.mjs');
  const child = fork(fixture, ['ownerless', root, 'ownerless-crash'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  children.push(child);
  await waitMessage(child, 'ownerless');
  if (child.exitCode === null) {
    await new Promise((resolve) => child.once('exit', resolve));
  }
  children.splice(children.indexOf(child), 1);
  const lockPath = preparationLockPath(root, 'ownerless-crash');
  const currentLockTime = new Date();
  await utimes(lockPath, currentLockTime, currentLockTime);
  const state: PreparationState = {
    schemaVersion: 2,
    owner: 'mpx',
    key: 'ownerless-crash',
    runId: '11111111-1111-4111-8111-111111111111',
    revision: 1,
    status: 'ready',
    execution: 'foreground',
    createdAt: 1,
    updatedAt: 1,
    steps: [] as PreparationState['steps'],
    finishedAt: 1,
  };
  await expect(
    new NodePreparationStore(root, {
      processIdentityInspector: presentInspector(),
      ownerlessGraceMs: 10_000,
      lockTimeoutMs: 10,
      lockRetryMs: 1,
    }).compareAndSwap(state.key, undefined, state),
  ).rejects.toMatchObject({ code: 'PREPARATION_STATE_LOCK_TIMEOUT' });
  const expiredLockTime = new Date(Date.now() - 10_001);
  await utimes(lockPath, expiredLockTime, expiredLockTime);
  await expect(
    new NodePreparationStore(root, {
      processIdentityInspector: presentInspector(),
      ownerlessGraceMs: 10_000,
      lockTimeoutMs: 500,
      lockRetryMs: 5,
    }).compareAndSwap(state.key, undefined, state),
  ).resolves.toBe(true);
});

it('recovers a real cross-process CAS lock after its owner crashes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx prepare crash '));
  roots.push(root);
  const fixture = path.resolve(import.meta.dirname, '../fixtures/preparation-cas-worker.mjs');
  const child = fork(fixture, ['crash', root, 'crash-key'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  children.push(child);
  await waitMessage(child, 'locked');
  child.kill();
  if (child.exitCode === null) {
    await new Promise((resolve) => child.once('exit', resolve));
  }
  children.splice(children.indexOf(child), 1);
  const inspector: PreparationProcessIdentityInspector = {
    inspect: async (pid) =>
      pid === process.pid
        ? { status: 'present', pid, startFingerprint: `process-${pid}` }
        : { status: 'absent', pid },
  };
  const state: PreparationState = {
    schemaVersion: 2,
    owner: 'mpx',
    key: 'crash-key',
    runId: '11111111-1111-4111-8111-111111111111',
    revision: 1,
    status: 'ready',
    execution: 'foreground',
    createdAt: 1,
    updatedAt: 1,
    steps: [] as PreparationState['steps'],
    finishedAt: 1,
  };
  await expect(
    new NodePreparationStore(root, {
      processIdentityInspector: inspector,
      lockTimeoutMs: 500,
      lockRetryMs: 5,
    }).compareAndSwap('crash-key', undefined, state),
  ).resolves.toBe(true);
});

it('serializes compare-and-swap writers between two processes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx prepare processes '));
  roots.push(root);
  const fixture = path.resolve(import.meta.dirname, '../fixtures/preparation-cas-worker.mjs');
  const first = fork(fixture, ['cas', root, 'shared'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const second = fork(fixture, ['cas', root, 'shared'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  children.push(first, second);
  const firstResult = waitMessage(first, 'result');
  const secondResult = waitMessage(second, 'result');
  first.send({ type: 'go' });
  second.send({ type: 'go' });
  expect([(await firstResult).swapped, (await secondResult).swapped].sort()).toEqual([false, true]);
  expect((await new NodePreparationStore(root).load('shared'))?.revision).toBe(1);
});

it('serializes concurrent compare-and-swap writers across store instances', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx prepare cas '));
  roots.push(root);
  const first = new NodePreparationStore(root);
  const second = new NodePreparationStore(root);
  const base: PreparationState = {
    schemaVersion: 2,
    owner: 'mpx',
    key: 'shared',
    runId: '11111111-1111-4111-8111-111111111111',
    revision: 1,
    status: 'preparing',
    execution: 'foreground',
    createdAt: 1,
    updatedAt: 1,
    steps: [] as PreparationState['steps'],
  };
  expect(await first.compareAndSwap('shared', undefined, base)).toBe(true);
  const outcomes = await Promise.all([
    first.compareAndSwap('shared', 1, {
      ...base,
      revision: 2,
      updatedAt: 2,
      status: 'ready',
      finishedAt: 2,
    }),
    second.compareAndSwap('shared', 1, {
      ...base,
      revision: 2,
      updatedAt: 3,
      status: 'failed',
      finishedAt: 3,
    }),
  ]);
  expect(outcomes.sort()).toEqual([false, true]);
  expect((await first.load('shared'))?.revision).toBe(2);
});

it('resolves package-manager selection for auto, none, and mismatch cases', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'mpx prepare manager '));
  roots.push(parent);
  const npmRoot = path.join(parent, 'npm');
  await mkdir(npmRoot);
  await writeFile(path.join(npmRoot, 'package-lock.json'), '{}');
  const yarnRoot = path.join(parent, 'yarn');
  await mkdir(yarnRoot);
  await writeFile(path.join(yarnRoot, 'yarn.lock'), 'lock');
  const executableOnly: PreparationPlan = {
    execution: 'foreground',
    steps: [{ id: 'run', uses: 'executable', argv: ['tool'], required: true }],
    order: ['run'],
    logging: { maxOutputBytes: 65536, redactEnvironmentValues: true },
  };
  const installPlan: PreparationPlan = {
    execution: 'foreground',
    steps: [{ id: 'install', uses: 'package-install', required: true }],
    order: ['install'],
    logging: { maxOutputBytes: 65536, redactEnvironmentValues: true },
  };

  expect(await resolvePreparationPackageManager(npmRoot, installPlan, 'auto')).toBe('npm');
  expect(await resolvePreparationPackageManager(yarnRoot, installPlan, undefined)).toBe('yarn');
  await expect(
    resolvePreparationPackageManager(npmRoot, installPlan, 'none'),
  ).rejects.toMatchObject({ code: 'PREPARATION_PACKAGE_MANAGER_UNAVAILABLE' });
  await expect(
    resolvePreparationPackageManager(npmRoot, installPlan, 'pnpm'),
  ).rejects.toMatchObject({ code: 'PREPARATION_PACKAGE_MANAGER_MISMATCH' });
  expect(await resolvePreparationPackageManager(npmRoot, executableOnly, 'none')).toBe('pnpm');
});

it('executes a real child directly with an allowlisted environment and records its owned fingerprint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx prepare child '));
  roots.push(root);
  const native = {
    inspect: async (pid: number) => ({ pid, startFingerprint: `birth-${pid}` }),
    terminateTree: async () => undefined,
  };
  const processAdapter = new NodePreparationProcessAdapter(native, root);
  const started: unknown[] = [];
  const execution = new NodePreparationExecutionAdapter({
    process: processAdapter,
    workerEntry: 'unused',
    stateRoot: root,
  });
  const result = await execution.spawn({
    argv: [
      process.execPath,
      '-e',
      "process.stdout.write(`allowed=${process.env.MPX_ALLOWED ?? 'missing'};SHOULD_NOT_LEAK=${process.env.SHOULD_NOT_LEAK ?? 'missing'}`)",
    ],
    cwd: root,
    environment: { MPX_ALLOWED: 'visible', SHOULD_NOT_LEAK: 'hidden' },
    environmentNames: ['MPX_ALLOWED'],
    timeoutMs: 5000,
    shell: false,
    onStarted: async (owned) => {
      started.push(owned);
    },
  });
  expect(result.output.toString()).toContain('allowed=visible');
  expect(result.output.toString()).toContain('SHOULD_NOT_LEAK=missing');
  expect(result.output.toString()).not.toContain('hidden');
  expect(started).toEqual([
    expect.objectContaining({
      startFingerprint: expect.stringMatching(/^birth-/u),
      ownerToken: expect.any(String),
    }),
  ]);
});

it('executes a trusted Node plus JavaScript launcher directly with shell:false', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'mpx prepare js launcher '));
  roots.push(parent);
  const worktree = path.join(parent, 'worktree');
  const trusted = path.join(parent, 'trusted');
  await mkdir(worktree);
  await mkdir(trusted);
  const support = path.join(trusted, 'launcher.mjs');
  await writeFile(support, 'process.stdout.write(`launcher:${process.argv[2]}`);', 'utf8');
  const nodeExecutable = await realpath(process.execPath);
  const policy = {
    allowlist: [
      {
        command: 'node-launcher',
        path: nodeExecutable,
        trustedPrefixArguments: [support],
        supportFiles: [support],
      },
    ],
    forbiddenRoots: [worktree],
  };
  const executable = await resolveTrustedExecutable('node-launcher', worktree, policy);
  const processAdapter = new NodePreparationProcessAdapter(
    {
      inspect: async (pid) => ({ pid, startFingerprint: `birth-${pid}` }),
      terminateTree: async () => undefined,
    },
    path.join(parent, 'state'),
  );
  const execution = new NodePreparationExecutionAdapter({
    process: processAdapter,
    workerEntry: 'unused',
    stateRoot: path.join(parent, 'state'),
    trustedExecutablePolicy: policy,
  });
  const result = await execution.spawn({
    argv: [executable.path, ...executable.trustedPrefixArguments, 'ok'],
    executable,
    cwd: worktree,
    environment: {},
    environmentNames: [],
    timeoutMs: 5_000,
    shell: false,
    onStarted: async () => undefined,
  });
  expect(result.exitCode).toBe(0);
  expect(result.output.toString()).toBe('launcher:ok');
});

it('bounds foreground timeout when fingerprint inspection never resolves and kills only the direct child handle', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx prepare timeout '));
  roots.push(root);
  let childPid = 0;
  const processAdapter = new NodePreparationProcessAdapter(
    {
      inspect: async (pid) => {
        childPid = pid;
        return await new Promise<never>(() => undefined);
      },
      terminateTree: async () => await new Promise<never>(() => undefined),
    },
    root,
    { nativeTimeoutMs: 100 },
  );
  const execution = new NodePreparationExecutionAdapter({
    process: processAdapter,
    workerEntry: 'unused',
    stateRoot: root,
  });
  let watchdog: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      execution.spawn({
        argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
        cwd: root,
        environment: {},
        environmentNames: [],
        timeoutMs: 50,
        shell: false,
        onStarted: async () => undefined,
      }),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('foreground timeout did not settle')), 10_000);
      }),
    ]);
    expect(result).toMatchObject({ timedOut: true, terminationState: 'unknown' });
    expect(childPid).toBeGreaterThan(0);
    expect(() => process.kill(childPid, 0)).toThrow();
  } finally {
    if (watchdog) {
      clearTimeout(watchdog);
    }
    if (childPid > 0) {
      try {
        process.kill(childPid);
      } catch {
        /* The adapter already stopped the directly owned fixture. */
      }
    }
  }
}, 15_000);

it('fails closed when native inspection and termination are deferred', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx prepare native timeout '));
  roots.push(root);
  let inspectDeferred = false;
  let terminateStarted = false;
  const processAdapter = new NodePreparationProcessAdapter(
    {
      inspect: async (pid) =>
        inspectDeferred
          ? await new Promise<never>(() => undefined)
          : { pid, startFingerprint: `birth-${pid}` },
      terminateTree: async () => {
        terminateStarted = true;
        await new Promise<never>(() => undefined);
      },
    },
    root,
    { nativeTimeoutMs: 25 },
  );
  const owned = { pid: 123, startFingerprint: 'birth-123', ownerToken: 'owner-123' };
  await processAdapter.claim(owned);
  await expect(processAdapter.terminateTree(owned.pid, owned)).rejects.toMatchObject({
    code: 'PREPARATION_PROCESS_NATIVE_TIMEOUT',
  });
  expect(terminateStarted).toBe(true);
  inspectDeferred = true;
  await expect(processAdapter.inspectNative(owned.pid)).rejects.toMatchObject({
    code: 'PREPARATION_PROCESS_NATIVE_TIMEOUT',
  });
  await expect(processAdapter.inspect(owned.pid)).rejects.toMatchObject({
    code: 'PREPARATION_PROCESS_NATIVE_TIMEOUT',
  });
});

it('settles a foreground timeout when verified tree termination rejects and stops the directly owned child', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx prepare rejected termination '));
  roots.push(root);
  let childPid = 0;
  let treeKills = 0;
  const processAdapter = new NodePreparationProcessAdapter(
    {
      inspect: async (pid) => {
        childPid = pid;
        return { pid, startFingerprint: `birth-${pid}` };
      },
      terminateTree: async () => {
        treeKills += 1;
        throw new Error('verified termination failed');
      },
    },
    root,
  );
  const execution = new NodePreparationExecutionAdapter({
    process: processAdapter,
    workerEntry: 'unused',
    stateRoot: root,
  });
  const started = Date.now();
  let settlementTimer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      execution.spawn({
        argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
        cwd: root,
        environment: {},
        environmentNames: [],
        timeoutMs: 50,
        shell: false,
        onStarted: async () => undefined,
      }),
      new Promise<never>((_, reject) => {
        settlementTimer = setTimeout(
          () => reject(new Error('foreground timeout did not settle')),
          2_000,
        );
      }),
    ]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toMatchObject({ timedOut: true, terminationState: 'unknown' });
    expect(treeKills).toBe(1);
    expect(childPid).toBeGreaterThan(0);
    expect(() => process.kill(childPid, 0)).toThrow();
  } finally {
    if (settlementTimer) {
      clearTimeout(settlementTimer);
    }
    if (childPid > 0) {
      try {
        process.kill(childPid);
      } catch {
        /* The adapter already stopped the directly owned fixture. */
      }
    }
  }
}, 5_000);

it.each([
  [
    'claim',
    'claim failed',
    async (processAdapter: NodePreparationProcessAdapter) => {
      processAdapter.claim = async () => {
        throw new Error('claim failed');
      };
    },
  ],
  ['onStarted', 'registration failed', async () => undefined],
] as const)(
  'rejects foreground registration when %s fails and leaves the direct child stopped',
  async (kind, message, configure) => {
    const root = await mkdtemp(path.join(tmpdir(), `mpx prepare ${kind} failure `));
    roots.push(root);
    let childPid = 0;
    const processAdapter = new NodePreparationProcessAdapter(
      {
        inspect: async (pid) => {
          childPid = pid;
          return { pid, startFingerprint: `birth-${pid}` };
        },
        terminateTree: async () => undefined,
      },
      root,
    );
    await configure(processAdapter);
    const execution = new NodePreparationExecutionAdapter({
      process: processAdapter,
      workerEntry: 'unused',
      stateRoot: root,
    });
    await expect(
      execution.spawn({
        argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
        cwd: root,
        environment: {},
        environmentNames: [],
        timeoutMs: 5000,
        shell: false,
        onStarted:
          kind === 'onStarted'
            ? async () => {
                throw new Error(message);
              }
            : async () => undefined,
      }),
    ).rejects.toThrow(message);
    expect(childPid).toBeGreaterThan(0);
    expect(() => process.kill(childPid, 0)).toThrow();
  },
);

it('activates an acknowledged worker only after its verified identity is durably registered', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx prepare activation-'));
  roots.push(root);
  const activationMarker = path.join(root, 'activated');
  const workerEntry = path.resolve(import.meta.dirname, '../fixtures/activating-inert-worker.mjs');
  const processAdapter = new NodePreparationProcessAdapter(
    {
      inspect: async (pid) => ({ pid, startFingerprint: `birth-${pid}` }),
      terminateTree: async () => undefined,
    },
    root,
  );
  const execution = new NodePreparationExecutionAdapter({
    process: processAdapter,
    workerEntry,
    stateRoot: root,
    environment: { ...process.env, MPX_TEST_ACTIVATION_MARKER: activationMarker },
  });
  const request: BackgroundPreparationRequest = {
    key: 'activation-key',
    runId: '11111111-1111-4111-8111-111111111111',
    approval: { schemaVersion: 1, owner: 'mpx', steps: [] },
    plan: {
      execution: 'background',
      steps: [],
      order: [],
      logging: { maxOutputBytes: 65536, redactEnvironmentValues: true },
    },
    worktreeRoot: root,
    packageManager: 'pnpm',
    logDirectory: path.join(root, 'logs'),
    environmentNames: ['MPX_TEST_ACTIVATION_MARKER'],
  };
  let persisted: unknown;
  const owned = await execution.startBackground(request, async (identity) => {
    await expect(readFile(activationMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    persisted = identity;
  });
  expect(persisted).toEqual(owned);
  await expect.poll(() => readFile(activationMarker, 'utf8')).toBe('activated');
});

it('bounds inert-worker cleanup when durable verification persistence fails and tree termination hangs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx prepare persistence failure-'));
  roots.push(root);
  const workerEntry = path.resolve(import.meta.dirname, '../fixtures/activating-inert-worker.mjs');
  let childPid = 0;
  const processAdapter = new NodePreparationProcessAdapter(
    {
      inspect: async (pid) => {
        childPid = pid;
        return { pid, startFingerprint: `birth-${pid}` };
      },
      terminateTree: async () => new Promise(() => undefined),
    },
    root,
  );
  const execution = new NodePreparationExecutionAdapter({
    process: processAdapter,
    workerEntry,
    stateRoot: root,
  });
  const request: BackgroundPreparationRequest = {
    key: 'persistence-failure',
    runId: '22222222-2222-4222-8222-222222222222',
    approval: { schemaVersion: 1, owner: 'mpx', steps: [] },
    plan: {
      execution: 'background',
      steps: [],
      order: [],
      logging: { maxOutputBytes: 65536, redactEnvironmentValues: true },
    },
    worktreeRoot: root,
    packageManager: 'pnpm',
    logDirectory: path.join(root, 'logs'),
    environmentNames: [],
  };
  const started = Date.now();
  await expect(
    execution.startBackground(request, async () => {
      throw new Error('state persistence failed');
    }),
  ).rejects.toThrow('state persistence failed');
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(childPid).toBeGreaterThan(0);
  expect(() => process.kill(childPid, 0)).toThrow();
}, 7_000);

it('removes the request when trusted worker resolution fails before spawn', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx prepare background resolution failure '));
  roots.push(root);
  const execution = new NodePreparationExecutionAdapter({
    process: new NodePreparationProcessAdapter(
      {
        inspect: async (pid) => ({ pid, startFingerprint: `birth-${pid}` }),
        terminateTree: async () => undefined,
      },
      root,
    ),
    workerEntry: 'unused',
    stateRoot: root,
    nodeExecutable: path.join(root, 'missing-node.exe'),
  });
  const request: BackgroundPreparationRequest = {
    key: 'resolution-failure',
    runId: '44444444-4444-4444-8444-444444444444',
    approval: { schemaVersion: 1, owner: 'mpx', steps: [] },
    plan: {
      execution: 'background',
      steps: [],
      order: [],
      logging: { maxOutputBytes: 65536, redactEnvironmentValues: true },
    },
    worktreeRoot: root,
    packageManager: 'pnpm',
    logDirectory: path.join(root, 'logs'),
    environmentNames: [],
  };
  await expect(execution.startBackground(request, async () => undefined)).rejects.toMatchObject({
    code: 'PREPARATION_EXECUTABLE_UNRESOLVED',
  });
  await expect(readdir(path.join(root, 'worker-requests'))).resolves.toEqual([]);
});

it('removes the request and waits for actual child exit when an acknowledged worker cannot be verified', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx prepare background-'));
  roots.push(root);
  const exitMarker = path.join(root, 'worker-exited');
  const workerEntry = path.resolve(import.meta.dirname, '../fixtures/delayed-inert-worker.mjs');
  const processAdapter = new NodePreparationProcessAdapter(
    { inspect: async () => undefined, terminateTree: async () => undefined },
    root,
  );
  const execution = new NodePreparationExecutionAdapter({
    process: processAdapter,
    workerEntry,
    stateRoot: root,
    environment: { ...process.env, MPX_TEST_EXIT_MARKER: exitMarker },
  });
  const request: BackgroundPreparationRequest = {
    key: 'background-key',
    runId: '33333333-3333-4333-8333-333333333333',
    approval: { schemaVersion: 1, owner: 'mpx', steps: [] },
    plan: {
      execution: 'background',
      steps: [],
      order: [],
      logging: { maxOutputBytes: 65536, redactEnvironmentValues: true },
    },
    worktreeRoot: root,
    packageManager: 'pnpm',
    logDirectory: path.join(root, 'logs'),
    environmentNames: ['MPX_TEST_EXIT_MARKER'],
  };
  await expect(execution.startBackground(request, async () => undefined)).rejects.toMatchObject({
    code: 'PREPARATION_WORKER_START_UNKNOWN',
  });
  expect(await readFile(exitMarker, 'utf8')).toBe('exited');
  expect(await readdir(path.join(root, 'worker-requests'))).toEqual([]);
}, 10_000);
