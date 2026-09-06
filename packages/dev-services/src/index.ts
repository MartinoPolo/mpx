import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { PassThrough, type Readable } from 'node:stream';
import { WindowsProcessCapabilities } from '@mpx/windows';

export * from './tool-adapter.js';

export const DEV_SERVICES_CHANGED_EVENT = 'dev-services:changed';
export type DevServiceState = 'starting' | 'ready' | 'crashed' | 'stopped';
export type ExecutorKind = 'host' | 'docker';
export interface PortAssignment {
  readonly worktreeRoot: string;
  readonly ports: readonly number[];
}
export interface StartRequest {
  readonly id: string;
  readonly executable: string;
  /** Set only by a trusted composition after fixed-candidate resolution. */
  readonly trustedAbsoluteExecutable?: true;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly ports: readonly number[];
  readonly assignment: PortAssignment;
  readonly executor: ExecutorKind;
  readonly environment?: Readonly<Record<string, string>>;
  readonly logFile?: string;
}
export interface ProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
}
export interface ManagedProcess {
  readonly pid: number;
  readonly fingerprint: string;
  readonly childIdentity?: { readonly pid: number; readonly fingerprint: string } | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly closed: Promise<ProcessExit>;
  onClose(listener: (exit: ProcessExit) => void): void;
  onError?(listener: (error: Error) => void): void;
}
export interface RuntimeAdapter {
  readonly kind: ExecutorKind;
  spawn(request: StartRequest): ManagedProcess | Promise<ManagedProcess>;
  probe(port: number): Promise<boolean>;
  inspect(pid: number): Promise<{ pid: number; fingerprint: string } | undefined>;
  stop(process: ManagedProcess): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): string;
}
export interface DevServiceSnapshot {
  readonly id: string;
  readonly state: DevServiceState;
  readonly pid: number | null;
  readonly fingerprint: string | null;
  readonly childPid?: number | null;
  readonly childFingerprint?: string | null;
  readonly cwd: string;
  readonly command: string;
  readonly ports: readonly number[];
  readonly readyPorts: readonly number[];
  readonly run: number;
  readonly generation: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly readyAt: string | null;
  readonly stoppedAt: string | null;
  readonly exitedAt: string | null;
  readonly updatedAt: string;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly lastError: string | null;
}
export interface DevServiceStatusEvent {
  readonly type: typeof DEV_SERVICES_CHANGED_EVENT;
  readonly snapshot: DevServiceSnapshot;
}

interface AtomicReplaceOptions {
  platform?: NodeJS.Platform;
  rename?: (temporary: string, destination: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
}
const WINDOWS_ATOMIC_REPLACE_RETRIES = 5;
const WINDOWS_ATOMIC_REPLACE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
export async function replaceAtomicFile(
  temporary: string,
  destination: string,
  options: AtomicReplaceOptions = {},
): Promise<void> {
  const move = options.rename ?? rename,
    platform = options.platform ?? process.platform,
    pause =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; ; attempt++) {
    try {
      await move(temporary, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        platform !== 'win32' ||
        !WINDOWS_ATOMIC_REPLACE_ERRORS.has(code ?? '') ||
        attempt >= WINDOWS_ATOMIC_REPLACE_RETRIES
      ) {
        throw error;
      }
      await pause(10 * (attempt + 1));
    }
  }
}

function canonical(value: string): string {
  const win = path.win32.isAbsolute(value);
  return (
    win
      ? path.win32.normalize(value).replaceAll('\\', '/').toLowerCase()
      : path.resolve(value).replaceAll('\\', '/')
  ).replace(/\/$/u, '');
}
function within(root: string, candidate: string): boolean {
  const r = canonical(root),
    c = canonical(candidate);
  return c === r || c.startsWith(`${r}/`);
}
const safeExecutable = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}(?:\.exe|\.cmd)?$/iu;
export function assertExecutorBoundary(selected: ExecutorKind, runtime: ExecutorKind): void {
  if (selected !== runtime) {
    throw new Error(
      selected === 'docker'
        ? 'Docker executor development services require a Docker runtime adapter; host execution is forbidden.'
        : 'Selected executor does not match the development-service runtime.',
    );
  }
}
export function validateStartRequest(request: StartRequest): StartRequest {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(request.id)) {
    throw new Error('Dev service id must be a bounded safe label.');
  }
  const absoluteExecutable =
    path.win32.isAbsolute(request.executable) || path.posix.isAbsolute(request.executable);
  if (
    absoluteExecutable
      ? request.trustedAbsoluteExecutable !== true
      : !safeExecutable.test(request.executable)
  ) {
    throw new Error('Dev service executable must be a safe label or trusted absolute program.');
  }
  if (
    !Array.isArray(request.args) ||
    request.args.some((arg) => typeof arg !== 'string' || /[\0\r\n]/u.test(arg))
  ) {
    throw new Error('Dev service arguments are invalid.');
  }
  const environment = request.environment ?? {};
  if (
    Object.entries(environment).some(
      ([key, value]) =>
        !/^[A-Z_][A-Z0-9_]{0,63}$/u.test(key) ||
        typeof value !== 'string' ||
        /[\0\r\n]/u.test(value) ||
        value.length > 4096,
    )
  ) {
    throw new Error('Dev service environment is invalid.');
  }
  if (!path.win32.isAbsolute(request.cwd) && !path.posix.isAbsolute(request.cwd)) {
    throw new Error('Dev service cwd must be absolute.');
  }
  if (!within(request.assignment.worktreeRoot, request.cwd)) {
    throw new Error('Dev service cwd must remain inside the assigned worktree.');
  }
  const valid = (ports: readonly number[]) =>
    ports.every((p) => Number.isInteger(p) && p > 0 && p <= 65535) &&
    new Set(ports).size === ports.length;
  if (
    !valid(request.ports) ||
    !valid(request.assignment.ports) ||
    request.ports.length !== request.assignment.ports.length ||
    request.ports.some((p) => !request.assignment.ports.includes(p))
  ) {
    throw new Error('Readiness ports must exactly match ports assigned to this worktree.');
  }
  return Object.freeze({
    ...request,
    cwd: canonical(request.cwd),
    args: Object.freeze([...request.args]),
    environment: Object.freeze({ ...environment }),
    ports: Object.freeze([...request.ports]),
    assignment: Object.freeze({
      ...request.assignment,
      worktreeRoot: canonical(request.assignment.worktreeRoot),
      ports: Object.freeze([...request.assignment.ports]),
    }),
  });
}
function displayCommand(request: Pick<StartRequest, 'executable' | 'args'>): string {
  return [request.executable, ...request.args].map((v) => JSON.stringify(v)).join(' ');
}

