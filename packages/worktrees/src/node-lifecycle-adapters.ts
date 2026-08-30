import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { MpxError, parseStrictJson } from '@mpx/core';
import {
  listWorktrees,
  resolveRepository,
  type FileSystemAdapter,
  type GitAdapter,
  type RepositoryLock,
} from './index.js';
import {
  productionTrustedExecutablePolicy,
  resolveTrustedExecutable,
  revalidateTrustedExecutable,
  type TrustedExecutablePolicy,
} from './trusted-executable.js';
import {
  assertLifecycleStateIdentity,
  sameLifecyclePath,
  type LifecycleGitAdapter,
  type LifecycleState,
  type LifecycleStateStore,
} from './lifecycle.js';

function execute(gitExecutable: string, args: readonly string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    execFile(
      gitExecutable,
      [...args],
      {
        cwd,
        encoding: 'buffer',
        shell: false,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_EDITOR: 'true',
          GIT_SEQUENCE_EDITOR: 'true',
        },
      },
      (error, stdout) =>
        error ? reject(error) : resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)),
    ),
  );
}
function fileName(key: string): string {
  return `${createHash('sha256').update(key).digest('hex')}.json`;
}
const LIFECYCLE_STATUSES = new Set<LifecycleState['status']>([
  'creating',
  'created',
  'including',
  'included',
  'allocating',
  'leased',
  'preparation-pending',
  'preparing',
  'approval-required',
  'ready',
  'failed',
  'unknown',
  'removing',
  'git-removed-awaiting-lease-release',
  'removed',
  'orphaned',
]);
const LIFECYCLE_PHASES = new Set(['git', 'includes', 'ports', 'preparation', 'remove', 'release']);
const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
function validState(value: unknown): value is LifecycleState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const state = value as Partial<LifecycleState>;
  if (
    state.schemaVersion !== 1 ||
    state.owner !== 'mpx' ||
    !nonEmptyString(state.key) ||
    !nonEmptyString(state.repositoryId) ||
    !nonEmptyString(state.repositoryIdentity) ||
    !nonEmptyString(state.mainRoot) ||
    !nonEmptyString(state.worktreePath) ||
    !nonEmptyString(state.branch) ||
    !nonEmptyString(state.base) ||
    !LIFECYCLE_STATUSES.has(state.status as LifecycleState['status']) ||
    !finiteNumber(state.createdAt) ||
    !finiteNumber(state.updatedAt)
  ) {
    return false;
  }
  if (!nonEmptyString(state.configHash)) {
    return false;
  }
  if (state.leaseId !== undefined && !nonEmptyString(state.leaseId)) {
    return false;
  }
  if (state.releaseIdentity !== undefined) {
    const identity = state.releaseIdentity;
    const required = [
      'schemaVersion',
      'leaseId',
      'projectId',
      'repositoryId',
      'worktreeId',
      'worktreePath',
      'role',
      'configHash',
    ];
    const allowed = new Set([...required, 'gitAdminPath', 'commonGitPath']);
    if (
      Object.keys(identity).some((key) => !allowed.has(key)) ||
      required.some((key) => !(key in identity)) ||
      identity.schemaVersion !== 1 ||
      identity.role !== 'linked' ||
      ![
        identity.leaseId,
        identity.projectId,
        identity.repositoryId,
        identity.worktreeId,
        identity.worktreePath,
        identity.configHash,
      ].every(nonEmptyString) ||
      [identity.gitAdminPath, identity.commonGitPath].some(
        (value) => value !== undefined && !nonEmptyString(value),
      ) ||
      identity.configHash !== state.configHash ||
      !sameLifecyclePath(identity.worktreePath, state.worktreePath)
    ) {
      return false;
    }
  }
  if (
    ['removing', 'git-removed-awaiting-lease-release'].includes(state.status as string) &&
    state.releaseIdentity === undefined
  ) {
    return false;
  }
  if (state.preparationStatus !== undefined && !nonEmptyString(state.preparationStatus)) {
    return false;
  }
  if (state.expectedApproval !== undefined && !nonEmptyString(state.expectedApproval)) {
    return false;
  }
  if (state.externalDeletion !== undefined && typeof state.externalDeletion !== 'boolean') {
    return false;
  }
  if (state.sourceRoot !== undefined && !nonEmptyString(state.sourceRoot)) {
    return false;
  }
  if (
    state.preparationExecution !== undefined &&
    !['none', 'foreground', 'background'].includes(state.preparationExecution)
  ) {
    return false;
  }
  if (
    state.includeEvidence !== undefined &&
    (!nonEmptyString(state.includeEvidence.manifestSha256) ||
      (state.includeEvidence.expectedApproval !== undefined &&
        !nonEmptyString(state.includeEvidence.expectedApproval)) ||
      (state.includeEvidence.copyStarted !== undefined &&
        typeof state.includeEvidence.copyStarted !== 'boolean') ||
      (state.includeEvidence.completed !== undefined &&
        typeof state.includeEvidence.completed !== 'boolean'))
  ) {
    return false;
  }
  if (
    state.preparationEvidence !== undefined &&
    (!nonEmptyString(state.preparationEvidence.planDigest) ||
      (state.preparationEvidence.expectedApproval !== undefined &&
        !nonEmptyString(state.preparationEvidence.expectedApproval)))
  ) {
    return false;
  }
  if (
    state.failure !== undefined &&
    (typeof state.failure !== 'object' ||
      state.failure === null ||
      !LIFECYCLE_PHASES.has(state.failure.phase) ||
      !nonEmptyString(state.failure.code) ||
      !nonEmptyString(state.failure.message))
  ) {
    return false;
  }
  if (
    state.approval !== undefined &&
    (typeof state.approval !== 'object' ||
      state.approval === null ||
      state.approval.schemaVersion !== 1 ||
      state.approval.owner !== 'mpx' ||
      !Array.isArray(state.approval.steps) ||
      state.approval.steps.some(
        (step) =>
          typeof step !== 'object' ||
          step === null ||
          !nonEmptyString(step.id) ||
          !['package', 'explicit-argv'].includes(step.kind) ||
          !nonEmptyString(step.digest),
      ))
  ) {
    return false;
  }
  return true;
}

