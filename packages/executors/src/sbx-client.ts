import path from 'node:path';
import type { BoundedProcessRunner, ProcessResult } from './index.js';
import { ExecutionError } from './index.js';

export const SBX_V0_39_0_PIN = Object.freeze({
  version: '0.39.0',
  buildCommit: 'def8cb0523a77e757bdd6ef52b459fe374f3783e',
  windowsBinarySha256: 'b064711a10f22363953e90eae926dbd9d96419e601f9308cd9d1102e3d81ccbf',
});
export async function resolveTrustedSbxExecutable(input: {
  candidates: readonly string[];
  projectRoot: string;
  trustedRoots: readonly string[];
  expectedSha256: string;
  inspect(file: string): Promise<{ file: boolean; realpath: string; sha256: string }>;
}): Promise<string> {
  const normalize = (value: string): string =>
    (path.win32.isAbsolute(value) ? path.win32.normalize(value) : path.posix.normalize(value))
      .replaceAll('\\', '/')
      .toLowerCase();
  const within = (candidate: string, root: string): boolean => {
    const c = normalize(candidate),
      r = normalize(root).replace(/\/$/u, '');
    return c === r || c.startsWith(`${r}/`);
  };
  if (!/^[a-f0-9]{64}$/u.test(input.expectedSha256)) {
    throw new ExecutionError('SBX_PIN_INVALID', 'Pinned sbx digest is invalid.');
  }
  for (const candidate of input.candidates) {
    if (!path.win32.isAbsolute(candidate) && !path.posix.isAbsolute(candidate)) {
      continue;
    }
    if (!/\.exe$/iu.test(candidate)) {
      continue;
    }
    const inspected = await input.inspect(candidate).catch(() => undefined);
    if (!inspected?.file || inspected.sha256 !== input.expectedSha256) {
      continue;
    }
    if (!path.win32.isAbsolute(inspected.realpath) && !path.posix.isAbsolute(inspected.realpath)) {
      continue;
    }
    if (
      within(inspected.realpath, input.projectRoot) ||
      !input.trustedRoots.some((root) => within(inspected.realpath, root))
    ) {
      continue;
    }
    return inspected.realpath;
  }
  throw new ExecutionError(
    'SBX_NOT_FOUND',
    'Pinned standalone sbx executable was not found in trusted roots.',
  );
}

export type SbxFailureCode =
  | 'SBX_NOT_FOUND'
  | 'VERSION_UNSUPPORTED'
  | 'BUILD_MISMATCH'
  | 'DAEMON_STOPPED'
  | 'UNREACHABLE'
  | 'CLIENT_DAEMON_MISMATCH'
  | 'AUTH_UNAVAILABLE'
  | 'LEGACY_ONLY'
  | 'FEATURE_UNAVAILABLE'
  | 'SBX_COMPAT_MISMATCH'
  | 'SBX_GLOBAL_POLICY_UNINITIALIZED';
