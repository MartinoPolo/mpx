import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileMruStore,
  deriveWorktreePath,
  discoverRemoteHead,
  expandBranchTemplate,
  extractBranchIssue,
  listWorktrees,
  parseWorktreePorcelainZ,
  resolveBaseBranch,
  resolveRepository,
  selectWorktree,
  withRepositoryLock,
  type FileSystemAdapter,
  type GitAdapter,
  type RepositoryLock,
} from './index.js';

const execFileAsync = promisify(execFile);
const temporary: string[] = [];
afterEach(async () =>
  Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))),
);

describe('branch issue extraction', () => {
  it('extracts a deterministic provider-neutral issue token', () => {
    expect(extractBranchIssue('feature/ABC-123-add-login')).toBe('ABC-123');
    expect(extractBranchIssue('users/alice/456-fix-spaces')).toBe('456');
    expect(extractBranchIssue('feature/no-issue')).toBeUndefined();
  });
});

const nodeFs: FileSystemAdapter = {
  realpath,
  readText: (file) => readFile(file, 'utf8'),
  writeText: (file, content) => writeFile(file, content, 'utf8'),
  mkdir: (directory) => mkdir(directory, { recursive: true }).then(() => undefined),
  exists: async (entry) => {
    try {
      await readFile(entry);
      return true;
    } catch {
      return false;
    }
  },
};

function validConfig(): string {
  return JSON.stringify({
    schemaVersion: 1,
    project: { id: 'acme/widgets' },
    repository: { provider: 'github', remote: 'origin' },
  });
}

describe('repository discovery', () => {
  it('canonically resolves the main checkout from the Git common directory for main and linked CWDs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx repo with spaces-'));
    temporary.push(root);
    await execFileAsync('git', ['init', root]);
    await writeFile(path.join(root, 'mpxconfig.json'), validConfig());
    const mainGit: GitAdapter = {
      run: async (args, cwd) =>
        Buffer.from((await execFileAsync('git', args, { cwd, encoding: 'buffer' })).stdout),
    };
    const fromMain = await resolveRepository(root, { git: mainGit, fs: nodeFs });
    const linkedGit: GitAdapter = { run: async () => Buffer.from(path.join(root, '.git')) };
    const fromLinked = await resolveRepository(path.join(root, 'pretend-linked'), {
      git: linkedGit,
      fs: nodeFs,
    });
    expect(fromMain.mainRoot).toBe(await realpath(root));
    expect(fromLinked.mainRoot).toBe(await realpath(root));
  });

  it('requires a valid mpxconfig.json at the canonical main root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-invalid-config-'));
    temporary.push(root);
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, 'mpxconfig.json'), '{"schemaVersion":2}');
    const git: GitAdapter = { run: async () => Buffer.from(path.join(root, '.git')) };
    await expect(resolveRepository(root, { git, fs: nodeFs })).rejects.toMatchObject({
      code: 'WORKTREE_PROJECT_CONFIG_INVALID',
    });
  });
});

describe('worktree path derivation', () => {
  it('maps a safe nested branch to the repository sibling worktree root on Windows', () => {
    expect(
      deriveWorktreePath('C:\\MP Projects\\widget repo', 'feature/issue-42', { platform: 'win32' }),
    ).toBe('C:\\MP Projects\\widget repo.worktrees\\feature\\issue-42');
    for (const branch of [
      '',
      '/absolute',
      'C:\\absolute',
      'feature//x',
      '../escape',
      'feature/../escape',
      'feature/.',
      'feature\\escape',
      'feature/has space',
      'feature/x..y',
      '@',
    ]) {
      expect(() =>
        deriveWorktreePath('C:\\MP Projects\\widget', branch, { platform: 'win32' }),
      ).toThrow();
    }
    expect(() =>
      deriveWorktreePath('C:\\MP Projects\\widget', 'feature/one', {
        platform: 'win32',
        occupiedPaths: ['c:\\mp projects\\widget.worktrees\\FEATURE\\ONE'],
      }),
    ).toThrow();
  });
});

