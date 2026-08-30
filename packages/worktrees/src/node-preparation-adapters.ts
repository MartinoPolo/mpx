import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { MpxError, isPathWithinRoot, parseStrictJson } from '@mpx/core';
import {
  productionTrustedExecutablePolicy,
  resolveTrustedExecutable,
  revalidateTrustedExecutable,
  type ResolvedExecutable,
  type TrustedExecutablePolicy,
} from './trusted-executable.js';
import type { PreparationPlan, PreparationStep } from '@mpx/config';
import { preparationApprovalPhrases } from './preparation-engine.js';
import type {
  BackgroundPreparationRequest,
  ConfiguredPackageManager,
  InspectedProcess,
  OwnedProcess,
  PackageManager,
  PreparationEvidence,
  PreparationEvidenceAdapter,
  PreparationExecutionAdapter,
  PreparationProcessAdapter,
  PreparationState,
  PreparationStoreAdapter,
  SpawnRequest,
  SpawnResult,
} from './preparation-engine.js';

const LOCKFILES = {
  'pnpm-lock.yaml': 'pnpm',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
} as const;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const failure = (code: string, message: string) =>
  new MpxError({ code, message, retryable: false });

async function exec(
  executable: ResolvedExecutable,
  policy: TrustedExecutablePolicy,
  argv: readonly string[],
  cwd: string,
): Promise<Buffer> {
  await revalidateTrustedExecutable(executable, policy);
  return new Promise((resolve, reject) => {
    const child = spawn(executable.path, [...executable.trustedPrefixArguments, ...argv], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`${executable.path} exited ${code}`)),
    );
  });
}
async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
async function hashFile(file: string): Promise<string> {
  return sha256(await readFile(file));
}
async function nearestManifest(cwd: string, root: string): Promise<string | undefined> {
  let current = path.resolve(cwd);
  const boundary = path.resolve(root);
  for (;;) {
    const candidate = path.join(current, 'package.json');
    if (await exists(candidate)) {
      return candidate;
    }
    if (current === boundary) {
      return undefined;
    }
    const parent = path.dirname(current);
    if (!isPathWithinRoot(parent, boundary) && parent !== boundary) {
      return undefined;
    }
    current = parent;
  }
}
async function repositoryPackageManifests(
  gitExecutable: ResolvedExecutable,
  policy: TrustedExecutablePolicy,
  root: string,
  nearest: string | undefined,
): Promise<{ path: string; hash: string }[]> {
  const listed = (
    await exec(
      gitExecutable,
      policy,
      [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        ':(glob)**/package.json',
      ],
      root,
    )
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  if (nearest) {
    listed.push(path.relative(root, nearest));
  }
  const relativePaths = [...new Set(listed.map((value) => value.replaceAll('\\', '/')))].sort();
  const result: { path: string; hash: string }[] = [];
  for (const relative of relativePaths) {
    const file = path.resolve(root, relative);
    if (isPathWithinRoot(file, path.resolve(root)) && (await exists(file))) {
      result.push({ path: relative, hash: await hashFile(file) });
    }
  }
  return result;
}

async function repositoryLockfiles(
  gitExecutable: ResolvedExecutable,
  policy: TrustedExecutablePolicy,
  root: string,
  cwd: string,
): Promise<{ path: string; hash: string }[]> {
  const patterns = Object.keys(LOCKFILES).map((name) => `:(glob)**/${name}`);
  const listed = (
    await exec(
      gitExecutable,
      policy,
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...patterns],
      root,
    )
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const rootPath = path.resolve(root);
  const candidates = new Set(listed.map((value) => value.replaceAll('\\', '/')));
  let current = path.resolve(cwd);
  for (;;) {
    for (const name of Object.keys(LOCKFILES)) {
      candidates.add(path.relative(rootPath, path.join(current, name)).replaceAll('\\', '/'));
    }
    if (current === rootPath) {
      break;
    }
    const parent = path.dirname(current);
    if (!isPathWithinRoot(parent, rootPath) && parent !== rootPath) {
      break;
    }
    current = parent;
  }
  const canonicalRoot = await realpath(rootPath);
  const files = new Map<string, string>();
  for (const relative of candidates) {
    const candidate = path.resolve(rootPath, relative);
    if (!isPathWithinRoot(candidate, rootPath)) {
      continue;
    }
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch {
      continue;
    }
    if (!isPathWithinRoot(canonical, canonicalRoot)) {
      continue;
    }
    try {
      if (!(await stat(canonical)).isFile()) {
        continue;
      }
    } catch {
      continue;
    }
    const canonicalRelative = path.relative(canonicalRoot, canonical).replaceAll('\\', '/');
    if (!Object.prototype.hasOwnProperty.call(LOCKFILES, path.basename(canonicalRelative))) {
      continue;
    }
    files.set(canonicalRelative, await hashFile(canonical));
  }
  return [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relative, hash]) => ({ path: relative, hash }));
}

export async function detectPackageManager(root: string): Promise<PackageManager> {
  const found = new Set<PackageManager>();
  for (const [name, manager] of Object.entries(LOCKFILES)) {
    if (await exists(path.join(root, name))) {
      found.add(manager);
    }
  }
  if (found.size !== 1) {
    throw failure(
      'PREPARATION_PACKAGE_MANAGER_AMBIGUOUS',
      'Exactly one supported package-manager lockfile must be present.',
    );
  }
  return [...found][0]!;
}

