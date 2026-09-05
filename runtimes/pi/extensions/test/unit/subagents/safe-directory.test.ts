import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { test, vi } from 'vitest';

import { ensureMemoryDir } from '../../../subagents/memory.js';
import {
  ensureSafeDirectory,
  type SafeDirectoryFileSystem,
} from '../../../subagents/safe-directory.js';

function directoryMetadata(path: string, linked = false) {
  const identity = [...path].reduce((value, character) => value + character.charCodeAt(0), 1);
  return {
    dev: 1,
    ino: identity,
    isDirectory: () => !linked,
    isSymbolicLink: () => linked,
  };
}

test('rejects a simulated ancestor symlink or reparse point before mkdir', () => {
  const target = resolve('virtual-safe-root', 'ancestor', 'target');
  const mkdir = vi.fn<SafeDirectoryFileSystem['mkdir']>();
  const fileSystem: SafeDirectoryFileSystem = {
    lstat: (path) => directoryMetadata(path, basename(path) === 'ancestor'),
    mkdir,
    realpath: (path) => path,
  };

  assert.throws(() => ensureSafeDirectory(target, fileSystem), /linked directory component/);
  assert.equal(mkdir.mock.calls.length, 0);
});

test('allows and creates a real nested directory', () => {
  const parent = mkdtempSync(join(tmpdir(), 'pi-safe-directory-'));
  const target = join(parent, 'one', 'two', 'three');

  try {
    ensureMemoryDir(target);
    assert.equal(lstatSync(target).isDirectory(), true);
    assert.equal(lstatSync(join(parent, 'one')).isSymbolicLink(), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