/** Atomic, version-checking lifecycle state persistence in a caller-selected local directory. */
export class NodeLifecycleStateStore implements LifecycleStateStore {
  constructor(private readonly directory: string) {}
  async load(key: string): Promise<LifecycleState | undefined> {
    try {
      const parsed = parseStrictJson(
        await readFile(path.join(this.directory, fileName(key)), 'utf8'),
      );
      if (!validState(parsed) || parsed.key !== key) {
        throw new Error('invalid shape');
      }
      assertLifecycleStateIdentity(parsed);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw new MpxError({
        code: 'WORKTREE_LIFECYCLE_STATE_INVALID',
        message: 'Lifecycle state is malformed or unsupported.',
        details: { cause: String(error) },
      });
    }
  }
  async writeAtomic(key: string, state: LifecycleState): Promise<void> {
    if (key !== state.key || !validState(state)) {
      throw new MpxError({
        code: 'WORKTREE_LIFECYCLE_STATE_INVALID',
        message: 'Lifecycle state identity is invalid.',
      });
    }
    assertLifecycleStateIdentity(state);
    await mkdir(this.directory, { recursive: true });
    const destination = path.join(this.directory, fileName(key));
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
  }
  async list(repositoryIdentity: string): Promise<readonly LifecycleState[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    const states = await Promise.all(
      names
        .filter((name) => /^[0-9a-f]{64}\.json$/u.test(name))
        .map(async (name) => {
          try {
            const parsed = parseStrictJson(await readFile(path.join(this.directory, name), 'utf8'));
            if (!validState(parsed) || fileName(parsed.key) !== name) {
              throw new Error('invalid shape');
            }
            assertLifecycleStateIdentity(parsed);
            return parsed;
          } catch (error) {
            if (error instanceof MpxError) {
              throw error;
            }
            throw new MpxError({
              code: 'WORKTREE_LIFECYCLE_STATE_INVALID',
              message: 'Lifecycle state is malformed or unsupported.',
              details: { cause: String(error) },
            });
          }
        }),
    );
    return states.filter((state) => state.repositoryIdentity === repositoryIdentity);
  }
}

interface RepositoryLockOwner {
  schemaVersion: 1;
  owner: 'mpx';
  token: string;
  pid: number;
  processStartFingerprint: string;
  acquiredAt: number;
}

export type ProcessIdentityInspection =
  | { status: 'present'; pid: number; startFingerprint: string }
  | { status: 'absent'; pid: number }
  | { status: 'unknown'; pid: number };