function needsPackageManager(plan: PreparationPlan): boolean {
  return plan.steps.some(
    (step) => step.uses === 'package-install' || step.uses === 'package-script',
  );
}

export async function resolvePreparationPackageManager(
  root: string,
  plan: PreparationPlan,
  configured: ConfiguredPackageManager | undefined,
): Promise<PackageManager> {
  if (!needsPackageManager(plan)) {
    return 'pnpm';
  }
  if (configured === 'none') {
    throw failure(
      'PREPARATION_PACKAGE_MANAGER_UNAVAILABLE',
      'This preparation plan requires a package manager, but configuration set it to none.',
    );
  }
  const detected = await detectPackageManager(root);
  if (configured === undefined || configured === 'auto') {
    return detected;
  }
  if (configured !== detected) {
    throw failure(
      'PREPARATION_PACKAGE_MANAGER_MISMATCH',
      'The configured package manager does not match the repository lockfile.',
    );
  }
  return configured;
}

export class NodePreparationEvidenceAdapter implements PreparationEvidenceAdapter {
  constructor(
    private readonly gitExecutable = 'git',
    private readonly trustedExecutablePolicy?: TrustedExecutablePolicy,
  ) {}
  async capture(request: {
    worktreeRoot: string;
    cwd: string;
    step: PreparationStep;
  }): Promise<PreparationEvidence> {
    const policy =
      this.trustedExecutablePolicy ?? productionTrustedExecutablePolicy([request.worktreeRoot]);
    const trustedGit = await resolveTrustedExecutable(
      this.gitExecutable,
      request.worktreeRoot,
      policy,
    );
    const commonReported = (
      await exec(trustedGit, policy, ['rev-parse', '--git-common-dir'], request.worktreeRoot)
    )
      .toString('utf8')
      .trim();
    const common = await realpath(
      path.isAbsolute(commonReported)
        ? commonReported
        : path.resolve(request.worktreeRoot, commonReported),
    );
    const mainRoot = path.dirname(common);
    const head = (await exec(trustedGit, policy, ['rev-parse', 'HEAD'], request.worktreeRoot))
      .toString('utf8')
      .trim();
    const manifest = await nearestManifest(request.cwd, request.worktreeRoot);
    const packageManifestHash = sha256(
      JSON.stringify(
        await repositoryPackageManifests(trustedGit, policy, request.worktreeRoot, manifest),
      ),
    );
    const lockfileHashes = await repositoryLockfiles(
      trustedGit,
      policy,
      request.worktreeRoot,
      request.cwd,
    );
    let resolvedPackageScriptBody: string | undefined;
    if (request.step.uses === 'package-script' && manifest) {
      const parsed = parseStrictJson(await readFile(manifest, 'utf8')) as { scripts?: unknown };
      const scripts =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? parsed.scripts
          : undefined;
      if (typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts)) {
        const body = (scripts as Record<string, unknown>)[request.step.script];
        if (typeof body === 'string') {
          resolvedPackageScriptBody = body;
        }
      }
    }
    const config = path.join(mainRoot, 'mpxconfig.json');
    return {
      repositoryIdentity: common,
      head,
      configHash: await hashFile(config),
      packageManifestHash,
      lockfileHashes,
      ...(resolvedPackageScriptBody === undefined ? {} : { resolvedPackageScriptBody }),
    };
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  // A directory sync makes the rename durable on filesystems that support it. Windows
  // does not permit opening directories this way, so the file sync + same-directory
  // rename remains the strongest portable guarantee there.
  try {
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    /* unsupported directory fsync */
  }
}
function stateFile(directory: string, key: string): string {
  return path.join(directory, 'states', `${sha256(key)}.json`);
}
function stateLockFile(directory: string, key: string): string {
  return path.join(directory, 'state-locks', `${sha256(key)}.lock`);
}

export type PreparationProcessIdentityInspection =
  | { status: 'present'; pid: number; startFingerprint: string }
  | { status: 'absent'; pid: number }
  | { status: 'unknown'; pid: number };
export interface PreparationProcessIdentityInspector {
  inspect(pid: number): Promise<PreparationProcessIdentityInspection>;
}
export interface NodePreparationStoreOptions {
  maximumLogBytes?: number;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  ownerlessGraceMs?: number;
  now?: () => number;
  token?: () => string;
  processIdentityInspector?: PreparationProcessIdentityInspector;
}
interface PreparationLockOwner {
  schemaVersion: 1;
  owner: 'mpx';
  token: string;
  pid: number;
  processStartFingerprint: string;
  acquiredAt: number;
}
const fallbackStartFingerprint = `node:${Math.round(Date.now() - process.uptime() * 1_000)}`;
const fallbackPreparationInspector: PreparationProcessIdentityInspector = {
  inspect: async (pid) => {
    if (pid === process.pid) {
      return { status: 'present', pid, startFingerprint: fallbackStartFingerprint };
    }
    try {
      process.kill(pid, 0);
      return { status: 'unknown', pid };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
        ? { status: 'absent', pid }
        : { status: 'unknown', pid };
    }
  },
};
function parsePreparationLockOwner(value: unknown): PreparationLockOwner | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const owner = value as Partial<PreparationLockOwner>;
  return owner.schemaVersion === 1 &&
    owner.owner === 'mpx' &&
    typeof owner.token === 'string' &&
    owner.token.length > 0 &&
    Number.isSafeInteger(owner.pid) &&
    (owner.pid ?? 0) > 0 &&
    typeof owner.processStartFingerprint === 'string' &&
    owner.processStartFingerprint.length > 0 &&
    typeof owner.acquiredAt === 'number' &&
    Number.isFinite(owner.acquiredAt)
    ? (owner as PreparationLockOwner)
    : undefined;
}

