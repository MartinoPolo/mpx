import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NodePreparationProcessAdapter,
  NodePreparationStore,
  PreparationEngine,
  type NativeProcessCapabilities,
  type OwnedProcess,
  type PreparationAdapters,
  type PreparationState,
  type PreparationStoreAdapter,
} from '@mpx/worktrees';

const roots: string[] = [];
const children: ChildProcess[] = [];

function waitForMessage(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for worker message ${type}`));
    }, 5_000);
    const onMessage = (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>).type === type
      ) {
        cleanup();
        resolve(message as Record<string, unknown>);
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Worker exited with ${code} before ${type}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for worker exit')), 5_000),
    ),
  ]);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
  }
  await waitForExit(child);
  const index = children.indexOf(child);
  if (index >= 0) {
    children.splice(index, 1);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await waitForExit(child);
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function state(key: string, worker: OwnedProcess): PreparationState {
  return {
    schemaVersion: 2,
    owner: 'mpx',
    key,
    runId: '11111111-1111-4111-8111-111111111111',
    revision: 1,
    status: 'preparing',
    execution: 'background',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    steps: [{ id: 'run', status: 'preparing', process: worker }],
    worker,
  };
}

function adapters(
  store: PreparationStoreAdapter,
  processAdapter: NodePreparationProcessAdapter,
): PreparationAdapters {
  return {
    store,
    process: processAdapter,
    clock: {
      now: Date.now,
      sleep: async (milliseconds) => {
        await new Promise((resolve) => setTimeout(resolve, milliseconds));
      },
    },
    paths: { canonicalize: async (value) => value },
    evidence: {
      capture: async () => {
        throw new Error('not used by persisted-state integration tests');
      },
    },
    execution: {
      resolveExecutable: async () => {
        throw new Error('not used by persisted-state integration tests');
      },
      spawn: async () => {
        throw new Error('not used by persisted-state integration tests');
      },
      startBackground: async () => {
        throw new Error('not used by persisted-state integration tests');
      },
    },
  };
}

async function startWorker(root: string, key: string): Promise<ChildProcess> {
  const fixture = path.resolve(import.meta.dirname, './fixtures/preparation-persisted-worker.mjs');
  const child = fork(fixture, [root, key], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.push(child);
  await waitForMessage(child, 'online');
  return child;
}

function nativeFor(
  child: ChildProcess,
  beforeTerminate: () => Promise<void> = async () => undefined,
): NativeProcessCapabilities {
  const fingerprint = `birth-${child.pid}`;
  return {
    inspect: async (pid) => {
      if (pid !== child.pid || child.exitCode !== null || child.signalCode !== null) {
        return undefined;
      }
      try {
        process.kill(pid, 0);
        return { pid, startFingerprint: fingerprint };
      } catch {
        return undefined;
      }
    },
    terminateTree: async (identity) => {
      expect(identity).toEqual({ pid: child.pid, startFingerprint: fingerprint });
      await beforeTerminate();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      await waitForExit(child);
    },
  };
}

async function persistWorker(
  root: string,
  key: string,
  child: ChildProcess,
  processAdapter: NodePreparationProcessAdapter,
): Promise<OwnedProcess> {
  const worker = {
    pid: child.pid!,
    startFingerprint: `birth-${child.pid}`,
    ownerToken: `token-${child.pid}`,
  };
  await processAdapter.claim(worker);
  expect(
    await new NodePreparationStore(root).compareAndSwap(key, undefined, state(key, worker)),
  ).toBe(true);
  return worker;
}

describe('persisted preparation worker races and restarts', () => {
  it.each(['ready', 'failed'] as const)(
    'keeps durable cancellation when a real worker races a %s completion',
    async (completionStatus) => {
      const root = await mkdtemp(path.join(tmpdir(), 'mpx persisted preparation race '));
      roots.push(root);
      const key = `race-${completionStatus}`;
      const child = await startWorker(root, key);
      const completion = waitForMessage(child, 'completion');
      const processAdapter = new NodePreparationProcessAdapter(
        nativeFor(child, async () => {
          await completion;
        }),
        root,
      );
      await persistWorker(root, key, child, processAdapter);

      let cancellation: Promise<PreparationState> | undefined;
      try {
        child.send?.({ type: 'capture' });
        await waitForMessage(child, 'captured');
        const baseStore = new NodePreparationStore(root);
        const cancellingPersisted = deferred<void>();
        const barrierStore: PreparationStoreAdapter = {
          load: (keyToLoad) => baseStore.load(keyToLoad),
          compareAndSwap: async (keyToSwap, expectedRevision, next, revalidate) => {
            const swapped = await baseStore.compareAndSwap(
              keyToSwap,
              expectedRevision,
              next,
              revalidate,
            );
            if (swapped && next.status === 'cancelling') {
              cancellingPersisted.resolve();
            }
            return swapped;
          },
          writeLogAtomic: (file, content) => baseStore.writeLogAtomic(file, content),
        };
        cancellation = new PreparationEngine(adapters(barrierStore, processAdapter)).cancel(key);
        await cancellingPersisted.promise;
        child.send?.({ type: 'complete', status: completionStatus });
        expect(await completion).toMatchObject({ status: completionStatus, swapped: false });
        const cancelled = await cancellation;
        const persisted = await baseStore.load(key);
        expect(['cancelled', 'unknown']).toContain(cancelled.status);
        expect(['cancelled', 'unknown']).toContain(persisted?.status);
        expect(persisted?.status).not.toBe(completionStatus);
      } finally {
        await cancellation?.catch(() => undefined);
        await stopChild(child);
      }
    },
  );

  it('reconciles and cancels an exact persisted worker from a fresh engine and store', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx persisted preparation restart '));
    roots.push(root);
    const key = 'restart-exact';
    const child = await startWorker(root, key);
    const processAdapter = new NodePreparationProcessAdapter(nativeFor(child), root);
    const worker = await persistWorker(root, key, child, processAdapter);

    try {
      const reconciled = await new PreparationEngine(
        adapters(
          new NodePreparationStore(root),
          new NodePreparationProcessAdapter(nativeFor(child), root),
        ),
      ).reconcile(key);
      expect(reconciled).toMatchObject({ status: 'preparing', worker });
      const cancelled = await new PreparationEngine(
        adapters(
          new NodePreparationStore(root),
          new NodePreparationProcessAdapter(nativeFor(child), root),
        ),
      ).cancel(key);
      expect(cancelled.status).toBe('cancelled');
      expect(() => process.kill(child.pid!, 0)).toThrow();
    } finally {
      await stopChild(child);
    }
  });

  it.each(['wrong-token', 'non-mpx-marker'] as const)(
    'does not terminate an active worker with a %s',
    async (markerCase) => {
      const root = await mkdtemp(path.join(tmpdir(), 'mpx persisted preparation marker '));
      roots.push(root);
      const key = markerCase;
      const child = await startWorker(root, key);
      let terminationCalls = 0;
      const native = nativeFor(child);
      const trackedNative: NativeProcessCapabilities = {
        ...native,
        terminateTree: async (identity) => {
          terminationCalls += 1;
          await native.terminateTree(identity);
        },
      };
      const processAdapter = new NodePreparationProcessAdapter(trackedNative, root);
      const worker = await persistWorker(root, key, child, processAdapter);
      const markerPath = path.join(root, 'owners', `${child.pid}.json`);
      await mkdir(path.dirname(markerPath), { recursive: true });
      await writeFile(
        markerPath,
        JSON.stringify(
          markerCase === 'wrong-token'
            ? { schemaVersion: 1, owner: 'mpx', ...worker, ownerToken: 'wrong-token' }
            : { schemaVersion: 1, owner: 'other', ...worker },
        ),
      );

      try {
        const result = await new PreparationEngine(
          adapters(
            new NodePreparationStore(root),
            new NodePreparationProcessAdapter(trackedNative, root),
          ),
        ).cancel(key);
        expect(result.status).toBe('unknown');
        expect(terminationCalls).toBe(0);
        expect(() => process.kill(child.pid!, 0)).not.toThrow();
      } finally {
        await stopChild(child);
      }
    },
  );
});
