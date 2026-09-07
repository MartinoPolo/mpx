import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  DiscoveryResult,
  DiscoveredSession,
  ProcessInspection,
  RuntimeDiscovery,
  SessionProcessInspector,
} from './service.js';
import { SessionError } from './schemas.js';

export interface CommandOutput {
  readonly available: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr?: string;
}
export type ClaudeCommandExecutor = (command: readonly string[]) => Promise<CommandOutput>;
export class ClaudeActiveScanner implements RuntimeDiscovery {
  readonly runtime = 'claude' as const;
  constructor(private readonly execute: ClaudeCommandExecutor) {}
  async scan(): Promise<DiscoveryResult> {
    let output: CommandOutput;
    try {
      output = await this.execute(['claude', 'agents', '--json']);
    } catch {
      return {
        status: 'unavailable',
        sessions: [],
        diagnostic: 'CLAUDE_DISCOVERY_UNAVAILABLE',
      };
    }
    if (!output.available || output.exitCode !== 0) {
      return {
        status: 'unavailable',
        sessions: [],
        diagnostic: 'CLAUDE_DISCOVERY_UNAVAILABLE',
      };
    }
    try {
      const parsed = JSON.parse(output.stdout) as unknown;
      const values = Array.isArray(parsed)
        ? parsed
        : isObject(parsed) && Array.isArray(parsed.sessions)
          ? parsed.sessions
          : isObject(parsed) && Array.isArray(parsed.agents)
            ? parsed.agents
            : undefined;
      if (!values) {
        throw new Error('missing agents array');
      }
      const sessions: DiscoveredSession[] = [];
      for (const value of values) {
        if (!isObject(value) || value.type !== 'interactive') {
          continue;
        }
        if (
          typeof value.sessionId !== 'string' ||
          typeof value.cwd !== 'string' ||
          typeof value.pid !== 'number' ||
          !Number.isSafeInteger(value.pid) ||
          value.pid < 1 ||
          (value.name !== null && typeof value.name !== 'string')
        ) {
          throw new Error('malformed interactive agent');
        }
        sessions.push({
          nativeSessionId: value.sessionId,
          nativeSessionRef: { kind: 'native-id', value: value.sessionId },
          cwd: value.cwd,
          title: value.name,
          pid: value.pid,
          startFingerprint:
            typeof value.startFingerprint === 'string'
              ? value.startFingerprint
              : `pid:${value.pid}`,
        });
      }
      return { status: 'available', sessions, diagnostic: null };
    } catch {
      return {
        status: 'malformed',
        sessions: [],
        diagnostic: 'CLAUDE_DISCOVERY_MALFORMED',
      };
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
export interface ProcessInspector extends Pick<SessionProcessInspector, 'inspectMany'> {
  inspect(pid: number): Promise<{ startFingerprint: string } | null>;
}

async function inspectRegistryProcesses(
  inspector: ProcessInspector,
  pids: readonly number[],
): Promise<ReadonlyMap<number, ProcessInspection>> {
  if (pids.length === 0) {
    return new Map();
  }
  if (inspector.inspectMany) {
    const processes = await inspector.inspectMany(pids);
    const requested = new Set(pids);
    if (
      !(processes instanceof Map) ||
      [...processes].some(
        ([pid, process]) =>
          !requested.has(pid) ||
          !isObject(process) ||
          (process.status !== 'absent' &&
            process.status !== 'unknown' &&
            !(
              process.status === 'present' &&
              Number.isSafeInteger(process.pid) &&
              typeof process.startFingerprint === 'string'
            )),
      )
    ) {
      throw new SessionError(
        'PI_PROCESS_INSPECTION_MALFORMED',
        'Pi process inspection returned malformed batch information',
      );
    }
    return processes;
  }
  const processes = new Map<number, ProcessInspection>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, pids.length) }, async () => {
      while (next < pids.length) {
        const pid = pids[next++]!;
        const process = await inspector.inspect(pid);
        processes.set(
          pid,
          process
            ? { status: 'present', pid, startFingerprint: process.startFingerprint }
            : { status: 'absent' },
        );
      }
    }),
  );
  return processes;
}

interface PiEntry {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  name: string | null;
  pid: number;
  processStartedAt: string;
  registeredAt: string;
}
export type MissingPiRegistryDirectory = 'available-empty' | 'unavailable';
export interface PiRegistryScannerOptions {
  readonly clock?: () => number;
  readonly maxBytesPerEntry?: number;
  readonly maxEntries?: number;
  /** Missing is available empty by default, or explicitly unavailable. */
  readonly missingDirectory?: MissingPiRegistryDirectory;
}