/** Privileged process identity boundary. Unknown inspection must never be treated as absence. */
export interface ProcessIdentityInspector {
  inspect(pid: number): Promise<ProcessIdentityInspection>;
}

export interface NodeRepositoryLockOptions {
  timeoutMs?: number;
  retryMs?: number;
  ownerlessGraceMs?: number;
  now?: () => number;
  token?: () => string;
  processIdentityInspector?: ProcessIdentityInspector;
}

const nodeProcessStartFingerprint = `node:${Math.round(Date.now() - process.uptime() * 1_000)}`;
const conservativeProcessIdentityInspector: ProcessIdentityInspector = {
  async inspect(pid) {
    if (pid === process.pid) {
      return { status: 'present', pid, startFingerprint: nodeProcessStartFingerprint };
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

function parseRepositoryLockOwner(value: unknown): RepositoryLockOwner | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<RepositoryLockOwner>;
  return candidate.schemaVersion === 1 &&
    candidate.owner === 'mpx' &&
    typeof candidate.token === 'string' &&
    candidate.token.length > 0 &&
    typeof candidate.pid === 'number' &&
    Number.isSafeInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.processStartFingerprint === 'string' &&
    candidate.processStartFingerprint.length > 0 &&
    finiteNumber(candidate.acquiredAt)
    ? (candidate as RepositoryLockOwner)
    : undefined;
}

/** Cross-process lock based on exclusive directory creation with conservative crash recovery. */
export class NodeRepositoryLock implements RepositoryLock {
  private readonly options: Required<NodeRepositoryLockOptions>;

  constructor(directory: string, options: NodeRepositoryLockOptions | number = {}) {
    this.directory = directory;
    const values = typeof options === 'number' ? { timeoutMs: options } : options;
    this.options = {
      timeoutMs: values.timeoutMs ?? 30_000,
      retryMs: values.retryMs ?? 25,
      ownerlessGraceMs: values.ownerlessGraceMs ?? 2_000,
      now: values.now ?? Date.now,
      token: values.token ?? randomUUID,
      processIdentityInspector:
        values.processIdentityInspector ?? conservativeProcessIdentityInspector,
    };
  }

  private readonly directory: string;

  async acquire(repositoryKey: string): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true });
    const lockPath = path.join(this.directory, `${fileName(repositoryKey)}.lock`);
    const deadline = this.options.now() + this.options.timeoutMs;
    const ownIdentity = await this.inspect(process.pid);
    if (
      ownIdentity.status !== 'present' ||
      ownIdentity.pid !== process.pid ||
      ownIdentity.startFingerprint.length === 0
    ) {
      throw new MpxError({
        code: 'WORKTREE_LOCK_IDENTITY_UNKNOWN',
        message: 'The repository lock owner process identity could not be established.',
        retryable: true,
      });
    }
    let token = '';
    while (true) {
      token = this.options.token();
      const candidate = `${lockPath}.candidate-${token}`;
      try {
        await mkdir(candidate);
        await this.writeOwner(candidate, {
          schemaVersion: 1,
          owner: 'mpx',
          token,
          pid: process.pid,
          processStartFingerprint: ownIdentity.startFingerprint,
          acquiredAt: this.options.now(),
        });
        await rename(candidate, lockPath);
        break;
      } catch (error) {
        await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(code ?? '')) {
          throw error;
        }
        if (await this.reclaim(lockPath)) {
          continue;
        }
        if (this.options.now() >= deadline) {
          throw new MpxError({
            code: 'WORKTREE_LOCK_TIMEOUT',
            message: 'Timed out waiting for the repository lifecycle lock.',
            retryable: true,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, this.options.retryMs));
      }
    }

    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      try {
        const current = parseRepositoryLockOwner(
          parseStrictJson(await readFile(path.join(lockPath, 'owner.json'), 'utf8')),
        );
        if (current?.token === token) {
          await rm(lockPath, { recursive: true, force: true });
        }
      } catch {
        // A missing or replaced lock is not ours to remove.
      }
    };
  }

  private async inspect(pid: number): Promise<ProcessIdentityInspection> {
    try {
      const identity = await this.options.processIdentityInspector.inspect(pid);
      if (
        identity.pid !== pid ||
        (identity.status === 'present' && identity.startFingerprint.length === 0)
      ) {
        return { status: 'unknown', pid };
      }
      return identity;
    } catch {
      return { status: 'unknown', pid };
    }
  }

  private async writeOwner(lockPath: string, owner: RepositoryLockOwner): Promise<void> {
    const destination = path.join(lockPath, 'owner.json');
    const temporary = `${destination}.${owner.token}.tmp`;
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
  }

  private async reclaim(lockPath: string): Promise<boolean> {
    const ownerPath = path.join(lockPath, 'owner.json');
    let owner: RepositoryLockOwner | undefined;
    try {
      owner = parseRepositoryLockOwner(parseStrictJson(await readFile(ownerPath, 'utf8')));
    } catch {
      owner = undefined;
    }

    if (owner) {
      const identity = await this.inspect(owner.pid);
      if (identity.status === 'unknown') {
        return false;
      }
      if (
        identity.status === 'present' &&
        identity.startFingerprint === owner.processStartFingerprint
      ) {
        return false;
      }
    } else {
      let modifiedAt: number;
      try {
        modifiedAt = (await stat(ownerPath)).mtimeMs;
      } catch {
        try {
          modifiedAt = (await stat(lockPath)).mtimeMs;
        } catch {
          return false;
        }
      }
      if (this.options.now() - modifiedAt < this.options.ownerlessGraceMs) {
        return false;
      }
    }

    const quarantine = `${lockPath}.quarantine-${this.options.token()}`;
    try {
      await rename(lockPath, quarantine);
    } catch {
      return false;
    }
    await rm(quarantine, { recursive: true, force: true });
    return true;
  }
}