export class PreparationStateLock {
  constructor(
    private readonly options: Required<
      Pick<
        NodePreparationStoreOptions,
        | 'lockTimeoutMs'
        | 'lockRetryMs'
        | 'ownerlessGraceMs'
        | 'now'
        | 'token'
        | 'processIdentityInspector'
      >
    >,
  ) {}
  async withLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
    const release = await this.acquire(lockPath);
    try {
      return await action();
    } finally {
      await release();
    }
  }
  async acquire(lockPath: string): Promise<() => Promise<void>> {
    await mkdir(path.dirname(lockPath), { recursive: true });
    const ownIdentity = await this.inspect(process.pid);
    if (ownIdentity.status !== 'present') {
      throw failure(
        'PREPARATION_STATE_LOCK_IDENTITY_UNKNOWN',
        'The preparation state lock owner identity could not be established.',
      );
    }
    const deadline = this.options.now() + this.options.lockTimeoutMs;
    let token = '';
    for (;;) {
      token = this.options.token();
      const candidate = `${lockPath}.candidate-${token}`;
      try {
        await mkdir(candidate);
        await atomicWrite(
          path.join(candidate, 'owner.json'),
          `${JSON.stringify({ schemaVersion: 1, owner: 'mpx', token, pid: process.pid, processStartFingerprint: ownIdentity.startFingerprint, acquiredAt: this.options.now() })}\n`,
        );
        await rename(candidate, lockPath);
        break;
      } catch (error) {
        await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
        if (
          !['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        ) {
          throw error;
        }
        if (await this.reclaim(lockPath)) {
          continue;
        }
        if (this.options.now() >= deadline) {
          throw failure(
            'PREPARATION_STATE_LOCK_TIMEOUT',
            'Timed out waiting for the preparation state lock.',
          );
        }
        await new Promise((resolve) => setTimeout(resolve, this.options.lockRetryMs));
      }
    }
    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      await this.release(lockPath, token);
    };
  }
  private async inspect(pid: number): Promise<PreparationProcessIdentityInspection> {
    try {
      const inspected = await this.options.processIdentityInspector.inspect(pid);
      if (
        inspected.pid !== pid ||
        (inspected.status === 'present' && inspected.startFingerprint.length === 0)
      ) {
        return { status: 'unknown', pid };
      }
      return inspected;
    } catch {
      return { status: 'unknown', pid };
    }
  }
  private async reclaimable(lockPath: string): Promise<boolean> {
    let owner: PreparationLockOwner | undefined;
    try {
      owner = parsePreparationLockOwner(
        parseStrictJson(await readFile(path.join(lockPath, 'owner.json'), 'utf8')),
      );
    } catch {
      owner = undefined;
    }
    if (owner) {
      const inspected = await this.inspect(owner.pid);
      return (
        inspected.status === 'absent' ||
        (inspected.status === 'present' &&
          inspected.startFingerprint !== owner.processStartFingerprint)
      );
    }
    let modifiedAt: number;
    try {
      modifiedAt = (await stat(path.join(lockPath, 'owner.json'))).mtimeMs;
    } catch {
      try {
        modifiedAt = (await stat(lockPath)).mtimeMs;
      } catch {
        return false;
      }
    }
    return this.options.now() - modifiedAt >= this.options.ownerlessGraceMs;
  }
  private async reclaim(lockPath: string): Promise<boolean> {
    if (!(await this.reclaimable(lockPath))) {
      return false;
    }
    const quarantine = `${lockPath}.quarantine-${this.options.token()}`;
    try {
      await rename(lockPath, quarantine);
    } catch {
      return false;
    }
    if (!(await this.reclaimable(quarantine))) {
      await rename(quarantine, lockPath).catch(() => undefined);
      return false;
    }
    await rm(quarantine, { recursive: true, force: true });
    return true;
  }
  private async release(lockPath: string, token: string): Promise<void> {
    let owner: PreparationLockOwner | undefined;
    try {
      owner = parsePreparationLockOwner(
        parseStrictJson(await readFile(path.join(lockPath, 'owner.json'), 'utf8')),
      );
    } catch {
      return;
    }
    if (owner?.token !== token) {
      return;
    }
    const quarantine = `${lockPath}.release-${this.options.token()}`;
    try {
      await rename(lockPath, quarantine);
    } catch {
      return;
    }
    try {
      const moved = parsePreparationLockOwner(
        parseStrictJson(await readFile(path.join(quarantine, 'owner.json'), 'utf8')),
      );
      if (moved?.token === token) {
        await rm(quarantine, { recursive: true, force: true });
      } else {
        await rename(quarantine, lockPath).catch(() => undefined);
      }
    } catch {
      await rename(quarantine, lockPath).catch(() => undefined);
    }
  }
}

export const nodePreparationPaths = { canonicalize: realpath };