export class PiV2ActiveRegistryScanner implements RuntimeDiscovery {
  readonly runtime = 'pi' as const;
  private readonly clock: () => number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly missingDirectory: MissingPiRegistryDirectory;
  /** Scans only the explicitly supplied maintained active-sessions directory. */
  constructor(
    private readonly accountRoot: string,
    private readonly registryDirectory: string,
    private readonly inspector: ProcessInspector,
    optionsOrClock: PiRegistryScannerOptions | (() => number) = {},
  ) {
    const options =
      typeof optionsOrClock === 'function' ? { clock: optionsOrClock } : optionsOrClock;
    this.clock = options.clock ?? Date.now;
    this.maxBytes = options.maxBytesPerEntry ?? 256 * 1024;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.missingDirectory = options.missingDirectory ?? 'available-empty';
  }
  async scan(): Promise<DiscoveryResult> {
    const root = await realpath(this.accountRoot);
    let files: string[];
    try {
      const linked = await lstat(this.registryDirectory);
      if (linked.isSymbolicLink() || !linked.isDirectory()) {
        throw new SessionError(
          'PI_REGISTRY_UNSAFE',
          'Pi registry must be an explicit non-symlink directory',
        );
      }
      files = (await readdir(this.registryDirectory))
        .filter((file) => file.endsWith('.json'))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      return this.missingDirectory === 'available-empty'
        ? { status: 'available', sessions: [], diagnostic: null }
        : {
            status: 'unavailable',
            sessions: [],
            diagnostic: 'PI_DISCOVERY_UNAVAILABLE',
          };
    }
    if (files.length > this.maxEntries) {
      throw new SessionError('PI_REGISTRY_MALFORMED', 'Pi registry has too many entries');
    }
    const newest = new Map<string, PiEntry>();
    for (const file of files) {
      const registryFile = path.join(this.registryDirectory, file),
        linked = await lstat(registryFile);
      if (linked.isSymbolicLink() || !linked.isFile() || linked.size > this.maxBytes) {
        throw new SessionError(
          'PI_REGISTRY_UNSAFE',
          'Pi registry entries must be bounded regular non-symlink JSON files',
        );
      }
      const raw = JSON.parse(await readFile(registryFile, 'utf8')) as unknown;
      if (isObject(raw) && raw.version === 1 && raw.agent === 'pi') {
        continue;
      }
      const entry = parsePiEntry(raw, this.clock());
      const prior = newest.get(entry.sessionId);
      if (!prior || entry.registeredAt > prior.registeredAt) {
        newest.set(entry.sessionId, entry);
      }
    }
    const pids = [...new Set([...newest.values()].map((entry) => entry.pid))];
    const processes = await inspectRegistryProcesses(this.inspector, pids);
    if (pids.some((pid) => !processes.has(pid) || processes.get(pid)?.status === 'unknown')) {
      return {
        status: 'unavailable',
        sessions: [],
        diagnostic: 'PI_PROCESS_INSPECTION_UNAVAILABLE',
      };
    }
    const sessions: DiscoveredSession[] = [];
    for (const entry of newest.values()) {
      const process = processes.get(entry.pid);
      if (
        process?.status !== 'present' ||
        process.pid !== entry.pid ||
        process.startFingerprint !== entry.processStartedAt
      ) {
        continue;
      }
      const candidate = path.resolve(entry.sessionFile);
      if (!path.isAbsolute(entry.sessionFile) || !contained(root, candidate)) {
        throw new SessionError(
          'PI_SESSION_ROOT_ESCAPE',
          'Pi session file escapes supplied account root',
        );
      }
      const linked = await lstat(candidate),
        resolved = await realpath(candidate);
      if (linked.isSymbolicLink() || !linked.isFile() || !contained(root, resolved)) {
        throw new SessionError(
          'PI_SESSION_UNSAFE',
          'Pi session file must be a contained regular non-symlink file',
        );
      }
      const relative = path.relative(root, candidate).split(path.sep).join('/');
      sessions.push({
        nativeSessionId: entry.sessionId,
        nativeSessionRef: { kind: 'root-relative-file', value: relative },
        cwd: entry.cwd,
        title: entry.name,
        pid: entry.pid,
        startFingerprint: entry.processStartedAt,
      });
    }
    return { status: 'available', sessions, diagnostic: null };
  }
}
function parsePiTimestamp(value: unknown, label: string, now: number): string {
  if (typeof value !== 'string') {
    throw new SessionError('PI_REGISTRY_MALFORMED', `${label} is invalid`);
  }
  const windowsRoundTrip = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{4}Z$/u.exec(value),
    canonical = windowsRoundTrip?.[1] ? `${windowsRoundTrip[1]}Z` : value,
    instant = Date.parse(canonical);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(canonical) ||
    !Number.isFinite(instant) ||
    new Date(instant).toISOString() !== canonical ||
    instant > now
  ) {
    throw new SessionError(
      'PI_REGISTRY_FUTURE_TIMESTAMP',
      `${label} must be canonical and not in the future`,
    );
  }
  return canonical;
}
function parsePiEntry(value: unknown, now: number): PiEntry {
  if (!isObject(value)) {
    throw new SessionError('PI_REGISTRY_MALFORMED', 'Pi active entry must be an object');
  }
  const required = [
      'version',
      'agent',
      'sessionId',
      'sessionFile',
      'cwd',
      'pid',
      'processStartedAt',
      'registeredAt',
    ],
    allowed = new Set([...required, 'name']);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new SessionError('PI_REGISTRY_MALFORMED', 'Pi active entry has an inexact shape');
  }
  if (
    value.version !== 2 ||
    value.agent !== 'pi' ||
    typeof value.sessionId !== 'string' ||
    !value.sessionId ||
    typeof value.sessionFile !== 'string' ||
    !path.isAbsolute(value.sessionFile) ||
    typeof value.cwd !== 'string' ||
    !path.isAbsolute(value.cwd) ||
    (Object.hasOwn(value, 'name') && typeof value.name !== 'string') ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1
  ) {
    throw new SessionError('PI_REGISTRY_MALFORMED', 'Pi active entry fields are invalid');
  }
  return {
    sessionId: value.sessionId,
    sessionFile: value.sessionFile,
    cwd: value.cwd,
    name: Object.hasOwn(value, 'name') ? (value.name as string) : null,
    pid: value.pid as number,
    processStartedAt: parsePiTimestamp(value.processStartedAt, 'processStartedAt', now),
    registeredAt: parsePiTimestamp(value.registeredAt, 'registeredAt', now),
  };
}
