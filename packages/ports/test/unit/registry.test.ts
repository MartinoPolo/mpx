import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InterprocessLock,
  RegistryStore,
  emptyRegistry,
  type LeaseRecord,
} from '../../src/index.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
const temporaryRoot = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-ports-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill();
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const workerPath = fileURLToPath(new URL('../fixtures/registry-worker.mjs', import.meta.url));
const spawnWorker = (mode: 'mutate' | 'crash', root: string, id: string) => {
  const child = fork(workerPath, [mode, root, id], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(child);
  return child;
};
const waitForMessage = <T extends { type: string }>(
  child: ChildProcess,
  type: string,
  timeoutMs = 15_000,
): Promise<T> =>
  new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const timeout = setTimeout(
      () => finish(new Error(`Timed out waiting for worker message ${type}. ${stderr}`)),
      timeoutMs,
    );
    const onMessage = (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: string }).type === type
      ) {
        finish(undefined, message as T);
      }
    };
    const onExit = (code: number | null) =>
      finish(new Error(`Worker exited with code ${code} before ${type}. ${stderr}`));
    const finish = (error?: Error, message?: T) => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) {
        reject(error);
      } else {
        resolve(message!);
      }
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
const waitForExit = (child: ChildProcess, timeoutMs = 15_000): Promise<number | null> =>
  new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for worker exit.')),
      timeoutMs,
    );
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
const lease = (id: string): LeaseRecord => {
  const port = 5_000 + id.charCodeAt(0);
  return {
    leaseId: id,
    projectId: `p-${id}`,
    repositoryId: `r-${id}`,
    worktreeId: `w-${id}`,
    worktreePath: `C:/${id}`,
    role: 'main',
    slot: 0,
    configHash: 'a'.repeat(64),
    services: { app: port },
    claims: [{ port, exclusive: true }],
    updatedAt: 1,
  };
};

describe('versioned registry', () => {
  it('writes strict versioned JSON atomically with sorted lease arrays', async () => {
    const root = await temporaryRoot();
    const store = new RegistryStore(root);
    await store.write({ ...emptyRegistry(), leases: [lease('z'), lease('a')] });
    expect((await store.read()).leases.map(({ leaseId }) => leaseId)).toEqual(['a', 'z']);
    expect(
      JSON.parse(await readFile(path.join(root, 'ports-registry.json'), 'utf8')).schemaVersion,
    ).toBe(1);
  });
  it('rebuilds atomically without reading a corrupt registry', async () => {
    const root = await temporaryRoot(),
      store = new RegistryStore(root);
    await writeFile(store.filePath, '{corrupt');
    await store.rebuild({ schemaVersion: 1, leases: [lease('a')] });
    expect((await store.read()).leases.map(({ leaseId }) => leaseId)).toEqual(['a']);
  });
  it('rejects malformed or unknown registry data', async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, 'ports-registry.json'), '{"schemaVersion":2,"leases":[]}');
    await expect(new RegistryStore(root).read()).rejects.toMatchObject({
      code: 'PORT_REGISTRY_INVALID',
    });
  });
  it.each([
    '{"schemaVersion":1,"schemaVersion":1,"leases":[]}',
    '{"schemaVersion":1,"leases":[],"__proto__":{}}',
    JSON.stringify({ schemaVersion: 1, leases: [{ ...lease('a'), slot: -1 }] }),
    JSON.stringify({
      schemaVersion: 1,
      leases: [
        { ...lease('a'), services: { app: 70000 }, claims: [{ port: 70000, exclusive: true }] },
      ],
    }),
    JSON.stringify({
      schemaVersion: 1,
      leases: [{ ...lease('a'), claims: [{ port: 5099, exclusive: true, unknown: true }] }],
    }),
    JSON.stringify({ schemaVersion: 1, leases: [lease('a'), { ...lease('b'), leaseId: 'a' }] }),
    JSON.stringify({
      schemaVersion: 1,
      leases: [
        lease('a'),
        { ...lease('b'), repositoryId: lease('a').repositoryId, worktreeId: lease('a').worktreeId },
      ],
    }),
    JSON.stringify({
      schemaVersion: 1,
      leases: [
        lease('a'),
        { ...lease('b'), repositoryId: lease('a').repositoryId, projectId: lease('a').projectId },
      ],
    }),
    JSON.stringify({ schemaVersion: 1, leases: [{ ...lease('a'), role: 'linked', slot: 1 }] }),
    JSON.stringify({
      schemaVersion: 1,
      leases: [
        lease('a'),
        { ...lease('b'), services: lease('a').services, claims: lease('a').claims },
      ],
    }),
  ])('rejects strict semantic, duplicate-key, and dangerous-key violations', async (contents) => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, 'ports-registry.json'), contents);
    await expect(new RegistryStore(root).read()).rejects.toMatchObject({
      code: 'PORT_REGISTRY_INVALID',
    });
  });
});

