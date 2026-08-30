import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export interface PortHold {
  release(): Promise<void>;
}
export interface ProcessFingerprint {
  pid: number;
  startedAt: string;
}
export interface ProcessInfo {
  pid: number;
  startedAt?: string;
  processName?: string;
  executable?: string;
  projectPath?: string;
}
export interface ListenerInfo {
  port: number;
  pid?: number;
  address?: string;
  processName?: string;
  executable?: string;
  projectPath?: string;
  startedAt?: string;
}
export interface PortPlatformAdapter {
  holdAvailablePorts(ports: readonly number[]): Promise<PortHold>;
  inspectListeners(ports?: readonly number[]): Promise<readonly ListenerInfo[]>;
  killProcess(fingerprint: ProcessFingerprint): Promise<void>;
  inspectProcess(pid: number): Promise<ProcessInfo | undefined>;
}
export interface WorktreeInfo {
  path: string;
  head?: string;
  branch?: string;
  detached?: true;
  prunable?: string;
  role: 'main' | 'linked';
}
export interface WorktreeIdentity extends WorktreeInfo {
  repositoryId: string;
  worktreeId: string;
  commonGitPath: string;
  gitAdminPath: string;
}
export interface GitWorktreeAdapter {
  identify(cwd: string): Promise<WorktreeIdentity>;
  list(cwd: string): Promise<readonly WorktreeIdentity[]>;
}

export function parseWorktreePorcelainZ(input: string): WorktreeInfo[] {
  const records: Array<Record<string, string | true>> = [];
  let current: Record<string, string | true> | undefined;
  for (const field of input.split('\0')) {
    if (!field) {
      continue;
    }
    const space = field.indexOf(' ');
    const key = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? true : field.slice(space + 1);
    if (key === 'worktree') {
      if (current) {
        records.push(current);
      }
      current = { worktree: value };
    } else if (current) {
      current[key] = value;
    }
  }
  if (current) {
    records.push(current);
  }
  return records.map((record, index) => ({
    path: String(record.worktree),
    ...(typeof record.HEAD === 'string' ? { head: record.HEAD } : {}),
    ...(typeof record.branch === 'string' ? { branch: record.branch } : {}),
    ...(record.detached === true ? { detached: true as const } : {}),
    ...(typeof record.prunable === 'string' ? { prunable: record.prunable } : {}),
    role: index === 0 ? ('main' as const) : ('linked' as const),
  }));
}
const hash = (value: string) => createHash('sha256').update(value.toLowerCase()).digest('hex');
const execFile = promisify(execFileCallback);

const MACHINE_ROOT_VARIABLES = [
  'MPX_PROJECTS',
  'MPX_WORK',
  'MPX_CLONED',
  'MPX_APPS',
  'MPX_ONEDRIVE',
  'MPX_AI_GENERATED',
  'MPX_OBSIDIAN_VAULT',
] as const;
const UNIX_GIT_CANDIDATES = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/bin/git',
  '/opt/homebrew/bin/git',
];

export type GitExecutableErrorCode =
  | 'GIT_EXECUTABLE_INVALID'
  | 'GIT_EXECUTABLE_UNAVAILABLE'
  | 'GIT_EXECUTABLE_UNTRUSTED'
  | 'GIT_EXECUTABLE_REPARSE'
  | 'GIT_EXECUTABLE_CHANGED';

/** A Git executable was not an explicitly trusted, immutable executable. */
export class GitExecutableError extends Error {
  constructor(
    readonly code: GitExecutableErrorCode,
    message: string,
    readonly candidate?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GitExecutableError';
  }
}

export interface RealGitWorktreeAdapterOptions {
  /** Absolute path used by tests; it is subject to the same trust checks. */
  gitExecutable?: string;
}

interface GitExecutableFacts {
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
  fixedCandidate: boolean;
}

const samePath = (left: string, right: string) => {
  const normalize = (value: string) => path.normalize(value).replace(/[\\\\]+$/, '');
  return process.platform === 'win32'
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
};

const containsPath = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

const configuredMachineRoots = async () =>
  Promise.all(
    MACHINE_ROOT_VARIABLES.flatMap((name) => {
      const value = process.env[name];
      if (!value) {
        return [];
      }
      return [realpath(value).catch(() => path.resolve(value))];
    }),
  );

const fixedGitCandidates = () => {
  if (process.platform !== 'win32') {
    return [...UNIX_GIT_CANDIDATES];
  }
  return [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'cmd', 'git.exe'),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'),
    process.env.MPX_APPS && path.join(process.env.MPX_APPS, 'Git', 'cmd', 'git.exe'),
  ].filter((candidate): candidate is string => Boolean(candidate));
};

const fixedCandidateFor = (candidate: string) =>
  fixedGitCandidates().some((fixed) => samePath(fixed, candidate));