export class NodePreparationStore implements PreparationStoreAdapter {
  private readonly root: string;
  private readonly maximumLogBytes: number;
  private readonly stateLock: PreparationStateLock;
  constructor(directory: string, options: number | NodePreparationStoreOptions = {}) {
    this.root = path.resolve(directory);
    const values = typeof options === 'number' ? { maximumLogBytes: options } : options;
    this.maximumLogBytes = values.maximumLogBytes ?? 65536;
    this.stateLock = new PreparationStateLock({
      lockTimeoutMs: values.lockTimeoutMs ?? 10_000,
      lockRetryMs: values.lockRetryMs ?? 10,
      ownerlessGraceMs: values.ownerlessGraceMs ?? 2_000,
      now: values.now ?? Date.now,
      token: values.token ?? randomUUID,
      processIdentityInspector: values.processIdentityInspector ?? fallbackPreparationInspector,
    });
  }
  async load(key: string): Promise<PreparationState | undefined> {
    try {
      const parsed = parseStrictJson(await readFile(stateFile(this.root, key), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('shape');
      }
      const value = parsed as Record<string, unknown>;
      if (
        value.owner !== 'mpx' ||
        value.schemaVersion !== 2 ||
        value.key !== key ||
        typeof value.runId !== 'string' ||
        value.runId.length < 16 ||
        !Number.isSafeInteger(value.revision) ||
        (value.revision as number) < 1 ||
        !['preparing', 'cancelling', 'ready', 'failed', 'cancelled', 'unknown'].includes(
          String(value.status),
        ) ||
        typeof value.execution !== 'string' ||
        typeof value.createdAt !== 'number' ||
        typeof value.updatedAt !== 'number' ||
        !Array.isArray(value.steps)
      ) {
        throw new Error('shape');
      }
      return value as unknown as PreparationState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw failure('PREPARATION_STATE_INVALID', 'Preparation state is malformed or unsupported.');
    }
  }
  async compareAndSwap(
    key: string,
    expectedRevision: number | undefined,
    state: PreparationState,
    revalidate?: () => Promise<void>,
  ): Promise<boolean> {
    if (
      key !== state.key ||
      state.owner !== 'mpx' ||
      state.schemaVersion !== 2 ||
      state.revision !== (expectedRevision ?? 0) + 1
    ) {
      throw failure(
        'PREPARATION_STATE_INVALID',
        'Preparation state identity or revision is invalid.',
      );
    }
    return this.stateLock.withLock(stateLockFile(this.root, key), async () => {
      const current = await this.load(key);
      if (
        current?.revision !== expectedRevision ||
        (current === undefined) !== (expectedRevision === undefined)
      ) {
        return false;
      }
      await revalidate?.();
      await atomicWrite(stateFile(this.root, key), `${JSON.stringify(state, null, 2)}\n`);
      return true;
    });
  }
  async writeLogAtomic(file: string, content: string): Promise<void> {
    const destination = path.resolve(file);
    if (!isPathWithinRoot(destination, this.root)) {
      throw failure(
        'PREPARATION_LOG_PATH_INVALID',
        'Preparation logs must remain under MPX local state.',
      );
    }
    const bytes = Buffer.from(content, 'utf8');
    let start = Math.max(0, bytes.length - this.maximumLogBytes);
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) {
      start += 1;
    }
    await atomicWrite(destination, bytes.subarray(start).toString('utf8'));
  }
}