export interface NodeLifecycleFoundationOptions {
  processIdentityInspector?: ProcessIdentityInspector;
  trustedExecutablePolicy?: TrustedExecutablePolicy;
  operationCwd?: string;
  isPreparationWorkerActive?: (state: LifecycleState) => Promise<boolean>;
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function pathContains(root: string, candidate: string): boolean {
  const windows =
    process.platform === 'win32' ||
    /^[A-Za-z]:[\\/]/u.test(root) ||
    /^[A-Za-z]:[\\/]/u.test(candidate);
  const implementation = windows ? path.win32 : path.posix;
  const normalize = (value: string) => {
    const resolved = implementation.resolve(value).replace(/[\\/]+$/u, '');
    return windows ? resolved.toLowerCase() : resolved;
  };
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${implementation.sep}`)
  );
}

/** Safe Node/Git foundation. Port, preparation, and privileged process identity services remain explicitly injectable. */
export function createNodeLifecycleFoundation(
  stateRoot: string,
  gitExecutable = 'git',
  options: NodeLifecycleFoundationOptions = {},
): {
  repository: { resolve(cwd: string): ReturnType<typeof resolveRepository> };
  git: LifecycleGitAdapter;
  lock: RepositoryLock;
  state: LifecycleStateStore;
} {
  const direct: GitAdapter = {
    run: async (args, cwd) => {
      const policy = options.trustedExecutablePolicy ?? productionTrustedExecutablePolicy([cwd]);
      const executable = await resolveTrustedExecutable(gitExecutable, cwd, policy);
      await revalidateTrustedExecutable(executable, policy);
      return execute(executable.path, args, cwd);
    },
  };
  const operationCwd = options.operationCwd ?? process.cwd();
  const fs: FileSystemAdapter = {
    realpath,
    readText: (file) => readFile(file, 'utf8'),
    writeText: async () => {
      throw new MpxError({
        code: 'WORKTREE_UNSUPPORTED_WRITE',
        message: 'This adapter does not expose arbitrary text writes.',
      });
    },
    mkdir: (directory) => mkdir(directory, { recursive: true }).then(() => undefined),
    exists: async (value) => {
      try {
        await access(value);
        return true;
      } catch {
        return false;
      }
    },
  };
  return {
    repository: { resolve: (cwd) => resolveRepository(cwd, { git: direct, fs }) },
    git: {
      run: direct.run,
      list: (cwd) => listWorktrees(direct, cwd),
      isDirty: async (cwd) =>
        (await direct.run(['status', '--porcelain', '--untracked-files=normal'], cwd)).length > 0,
      isInUse: async (worktreePath) =>
        pathContains(await canonicalPath(worktreePath), await canonicalPath(operationCwd)),
    },
    lock: new NodeRepositoryLock(
      path.join(stateRoot, 'locks'),
      options.processIdentityInspector === undefined
        ? {}
        : { processIdentityInspector: options.processIdentityInspector },
    ),
    state: new NodeLifecycleStateStore(path.join(stateRoot, 'lifecycle')),
  };
}