const commits = /^[a-f0-9]{40}$/u;
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExecutionError('SBX_JSON_INVALID', `${label} is not an object.`);
  }
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) {
    throw new ExecutionError('SBX_JSON_INVALID', `${label} contains unknown field '${unknown}'.`);
  }
}
function json(text: string, label: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > 65_536) {
    throw new ExecutionError('SBX_JSON_INVALID', `${label} exceeds output bounds.`);
  }
  try {
    return record(JSON.parse(text), label);
  } catch (error) {
    if (error instanceof ExecutionError) {
      throw error;
    }
    throw new ExecutionError('SBX_JSON_INVALID', `${label} is not valid JSON.`);
  }
}
export function parseSbxVersion(text: string): { version: string; buildCommit: string } {
  if (Buffer.byteLength(text) > 4096) {
    throw new ExecutionError('SBX_VERSION_INVALID', 'sbx version exceeds output bounds.');
  }
  let version: unknown, buildCommit: unknown;
  if (text.trimStart().startsWith('{')) {
    const item = json(text, 'sbx version');
    exact(item, ['version', 'buildCommit'], 'sbx version');
    ({ version, buildCommit } = item);
  } else {
    const match = /^sbx version: v(\d+\.\d+\.\d+) ([a-f0-9]{40})\r?\n?$/u.exec(text);
    if (!match) {
      throw new ExecutionError('SBX_VERSION_INVALID', 'sbx version output is incompatible.');
    }
    [, version, buildCommit] = match;
  }
  if (
    typeof version !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(version) ||
    typeof buildCommit !== 'string' ||
    !commits.test(buildCommit)
  ) {
    throw new ExecutionError('SBX_VERSION_INVALID', 'sbx version output is malformed.');
  }
  return Object.freeze({ version, buildCommit });
}
export interface SbxDaemonStatus {
  status: 'running' | 'stopped' | 'unreachable';
  socket: string;
  clientVersion?: string;
  daemonVersion?: string;
  logs?: string;
}
export function parseSbxDaemonStatus(text: string): SbxDaemonStatus {
  const item = json(text, 'sbx daemon status');
  exact(item, ['status', 'socket', 'clientVersion', 'daemonVersion', 'logs'], 'sbx daemon status');
  if (
    !['running', 'stopped', 'unreachable'].includes(String(item.status)) ||
    typeof item.socket !== 'string' ||
    item.socket.length > 512 ||
    /\r|\n|\0/u.test(item.socket) ||
    (item.clientVersion !== undefined && typeof item.clientVersion !== 'string') ||
    (item.daemonVersion !== undefined && typeof item.daemonVersion !== 'string') ||
    (item.logs !== undefined &&
      (typeof item.logs !== 'string' ||
        item.logs.length > 512 ||
        /[\u0000-\u001f\u007f]/u.test(item.logs)))
  ) {
    throw new ExecutionError('SBX_JSON_INVALID', 'sbx daemon status JSON is malformed.');
  }
  return Object.freeze(item as unknown as SbxDaemonStatus);
}
export interface SbxDiagnoseSummary {
  pass: number;
  warn: number;
  fail: number;
  skip: number;
}
export interface SbxDiagnose {
  version: string;
  checks: readonly { name: string; status: 'pass' | 'warn' | 'fail' | 'skip' }[];
  summary: SbxDiagnoseSummary;
}
export function parseSbxDiagnose(text: string): SbxDiagnose {
  const item = json(text, 'sbx diagnose');
  exact(item, ['version', 'checks', 'summary'], 'sbx diagnose');
  if (item.version !== '1.0' || !Array.isArray(item.checks) || item.checks.length > 64) {
    throw new ExecutionError('SBX_JSON_INVALID', 'sbx diagnose JSON is incompatible.');
  }
  const checks = item.checks.map((raw, index) => {
    const check = record(raw, `checks[${index}]`);
    exact(check, ['name', 'status', 'message', 'detail', 'hint'], `checks[${index}]`);
    if (
      typeof check.name !== 'string' ||
      check.name.length > 80 ||
      !['pass', 'warn', 'fail', 'skip'].includes(String(check.status)) ||
      [check.message, check.detail, check.hint].some(
        (v) => typeof v !== 'string' || v.length > 4096,
      )
    ) {
      throw new ExecutionError('SBX_JSON_INVALID', 'sbx diagnose check is malformed.');
    }
    return Object.freeze({
      name: check.name,
      status: check.status as 'pass' | 'warn' | 'fail' | 'skip',
    });
  });
  const summary = record(item.summary, 'summary');
  exact(summary, ['pass', 'warn', 'fail', 'skip'], 'summary');
  if (Object.values(summary).some((v) => !Number.isSafeInteger(v) || Number(v) < 0)) {
    throw new ExecutionError('SBX_JSON_INVALID', 'sbx diagnose summary is malformed.');
  }
  return Object.freeze({
    version: '1.0',
    checks: Object.freeze(checks),
    summary: Object.freeze(summary as unknown as SbxDiagnoseSummary),
  });
}
const requiredCommands = [
  'create',
  'daemon',
  'diagnose',
  'exec',
  'ls',
  'policy',
  'ports',
  'rm',
  'run',
  'version',
];
const legacyCommandSurface = /docker sandbox(?:s)?\s+(?:run|create)/iu;
export function assertSbxHelpCompatibility(text: string): void {
  if (
    Buffer.byteLength(text) > 65_536 ||
    legacyCommandSurface.test(text) ||
    requiredCommands.some((command) => !new RegExp(`(?:^|\\n)\\s*${command}\\s`, `u`).test(text))
  ) {
    throw new ExecutionError(
      'SBX_COMPAT_MISMATCH',
      'SBX_COMPAT_MISMATCH: standalone sbx command surface is incompatible.',
    );
  }
}
async function probe(
  runner: BoundedProcessRunner,
  executable: string,
  cwd: string,
  argv: string[],
): Promise<ProcessResult> {
  return runner.run({
    executable,
    argv,
    cwd,
    environment: {},
    timeoutMs: 10_000,
    maxOutputBytes: 65_536,
    shell: false,
  });
}
export async function diagnoseSbx(input: {
  executable: string | undefined;
  cwd: string;
  runner: BoundedProcessRunner;
  pin: { version: string; buildCommit: string };
}): Promise<{
  available: boolean;
  failureCodes: readonly SbxFailureCode[];
  version?: string;
  readOnly: true;
}> {
  if (
    !input.executable ||
    (!path.win32.isAbsolute(input.executable) && !path.posix.isAbsolute(input.executable))
  ) {
    return Object.freeze({
      available: false,
      failureCodes: ['SBX_NOT_FOUND' as const],
      readOnly: true,
    });
  }
  const failures: SbxFailureCode[] = [];
  let version: { version: string; buildCommit: string } | undefined,
    daemon: SbxDaemonStatus | undefined,
    diagnose: SbxDiagnose | undefined;
  try {
    const result = await probe(input.runner, input.executable, input.cwd, ['version']);
    if (result.exitCode !== 0) {
      failures.push('UNREACHABLE');
    } else {
      version = parseSbxVersion(result.stdout);
    }
  } catch {
    failures.push('UNREACHABLE');
  }
  if (version) {
    if (version.version !== input.pin.version) {
      failures.push('VERSION_UNSUPPORTED');
    }
    if (version.buildCommit !== input.pin.buildCommit) {
      failures.push('BUILD_MISMATCH');
    }
  }
  try {
    const result = await probe(input.runner, input.executable, input.cwd, ['--help']);
    if (result.exitCode !== 0) {
      failures.push('UNREACHABLE');
    } else {
      try {
        assertSbxHelpCompatibility(result.stdout);
      } catch {
        failures.push(
          legacyCommandSurface.test(result.stdout) ? 'LEGACY_ONLY' : 'SBX_COMPAT_MISMATCH',
        );
      }
    }
  } catch {
    failures.push('SBX_COMPAT_MISMATCH');
  }
  try {
    const result = await probe(input.runner, input.executable, input.cwd, [
      'daemon',
      'status',
      '--json',
    ]);
    if (result.exitCode !== 0) {
      failures.push('UNREACHABLE');
    } else {
      daemon = parseSbxDaemonStatus(result.stdout);
    }
  } catch {
    failures.push('UNREACHABLE');
  }
  if (daemon) {
    if (daemon.status === 'stopped') {
      failures.push('DAEMON_STOPPED');
    }
    if (daemon.status === 'unreachable') {
      failures.push('UNREACHABLE');
    }
    if (
      daemon.clientVersion &&
      daemon.daemonVersion &&
      daemon.clientVersion !== daemon.daemonVersion
    ) {
      failures.push('CLIENT_DAEMON_MISMATCH');
    }
  }
  try {
    const result = await probe(input.runner, input.executable, input.cwd, [
      'diagnose',
      '--output',
      'json',
    ]);
    diagnose = parseSbxDiagnose(result.stdout);
  } catch {
    failures.push('UNREACHABLE');
  }
  if (diagnose) {
    if (diagnose.checks.some((c) => c.name === 'Authentication' && c.status === 'fail')) {
      failures.push('AUTH_UNAVAILABLE');
    }
  }
  // Read-only preflight only. MPX never runs `policy init`; the user must review and
  // perform the global, all-sandboxes `sbx policy init allow-all` once.
  try {
    const result = await probe(input.runner, input.executable, input.cwd, [
      'policy',
      'ls',
      '--json',
    ]);
    if (result.exitCode !== 0) {
      failures.push('SBX_GLOBAL_POLICY_UNINITIALIZED');
    }
  } catch {
    failures.push('SBX_GLOBAL_POLICY_UNINITIALIZED');
  }
  return Object.freeze({
    available: true,
    failureCodes: Object.freeze([...new Set(failures)]),
    ...(version ? { version: version.version } : {}),
    readOnly: true,
  });
}