describe('interprocess lock', () => {
  it('protects a live owner and times out with a stable error', async () => {
    const root = await temporaryRoot();
    const first = new InterprocessLock(root, {
      inspectProcess: () => ({ alive: true }),
      now: () => 100,
      timeoutMs: 5,
      retryMs: 1,
    });
    const release = await first.acquire();
    const winningOwner = JSON.parse(
      await readFile(path.join(first.lockPath, 'owner.json'), 'utf8'),
    ) as { token: string };
    await expect(
      new InterprocessLock(root, {
        inspectProcess: () => ({ alive: true }),
        now: (() => {
          let n = 100;
          return () => ++n;
        })(),
        timeoutMs: 2,
        retryMs: 1,
      }).acquire(),
    ).rejects.toMatchObject({ code: 'PORT_LOCK_TIMEOUT' });
    expect(
      JSON.parse(await readFile(path.join(first.lockPath, 'owner.json'), 'utf8')),
    ).toMatchObject({ token: winningOwner.token });
    await release();
  });
  it('does not recover an empty owner directory until its filesystem grace period expires', async () => {
    const root = await temporaryRoot();
    const lockPath = path.join(root, 'ports-registry.lock');
    await mkdir(lockPath, { recursive: true });
    await expect(
      new InterprocessLock(root, { emptyOwnerGraceMs: 10_000, timeoutMs: 5, retryMs: 1 }).acquire(),
    ).rejects.toMatchObject({ code: 'PORT_LOCK_TIMEOUT' });
    await utimes(lockPath, new Date(0), new Date(0));
    const release = await new InterprocessLock(root, { emptyOwnerGraceMs: 10_000 }).acquire();
    await release();
  });
  it('applies the filesystem grace period to malformed owner metadata', async () => {
    const root = await temporaryRoot();
    const lockPath = path.join(root, 'ports-registry.lock');
    const ownerPath = path.join(lockPath, 'owner.json');
    await mkdir(lockPath, { recursive: true });
    await writeFile(ownerPath, '{partial');
    await expect(
      new InterprocessLock(root, { emptyOwnerGraceMs: 10_000, timeoutMs: 5, retryMs: 1 }).acquire(),
    ).rejects.toMatchObject({ code: 'PORT_LOCK_TIMEOUT' });
    await utimes(ownerPath, new Date(0), new Date(0));
    const release = await new InterprocessLock(root, { emptyOwnerGraceMs: 10_000 }).acquire();
    await release();
  });
  it('protects a live PID only when its exact process-start fingerprint matches', async () => {
    const root = await temporaryRoot();
    const lockPath = path.join(root, 'ports-registry.lock');
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, 'owner.json'),
      JSON.stringify({
        version: 1,
        token: 'old',
        pid: 8,
        processStartFingerprint: 'start-a',
        acquiredAt: 1,
        heartbeatAt: 1,
      }),
    );
    const inspectProcess = async () => ({ alive: true, startFingerprint: 'start-b' });
    const release = await new InterprocessLock(root, { inspectProcess }).acquire();
    await release();
  });
  it('never steals a live matching owner regardless of heartbeat age', async () => {
    const root = await temporaryRoot();
    const lockPath = path.join(root, 'ports-registry.lock');
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, 'owner.json'),
      JSON.stringify({
        version: 1,
        token: 'old',
        pid: 8,
        processStartFingerprint: 'same-start',
        acquiredAt: 1,
        heartbeatAt: 1,
      }),
    );
    const inspectProcess = () => ({ alive: true, startFingerprint: 'same-start' });
    await expect(
      new InterprocessLock(root, { inspectProcess, timeoutMs: 5, retryMs: 1 }).acquire(),
    ).rejects.toMatchObject({ code: 'PORT_LOCK_TIMEOUT' });
  });
  it('never steals a live owner when its start fingerprint is unavailable', async () => {
    const root = await temporaryRoot();
    const lockPath = path.join(root, 'ports-registry.lock');
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, 'owner.json'),
      JSON.stringify({
        version: 1,
        token: 'old',
        pid: 8,
        processStartFingerprint: 'unavailable:8',
        acquiredAt: 1,
        heartbeatAt: 1,
      }),
    );
    await expect(
      new InterprocessLock(root, {
        inspectProcess: () => ({ alive: true, startFingerprint: 'now-available' }),
        timeoutMs: 5,
        retryMs: 1,
      }).acquire(),
    ).rejects.toMatchObject({ code: 'PORT_LOCK_TIMEOUT' });
  });
  it('publishes complete versioned heartbeat records', async () => {
    const root = await temporaryRoot();
    let now = 100;
    const lock = new InterprocessLock(root, {
      now: () => ++now,
      inspectProcess: () => ({ alive: true, startFingerprint: 'self-start' }),
      heartbeatMs: 2,
    });
    const release = await lock.acquire();
    const observed: Array<{ version: number; token: string; heartbeatAt: number }> = [];
    for (let index = 0; index < 20; index += 1) {
      try {
        observed.push(
          JSON.parse(await readFile(path.join(lock.lockPath, 'heartbeat.json'), 'utf8')) as {
            version: number;
            token: string;
            heartbeatAt: number;
          },
        );
      } catch {
        /* The first heartbeat may not have been published yet. */
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await release();
    expect(observed.length).toBeGreaterThan(1);
    expect(
      observed.every(
        ({ version, token, heartbeatAt }) =>
          version === 1 && token.length > 0 && Number.isFinite(heartbeatAt),
      ),
    ).toBe(true);
    expect(observed.at(-1)!.heartbeatAt).toBeGreaterThan(observed[0]!.heartbeatAt);
  });
  it('serializes simultaneous registry transactions', async () => {
    const root = await temporaryRoot();
    const store = new RegistryStore(root);
    await Promise.all(
      ['a', 'b'].map((id) =>
        store.transaction(async (state) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          state.leases.push(lease(id));
        }),
      ),
    );
    expect((await store.read()).leases.map(({ leaseId }) => leaseId)).toEqual(['a', 'b']);
  });
  it('preserves every mutation across simultaneous worker processes without duplicate holders', async () => {
    const root = await temporaryRoot();
    const workers = ['worker-a', 'worker-b', 'worker-c', 'worker-d'].map((id) =>
      spawnWorker('mutate', root, id),
    );
    await Promise.all(workers.map((worker) => waitForMessage(worker, 'ready')));
    const intervals = new Map<string, { enteredAt?: number; leavingAt?: number }>();
    for (const worker of workers) {
      worker.on('message', (message) => {
        const event = message as { type?: string; id?: string; at?: number };
        if (event.type === 'entered' && event.id && event.at !== undefined) {
          intervals.set(event.id, { enteredAt: event.at });
          worker.send({ type: 'continue' });
        } else if (event.type === 'leaving' && event.id && event.at !== undefined) {
          intervals.set(event.id, { ...intervals.get(event.id), leavingAt: event.at });
          worker.send({ type: 'leave-ack' });
        }
      });
    }
    for (const worker of workers) {
      worker.send({ type: 'go' });
    }
    await Promise.all(workers.map((worker) => waitForMessage(worker, 'done')));
    await Promise.all(workers.map((worker) => waitForExit(worker)));
    const ordered = [...intervals.values()].sort(
      (left, right) => left.enteredAt! - right.enteredAt!,
    );
    expect(ordered).toHaveLength(workers.length);
    for (let index = 1; index < ordered.length; index += 1) {
      expect(ordered[index]!.enteredAt).toBeGreaterThanOrEqual(ordered[index - 1]!.leavingAt!);
    }
    expect((await new RegistryStore(root).read()).leases.map(({ leaseId }) => leaseId)).toEqual([
      'worker-a',
      'worker-b',
      'worker-c',
      'worker-d',
    ]);
  }, 30_000);
  it('recovers after a worker crashes abruptly while owning the registry lock', async () => {
    const root = await temporaryRoot();
    const crashing = spawnWorker('crash', root, 'crashed');
    await waitForMessage(crashing, 'ready');
    crashing.send({ type: 'go' });
    await waitForMessage(crashing, 'entered');
    crashing.send({ type: 'crash' });
    expect(await waitForExit(crashing)).toBe(23);
    const recovering = spawnWorker('mutate', root, 'recovered');
    recovering.on('message', (message) => {
      const type = (message as { type?: string })?.type;
      if (type === 'entered') {
        recovering.send({ type: 'continue' });
      } else if (type === 'leaving') {
        recovering.send({ type: 'leave-ack' });
      }
    });
    await waitForMessage(recovering, 'ready');
    recovering.send({ type: 'go' });
    await waitForMessage(recovering, 'done');
    await waitForExit(recovering);
    expect((await new RegistryStore(root).read()).leases.map(({ leaseId }) => leaseId)).toEqual([
      'recovered',
    ]);
  }, 30_000);
});