describe('base resolution', () => {
  it('uses explicit then configured then remote HEAD and fails closed when unresolved', async () => {
    const discover = async () => 'trunk';
    await expect(
      resolveBaseBranch({
        explicit: 'release',
        configured: 'develop',
        discoverRemoteHead: discover,
      }),
    ).resolves.toBe('release');
    await expect(
      resolveBaseBranch({ configured: 'develop', discoverRemoteHead: discover }),
    ).resolves.toBe('develop');
    await expect(resolveBaseBranch({ discoverRemoteHead: discover })).resolves.toBe('trunk');
    const calls: readonly string[][] = [];
    const git: GitAdapter = {
      run: async (args) => {
        (calls as string[][]).push([...args]);
        return Buffer.from('refs/remotes/upstream/stable\n');
      },
    };
    await expect(discoverRemoteHead(git, 'C:/repo', 'upstream')).resolves.toBe('stable');
    expect(calls).toEqual([['symbolic-ref', '--quiet', 'refs/remotes/upstream/HEAD']]);
    await expect(
      resolveBaseBranch({ discoverRemoteHead: async () => undefined }),
    ).rejects.toMatchObject({ code: 'WORKTREE_BASE_UNRESOLVED' });
  });
});

describe('branch templates', () => {
  it('expands only supplied issue tokens deterministically and never substitutes main', () => {
    expect(
      expandBranchTemplate('{author}/{issue}-{slug}', {
        author: 'Ada Lovelace',
        issue: 'MPX-42',
        slug: 'Fix path spaces!',
      }),
    ).toBe('ada-lovelace/MPX-42-fix-path-spaces');
    expect(() => expandBranchTemplate('{issue}/{slug}', { slug: 'missing issue' })).toThrowError(
      /issue/,
    );
    expect(() => expandBranchTemplate('{base}/{slug}', { slug: 'x' })).toThrowError(/base/);
  });
});

describe('worktree inventory', () => {
  it('requests and parses porcelain-z without losing spaces, detached, locked, or prunable state', async () => {
    const raw = Buffer.from(
      'worktree C:/MP Projects/widget\0HEAD abc\0branch refs/heads/main\0\0worktree C:/MP Projects/widget.worktrees/issue 42\0HEAD def\0detached\0locked reason with spaces\0prunable stale metadata\0\0',
    );
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const git: GitAdapter = {
      run: async (args, cwd) => {
        calls.push({ args, cwd });
        return raw;
      },
    };
    expect(await listWorktrees(git, 'C:/MP Projects/widget')).toEqual([
      {
        path: 'C:/MP Projects/widget',
        head: 'abc',
        branch: 'main',
        detached: false,
        locked: false,
        prunable: false,
      },
      {
        path: 'C:/MP Projects/widget.worktrees/issue 42',
        head: 'def',
        detached: true,
        locked: 'reason with spaces',
        prunable: 'stale metadata',
      },
    ]);
    expect(calls).toEqual([
      { args: ['worktree', 'list', '--porcelain', '-z'], cwd: 'C:/MP Projects/widget' },
    ]);
    expect(parseWorktreePorcelainZ(raw)).toHaveLength(2);
  });
});

describe('repository lifecycle lock', () => {
  it('releases an injected repository lock after lifecycle work fails', async () => {
    const events: string[] = [];
    const lock: RepositoryLock = {
      acquire: async (key) => {
        events.push(`acquire:${key}`);
        return async () => {
          events.push('release');
        };
      },
    };
    await expect(
      withRepositoryLock(lock, 'acme/widgets', async () => {
        events.push('work');
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(events).toEqual(['acquire:acme/widgets', 'work', 'release']);
  });
});

describe('selection MRU', () => {
  it('selects by exact path only and writes an MPX-owned user-local MRU document', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-state-'));
    temporary.push(root);
    const store = new FileMruStore(path.join(root, 'worktrees-mru.json'), nodeFs);
    const inventory = [
      {
        path: 'C:/repo.worktrees/issue 42',
        head: 'abc',
        branch: 'issue/42',
        detached: false,
        locked: false,
        prunable: false,
      },
    ];
    await expect(
      selectWorktree({ repository: 'acme/widgets', inventory, store }),
    ).rejects.toMatchObject({ code: 'WORKTREE_PATH_REQUIRED' });
    const worktree = inventory[0];
    if (!worktree) {
      throw new Error('worktree fixture is empty');
    }
    const selected = await selectWorktree({
      repository: 'acme/widgets',
      path: worktree.path,
      inventory,
      store,
    });
    expect(selected.path).toBe(worktree.path);
    expect(JSON.parse(await readFile(path.join(root, 'worktrees-mru.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      owner: 'mpx',
      repositories: { 'acme/widgets': worktree.path },
    });
  });
});
