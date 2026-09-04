import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { test } from 'vitest';

import {
  type AgentFileMetadata,
  type AgentFileSystem,
  readExistingAgentFile,
  resolveExistingAgentFile,
  writeAgentFile,
} from '../../../subagents/agent-file-policy.js';

const directoryMetadata: AgentFileMetadata = {
  device: '1',
  inode: '10',
  mode: '16877',
  size: '0',
  modificationTime: '1',
  changeTime: '1',
  isFile: false,
  isDirectory: true,
  isSymbolicLink: false,
};

const fileMetadata: AgentFileMetadata = {
  device: '1',
  inode: '20',
  mode: '33188',
  size: '4',
  modificationTime: '1',
  changeTime: '1',
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
};

function redirectedFileSystem(
  directory: string,
  target: string,
): {
  fileSystem: AgentFileSystem;
  opened: () => boolean;
  wrote: () => boolean;
} {
  let opened = false;
  let wrote = false;
  const fileSystem: AgentFileSystem = {
    lstat: (path) => (path === directory ? directoryMetadata : fileMetadata),
    realpath: (path) => (path === target ? resolve(directory, '..', 'outside.md') : path),
    mkdir: () => undefined,
    open: () => {
      opened = true;
      return 1;
    },
    fstat: () => fileMetadata,
    read: () => 'safe',
    truncate: () => undefined,
    write: () => {
      wrote = true;
    },
    close: () => undefined,
    unlink: () => undefined,
  };
  return { fileSystem, opened: () => opened, wrote: () => wrote };
}

test('reads genuine project and global agent files under their declared directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-agent-policy-'));
  try {
    const directories = [join(root, 'project', '.pi', 'agents'), join(root, 'global', 'agents')];
    for (const directory of directories) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'reviewer.md'), '---\ndescription: reviewer\n---\n', 'utf-8');

      const resolved = resolveExistingAgentFile(directory, 'reviewer');
      assert.equal(readExistingAgentFile(resolved), '---\ndescription: reviewer\n---\n');

      writeAgentFile(directory, 'reviewer', '---\ndescription: updated\n---\n', true);
      assert.equal(
        readExistingAgentFile(resolveExistingAgentFile(directory, 'reviewer')),
        '---\ndescription: updated\n---\n',
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects realpath redirection before opening or writing an existing file', () => {
  const directory = resolve('project', '.pi', 'agents');
  const target = join(directory, 'reviewer.md');
  const mock = redirectedFileSystem(directory, target);

  assert.throws(
    () => writeAgentFile(directory, 'reviewer', 'changed', true, mock.fileSystem),
    /Redirected agent file/,
  );
  assert.equal(mock.opened(), false);
  assert.equal(mock.wrote(), false);
});

test('rejects a symbolic-link agent entry without reading its target', () => {
  const directory = resolve('global', 'agents');
  const target = join(directory, 'reviewer.md');
  let read = false;
  const mock = redirectedFileSystem(directory, target);
  const fileSystem: AgentFileSystem = {
    ...mock.fileSystem,
    lstat: (path) =>
      path === directory ? directoryMetadata : { ...fileMetadata, isSymbolicLink: true },
    read: () => {
      read = true;
      return 'outside';
    },
  };

  assert.throws(
    () => resolveExistingAgentFile(directory, 'reviewer', fileSystem),
    /Unsafe agent file/,
  );
  assert.equal(read, false);
});

test('fails closed when file metadata changes before mutation', () => {
  const directory = resolve('project', '.agents', 'agents');
  const target = join(directory, 'reviewer.md');
  let fileChecks = 0;
  let truncated = false;
  const fileSystem: AgentFileSystem = {
    lstat: (path) => {
      if (path === directory) return directoryMetadata;
      fileChecks++;
      return fileChecks === 1 ? fileMetadata : { ...fileMetadata, changeTime: String(fileChecks) };
    },
    realpath: (path) => path,
    mkdir: () => undefined,
    open: () => 1,
    fstat: () => fileMetadata,
    read: () => 'safe',
    truncate: () => {
      truncated = true;
    },
    write: () => undefined,
    close: () => undefined,
    unlink: () => undefined,
  };

  const existing = resolveExistingAgentFile(directory, 'reviewer', fileSystem);
  assert.equal(existing.path, target);
  assert.throws(
    () => writeAgentFile(directory, 'reviewer', 'changed', true, fileSystem),
    /Agent file changed during operation/,
  );
  assert.equal(truncated, false);
});
