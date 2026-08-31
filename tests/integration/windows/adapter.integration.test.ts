import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WindowsProcessCapabilities } from '@mpx/windows';

const fixture = path.resolve(import.meta.dirname, './fixtures/owned-process-tree.mjs');
const waitLimitMs = 5_000;
const pollMs = 20;

const waitFor = async (
  description: string,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> => {
  const deadline = Date.now() + waitLimitMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting for ${description}`);
};

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

interface OwnedTree {
  handle: ChildProcess;
  parentPid: number;
  childPid: number;
}

const startOwnedTree = async (
  directory: string,
  name: string,
  handles: ChildProcess[],
  mode: 'parent' | 'adversarial-parent' = 'parent',
): Promise<OwnedTree> => {
  const readyPath = path.join(directory, `${name}.json`);
  const handle = spawn(process.execPath, [fixture, mode, readyPath], {
    stdio: 'ignore',
    windowsHide: true,
  });
  handles.push(handle);
  let spawnError: Error | undefined;
  handle.once('error', (error) => {
    spawnError = error;
  });
  let ready: { parentPid: number; childPid: number } | undefined;
  await waitFor(`${name} fixture readiness`, async () => {
    if (spawnError) {
      throw spawnError;
    }
    if (handle.exitCode !== null) {
      throw new Error(`${name} fixture exited with ${handle.exitCode}`);
    }
    try {
      ready = JSON.parse(await readFile(readyPath, 'utf8'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  });
  if (!ready || handle.pid !== ready.parentPid) {
    throw new Error(`${name} fixture reported invalid readiness`);
  }
  return { handle, ...ready };
};

const startSentinel = async (directory: string, handles: ChildProcess[]): Promise<ChildProcess> => {
  const readyPath = path.join(directory, 'sentinel.json');
  const handle = spawn(process.execPath, [fixture, 'child', readyPath, String(process.pid)], {
    stdio: 'ignore',
    windowsHide: true,
  });
  handles.push(handle);
  let spawnError: Error | undefined;
  handle.once('error', (error) => {
    spawnError = error;
  });
  await waitFor('sentinel readiness', async () => {
    if (spawnError) {
      throw spawnError;
    }
    if (handle.exitCode !== null) {
      throw new Error(`Sentinel exited with ${handle.exitCode}`);
    }
    try {
      const ready = JSON.parse(await readFile(readyPath, 'utf8')) as { pid?: number };
      return ready.pid === handle.pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  });
  return handle;
};

const cleanupHandles = async (handles: readonly ChildProcess[]): Promise<void> => {
  for (const handle of handles) {
    if (handle.exitCode === null && handle.signalCode === null) {
      handle.kill();
    }
  }
  await Promise.all(
    handles.map(async (handle) => {
      await waitFor(
        `PID ${handle.pid ?? 'unknown'} cleanup`,
        () => handle.exitCode !== null || handle.signalCode !== null,
      );
    }),
  );
};

describe.runIf(process.platform === 'win32')(
  'WindowsProcessCapabilities real process-tree safety',
  () => {
    it('reports a nonexistent root as missing without killing an owned process tree', async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'mpx-windows-tree-'));
      const handles: ChildProcess[] = [];
      try {
        const tree = await startOwnedTree(directory, 'owned', handles);
        const capabilities = new WindowsProcessCapabilities();
        const nonexistentPid = 2_147_483_647;

        expect(await capabilities.inspect(nonexistentPid)).toBeUndefined();
        await expect(
          capabilities.terminateTree({
            pid: nonexistentPid,
            startFingerprint: 'not-a-real-fingerprint',
          }),
        ).rejects.toMatchObject({ code: 'PROCESS_DISAPPEARED' });
        expect(processExists(tree.parentPid)).toBe(true);
        expect(processExists(tree.childPid)).toBe(true);
      } finally {
        await cleanupHandles(handles);
        await rm(directory, { recursive: true, force: true });
      }
    }, 10_000);

    it('rejects a wrong start fingerprint and leaves the owned parent and child alive', async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'mpx-windows-tree-'));
      const handles: ChildProcess[] = [];
      try {
        const tree = await startOwnedTree(directory, 'owned', handles);
        const capabilities = new WindowsProcessCapabilities();
        const inspected = await capabilities.inspect(tree.parentPid);
        if (!inspected) {
          throw new Error('Owned fixture disappeared before inspection');
        }

        await expect(
          capabilities.terminateTree({
            ...inspected,
            startFingerprint: `${inspected.startFingerprint}-wrong`,
          }),
        ).rejects.toMatchObject({ code: 'PROCESS_FINGERPRINT_MISMATCH' });
        expect(processExists(tree.parentPid)).toBe(true);
        expect(processExists(tree.childPid)).toBe(true);
      } finally {
        await cleanupHandles(handles);
        await rm(directory, { recursive: true, force: true });
      }
    }, 10_000);

    it('terminates only the tree identified by its exact inspected fingerprint', async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'mpx-windows-tree-'));
      const handles: ChildProcess[] = [];
      try {
        const tree = await startOwnedTree(directory, 'owned', handles);
        const sentinel = await startSentinel(directory, handles);
        const capabilities = new WindowsProcessCapabilities();
        const inspected = await capabilities.inspect(tree.parentPid);
        if (!inspected) {
          throw new Error('Owned fixture disappeared before inspection');
        }

        await capabilities.terminateTree(inspected);
        await waitFor(
          'owned parent termination',
          () => tree.handle.exitCode !== null || tree.handle.signalCode !== null,
        );
        await waitFor('owned child termination', () => !processExists(tree.childPid));
        expect(processExists(tree.parentPid)).toBe(false);
        expect(processExists(sentinel.pid!)).toBe(true);
      } finally {
        await cleanupHandles(handles);
        await rm(directory, { recursive: true, force: true });
      }
    }, 10_000);

    it('stops a delayed grandchild created during cancellation while preserving a sentinel', async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'mpx-windows-tree-'));
      const handles: ChildProcess[] = [];
      try {
        const tree = await startOwnedTree(directory, 'adversarial', handles, 'adversarial-parent');
        const sentinel = await startSentinel(directory, handles);
        const capabilities = new WindowsProcessCapabilities();
        const inspected = await capabilities.inspect(tree.parentPid);
        if (!inspected) {
          throw new Error('Owned fixture disappeared before inspection');
        }

        await writeFile(path.join(directory, 'adversarial.json.cancel'), 'cancel', 'utf8');
        await capabilities.terminateTree(inspected);
        const grandchildReadyPath = path.join(directory, 'adversarial.json.child.grandchild');
        let grandchildPid: number | undefined;
        await waitFor('delayed grandchild creation', async () => {
          try {
            grandchildPid = (
              JSON.parse(await readFile(grandchildReadyPath, 'utf8')) as { pid?: number }
            ).pid;
            return typeof grandchildPid === 'number';
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return false;
            }
            throw error;
          }
        });
        await waitFor(
          'owned parent termination',
          () => tree.handle.exitCode !== null || tree.handle.signalCode !== null,
        );
        await waitFor('owned child termination', () => !processExists(tree.childPid));
        await waitFor(
          'owned delayed grandchild termination',
          () => grandchildPid !== undefined && !processExists(grandchildPid),
        );
        expect(processExists(tree.parentPid)).toBe(false);
        expect(processExists(tree.childPid)).toBe(false);
        expect(processExists(grandchildPid!)).toBe(false);
        expect(processExists(sentinel.pid!)).toBe(true);
      } finally {
        await cleanupHandles(handles);
        await rm(directory, { recursive: true, force: true });
      }
    }, 15_000);
  },
);