export interface NativeProcessCapabilities {
  inspect(pid: number): Promise<{ pid: number; startFingerprint: string } | undefined>;
  terminateTree(process: { pid: number; startFingerprint: string }): Promise<void>;
}
export interface NodePreparationProcessOptions {
  nativeTimeoutMs?: number;
}
class OwnershipRegistry {
  constructor(private readonly root: string) {}
  private file(pid: number): string {
    return path.join(this.root, 'owners', `${pid}.json`);
  }
  async claim(processIdentity: OwnedProcess): Promise<void> {
    await atomicWrite(
      this.file(processIdentity.pid),
      JSON.stringify({ schemaVersion: 1, owner: 'mpx', ...processIdentity }),
    );
  }
  async release(processIdentity: OwnedProcess): Promise<void> {
    const file = this.file(processIdentity.pid);
    try {
      const marker = parseStrictJson(await readFile(file, 'utf8')) as Record<string, unknown>;
      if (
        marker.pid === processIdentity.pid &&
        marker.startFingerprint === processIdentity.startFingerprint &&
        marker.ownerToken === processIdentity.ownerToken
      ) {
        await rm(file);
      }
    } catch {
      /* A missing or replaced marker is not ours to remove. */
    }
  }
  async inspect(
    pid: number,
    native: Pick<NativeProcessCapabilities, 'inspect'>,
  ): Promise<InspectedProcess | undefined> {
    const current = await native.inspect(pid);
    if (!current) {
      return undefined;
    }
    try {
      const parsed = parseStrictJson(await readFile(this.file(pid), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { startFingerprint: current.startFingerprint, owner: 'other' };
      }
      const marker = parsed as Record<string, unknown>;
      if (
        marker.owner !== 'mpx' ||
        marker.pid !== pid ||
        marker.startFingerprint !== current.startFingerprint ||
        (marker.ownerToken !== undefined && typeof marker.ownerToken !== 'string')
      ) {
        return { startFingerprint: current.startFingerprint, owner: 'other' };
      }
      return {
        startFingerprint: current.startFingerprint,
        owner: 'mpx',
        ...(typeof marker.ownerToken === 'string' ? { ownerToken: marker.ownerToken } : {}),
      };
    } catch {
      return { startFingerprint: current.startFingerprint, owner: 'other' };
    }
  }
}

const DEFAULT_NATIVE_TIMEOUT_MS = 10_000;

export class NodePreparationProcessAdapter implements PreparationProcessAdapter {
  private readonly ownership: OwnershipRegistry;
  private readonly nativeTimeoutMs: number;
  constructor(
    private readonly native: NativeProcessCapabilities,
    stateRoot: string,
    options: NodePreparationProcessOptions = {},
  ) {
    this.ownership = new OwnershipRegistry(stateRoot);
    this.nativeTimeoutMs = options.nativeTimeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS;
    if (!Number.isFinite(this.nativeTimeoutMs) || this.nativeTimeoutMs <= 0) {
      throw new RangeError('nativeTimeoutMs must be a finite positive number');
    }
  }
  claim(processIdentity: OwnedProcess): Promise<void> {
    return this.ownership.claim(processIdentity);
  }
  releaseClaim(processIdentity: OwnedProcess): Promise<void> {
    return this.ownership.release(processIdentity);
  }
  inspectNative(pid: number): ReturnType<NativeProcessCapabilities['inspect']> {
    return this.withNativeTimeout(() => this.native.inspect(pid), 'inspection');
  }
  inspect(pid: number): Promise<InspectedProcess | undefined> {
    return this.ownership.inspect(pid, { inspect: (currentPid) => this.inspectNative(currentPid) });
  }
  async terminateTree(pid: number, expected?: OwnedProcess): Promise<void> {
    const inspected = await this.inspect(pid);
    if (
      !inspected ||
      inspected.owner !== 'mpx' ||
      (expected &&
        (expected.startFingerprint !== inspected.startFingerprint ||
          expected.ownerToken !== inspected.ownerToken))
    ) {
      throw failure(
        'PREPARATION_PROCESS_UNKNOWN',
        'The exact process identity is not owned by MPX.',
      );
    }
    await this.withNativeTimeout(
      () => this.native.terminateTree({ pid, startFingerprint: inspected.startFingerprint }),
      'termination',
    );
  }
  private async withNativeTimeout<T>(
    operation: () => Promise<T>,
    kind: 'inspection' | 'termination',
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                failure('PREPARATION_PROCESS_NATIVE_TIMEOUT', `Native process ${kind} timed out.`),
              ),
            this.nativeTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

const BASE_ENVIRONMENT = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'LOCALAPPDATA',
  'MPX_APPS',
  'MPX_PROJECTS',
  'MPX_WORK',
  'MPX_CLONED',
  'MPX_AI_GENERATED',
];
function childEnvironment(
  names: readonly string[],
  supplied: Readonly<Record<string, string>> = process.env as Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    [...new Set([...BASE_ENVIRONMENT, ...names])].flatMap((name) =>
      supplied[name] === undefined ? [] : [[name, supplied[name]]],
    ),
  );
}

