import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'vitest';

import {
  DevServerManager,
  type ManagedChild,
  type RuntimeAdapter,
  type SpawnSpec,
} from '../../../dev-server/manager.js';

class FakeChild extends EventEmitter implements ManagedChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly closed: Promise<{ code: number | null; signal: string | null }>;
  private resolveClosed!: (exit: { code: number | null; signal: string | null }) => void;

  readonly pid: number;

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  exit(code: number | null = 0, signal: string | null = null): void {
    const exit = { code, signal };
    this.emit('close', exit);
    this.resolveClosed(exit);
  }

  onClose(listener: (exit: { code: number | null; signal: string | null }) => void): void {
    this.on('close', listener);
  }
}

class FakeRuntime implements RuntimeAdapter {
  children: FakeChild[] = [];
  stopCalls: number[] = [];
  probes = new Map<number, boolean[]>();
  specs: SpawnSpec[] = [];
  #pid = 100;
  #tick = 0;

  now = () => new Date(1_700_000_000_000 + this.#tick++).toISOString();
  sleep = async () => {};
  spawn = (spec: SpawnSpec): ManagedChild => {
    this.specs.push(spec);
    const child = new FakeChild(this.#pid++);
    this.children.push(child);
    return child;
  };
  probe = async (port: number) => this.probes.get(port)?.shift() ?? false;
  stop = async (child: ManagedChild) => {
    this.stopCalls.push(child.pid);
    (child as FakeChild).exit(null, 'SIGTERM');
  };
}

function createManager(runtime = new FakeRuntime()) {
  const events: unknown[] = [];
  return {
    runtime,
    events,
    manager: new DevServerManager(runtime, (snapshot) => events.push(snapshot)),
  };
}

test('launch reserves an id and publishes an immutable ready snapshot immediately when no ports are configured', async () => {
  const { manager, runtime, events } = createManager();
  const snapshot = await manager.start({
    id: 'web',
    command: 'npm run dev',
    cwd: 'C:/repo',
    ports: [],
  });

  assert.equal(snapshot.state, 'ready');
  assert.equal(snapshot.pid, 100);
  assert.equal(snapshot.run, 1);
  assert.equal(snapshot.generation, 1);
  assert.ok(snapshot.startedAt);
  assert.ok(snapshot.readyAt);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.ports), true);
  assert.equal(runtime.specs[0]?.command, 'npm run dev');
  assert.deepEqual(events, [events[0], snapshot]);
});

test('readiness uses non-overlapping probes until every configured localhost port listens', async () => {
  const { manager, runtime } = createManager();
  runtime.probes.set(3000, [false, true]);
  runtime.probes.set(3001, [true, true]);

  const snapshot = await manager.start({
    id: 'web',
    command: 'serve',
    cwd: 'C:/repo',
    ports: [3000, 3001],
  });
  assert.equal(snapshot.state, 'starting');
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(manager.status('web')!.state, 'ready');
  assert.deepEqual(manager.status('web')!.readyPorts, [3000, 3001]);
  assert.deepEqual(runtime.probes.get(3000), []);
  assert.deepEqual(runtime.probes.get(3001), []);
});

test('stdout and stderr stream errors are observed with contextual latest error', async () => {
  const { manager, runtime } = createManager();
  await manager.start({ id: 'web', command: 'serve', cwd: 'C:/repo', ports: [] });

  assert.doesNotThrow(() => runtime.children[0]!.stdout.emit('error', new Error('output failed')));
  assert.equal(manager.status('web')!.lastError, 'stdout stream: output failed');
  assert.doesNotThrow(() =>
    runtime.children[0]!.stderr.emit('error', new Error('diagnostics failed')),
  );
  assert.equal(manager.status('web')!.lastError, 'stderr stream: diagnostics failed');
});

test('an unexpected exit, including code zero, is crashed', async () => {
  const { manager, runtime } = createManager();
  await manager.start({ id: 'web', command: 'serve', cwd: 'C:/repo', ports: [] });
  runtime.children[0]!.exit(0);
  await Promise.resolve();

  const snapshot = manager.status('web')!;
  assert.equal(snapshot.state, 'crashed');
  assert.equal(snapshot.exitCode, 0);
  assert.equal(snapshot.exitStatus, 'exited 0');
});

test('a requested stop terminates the owned process tree and becomes stopped', async () => {
  const { manager, runtime } = createManager();
  await manager.start({ id: 'web', command: 'serve', cwd: 'C:/repo', ports: [] });

  const snapshot = await manager.stop('web');

  assert.equal(snapshot.state, 'stopped');
  assert.deepEqual(runtime.stopCalls, [100]);
  assert.equal(snapshot.exitSignal, 'SIGTERM');
});

test('restart serializes stop and launch, increments run, and preserves logs from both runs', async () => {
  const { manager, runtime } = createManager();
  await manager.start({ id: 'web', command: 'serve', cwd: 'C:/repo', ports: [] });
  runtime.children[0]!.stdout.write('first\n');

  const snapshot = await manager.restart('web');
  runtime.children[1]!.stderr.write('second\n');

  assert.equal(snapshot.run, 2);
  assert.equal(snapshot.pid, 101);
  assert.deepEqual(
    manager.logEntries('web').map(({ run, text }) => ({ run, text })),
    [
      { run: 1, text: 'first' },
      { run: 2, text: 'second' },
    ],
  );
});

