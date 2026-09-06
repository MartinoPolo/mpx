import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { connect } from 'node:net';
import { promisify } from 'node:util';

import type { ManagedChild, ProcessExit, RuntimeAdapter, SpawnSpec } from './manager.js';

const runFile = promisify(execFile);
const STOP_TIMEOUT_MS = 5_000;
const CLOSE_GRACE_MS = 2_000;

class SystemChild implements ManagedChild {
  readonly pid: number;
  readonly stdout;
  readonly stderr;
  readonly closed: Promise<ProcessExit>;
  readonly process: ChildProcessWithoutNullStreams;
  readonly #listeners: Array<(exit: ProcessExit) => void> = [];
  readonly #errorListeners: Array<(error: Error) => void> = [];
  settled = false;
  exit: ProcessExit | undefined;
  error: Error | undefined;

  constructor(process: ChildProcessWithoutNullStreams) {
    if (process.pid === undefined) {
      process.once('error', () => {});
      throw new Error('Spawned dev server has no process id.');
    }
    this.process = process;
    this.pid = process.pid;
    this.stdout = process.stdout;
    this.stderr = process.stderr;
    this.closed = new Promise((resolve) => {
      process.once('close', (code, signal) => {
        this.settled = true;
        const exit = { code, signal };
        this.exit = exit;
        resolve(exit);
        for (const listener of this.#listeners.splice(0)) {
          listener(exit);
        }
      });
    });
    process.once('error', (error) => {
      this.error = error;
      for (const listener of this.#errorListeners.splice(0)) {
        listener(error);
      }
    });
  }

  onClose(listener: (exit: ProcessExit) => void): void {
    if (this.exit !== undefined) {
      listener(this.exit);
    } else {
      this.#listeners.push(listener);
    }
  }

  onError(listener: (error: Error) => void): void {
    if (this.error !== undefined) {
      listener(this.error);
    } else {
      this.#errorListeners.push(listener);
    }
  }
}

export function systemSpawnInvocation(
  command: string,
  platform = process.platform,
): {
  file: string;
  args: string[];
  detached: boolean;
} {
  return platform === 'win32'
    ? { file: 'cmd.exe', args: ['/d', '/s', '/c', command], detached: false }
    : { file: '/bin/sh', args: ['-c', command], detached: true };
}

export function createSystemRuntime(): RuntimeAdapter {
  return {
    now: () => new Date().toISOString(),
    sleep: (milliseconds) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        timer.unref?.();
      }),
    spawn(spec: SpawnSpec): ManagedChild {
      const invocation = systemSpawnInvocation(spec.command);
      const child = spawn(invocation.file, invocation.args, {
        cwd: spec.cwd,
        detached: invocation.detached,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      return new SystemChild(child as unknown as ChildProcessWithoutNullStreams);
    },
    probe(port: number): Promise<boolean> {
      return new Promise((resolve) => {
        const socket = connect({ host: 'localhost', port });
        let settled = false;
        const finish = (ready: boolean): void => {
          if (settled) {
            return;
          }
          settled = true;
          socket.destroy();
          resolve(ready);
        };
        socket.setTimeout(400);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
      });
    },
    async stop(child: ManagedChild): Promise<void> {
      const systemChild = child as SystemChild;
      if (systemChild.settled) {
        return;
      }
      if (process.platform === 'win32') {
        try {
          await runFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            timeout: STOP_TIMEOUT_MS,
            windowsHide: true,
          });
        } catch (error) {
          if (!systemChild.settled && !(await settlesWithin(child.closed, CLOSE_GRACE_MS))) {
            throw error;
          }
          return;
        }
        await waitBounded(child.closed, CLOSE_GRACE_MS);
        return;
      }

      tryKillGroup(child.pid, 'SIGTERM');
      if (await settlesWithin(child.closed, STOP_TIMEOUT_MS)) {
        return;
      }
      tryKillGroup(child.pid, 'SIGKILL');
      await waitBounded(child.closed, CLOSE_GRACE_MS);
    },
  };
}

function tryKillGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), milliseconds);
    }),
  ]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  return result;
}

async function waitBounded(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  if (!(await settlesWithin(promise, milliseconds))) {
    throw new Error('Timed out waiting for the dev server process tree to close.');
  }
}