type StreamName = 'stdout' | 'stderr';
interface StreamState {
  decoder: StringDecoder;
  partial: string;
  pendingCr: boolean;
}
const controls =
  /(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001bP[\s\S]*?\u001b\\|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-_])/gu;
export class RollingLogBuffer {
  readonly max: number;
  run = 0;
  items: { run: number; stream: StreamName; text: string }[] = [];
  size = 0;
  states = this.fresh();
  constructor(options: { maxCharacters?: number } = {}) {
    this.max = Math.max(1, options.maxCharacters ?? 100000);
  }
  fresh(): Record<StreamName, StreamState> {
    return {
      stdout: { decoder: new StringDecoder('utf8'), partial: '', pendingCr: false },
      stderr: { decoder: new StringDecoder('utf8'), partial: '', pendingCr: false },
    };
  }
  beginRun(run: number) {
    this.flush();
    this.run = run;
    this.states = this.fresh();
  }
  write(stream: StreamName, chunk: Uint8Array) {
    this.consume(stream, this.states[stream].decoder.write(chunk));
  }
  flush() {
    for (const stream of ['stdout', 'stderr'] as const) {
      const s = this.states[stream];
      this.consume(stream, s.decoder.end());
      if (s.pendingCr || s.partial) {
        this.emit(stream, s.partial);
        s.partial = '';
        s.pendingCr = false;
      }
    }
  }
  entries() {
    return this.items.map((v) => Object.freeze({ ...v }));
  }
  present(options: { maxCharacters?: number; maxLines?: number } = {}) {
    const chars = Math.max(1, options.maxCharacters ?? 20000),
      lines = Math.max(1, options.maxLines ?? 200);
    let text = this.items
      .slice(-lines)
      .map((v) => v.text.replace(controls, ''))
      .join('\n');
    if (text.length > chars) {
      text = chars === 1 ? '…' : `…${text.slice(-(chars - 1))}`;
    }
    return text;
  }
  consume(stream: StreamName, text: string) {
    const s = this.states[stream];
    for (const char of text) {
      if (s.pendingCr) {
        s.pendingCr = false;
        if (char === '\n') {
          this.emit(stream, s.partial);
          s.partial = '';
          continue;
        }
        s.partial = '';
      }
      if (char === '\r') {
        s.pendingCr = true;
      } else if (char === '\n') {
        this.emit(stream, s.partial);
        s.partial = '';
      } else {
        s.partial += char;
        if (s.partial.length > this.max) {
          s.partial = s.partial.slice(-this.max);
        }
      }
    }
  }
  emit(stream: StreamName, text: string) {
    if (!text) {
      return;
    }
    const bounded = text.slice(-this.max);
    this.items.push(Object.freeze({ run: this.run, stream, text: bounded }));
    this.size += bounded.length;
    while (this.size > this.max) {
      const old = this.items.shift()!;
      this.size -= old.text.length;
    }
  }
}

