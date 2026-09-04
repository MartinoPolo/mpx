import type { Readable } from 'node:stream';

import { RollingLogBuffer, type LogEntry } from './log-buffer.js';
import type { DevServerSnapshot, DevServerState } from './contract.js';

export type { DevServerSnapshot } from './contract.js';

export interface SpawnSpec {
  readonly command: string;
  readonly cwd: string;
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface ManagedChild {
  readonly pid: number;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly closed: Promise<ProcessExit>;
  onClose(listener: (exit: ProcessExit) => void): void;
  onError?(listener: (error: Error) => void): void;
}

export interface RuntimeAdapter {
  spawn(spec: SpawnSpec): ManagedChild;
  probe(port: number): Promise<boolean>;
  stop(child: ManagedChild): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
  now(): string;
}

export interface StartOptions {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly ports?: readonly number[];
}

interface RecordState {
  id: string;
  state: DevServerState;
  child: ManagedChild | null;
  pid: number | null;
  cwd: string;
  command: string;
  ports: number[];
  readyPorts: number[];
  run: number;
  generation: number;
  createdAt: string;
  startedAt: string | null;
  readyAt: string | null;
  stoppedAt: string | null;
  exitedAt: string | null;
  updatedAt: string;
  exitCode: number | null;
  exitSignal: string | null;
  exitStatus: string | null;
  lastError: string | null;
  stopRequested: boolean;
  queue: Promise<void>;
  logs: RollingLogBuffer;
  readinessTask: Promise<void> | null;
}

export class DevServerManager {
  readonly #records = new Map<string, RecordState>();
  readonly runtime: RuntimeAdapter;
  readonly publish: (snapshot: DevServerSnapshot) => void;
  readonly readinessIntervalMs: number;
  #shuttingDown = false;
  #shutdownPromise: Promise<void> | undefined;

  constructor(
    runtime: RuntimeAdapter,
    publish: (snapshot: DevServerSnapshot) => void = () => {},
    readinessIntervalMs = 200,
  ) {
    this.runtime = runtime;
    this.publish = publish;
    this.readinessIntervalMs = readinessIntervalMs;
  }