async function readBackgroundPreparationRequest(
  requestFile: string,
  stateRoot: string,
  workerToken: string | undefined,
  consume: boolean,
): Promise<BackgroundPreparationRequest> {
  const requestsRoot = path.resolve(stateRoot, 'worker-requests');
  const file = path.resolve(requestFile);
  if (!isPathWithinRoot(file, requestsRoot) || !/^[0-9a-f-]+\.json$/iu.test(path.basename(file))) {
    throw failure('PREPARATION_WORKER_REQUEST_INVALID', 'The worker request path is invalid.');
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJson(await readFile(file, 'utf8'));
  } catch {
    throw failure(
      'PREPARATION_WORKER_REQUEST_INVALID',
      'The worker request is missing or malformed.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw failure('PREPARATION_WORKER_REQUEST_INVALID', 'The worker request is malformed.');
  }
  const envelope = parsed as Record<string, unknown>;
  const candidate = envelope.request;
  if (
    !workerToken ||
    envelope.workerToken !== workerToken ||
    envelope.schemaVersion !== 1 ||
    envelope.owner !== 'mpx' ||
    typeof candidate !== 'object' ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    throw failure('PREPARATION_WORKER_REQUEST_INVALID', 'The worker request is malformed.');
  }
  const request = candidate as Record<string, unknown>;
  if (
    typeof request.key !== 'string' ||
    typeof request.runId !== 'string' ||
    request.runId.length < 16 ||
    typeof request.worktreeRoot !== 'string' ||
    typeof request.logDirectory !== 'string' ||
    !['pnpm', 'npm', 'yarn', 'bun'].includes(String(request.packageManager)) ||
    !Array.isArray(request.environmentNames) ||
    request.environmentNames.some((value) => typeof value !== 'string') ||
    typeof request.plan !== 'object' ||
    request.plan === null ||
    typeof request.approval !== 'object' ||
    request.approval === null
  ) {
    throw failure('PREPARATION_WORKER_REQUEST_INVALID', 'The worker request is malformed.');
  }
  const approval = request.approval as Record<string, unknown>;
  if (
    approval.schemaVersion !== 1 ||
    approval.owner !== 'mpx' ||
    !Array.isArray(approval.steps) ||
    approval.steps.some(
      (step) =>
        typeof step !== 'object' ||
        step === null ||
        !['package', 'explicit-argv'].includes(String((step as Record<string, unknown>).kind)),
    )
  ) {
    throw failure(
      'PREPARATION_WORKER_REQUEST_INVALID',
      'The worker approval evidence is malformed.',
    );
  }
  const expected = preparationApprovalPhrases(
    approval as unknown as import('./preparation-engine.js').PreparationApproval,
  );
  if (
    request.packageAutomationApproval !== expected.packageAutomationApproval ||
    request.explicitExecutableApproval !== expected.explicitExecutableApproval
  ) {
    throw failure(
      'PREPARATION_WORKER_REQUEST_INVALID',
      'The worker request is missing separate exact preparation approvals.',
    );
  }
  if (consume) {
    await rm(file);
  }
  return request as unknown as BackgroundPreparationRequest;
}

export async function consumeBackgroundPreparationRequest(
  requestFile: string,
  stateRoot: string,
  workerToken: string | undefined,
): Promise<BackgroundPreparationRequest> {
  return readBackgroundPreparationRequest(requestFile, stateRoot, workerToken, true);
}

export async function awaitBackgroundPreparationActivation(
  requestFile: string,
  stateRoot: string,
  workerToken: string | undefined,
): Promise<BackgroundPreparationRequest> {
  await readBackgroundPreparationRequest(requestFile, stateRoot, workerToken, false);
  if (!workerToken || typeof process.send !== 'function' || !process.connected) {
    throw failure(
      'PREPARATION_WORKER_HANDSHAKE_FAILED',
      'The worker has no directly owned parent channel.',
    );
  }
  await new Promise<void>((resolve, reject) =>
    process.send!(
      { type: 'mpx-preparation-ready', workerToken, requestId: path.basename(requestFile) },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          failure(
            'PREPARATION_WORKER_HANDSHAKE_FAILED',
            'The worker was not activated by its parent.',
          ),
        );
      }, 6_000);
      const message = (value: unknown) => {
        if (typeof value !== 'object' || value === null) {
          return;
        }
        const record = value as Record<string, unknown>;
        if (record.type === 'mpx-preparation-abort') {
          cleanup();
          reject(
            failure(
              'PREPARATION_WORKER_HANDSHAKE_FAILED',
              'The parent aborted inert worker startup.',
            ),
          );
          return;
        }
        if (record.type !== 'mpx-preparation-activate' || record.workerToken !== workerToken) {
          return;
        }
        cleanup();
        resolve();
      };
      const disconnected = () => {
        cleanup();
        reject(
          failure(
            'PREPARATION_WORKER_HANDSHAKE_FAILED',
            'The worker parent disconnected before activation.',
          ),
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        process.removeListener('message', message);
        process.removeListener('disconnect', disconnected);
      };
      process.on('message', message);
      process.once('disconnect', disconnected);
    });
  } catch (error) {
    await rm(requestFile, { force: true });
    throw error;
  }
  return consumeBackgroundPreparationRequest(requestFile, stateRoot, workerToken);
}

export interface NodePreparationExecutionOptions {
  process: NodePreparationProcessAdapter;
  workerEntry: string;
  stateRoot: string;
  nodeExecutable?: string;
  environment?: Readonly<Record<string, string>>;
  trustedExecutablePolicy?: TrustedExecutablePolicy;
}
export async function boundedWait<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T | undefined> {
  if (milliseconds <= 0) {
    return undefined;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), milliseconds);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