test('generation guards ignore stale process callbacks after restart', async () => {
  const { manager, runtime } = createManager();
  await manager.start({ id: 'web', command: 'serve', cwd: 'C:/repo', ports: [] });
  await manager.restart('web');
  runtime.children[0]!.exit(9);
  await Promise.resolve();

  assert.equal(manager.status('web')!.state, 'ready');
  assert.equal(manager.status('web')!.pid, 101);
});

test('duplicate starts observe the synchronous id reservation', async () => {
  const { manager } = createManager();
  const first = manager.start({ id: 'web', command: 'serve', cwd: 'C:/repo', ports: [] });
  const duplicate = manager.start({ id: 'web', command: 'other', cwd: 'C:/repo', ports: [] });

  await assert.rejects(duplicate, /already exists/);
  await first;
});

test('shutdown interrupts an in-flight readiness wait without leaking its process', async () => {
  const { manager, runtime } = createManager();
  runtime.probes.set(3000, [false]);
  const starting = manager.start({ id: 'web', command: 'serve', cwd: 'C:/repo', ports: [3000] });

  const shutdown = manager.shutdown();
  await Promise.all([starting, shutdown]);

  assert.deepEqual(runtime.stopCalls, [100]);
  assert.equal(manager.status('web')!.state, 'stopped');
});

test('a pending probe does not block start or overlap, and stale completion after stop is ignored', async () => {
  const runtime = new FakeRuntime();
  let resolveProbe!: (ready: boolean) => void;
  let active = 0;
  let maximumActive = 0;
  runtime.probe = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const ready = await new Promise<boolean>((resolve) => {
      resolveProbe = resolve;
    });
    active -= 1;
    return ready;
  };
  const { manager } = createManager(runtime);

  const snapshot = await manager.start({
    id: 'web',
    command: 'serve',
    cwd: 'C:/repo',
    ports: [3000],
  });
  assert.equal(snapshot.state, 'starting');
  assert.equal(active, 1);
  const stopped = await manager.stop('web');
  assert.equal(stopped.state, 'stopped');
  resolveProbe(true);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(maximumActive, 1);
  assert.equal(manager.status('web')!.state, 'stopped');
});

test('shutdown waits for an in-flight readiness probe after stopping its process', async () => {
  const runtime = new FakeRuntime();
  let resolveProbe!: (ready: boolean) => void;
  runtime.probe = () =>
    new Promise<boolean>((resolve) => {
      resolveProbe = resolve;
    });
  const { manager } = createManager(runtime);
  await manager.start({ id: 'web', command: 'serve', cwd: 'C:/repo', ports: [3000] });

  let settled = false;
  const shutdown = manager.shutdown().then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.stopCalls, [100]);
  assert.equal(settled, false);

  resolveProbe(false);
  await shutdown;
  assert.equal(manager.status('web')!.state, 'stopped');
});

test('shutdown closes the start and restart gates and memoizes cleanup', async () => {
  const { manager, runtime } = createManager();
  await manager.start({ id: 'web', command: 'serve', cwd: 'C:/repo', ports: [] });

  const first = manager.shutdown();
  const second = manager.shutdown();
  assert.equal(first, second);
  await assert.rejects(
    manager.start({ id: 'api', command: 'serve', cwd: 'C:/repo', ports: [] }),
    /shutting down/,
  );
  await assert.rejects(manager.restart('web'), /shutting down/);
  await Promise.all([first, second]);

  assert.deepEqual(runtime.stopCalls, [100]);
  assert.equal(manager.status('web')!.state, 'stopped');
});

test('shutdown attempts every record and reports cleanup failures', async () => {
  const runtime = new FakeRuntime();
  runtime.stop = async (child) => {
    runtime.stopCalls.push(child.pid);
    if (child.pid === 100) {
      throw new Error('cannot stop web');
    }
    (child as FakeChild).exit(null, 'SIGTERM');
  };
  const { manager } = createManager(runtime);
  await manager.start({ id: 'web', command: 'serve', cwd: 'C:/repo', ports: [] });
  await manager.start({ id: 'api', command: 'serve', cwd: 'C:/repo', ports: [] });

  const shutdown = manager.shutdown();
  await assert.rejects(shutdown, (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    assert.match((error as AggregateError).message, /cleanup/);
    assert.deepEqual((error as AggregateError).errors, [new Error('cannot stop web')]);
    return true;
  });

  assert.deepEqual(runtime.stopCalls, [100, 101]);
  assert.equal(manager.status('web')!.lastError, 'cannot stop web');
  assert.equal(manager.status('api')!.state, 'stopped');
  const repeatedShutdown = manager.shutdown();
  assert.equal(repeatedShutdown, shutdown);
  await assert.rejects(repeatedShutdown, /cleanup/);
});