  start(options: StartOptions): Promise<DevServerSnapshot> {
    try {
      this.assertStartAllowed();
      const normalized = this.normalize(options);
      if (this.#records.has(normalized.id))
        throw new Error(`Dev server '${normalized.id}' already exists.`);
      const now = this.runtime.now();
      const record: RecordState = {
        ...normalized,
        state: 'starting',
        child: null,
        pid: null,
        readyPorts: [],
        run: 0,
        generation: 0,
        createdAt: now,
        startedAt: null,
        readyAt: null,
        stoppedAt: null,
        exitedAt: null,
        updatedAt: now,
        exitCode: null,
        exitSignal: null,
        exitStatus: null,
        lastError: null,
        stopRequested: false,
        queue: Promise.resolve(),
        logs: new RollingLogBuffer(),
        readinessTask: null,
      };
      // Reservation happens before spawn and before this method returns its promise.
      this.#records.set(record.id, record);
      return this.launch(record);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  status(id: string): DevServerSnapshot | undefined {
    const record = this.#records.get(id);
    return record === undefined ? undefined : this.snapshot(record);
  }

  list(): readonly DevServerSnapshot[] {
    return [...this.#records.values()].map((record) => this.snapshot(record));
  }

  logs(id: string, options: { maxCharacters?: number; maxLines?: number } = {}): string {
    return this.require(id).logs.present(options);
  }

  logEntries(id: string): readonly LogEntry[] {
    return this.require(id).logs.entries();
  }

  stop(id: string): Promise<DevServerSnapshot> {
    const record = this.require(id);
    // Interrupt an in-flight readiness wait before joining the mutation queue.
    if (record.child !== null) record.stopRequested = true;
    return this.enqueue(record, async () => {
      await this.stopInternal(record);
      return this.snapshot(record);
    });
  }

  restart(id: string): Promise<DevServerSnapshot> {
    if (this.#shuttingDown)
      return Promise.reject(new Error('Dev server manager is shutting down.'));
    const record = this.require(id);
    return this.enqueue(record, async () => {
      this.assertStartAllowed();
      await this.stopInternal(record);
      this.assertStartAllowed();
      return this.launch(record);
    });
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    this.#shuttingDown = true;
    const records = [...this.#records.values()];
    for (const record of records) {
      if (record.child !== null) record.stopRequested = true;
    }
    const readinessTasks = records.flatMap((record) =>
      record.readinessTask === null ? [] : [record.readinessTask],
    );
    const stopOperations = records.map((record) =>
      this.enqueue(record, async () => {
        await this.stopInternal(record);
      }),
    );
    this.#shutdownPromise = (async () => {
      const [stopResults] = await Promise.all([
        Promise.allSettled(stopOperations),
        Promise.allSettled(readinessTasks),
      ]);
      const stopFailures = stopResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (stopFailures.length > 0) {
        throw new AggregateError(
          stopFailures,
          'Failed to stop one or more dev servers during cleanup.',
        );
      }
    })();
    return this.#shutdownPromise;
  }

  private async launch(record: RecordState): Promise<DevServerSnapshot> {
    const generation = ++record.generation;
    record.run += 1;
    record.state = 'starting';
    record.stopRequested = false;
    record.readyPorts = [];
    record.startedAt = this.runtime.now();
    record.readyAt = null;
    record.stoppedAt = null;
    record.exitedAt = null;
    record.exitCode = null;
    record.exitSignal = null;
    record.exitStatus = null;
    record.lastError = null;
    record.logs.beginRun(record.run);

    let child: ManagedChild;
    try {
      child = this.runtime.spawn({ command: record.command, cwd: record.cwd });
    } catch (error) {
      record.child = null;
      record.pid = null;
      record.state = 'crashed';
      record.exitedAt = this.runtime.now();
      record.lastError = error instanceof Error ? error.message : String(error);
      this.emit(record);
      return this.snapshot(record);
    }
    record.child = child;
    record.pid = child.pid;
    child.stdout.on('data', (chunk: Uint8Array) => {
      if (record.generation === generation) record.logs.write('stdout', chunk);
    });
    child.stderr.on('data', (chunk: Uint8Array) => {
      if (record.generation === generation) record.logs.write('stderr', chunk);
    });
    const handleStreamError = (stream: 'stdout' | 'stderr', error: Error): void => {
      if (record.generation !== generation) return;
      record.lastError = `${stream} stream: ${error.message}`;
      this.emit(record);
    };
    child.stdout.on('error', (error: Error) => handleStreamError('stdout', error));
    child.stderr.on('error', (error: Error) => handleStreamError('stderr', error));
    child.onClose((exit) => this.handleClose(record, generation, exit));
    child.onError?.((error) => {
      if (record.generation !== generation) return;
      record.lastError = error.message;
      this.emit(record);
    });
    this.emit(record);

    if (record.ports.length === 0) {
      this.markReady(record, generation, []);
    } else {
      const task = this.monitorReadiness(record, generation);
      record.readinessTask = task;
      void task
        .catch((error) => {
          if (record.generation !== generation || record.state !== 'starting') return;
          record.lastError = error instanceof Error ? error.message : String(error);
          this.emit(record);
        })
        .finally(() => {
          if (record.readinessTask === task) record.readinessTask = null;
        });
    }
    return this.snapshot(record);
  }

  private async monitorReadiness(record: RecordState, generation: number): Promise<void> {
    while (
      record.generation === generation &&
      record.state === 'starting' &&
      !record.stopRequested
    ) {
      const results = await Promise.all(
        record.ports.map(async (port) => ({ port, ready: await this.runtime.probe(port) })),
      );
      if (record.generation !== generation || record.state !== 'starting' || record.stopRequested)
        return;
      const readyPorts = results.filter((result) => result.ready).map((result) => result.port);
      if (!sameNumbers(record.readyPorts, readyPorts)) {
        record.readyPorts = readyPorts;
        this.emit(record);
      }
      if (readyPorts.length === record.ports.length) {
        this.markReady(record, generation, readyPorts);
        return;
      }
      await this.runtime.sleep(this.readinessIntervalMs);
    }
  }

  private markReady(record: RecordState, generation: number, ports: readonly number[]): void {
    if (record.generation !== generation || record.state !== 'starting') return;
    record.state = 'ready';
    record.readyPorts = [...ports];
    record.readyAt = this.runtime.now();
    this.emit(record);
  }

  private handleClose(record: RecordState, generation: number, exit: ProcessExit): void {
    if (record.generation !== generation) return;
    const stopRequested = record.stopRequested;
    record.stopRequested = true;
    record.logs.flush();
    record.child = null;
    record.pid = null;
    record.exitedAt = this.runtime.now();
    record.exitCode = exit.code;
    record.exitSignal = exit.signal;
    record.exitStatus =
      exit.code !== null
        ? `exited ${exit.code}`
        : exit.signal !== null
          ? `signaled ${exit.signal}`
          : 'exited';
    if (stopRequested) {
      record.state = 'stopped';
      record.stoppedAt = record.exitedAt;
    } else {
      record.state = 'crashed';
    }
    this.emit(record);
  }

  private async stopInternal(record: RecordState): Promise<void> {
    const child = record.child;
    if (child === null || record.state === 'stopped' || record.state === 'crashed') return;
    record.stopRequested = true;
    try {
      await this.runtime.stop(child);
      await child.closed;
    } catch (error) {
      // A concurrently exited process is already handled by its close callback.
      if (record.child !== null) {
        record.lastError = error instanceof Error ? error.message : String(error);
        this.emit(record);
        throw error;
      }
    }
    if (record.child === child) {
      record.child = null;
      record.pid = null;
      record.state = 'stopped';
      record.stoppedAt = this.runtime.now();
      record.exitedAt ??= record.stoppedAt;
      this.emit(record);
    }
  }

  private enqueue<T>(record: RecordState, operation: () => Promise<T>): Promise<T> {
    const result = record.queue.then(operation, operation);
    record.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private emit(record: RecordState): void {
    record.updatedAt = this.runtime.now();
    this.publish(this.snapshot(record));
  }

  private snapshot(record: RecordState): DevServerSnapshot {
    return Object.freeze({
      id: record.id,
      state: record.state,
      pid: record.pid,
      cwd: record.cwd,
      command: record.command,
      ports: Object.freeze([...record.ports]),
      readyPorts: Object.freeze([...record.readyPorts]),
      run: record.run,
      generation: record.generation,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      readyAt: record.readyAt,
      stoppedAt: record.stoppedAt,
      exitedAt: record.exitedAt,
      updatedAt: record.updatedAt,
      exitCode: record.exitCode,
      exitSignal: record.exitSignal,
      exitStatus: record.exitStatus,
      lastError: record.lastError,
    });
  }

  private normalize(options: StartOptions): Pick<RecordState, 'id' | 'command' | 'cwd' | 'ports'> {
    const id = options.id.trim();
    const command = options.command.trim();
    const cwd = options.cwd.trim();
    if (id === '') throw new Error('Dev server id is required.');
    if (command === '') throw new Error('Dev server command is required.');
    if (cwd === '') throw new Error('Dev server cwd is required.');
    const ports = [...new Set(options.ports ?? [])];
    if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new Error('Dev server ports must be integers from 1 through 65535.');
    }
    return { id, command, cwd, ports };
  }

  private require(id: string): RecordState {
    const record = this.#records.get(id);
    if (record === undefined) throw new Error(`Unknown dev server '${id}'.`);
    return record;
  }

  private assertStartAllowed(): void {
    if (this.#shuttingDown) throw new Error('Dev server manager is shutting down.');
  }
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