async function awaitWorkerExit(child: import('node:child_process').ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
}
async function stopOwnedInertWorker(
  child: import('node:child_process').ChildProcess,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (typeof child.send === 'function' && child.connected) {
    await boundedWait(
      new Promise<void>((resolve, reject) =>
        child.send!({ type: 'mpx-preparation-abort' }, (error) =>
          error ? reject(error) : resolve(),
        ),
      ).catch(() => undefined),
      200,
    );
  }
  await boundedWait(awaitWorkerExit(child), 400);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill();
    } catch {
      /* The child may have exited between the check and signal. */
    }
  }
  await boundedWait(awaitWorkerExit(child), 400);
}
async function waitForWorkerAcknowledgement(
  child: import('node:child_process').ChildProcess,
  workerToken: string,
  requestId: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        failure(
          'PREPARATION_WORKER_HANDSHAKE_FAILED',
          'The inert preparation worker did not acknowledge startup.',
        ),
      );
    }, 6_000);
    const message = (value: unknown) => {
      if (typeof value !== 'object' || value === null) {
        return;
      }
      const record = value as Record<string, unknown>;
      if (
        record.type !== 'mpx-preparation-ready' ||
        record.workerToken !== workerToken ||
        record.requestId !== requestId
      ) {
        return;
      }
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(
        failure(
          'PREPARATION_WORKER_HANDSHAKE_FAILED',
          'The inert preparation worker exited before acknowledgement.',
        ),
      );
    };
    const failed = () => {
      cleanup();
      reject(
        failure(
          'PREPARATION_WORKER_START_FAILED',
          'The inert preparation worker could not be started.',
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('message', message);
      child.removeListener('close', closed);
      child.removeListener('error', failed);
    };
    child.on('message', message);
    child.once('close', closed);
    child.once('error', failed);
  });
}
async function activateWorker(
  child: import('node:child_process').ChildProcess,
  workerToken: string,
): Promise<void> {
  if (typeof child.send !== 'function' || !child.connected) {
    throw failure(
      'PREPARATION_WORKER_HANDSHAKE_FAILED',
      'The verified worker parent channel is unavailable.',
    );
  }
  await new Promise<void>((resolve, reject) =>
    child.send!({ type: 'mpx-preparation-activate', workerToken }, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
}
export class NodePreparationExecutionAdapter implements PreparationExecutionAdapter {
  constructor(private readonly options: NodePreparationExecutionOptions) {}
  resolveExecutable(command: string, cwd: string): Promise<ResolvedExecutable> {
    return resolveTrustedExecutable(
      command,
      cwd,
      this.options.trustedExecutablePolicy ?? productionTrustedExecutablePolicy([cwd]),
    );
  }
  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    if (request.shell || request.argv.length === 0 || !path.isAbsolute(request.argv[0]!)) {
      throw failure(
        'PREPARATION_EXECUTION_INVALID',
        'Preparation requires a trusted absolute executable in argv[0].',
      );
    }
    const policy =
      this.options.trustedExecutablePolicy ?? productionTrustedExecutablePolicy([request.cwd]);
    const executable =
      request.executable ?? (await resolveTrustedExecutable(request.argv[0]!, request.cwd, policy));
    if (request.executable && request.argv[0] !== executable.path) {
      throw failure(
        'PREPARATION_EXECUTION_INVALID',
        'Preparation executable evidence does not match argv[0].',
      );
    }
    await revalidateTrustedExecutable(executable, policy);
    const trustedPrefixArguments = [...(executable.trustedPrefixArguments ?? [])];
    const providedPrefix = request.argv.slice(1, trustedPrefixArguments.length + 1);
    if (
      providedPrefix.length !== trustedPrefixArguments.length ||
      providedPrefix.some((argument, index) => argument !== trustedPrefixArguments[index])
    ) {
      throw failure(
        'PREPARATION_EXECUTION_INVALID',
        'Preparation argv does not contain the approved launcher prefix.',
      );
    }
    const command = executable.path;
    const args = [
      ...trustedPrefixArguments,
      ...request.argv.slice(trustedPrefixArguments.length + 1),
    ];
    let output = Buffer.alloc(0);
    const outputLimit = request.maxOutputBytes ?? 65536;
    const collect = (value: unknown) => {
      output = Buffer.concat([output, Buffer.from(value as Uint8Array)]);
      if (output.length > outputLimit) {
        output = output.subarray(output.length - outputLimit);
      }
    };
    return new Promise((resolve, reject) => {
      const environment = childEnvironment(request.environmentNames, {
        ...(process.env as Record<string, string>),
        ...request.environment,
      });
      const child = spawn(command, args, {
        cwd: request.cwd,
        shell: false,
        windowsHide: true,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      let cancelInspection = false;
      let timedOut = false;
      let settled = false;
      let finishing = false;
      let registrationError: unknown;
      let registrationFailureCleanup: Promise<void> | undefined;
      let claimed: OwnedProcess | undefined;
      let termination: Promise<'terminated' | 'unknown'> = Promise.resolve('unknown');
      let timer: NodeJS.Timeout | undefined;
      const childExited = new Promise<number | null>((resolveExit) =>
        child.once('close', resolveExit),
      );
      const signalDirectChild = () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        try {
          child.kill();
        } catch {
          /* The directly owned child may exit between the check and signal. */
        }
      };
      const cleanupRegistration = async (owned: OwnedProcess | undefined) => {
        signalDirectChild();
        if (owned) {
          await boundedWait(
            this.options.process.terminateTree(owned.pid, owned).catch(() => undefined),
            900,
          );
          await boundedWait(
            this.options.process.releaseClaim(owned).catch(() => undefined),
            900,
          );
        }
      };
      const identity = (async (): Promise<OwnedProcess | undefined> => {
        if (!child.pid) {
          return undefined;
        }
        const native = await this.waitForFingerprint(child.pid, () => cancelInspection);
        if (!native || cancelInspection) {
          return undefined;
        }
        const owned = { ...native, ownerToken: randomUUID() };
        await this.options.process.claim(owned);
        claimed = owned;
        await request.onStarted(owned);
        return owned;
      })();
      const failRegistration = async (error: unknown) => {
        cancelInspection = true;
        // Once the execution timeout owns settlement, a failed/unknown native
        // fingerprint is cleanup uncertainty, not a second spawn failure.
        if (timedOut) {
          await cleanupRegistration(claimed);
          return;
        }
        registrationError = error;
        await cleanupRegistration(claimed);
        await boundedWait(childExited, 900);
        if (!settled) {
          settled = true;
          if (timer) {
            clearTimeout(timer);
          }
          reject(error);
        }
      };
      // Register this rejection handler before any child exit can settle the spawn successfully.
      void identity.catch((error) => {
        registrationFailureCleanup = failRegistration(error);
      });
      const finish = async (code: number | null) => {
        if (settled || finishing) {
          return;
        }
        finishing = true;
        if (timer) {
          clearTimeout(timer);
        }
        const deadline = timedOut ? Date.now() + 950 : Date.now() + 1_000;
        if (timedOut) {
          const remaining = () => Math.max(0, deadline - Date.now());
          await boundedWait(termination, remaining());
          await boundedWait(childExited, remaining());
        }
        const owned = await boundedWait(
          identity.catch(() => undefined),
          Math.max(0, deadline - Date.now()),
        );
        if (registrationError) {
          await registrationFailureCleanup?.catch(() => undefined);
          if (!settled) {
            settled = true;
            reject(registrationError);
          }
          return;
        }
        if (settled) {
          return;
        }
        settled = true;
        resolve({
          exitCode: code,
          output,
          timedOut,
          ...(owned ? { pid: owned.pid, startFingerprint: owned.startFingerprint } : {}),
          ...(timedOut
            ? {
                terminationState:
                  (await boundedWait(termination, Math.max(0, deadline - Date.now()))) ?? 'unknown',
              }
            : {}),
        });
      };
      timer = setTimeout(() => {
        timedOut = true;
        cancelInspection = true;
        // The ChildProcess handle is directly owned by this invocation and is safe to signal without trusting a PID.
        signalDirectChild();
        const deadline = Date.now() + 950;
        termination = (async () => {
          const owned = await boundedWait(
            identity.catch(() => undefined),
            Math.max(0, deadline - Date.now()),
          );
          if (!owned) {
            return 'unknown' as const;
          }
          return (
            (await boundedWait(
              this.options.process
                .terminateTree(owned.pid, owned)
                .then(() => 'terminated' as const)
                .catch(() => 'unknown' as const),
              Math.max(0, deadline - Date.now()),
            )) ?? 'unknown'
          );
        })().catch(() => 'unknown');
        void finish(child.exitCode);
      }, request.timeoutMs);
      child.once('error', (error) => {
        if (!timedOut && !settled) {
          settled = true;
          if (timer) {
            clearTimeout(timer);
          }
          reject(error);
        }
      });
      child.once('close', (code) => {
        cancelInspection = true;
        void finish(code);
      });
    });
  }
  async startBackground(
    request: BackgroundPreparationRequest,
    onVerified: (process: OwnedProcess) => Promise<void>,
  ): Promise<OwnedProcess> {
    const directory = path.join(this.options.stateRoot, 'worker-requests');
    const requestFile = path.join(directory, `${randomUUID()}.json`);
    const workerToken = randomUUID();
    let child: import('node:child_process').ChildProcess | undefined;
    let owned: OwnedProcess | undefined;
    try {
      await atomicWrite(
        requestFile,
        JSON.stringify({ schemaVersion: 1, owner: 'mpx', workerToken, request }),
      );
      const workerEnvironment = childEnvironment(
        request.environmentNames,
        this.options.environment ?? (process.env as Record<string, string>),
      );
      workerEnvironment.MPX_PREPARATION_WORKER_TOKEN = workerToken;
      const workerPolicy =
        this.options.trustedExecutablePolicy ??
        productionTrustedExecutablePolicy([request.worktreeRoot]);
      const workerExecutable = await resolveTrustedExecutable(
        this.options.nodeExecutable ?? process.execPath,
        request.worktreeRoot,
        workerPolicy,
      );
      await revalidateTrustedExecutable(workerExecutable, workerPolicy);
      child = spawn(
        workerExecutable.path,
        [this.options.workerEntry, '__preparation-worker', requestFile],
        {
          detached: false,
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          env: workerEnvironment,
        },
      );
      if (!child.pid) {
        throw failure(
          'PREPARATION_WORKER_START_FAILED',
          'The preparation worker did not report a PID.',
        );
      }
      await waitForWorkerAcknowledgement(child, workerToken, path.basename(requestFile));
      const native = await this.waitForFingerprint(child.pid);
      if (!native) {
        throw failure(
          'PREPARATION_WORKER_START_UNKNOWN',
          'The preparation worker identity could not be verified.',
        );
      }
      owned = { ...native, ownerToken: randomUUID() };
      await this.options.process.claim(owned);
      await onVerified(owned);
      await activateWorker(child, workerToken);
      child.disconnect();
      child.unref();
      return owned;
    } catch (error) {
      // The request is disposable until activation has completed. This also covers
      // resolution and synchronous spawn failures, before a child handle exists.
      await rm(requestFile, { force: true }).catch(() => undefined);
      if (child) {
        // The child handle is directly owned, so signal it without waiting for native PID cleanup.
        await stopOwnedInertWorker(child);
      }
      if (owned) {
        await boundedWait(
          this.options.process.terminateTree(owned.pid, owned).catch(() => undefined),
          1_000,
        );
      }
      if (owned) {
        await boundedWait(
          this.options.process.releaseClaim(owned).catch(() => undefined),
          1_000,
        );
      }
      throw error;
    }
  }
  private async waitForFingerprint(
    pid: number,
    cancelled: () => boolean = () => false,
  ): Promise<{ pid: number; startFingerprint: string } | undefined> {
    for (let index = 0; index < 15 && !cancelled(); index += 1) {
      // Native Windows inspection starts a PowerShell/CIM process and routinely needs
      // more than a scheduler tick. Bound each attempt without discarding valid slow results.
      const found = await boundedWait(this.options.process.inspectNative(pid), 2_000);
      if (found) {
        return found;
      }
      if (!cancelled()) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    return undefined;
  }
}