async function captureGitExecutable(
  candidate: string,
  cwd: string,
  fixedCandidate: boolean,
  revalidation: boolean,
): Promise<GitExecutableFacts> {
  if (!path.isAbsolute(candidate)) {
    throw new GitExecutableError(
      'GIT_EXECUTABLE_INVALID',
      `Git executable path must be absolute: ${candidate}`,
      candidate,
    );
  }
  const absoluteCandidate = path.resolve(candidate);
  let canonicalCwd: string;
  let canonicalPath: string;
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    canonicalCwd = await realpath(cwd);
    details = await lstat(absoluteCandidate);
    canonicalPath = await realpath(absoluteCandidate);
  } catch (cause) {
    throw new GitExecutableError(
      revalidation ? 'GIT_EXECUTABLE_CHANGED' : 'GIT_EXECUTABLE_UNAVAILABLE',
      `Git executable is unavailable: ${candidate}`,
      candidate,
      { cause },
    );
  }
  if (details.isSymbolicLink() || !samePath(canonicalPath, absoluteCandidate)) {
    throw new GitExecutableError(
      'GIT_EXECUTABLE_REPARSE',
      `Git executable is a symlink or reparse point: ${candidate}`,
      candidate,
    );
  }
  if (!details.isFile()) {
    throw new GitExecutableError(
      'GIT_EXECUTABLE_INVALID',
      `Git executable is not a regular file: ${candidate}`,
      candidate,
    );
  }
  const machineRoots = await configuredMachineRoots();
  // MPX_APPS is also the explicit fixed Git trust anchor; every other file under
  // a configured machine root, including an injected path under MPX_APPS, is rejected.
  if (
    containsPath(canonicalCwd, canonicalPath) ||
    machineRoots.some(
      (root) =>
        containsPath(root, canonicalPath) && !(fixedCandidate && fixedCandidateFor(candidate)),
    )
  ) {
    throw new GitExecutableError(
      'GIT_EXECUTABLE_UNTRUSTED',
      `Git executable is inside a protected project root: ${candidate}`,
      candidate,
    );
  }
  let contents: Buffer;
  try {
    contents = await readFile(canonicalPath);
  } catch (cause) {
    throw new GitExecutableError(
      revalidation ? 'GIT_EXECUTABLE_CHANGED' : 'GIT_EXECUTABLE_UNAVAILABLE',
      `Git executable could not be read: ${candidate}`,
      candidate,
      { cause },
    );
  }
  return {
    path: canonicalPath,
    hash: createHash('sha256').update(contents).digest('hex'),
    size: details.size,
    mtimeMs: details.mtimeMs,
    fixedCandidate,
  };
}

const sameFacts = (left: GitExecutableFacts, right: GitExecutableFacts) =>
  samePath(left.path, right.path) &&
  left.hash === right.hash &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs;

export class RealGitWorktreeAdapter implements GitWorktreeAdapter {
  private readonly injectedGitExecutable: string | undefined;
  private executableFacts?: Promise<GitExecutableFacts>;

  constructor(options: RealGitWorktreeAdapterOptions = {}) {
    this.injectedGitExecutable = options.gitExecutable;
  }

  private trustedExecutable(cwd: string): Promise<GitExecutableFacts> {
    if (!this.executableFacts) {
      this.executableFacts = this.injectedGitExecutable
        ? captureGitExecutable(this.injectedGitExecutable, cwd, false, false)
        : (async () => {
            const failures: unknown[] = [];
            for (const candidate of fixedGitCandidates()) {
              try {
                return await captureGitExecutable(candidate, cwd, true, false);
              } catch (cause) {
                failures.push(cause);
              }
            }
            throw new GitExecutableError(
              'GIT_EXECUTABLE_UNAVAILABLE',
              'No available fixed Git executable candidate was trusted',
              undefined,
              { cause: failures[0] },
            );
          })();
    }
    return this.executableFacts;
  }

  private async runGit(cwd: string, args: readonly string[]) {
    const trusted = await this.trustedExecutable(cwd);
    const current = await captureGitExecutable(trusted.path, cwd, trusted.fixedCandidate, true);
    if (!sameFacts(trusted, current)) {
      throw new GitExecutableError(
        'GIT_EXECUTABLE_CHANGED',
        `Git executable changed before execution: ${trusted.path}`,
        trusted.path,
      );
    }
    return execFile(trusted.path, [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
    });
  }

  async identify(cwd: string): Promise<WorktreeIdentity> {
    const list = await this.list(cwd);
    const canonicalCwd = await realpath(cwd);
    const found = list.find(
      (item) =>
        path.normalize(item.path).toLowerCase() === path.normalize(canonicalCwd).toLowerCase() ||
        canonicalCwd
          .toLowerCase()
          .startsWith(`${path.normalize(item.path).toLowerCase()}${path.sep}`),
    );
    if (!found) {
      throw new Error(`Git did not report a worktree containing ${cwd}`);
    }
    return found;
  }
  async list(cwd: string): Promise<WorktreeIdentity[]> {
    const [{ stdout }, { stdout: commonOutput }] = await Promise.all([
      this.runGit(cwd, ['worktree', 'list', '--porcelain', '-z']),
      this.runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ]);
    const commonGitPath = await realpath(commonOutput.trim());
    const repositoryId = hash(path.normalize(commonGitPath));
    return Promise.all(
      parseWorktreePorcelainZ(stdout)
        .filter((item) => item.prunable === undefined)
        .map(async (item) => {
          const canonicalPath = await realpath(item.path);
          const { stdout: adminOutput } = await this.runGit(canonicalPath, [
            'rev-parse',
            '--path-format=absolute',
            '--git-dir',
          ]);
          const gitAdminPath = await realpath(adminOutput.trim());
          return {
            ...item,
            path: canonicalPath,
            commonGitPath,
            gitAdminPath,
            repositoryId,
            worktreeId: hash(path.normalize(gitAdminPath)),
          };
        }),
    );
  }
}