interface RecordState {
  request: StartRequest;
  state: DevServiceState;
  child: ManagedProcess | null;
  pid: number | null;
  fingerprint: string | null;
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
  lastError: string | null;
  stopRequested: boolean;
  queue: Promise<void>;
  logs: RollingLogBuffer;
  readiness: Promise<void> | null;
}
export class DevServiceManager {
  readonly records = new Map<string, RecordState>();
  shuttingDown = false;
  shutdownTask?: Promise<void>;
  constructor(
    readonly runtime: RuntimeAdapter,
    readonly publish: (event: DevServiceStatusEvent) => void = () => {},
    readonly readinessIntervalMs = 200,
  ) {}
  start(input: StartRequest): Promise<DevServiceSnapshot> {
    try {
      if (this.shuttingDown) {
        throw new Error('Dev service manager is shutting down.');
      }
      assertExecutorBoundary(input.executor, this.runtime.kind);
      const request = validateStartRequest(input);
      if (this.records.has(request.id)) {
        throw new Error(`Dev service '${request.id}' already exists.`);
      }
      const now = this.runtime.now();
      const record: RecordState = {
        request,
        state: 'starting',
        child: null,
        pid: null,
        fingerprint: null,
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
        lastError: null,
        stopRequested: false,
        queue: Promise.resolve(),
        logs: new RollingLogBuffer(),
        readiness: null,
      };
      this.records.set(request.id, record);
      return this.launch(record);
    } catch (e) {
      return Promise.reject(e);
    }
  }
  status(id: string) {
    const r = this.records.get(id);
    return r ? this.snapshot(r) : undefined;
  }
  list() {
    return [...this.records.values()].map((r) => this.snapshot(r));
  }
  logs(id: string, o: { maxCharacters?: number; maxLines?: number } = {}) {
    return this.require(id).logs.present(o);
  }
  logEntries(id: string) {
    return this.require(id).logs.entries();
  }
  stop(id: string) {
    const r = this.require(id);
    if (r.child) {
      r.stopRequested = true;
    }
    return this.enqueue(r, async () => {
      await this.stopInternal(r);
      return this.snapshot(r);
    });
  }
  restart(id: string, replacementRequest?: StartRequest) {
    if (this.shuttingDown) {
      return Promise.reject(new Error('Dev service manager is shutting down.'));
    }
    const r = this.require(id);
    let replacement: StartRequest | undefined;
    try {
      if (replacementRequest) {
        assertExecutorBoundary(replacementRequest.executor, this.runtime.kind);
        replacement = validateStartRequest(replacementRequest);
        if (replacement.id !== id) {
          throw new Error('Replacement dev service id must match the restarted service.');
        }
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(r, async () => {
      await this.stopInternal(r);
      if (replacement) {
        r.request = replacement;
      }
      return this.launch(r);
    });
  }
  shutdown() {
    if (this.shutdownTask) {
      return this.shutdownTask;
    }
    this.shuttingDown = true;
    const records = [...this.records.values()];
    records.forEach((r) => {
      if (r.child) {
        r.stopRequested = true;
      }
    });
    this.shutdownTask = (async () => {
      const results = await Promise.allSettled(
        records.map((r) => this.enqueue(r, () => this.stopInternal(r))),
      );
      const errors = results
        .filter((v): v is PromiseRejectedResult => v.status === 'rejected')
        .map((v) => v.reason);
      if (errors.length) {
        throw new AggregateError(errors, 'Failed to clean up managed development services.');
      }
    })();
    return this.shutdownTask;
  }
  async reconcile(): Promise<readonly DevServiceSnapshot[]> {
    for (const r of this.records.values()) {
      if (!r.child) {
        continue;
      }
      const identity = await this.runtime.inspect(r.child.pid);
      if (identity && identity.pid === r.child.pid && identity.fingerprint === r.fingerprint) {
        continue;
      }
      this.crash(r, 'Owned process is absent or its fingerprint no longer matches.');
    }
    return this.list();
  }
  async launch(r: RecordState) {
    const generation = ++r.generation;
    r.run++;
    r.state = 'starting';
    r.stopRequested = false;
    r.readyPorts = [];
    r.startedAt = this.runtime.now();
    r.readyAt = r.stoppedAt = r.exitedAt = null;
    r.exitCode = r.exitSignal = r.lastError = null;
    r.logs.beginRun(r.run);
    let child: ManagedProcess;
    try {
      child = await this.runtime.spawn(r.request);
    } catch (e) {
      this.crash(r, e instanceof Error ? e.message : String(e));
      return this.snapshot(r);
    }
    r.child = child;
    r.pid = child.pid;
    r.fingerprint = child.fingerprint;
    child.stdout.on('data', (c) => {
      if (r.generation === generation) {
        r.logs.write('stdout', c);
      }
    });
    child.stderr.on('data', (c) => {
      if (r.generation === generation) {
        r.logs.write('stderr', c);
      }
    });
    child.onClose((exit) => this.closed(r, generation, exit));
    child.onError?.((error) => {
      if (r.generation === generation) {
        r.lastError = error.message;
        this.emit(r);
      }
    });
    this.emit(r);
    if (!r.request.ports.length) {
      this.ready(r, generation, []);
    } else {
      const task = this.monitor(r, generation);
      r.readiness = task;
      void task.finally(() => {
        if (r.readiness === task) {
          r.readiness = null;
        }
      });
    }
    return this.snapshot(r);
  }
  async monitor(r: RecordState, g: number) {
    try {
      while (r.generation === g && r.state === 'starting' && !r.stopRequested) {
        const results = await Promise.all(
          r.request.ports.map(async (port) => ({ port, ready: await this.runtime.probe(port) })),
        );
        if (r.generation !== g || r.state !== 'starting' || r.stopRequested) {
          return;
        }
        const ready = results.filter((v) => v.ready).map((v) => v.port);
        if (JSON.stringify(ready) !== JSON.stringify(r.readyPorts)) {
          r.readyPorts = ready;
          this.emit(r);
        }
        if (ready.length === r.request.ports.length) {
          this.ready(r, g, ready);
          return;
        }
        await this.runtime.sleep(this.readinessIntervalMs);
      }
    } catch (error) {
      if (r.generation === g && r.state === 'starting') {
        const message = error instanceof Error ? error.message : String(error);
        this.crash(r, `Readiness probe failed: ${message}`);
        if (r.child) {
          try {
            await this.runtime.stop(r.child);
          } catch {}
        }
      }
    }
  }
  crash(r: RecordState, message: string) {
    r.generation += 1;
    r.logs.flush();
    r.child = null;
    r.pid = null;
    r.fingerprint = null;
    r.state = 'crashed';
    r.exitedAt = this.runtime.now();
    r.lastError = message;
    this.emit(r);
  }
  ready(r: RecordState, g: number, ports: number[]) {
    if (r.generation !== g || r.state !== 'starting') {
      return;
    }
    r.state = 'ready';
    r.readyPorts = [...ports];
    r.readyAt = this.runtime.now();
    this.emit(r);
  }
  closed(r: RecordState, g: number, exit: ProcessExit) {
    if (r.generation !== g) {
      return;
    }
    const requested = r.stopRequested;
    r.logs.flush();
    r.child = null;
    r.pid = null;
    r.fingerprint = null;
    r.exitedAt = this.runtime.now();
    r.exitCode = exit.code;
    r.exitSignal = exit.signal;
    r.state = requested ? 'stopped' : 'crashed';
    if (requested) {
      r.stoppedAt = r.exitedAt;
    }
    this.emit(r);
  }
  async stopInternal(r: RecordState) {
    const child = r.child;
    if (!child || r.state === 'stopped' || r.state === 'crashed') {
      return;
    }
    r.stopRequested = true;
    const identity = await this.runtime.inspect(child.pid);
    if (!identity || identity.pid !== child.pid || identity.fingerprint !== r.fingerprint) {
      r.lastError = 'Process ownership fingerprint no longer matches; refusing termination.';
      this.emit(r);
      throw new Error(r.lastError);
    }
    await this.runtime.stop(child);
    await child.closed;
  }
  enqueue<T>(r: RecordState, fn: () => Promise<T>) {
    const out = r.queue.then(fn, fn);
    r.queue = out.then(
      () => undefined,
      () => undefined,
    );
    return out;
  }
  require(id: string) {
    const r = this.records.get(id);
    if (!r) {
      throw new Error(`Unknown dev service '${id}'.`);
    }
    return r;
  }
  emit(r: RecordState) {
    r.updatedAt = this.runtime.now();
    this.publish(Object.freeze({ type: DEV_SERVICES_CHANGED_EVENT, snapshot: this.snapshot(r) }));
  }
  snapshot(r: RecordState): DevServiceSnapshot {
    return Object.freeze({
      id: r.request.id,
      state: r.state,
      pid: r.pid,
      fingerprint: r.fingerprint,
      cwd: r.request.cwd,
      command: displayCommand(r.request),
      ports: Object.freeze([...r.request.ports]),
      readyPorts: Object.freeze([...r.readyPorts]),
      run: r.run,
      generation: r.generation,
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      readyAt: r.readyAt,
      stoppedAt: r.stoppedAt,
      exitedAt: r.exitedAt,
      updatedAt: r.updatedAt,
      exitCode: r.exitCode,
      exitSignal: r.exitSignal,
      lastError: r.lastError,
    });
  }
}

interface DurableRecord {
  request: StartRequest;
  snapshot: DevServiceSnapshot;
  logFile: string;
}
class ExistingProcess implements ManagedProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  closed = new Promise<ProcessExit>(() => {});
  constructor(
    readonly pid: number,
    readonly fingerprint: string,
  ) {}
  onClose() {}
}
export class DurableDevServiceManager {
  private readonly stateFile: string;
  private loaded = false;
  private records = new Map<string, DurableRecord>();
  private saveTask: Promise<void> = Promise.resolve();
  private saveSequence = 0;
  constructor(
    readonly runtime: RuntimeAdapter,
    readonly stateRoot: string,
    readonly readinessIntervalMs = 200,
  ) {
    this.stateFile = path.join(stateRoot, 'state.json');
  }
  private async load() {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as {
        version: number;
        records: DurableRecord[];
      };
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
        throw new Error('Unsupported durable dev-service state.');
      }
      for (const item of parsed.records) {
        this.records.set(item.request.id, item);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  private save() {
    const persist = async () => {
      await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
      const temporary = `${this.stateFile}.${process.pid}.${this.saveSequence++}.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, records: [...this.records.values()] }),
        { encoding: 'utf8', mode: 0o600 },
      );
      await chmod(temporary, 0o600).catch(() => {});
      await replaceAtomicFile(temporary, this.stateFile);
    };
    const result = this.saveTask.then(persist, persist);
    this.saveTask = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private snap(request: StartRequest, previous?: DevServiceSnapshot): DevServiceSnapshot {
    const now = this.runtime.now();
    return {
      id: request.id,
      state: 'starting',
      pid: null,
      fingerprint: null,
      cwd: request.cwd,
      command: displayCommand(request),
      ports: [...request.ports],
      readyPorts: [],
      run: (previous?.run ?? 0) + 1,
      generation: (previous?.generation ?? 0) + 1,
      createdAt: previous?.createdAt ?? now,
      startedAt: now,
      readyAt: null,
      stoppedAt: null,
      exitedAt: null,
      updatedAt: now,
      exitCode: null,
      exitSignal: null,
      lastError: null,
    };
  }
  async start(input: StartRequest) {
    await this.load();
    assertExecutorBoundary(input.executor, this.runtime.kind);
    let request = validateStartRequest(input);
    if (this.records.has(request.id)) {
      throw new Error(`Dev service '${request.id}' already exists.`);
    }
    const logFile = path.join(this.stateRoot, `${request.id}.log`);
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    await writeFile(logFile, '', { mode: 0o600 });
    request = { ...request, logFile };
    let snapshot = this.snap(request);
    const record = { request, snapshot, logFile };
    this.records.set(request.id, record);
    await this.save();
    let child: ManagedProcess;
    try {
      child = await this.runtime.spawn(request);
    } catch (error) {
      snapshot = {
        ...snapshot,
        state: 'crashed',
        exitedAt: this.runtime.now(),
        updatedAt: this.runtime.now(),
        lastError: error instanceof Error ? error.message : String(error),
      };
      record.snapshot = snapshot;
      await this.save();
      return snapshot;
    }
    snapshot = {
      ...snapshot,
      pid: child.pid,
      fingerprint: child.fingerprint,
      ...(child.childIdentity
        ? { childPid: child.childIdentity.pid, childFingerprint: child.childIdentity.fingerprint }
        : {}),
      updatedAt: this.runtime.now(),
    };
    record.snapshot = snapshot;
    await this.save();
    child.onClose((exit) => {
      void this.markExit(request.id, child, exit);
    });
    if (!request.ports.length) {
      snapshot = {
        ...snapshot,
        state: 'ready',
        readyAt: this.runtime.now(),
        updatedAt: this.runtime.now(),
      };
      record.snapshot = snapshot;
      await this.save();
    } else {
      void this.monitor(record, child);
    }
    return snapshot;
  }
  private ownsStartingChild(record: DurableRecord, child: ManagedProcess) {
    const snapshot = record.snapshot;
    return (
      snapshot.state === 'starting' &&
      snapshot.pid === child.pid &&
      snapshot.fingerprint === child.fingerprint
    );
  }
  private async monitor(record: DurableRecord, child: ManagedProcess) {
    try {
      while (this.ownsStartingChild(record, child)) {
        const results = await Promise.all(
          record.request.ports.map(async (port) => ({
            port,
            ready: await this.runtime.probe(port),
          })),
        );
        if (!this.ownsStartingChild(record, child)) {
          return;
        }
        const readyPorts = results.filter((v) => v.ready).map((v) => v.port);
        record.snapshot = { ...record.snapshot, readyPorts, updatedAt: this.runtime.now() };
        if (readyPorts.length === record.request.ports.length) {
          record.snapshot = {
            ...record.snapshot,
            state: 'ready',
            readyAt: this.runtime.now(),
            updatedAt: this.runtime.now(),
          };
          await this.save();
          return;
        }
        await this.save();
        await this.runtime.sleep(this.readinessIntervalMs);
      }
    } catch (error) {
      if (!this.ownsStartingChild(record, child)) {
        return;
      }
      record.snapshot = {
        ...record.snapshot,
        state: 'crashed',
        pid: null,
        fingerprint: null,
        exitedAt: this.runtime.now(),
        updatedAt: this.runtime.now(),
        lastError: `Readiness probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      await this.save();
      try {
        await this.runtime.stop(child);
      } catch {}
    }
  }
  private async markExit(id: string, child: ManagedProcess, exit: ProcessExit) {
    const record = this.records.get(id);
    if (
      !record ||
      record.snapshot.pid !== child.pid ||
      record.snapshot.fingerprint !== child.fingerprint
    ) {
      return;
    }
    const requested = record.snapshot.state === 'stopped';
    record.snapshot = {
      ...record.snapshot,
      state: requested ? 'stopped' : 'crashed',
      pid: null,
      fingerprint: null,
      exitedAt: this.runtime.now(),
      stoppedAt: requested ? this.runtime.now() : null,
      updatedAt: this.runtime.now(),
      exitCode: exit.code,
      exitSignal: exit.signal,
    };
    await this.save();
  }
  private async reconcileRecord(record: DurableRecord) {
    const { pid, fingerprint, state } = record.snapshot;
    if (pid === null || fingerprint === null || state === 'stopped' || state === 'crashed') {
      return;
    }
    const identity = await this.runtime.inspect(pid);
    if (identity?.pid === pid && identity.fingerprint === fingerprint) {
      if (state === 'starting') {
        try {
          const readyPorts = (
            await Promise.all(
              record.request.ports.map(async (port) => ({
                port,
                ready: await this.runtime.probe(port),
              })),
            )
          )
            .filter((item) => item.ready)
            .map((item) => item.port);
          record.snapshot = {
            ...record.snapshot,
            readyPorts,
            ...(readyPorts.length === record.request.ports.length
              ? { state: 'ready' as const, readyAt: this.runtime.now() }
              : {}),
            updatedAt: this.runtime.now(),
          };
        } catch (error) {
          record.snapshot = {
            ...record.snapshot,
            state: 'crashed',
            pid: null,
            fingerprint: null,
            exitedAt: this.runtime.now(),
            updatedAt: this.runtime.now(),
            lastError: `Readiness probe failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        await this.save();
      }
      return;
    }
    record.snapshot = {
      ...record.snapshot,
      state: 'crashed',
      pid: null,
      fingerprint: null,
      exitedAt: this.runtime.now(),
      updatedAt: this.runtime.now(),
      lastError: 'Owned process is absent or its fingerprint no longer matches.',
    };
    await this.save();
  }
  async status(
    id?: string,
  ): Promise<DevServiceSnapshot | readonly DevServiceSnapshot[] | undefined> {
    await this.load();
    for (const record of this.records.values()) {
      await this.reconcileRecord(record);
    }
    return id === undefined
      ? [...this.records.values()].map((v) => v.snapshot)
      : this.records.get(id)?.snapshot;
  }
  async list() {
    return (await this.status()) as readonly DevServiceSnapshot[];
  }
  private async required(id: string) {
    await this.load();
    const record = this.records.get(id);
    if (!record) {
      throw new Error(`Unknown dev service '${id}'.`);
    }
    await this.reconcileRecord(record);
    return record;
  }
  async logs(id: string, o: { maxCharacters?: number; maxLines?: number } = {}) {
    await this.load();
    const record = this.records.get(id);
    if (!record) {
      throw new Error(`Unknown dev service '${id}'.`);
    }
    let text = '';
    try {
      text = await readFile(record.logFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const lines = Math.max(1, o.maxLines ?? 200),
      chars = Math.max(1, o.maxCharacters ?? 20000);
    text = text.replace(controls, '').split(/\r?\n/u).slice(-lines).join('\n');
    return text.length > chars ? (chars === 1 ? '…' : `…${text.slice(-(chars - 1))}`) : text;
  }
  async stop(id: string) {
    const record = await this.required(id),
      { pid, fingerprint } = record.snapshot;
    if (pid === null || fingerprint === null) {
      return record.snapshot;
    }
    const identity = await this.runtime.inspect(pid);
    if (identity?.pid !== pid || identity.fingerprint !== fingerprint) {
      throw new Error('Process ownership fingerprint no longer matches; refusing termination.');
    }
    record.snapshot = { ...record.snapshot, state: 'stopped', updatedAt: this.runtime.now() };
    await this.save();
    await this.runtime.stop(new ExistingProcess(pid, fingerprint));
    record.snapshot = {
      ...record.snapshot,
      pid: null,
      fingerprint: null,
      stoppedAt: this.runtime.now(),
      exitedAt: this.runtime.now(),
      updatedAt: this.runtime.now(),
    };
    await this.save();
    return record.snapshot;
  }
  async restart(id: string, replacementRequest?: StartRequest) {
    const old = await this.required(id);
    let request: StartRequest;
    if (replacementRequest) {
      assertExecutorBoundary(replacementRequest.executor, this.runtime.kind);
      request = validateStartRequest(replacementRequest);
      if (request.id !== id) {
        throw new Error('Replacement dev service id must match the restarted service.');
      }
    } else {
      const { logFile: _logFile, ...storedRequest } = old.request;
      request = storedRequest;
    }
    await this.stop(id);
    this.records.delete(id);
    await this.save();
    const next = await this.start(request);
    const current = this.records.get(id)!;
    current.snapshot = {
      ...next,
      run: old.snapshot.run + 1,
      generation: old.snapshot.generation + 1,
      createdAt: old.snapshot.createdAt,
    };
    await this.save();
    return current.snapshot;
  }
  async reconcile() {
    await this.status();
    return [...this.records.values()].map((v) => v.snapshot);
  }
  async shutdown() {
    /* Durable CLI ownership intentionally outlives an invocation. */
  }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const WINDOWS_LAUNCHER_SOURCE = `import {openSync} from "node:fs";import {spawn} from "node:child_process";const payload=JSON.parse(Buffer.from(process.env.MPX_SUPERVISOR_PAYLOAD??"","base64url").toString("utf8"));const gate=process.env.MPX_SUPERVISOR_GATE;if(!gate)process.exit(125);for(let i=0;i<500;i++){try{openSync(gate,"r");break}catch{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}}let fd;try{fd=openSync(payload.logFile,"a");const child=spawn(payload.executable,payload.args,{cwd:payload.cwd,env:{...process.env,...payload.environment},shell:false,detached:false,stdio:["ignore",fd,fd],windowsHide:true});child.once("error",error=>{try{process.stderr.write(String(error)+"\\n")}finally{process.exit(126)}});child.once("exit",(code,signal)=>process.exit(code??(signal?1:0)));}catch(error){process.stderr.write(String(error)+"\\n");process.exit(126)}\n`;
const WINDOWS_SUPERVISOR_SOURCE = String.raw`$ErrorActionPreference='Stop'
$source=@'
using System;
using System.Runtime.InteropServices;
public static class MpxJob {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr attrs,string name);
 [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr value,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,IntPtr value,uint length,IntPtr returned);
 [StructLayout(LayoutKind.Sequential)] struct Basic { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
 [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
 [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic BasicLimitInformation; public Io IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long TotalUserTime,TotalKernelTime,ThisPeriodTotalUserTime,ThisPeriodTotalKernelTime; public uint TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses; }
 public static IntPtr CreateKillOnClose(){var job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new System.ComponentModel.Win32Exception();var info=new Extended();info.BasicLimitInformation.LimitFlags=0x2000;var size=Marshal.SizeOf(info);var ptr=Marshal.AllocHGlobal(size);try{Marshal.StructureToPtr(info,ptr,false);if(!SetInformationJobObject(job,9,ptr,(uint)size))throw new System.ComponentModel.Win32Exception();return job;}finally{Marshal.FreeHGlobal(ptr);}}
 public static uint Active(IntPtr job){var size=Marshal.SizeOf(typeof(Accounting));var ptr=Marshal.AllocHGlobal(size);try{if(!QueryInformationJobObject(job,1,ptr,(uint)size,IntPtr.Zero))throw new System.ComponentModel.Win32Exception();return ((Accounting)Marshal.PtrToStructure(ptr,typeof(Accounting))).ActiveProcesses;}finally{Marshal.FreeHGlobal(ptr);}}
}
'@
Add-Type -TypeDefinition $source
$job=[MpxJob]::CreateKillOnClose()
try {
 $start=New-Object System.Diagnostics.ProcessStartInfo
 $start.FileName=$env:MPX_SUPERVISOR_NODE
 $start.Arguments='"'+$env:MPX_SUPERVISOR_LAUNCHER.Replace('"','\"')+'"'
 $start.WorkingDirectory=$env:MPX_SUPERVISOR_CWD
 $start.UseShellExecute=$false
 $start.CreateNoWindow=$true
 $child=[System.Diagnostics.Process]::Start($start)
 if(-not [MpxJob]::AssignProcessToJobObject($job,$child.Handle)){throw 'AssignProcessToJobObject failed'}
 [System.IO.File]::WriteAllText($env:MPX_SUPERVISOR_GATE,'assigned')
 $handshake=[ordered]@{schemaVersion=1;owner='mpx';childPid=[int]$child.Id;childFingerprint=$child.StartTime.ToUniversalTime().ToString('o')}
 [System.IO.File]::WriteAllText($env:MPX_SUPERVISOR_HANDSHAKE,($handshake|ConvertTo-Json -Compress))
 $seen=$false;$absent=0
 while((-not $seen)-or $absent-lt 3){$active=[MpxJob]::Active($job);if($active-gt 0){$seen=$true;$absent=0}elseif($seen){$absent++};Start-Sleep -Milliseconds 100}
 exit 0
} catch { @{schemaVersion=1;owner='mpx';error='supervisor-start-failed'}|ConvertTo-Json -Compress; exit 125 } finally {if($job-ne[IntPtr]::Zero){[void][MpxJob]::CloseHandle($job)}}
`;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
async function materializeSupervisor(root: string) {
  const directory = path.join(root, '.supervisor'),
    launcher = path.join(directory, `launcher-${digest(WINDOWS_LAUNCHER_SOURCE)}.mjs`),
    helper = path.join(directory, `supervisor-${digest(WINDOWS_SUPERVISOR_SOURCE)}.ps1`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [file, source] of [
    [launcher, WINDOWS_LAUNCHER_SOURCE],
    [helper, WINDOWS_SUPERVISOR_SOURCE],
  ] as const) {
    try {
      const stat = await lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile() || (await readFile(file, 'utf8')) !== source) {
        throw new Error('MPX Windows supervisor helper fingerprint mismatch.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      await writeFile(file, source, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
  }
  return { launcher, helper };
}
class SystemProcess implements ManagedProcess {
  readonly pid: number;
  readonly fingerprint: string;
  readonly stdout;
  readonly stderr;
  readonly closed: Promise<ProcessExit>;
  exit?: ProcessExit;
  error?: Error;
  listeners: ((e: ProcessExit) => void)[] = [];
  errorListeners: ((e: Error) => void)[] = [];
  constructor(
    readonly process: ChildProcessWithoutNullStreams,
    fingerprint: string,
    streams?: { stdout: Readable; stderr: Readable },
    readonly childIdentity?: { pid: number; fingerprint: string },
  ) {
    if (process.pid === undefined) {
      throw new Error('Spawned service has no pid.');
    }
    this.pid = process.pid;
    this.fingerprint = fingerprint;
    this.stdout = streams?.stdout ?? process.stdout;
    this.stderr = streams?.stderr ?? process.stderr;
    this.closed = new Promise((resolve) =>
      process.once('close', (code, signal) => {
        const e = { code, signal };
        this.exit = e;
        resolve(e);
        this.listeners.splice(0).forEach((fn) => fn(e));
      }),
    );
    process.once('error', (e) => {
      this.error = e;
      this.errorListeners.splice(0).forEach((fn) => fn(e));
    });
  }
  onClose(fn: (e: ProcessExit) => void) {
    if (this.exit) {
      fn(this.exit);
    } else {
      this.listeners.push(fn);
    }
  }
  onError(fn: (e: Error) => void) {
    if (this.error) {
      fn(this.error);
    } else {
      this.errorListeners.push(fn);
    }
  }
}
export function systemSpawnInvocation(
  executable: string,
  args: readonly string[],
  platform = process.platform,
  durable = false,
) {
  return { file: executable, args: [...args], detached: platform !== 'win32', unref: durable };
}
export function createSystemRuntime(): RuntimeAdapter {
  const identities = new Map<number, string>(),
    windows = new WindowsProcessCapabilities();
  const inspectOs = async (pid: number): Promise<string | undefined> => {
    if (process.platform === 'win32') {
      return (await windows.inspect(pid))?.startFingerprint;
    }
    if (process.platform === 'linux') {
      try {
        const fields = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(' ');
        return fields[21];
      } catch {
        return undefined;
      }
    }
    try {
      process.kill(pid, 0);
      return identities.get(pid);
    } catch {
      return undefined;
    }
  };
  return {
    kind: 'host',
    now: () => new Date().toISOString(),
    sleep: wait,
    async spawn(request) {
      let output: Awaited<ReturnType<typeof open>> | undefined;
      try {
        let file = request.executable,
          args = [...request.args],
          environment = { ...process.env, ...request.environment },
          childIdentity: { pid: number; fingerprint: string } | undefined;
        if (request.logFile && process.platform === 'win32') {
          const generated = await materializeSupervisor(path.dirname(request.logFile)),
            token = randomUUID(),
            gate = path.join(path.dirname(request.logFile), `.gate-${token}`),
            handshake = path.join(path.dirname(request.logFile), `.handshake-${token}.json`);
          const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
          if (!systemRoot || !path.isAbsolute(systemRoot)) {
            throw new Error('SystemRoot is required for the Windows service supervisor.');
          }
          file = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
          args = [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            generated.helper,
          ];
          environment = {
            ...environment,
            MPX_SUPERVISOR_NODE: process.execPath,
            MPX_SUPERVISOR_LAUNCHER: generated.launcher,
            MPX_SUPERVISOR_CWD: request.cwd,
            MPX_SUPERVISOR_GATE: gate,
            MPX_SUPERVISOR_HANDSHAKE: handshake,
            MPX_SUPERVISOR_PAYLOAD: Buffer.from(
              JSON.stringify({
                executable: request.executable,
                args: request.args,
                cwd: request.cwd,
                environment: request.environment ?? {},
                logFile: request.logFile,
              }),
              'utf8',
            ).toString('base64url'),
          };
          const processHandle = spawn(file, args, {
            cwd: request.cwd,
            env: environment,
            detached: false,
            stdio: ['ignore', 'ignore', 'ignore'],
            windowsHide: true,
          }) as unknown as ChildProcessWithoutNullStreams;
          if (processHandle.pid === undefined) {
            throw new Error('Spawned supervisor has no pid.');
          }
          let parsed:
            { owner?: unknown; childPid?: unknown; childFingerprint?: unknown } | undefined;
          for (let i = 0; i < 500 && !parsed; i++) {
            try {
              parsed = JSON.parse(await readFile(handshake, 'utf8'));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
              }
              if (processHandle.exitCode !== null) {
                throw new Error('Windows service supervisor exited before ownership handshake.');
              }
              await wait(10);
            }
          }
          if (
            parsed?.owner !== 'mpx' ||
            !Number.isSafeInteger(parsed.childPid) ||
            Number(parsed.childPid) <= 0 ||
            typeof parsed.childFingerprint !== 'string' ||
            !parsed.childFingerprint
          ) {
            throw new Error('Windows service supervisor ownership handshake failed.');
          }
          childIdentity = { pid: Number(parsed.childPid), fingerprint: parsed.childFingerprint };
          const fingerprint = await inspectOs(processHandle.pid);
          if (!fingerprint) {
            processHandle.kill();
            throw new Error('Spawned service supervisor fingerprint is unavailable.');
          }
          const child = new SystemProcess(
            processHandle,
            fingerprint,
            { stdout: new PassThrough(), stderr: new PassThrough() },
            childIdentity,
          );
          identities.set(child.pid, child.fingerprint);
          void child.closed.finally(() => {
            identities.delete(child.pid);
          });
          processHandle.unref();
          return child;
        }
        const invocation = systemSpawnInvocation(
          file,
          args,
          process.platform,
          request.logFile !== undefined,
        );
        if (request.logFile) {
          output = await open(request.logFile, 'a', 0o600);
        }
        const processHandle = spawn(invocation.file, invocation.args, {
          cwd: request.cwd,
          env: environment,
          detached: invocation.detached,
          stdio: ['ignore', output?.fd ?? 'pipe', output?.fd ?? 'pipe'],
          windowsHide: true,
        }) as unknown as ChildProcessWithoutNullStreams;
        if (processHandle.pid === undefined) {
          throw new Error('Spawned service has no pid.');
        }
        const fingerprint = await inspectOs(processHandle.pid);
        if (!fingerprint) {
          processHandle.kill();
          throw new Error('Spawned service process fingerprint is unavailable.');
        }
        const streams = output
          ? { stdout: new PassThrough(), stderr: new PassThrough() }
          : undefined;
        const child = new SystemProcess(processHandle, fingerprint, streams, childIdentity);
        identities.set(child.pid, child.fingerprint);
        void child.closed.finally(() => {
          identities.delete(child.pid);
          void output?.close();
        });
        if (invocation.unref) {
          processHandle.unref();
        }
        return child;
      } catch (error) {
        await output?.close();
        throw error;
      }
    },
    async inspect(pid) {
      const fingerprint = await inspectOs(pid);
      return fingerprint ? { pid, fingerprint } : undefined;
    },
    probe(port) {
      return new Promise((resolve) => {
        const socket = connect({ host: 'localhost', port });
        let done = false;
        const finish = (v: boolean) => {
          if (done) {
            return;
          }
          done = true;
          socket.destroy();
          resolve(v);
        };
        socket.setTimeout(400);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
      });
    },
    async stop(child) {
      if (process.platform === 'win32') {
        await windows.terminate({ pid: child.pid, startFingerprint: child.fingerprint });
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw e;
          }
        }
        for (let i = 0; i < 50 && (await inspectOs(child.pid)); i++) {
          await wait(100);
        }
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw e;
          }
        }
      }
    },
  };
}
