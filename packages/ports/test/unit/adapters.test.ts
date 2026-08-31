import { execFile as execFileCallback } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GitExecutableError,
  RealGitWorktreeAdapter,
  parseWorktreePorcelainZ,
} from '../../src/index.js';

const execFile = promisify(execFileCallback);
const roots: string[] = [];

const fixedGitCandidates = () =>
  process.platform === 'win32'
    ? [
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'cmd', 'git.exe'),
        process.env.LOCALAPPDATA &&
          path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'),
        process.env.MPX_APPS && path.join(process.env.MPX_APPS, 'Git', 'cmd', 'git.exe'),
      ].filter((candidate): candidate is string => Boolean(candidate))
    : ['/usr/bin/git', '/usr/local/bin/git', '/bin/git', '/opt/homebrew/bin/git'];

const installedFixedGit = async () => {
  for (const candidate of fixedGitCandidates()) {
    try {
      const details = await stat(candidate);
      if (details.isFile()) {
        return candidate;
      }
    } catch {
      // Try the next fixed candidate.
    }
  }
  return undefined;
};

const temporaryDirectory = async (parent = os.tmpdir()) => {
  const directory = await mkdtemp(path.join(parent, 'mpx-ports-adapter-'));
  roots.push(directory);
  return directory;
};

const injectableGitSource = (git: string) =>
  process.platform === 'win32'
    ? path.resolve(path.dirname(git), '..', 'mingw64', 'bin', 'git.exe')
    : git;

const makeRepository = async (git: string) => {
  const cwd = await temporaryDirectory();
  await execFile(git, ['init', cwd], { encoding: 'utf8' });
  return cwd;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('git worktree porcelain parser', () => {
  it('parses nul-delimited worktree records without splitting paths containing spaces', () => {
    const input =
      'worktree C:/repo with spaces\0HEAD abc123\0branch refs/heads/main\0\0worktree C:/linked tree\0HEAD def456\0detached\0\0';
    expect(parseWorktreePorcelainZ(input)).toEqual([
      { path: 'C:/repo with spaces', head: 'abc123', branch: 'refs/heads/main', role: 'main' },
      { path: 'C:/linked tree', head: 'def456', detached: true, role: 'linked' },
    ]);
  });
});

describe('RealGitWorktreeAdapter executable trust', () => {
  it('uses a fixed Git candidate, never checkout/PATH git.exe or git.cmd on Windows', async () => {
    if (process.platform !== 'win32') {
      return;
    }
    const git = await installedFixedGit();
    if (!git) {
      throw new Error('The Windows regression requires a fixed Git candidate');
    }
    const checkout = await makeRepository(git);
    const maliciousBin = path.join(checkout, 'malicious-bin');
    const marker = path.join(checkout, 'malicious-invoked.txt');
    await mkdir(maliciousBin);
    await writeFile(path.join(maliciousBin, 'git.exe'), 'not an executable');
    await writeFile(
      path.join(maliciousBin, 'git.cmd'),
      `@echo off\r\necho invoked>${marker}\r\nexit /b 99\r\n`,
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${maliciousBin};${oldPath ?? ''}`;
    try {
      await expect(new RealGitWorktreeAdapter().list(checkout)).resolves.toHaveLength(1);
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an injected Git path after its captured hash, size, or mtime changes', async () => {
    const git = await installedFixedGit();
    if (!git) {
      return;
    }
    const checkout = await makeRepository(git);
    const injected = path.join(await temporaryDirectory(), 'git.exe');
    await copyFile(injectableGitSource(git), injected);
    const adapter = new RealGitWorktreeAdapter({ gitExecutable: injected });
    await expect(adapter.list(checkout)).resolves.toHaveLength(1);
    await writeFile(injected, 'mutated Git executable');
    await expect(adapter.list(checkout)).rejects.toMatchObject({ code: 'GIT_EXECUTABLE_CHANGED' });
  });

  it('rejects an injected Git reparse point before execution', async () => {
    if (process.platform !== 'win32') {
      return;
    }
    const git = await installedFixedGit();
    if (!git) {
      return;
    }
    const checkout = await makeRepository(git);
    const executableRoot = await temporaryDirectory();
    const injected = path.join(executableRoot, 'git.exe');
    const target = path.join(executableRoot, 'real-git.exe');
    await copyFile(injectableGitSource(git), target);
    await copyFile(injectableGitSource(git), injected);
    const adapter = new RealGitWorktreeAdapter({ gitExecutable: injected });
    await expect(adapter.list(checkout)).resolves.toHaveLength(1);
    await rm(injected);
    await symlink(target, injected, 'file');
    await expect(adapter.list(checkout)).rejects.toMatchObject({ code: 'GIT_EXECUTABLE_REPARSE' });
  });

  it('rejects an injected executable inside a configured machine project root', async () => {
    const git = await installedFixedGit();
    const configuredRoot = process.env.MPX_PROJECTS;
    if (!git || !configuredRoot) {
      return;
    }
    const checkout = await makeRepository(git);
    const executableRoot = await temporaryDirectory(configuredRoot);
    const injected = path.join(executableRoot, 'git.exe');
    await copyFile(injectableGitSource(git), injected);
    await expect(
      new RealGitWorktreeAdapter({ gitExecutable: injected }).list(checkout),
    ).rejects.toMatchObject({ code: 'GIT_EXECUTABLE_UNTRUSTED' });
  });

  it('fails structurally when an injected Git candidate is unavailable', async () => {
    const checkout = await temporaryDirectory();
    const missing = path.join(checkout, 'missing-git.exe');
    await expect(
      new RealGitWorktreeAdapter({ gitExecutable: missing }).list(checkout),
    ).rejects.toBeInstanceOf(GitExecutableError);
  });
});
