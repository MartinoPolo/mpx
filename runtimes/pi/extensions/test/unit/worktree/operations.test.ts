import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test } from 'vitest';

import {
  parseCommand,
  parseWorkspaceCreateResult,
  prepareWorktree,
  validateRequest,
  type Execute,
} from '../../../worktree/operations.js';

test('command parser preserves quoted paths, creation options, and the raw task tail', () => {
  assert.deepEqual(
    parseCommand('--enter "C:\\work trees\\feature" -- fix the parser --base literally'),
    {
      action: 'enter',
      path: 'C:\\work trees\\feature',
      task: 'fix the parser --base literally',
    },
  );
  assert.deepEqual(parseCommand('feature/name --base HEAD~2 -- continue here'), {
    action: 'create',
    name: 'feature/name',
    base: 'HEAD~2',
    task: 'continue here',
  });
  assert.throws(
    () => parseCommand('feature/name --color #12aBcD'),
    /Unexpected argument: --color/u,
  );
});

test('workspace create output requires a successful mutation with one absolute path', () => {
  const absolute = path.resolve('created-worktree');
  assert.equal(
    parseWorkspaceCreateResult(
      JSON.stringify({
        ok: true,
        data: { kind: 'workspace-mutation', operation: 'create', path: absolute },
      }),
    ),
    absolute,
  );
  assert.throws(() => parseWorkspaceCreateResult('{}'), /valid workspace create result/);
  assert.throws(
    () =>
      parseWorkspaceCreateResult(
        JSON.stringify({
          ok: true,
          data: { kind: 'workspace-mutation', operation: 'create', path: 'relative' },
        }),
      ),
    /absolute/,
  );
});

test('invalid requests fail before any process side effect', async () => {
  let calls = 0;
  const execute: Execute = async () => {
    calls += 1;
    throw new Error('must not execute');
  };
  assert.throws(() => validateRequest({ action: 'create', name: '-danger' }), /literal Git branch/);
  await assert.rejects(
    prepareWorktree(
      { action: 'enter', path: '', base: 'HEAD' },
      process.cwd(),
      execute,
      new AbortController().signal,
    ),
    /existing worktree path|apply only/,
  );
  assert.equal(calls, 0);
});

test('enter canonicalizes aliases and accepts only another root from the same repository', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-worktree-operations-'));
  try {
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    const targetAlias = path.join(root, 'target-alias');
    const foreign = path.join(root, 'foreign');
    const subdirectory = path.join(target, 'nested');
    const sourceCommon = path.join(root, 'common');
    const foreignCommon = path.join(root, 'foreign-common');
    await Promise.all(
      [source, target, foreign, subdirectory, sourceCommon, foreignCommon].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );
    await symlink(target, targetAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const execute: Execute = async (command, args, options) => {
      assert.equal(command, 'git');
      const directory = await realpath(options?.cwd ?? source);
      if (args.includes('--show-toplevel')) {
        const gitRoot = directory === subdirectory ? target : directory;
        return { stdout: gitRoot, stderr: '', code: 0, killed: false };
      }
      return {
        stdout: directory === foreign ? foreignCommon : sourceCommon,
        stderr: '',
        code: 0,
        killed: false,
      };
    };

    assert.equal(
      await prepareWorktree(
        { action: 'enter', path: targetAlias },
        source,
        execute,
        new AbortController().signal,
      ),
      await realpath(target),
    );
    await assert.rejects(
      prepareWorktree(
        { action: 'enter', path: foreign },
        source,
        execute,
        new AbortController().signal,
      ),
      /different Git repository/,
    );
    await assert.rejects(
      prepareWorktree(
        { action: 'enter', path: subdirectory },
        source,
        execute,
        new AbortController().signal,
      ),
      /worktree root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('create delegates to the release-owned workspace CLI and uses its returned destination', async () => {
  const source = path.resolve('source-root');
  const target = path.resolve('hub-selected-feature');
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  await Promise.all(
    [source, target, path.join(source, '.git')].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  const execute: Execute = async (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return {
        stdout: options?.cwd === target ? `${target}\n` : `${source}\n`,
        stderr: '',
        code: 0,
        killed: false,
      };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: `${path.join(source, '.git')}\n`, stderr: '', code: 0, killed: false };
    }
    if (command === 'git' && args[0] === 'check-ref-format') {
      return { stdout: '', stderr: '', code: 0, killed: false };
    }
    if (command === 'mpx') {
      return {
        stdout: JSON.stringify({
          ok: true,
          data: { kind: 'workspace-mutation', operation: 'create', path: target },
        }),
        stderr: '',
        code: 0,
        killed: false,
      };
    }
    throw new Error(`unexpected call: ${command} ${args.join(' ')}`);
  };

  assert.equal(
    await prepareWorktree(
      { action: 'create', name: 'feature', base: 'HEAD~1' },
      source,
      execute,
      new AbortController().signal,
    ),
    target,
  );
  assert.deepEqual(
    calls.find(({ command }) => command === 'mpx'),
    {
      command: 'mpx',
      args: ['--cwd', source, '--json', 'workspace', 'create', 'feature', '--base', 'HEAD~1'],
      cwd: source,
    },
  );
  await Promise.all([
    rm(source, { recursive: true, force: true }),
    rm(target, { recursive: true, force: true }),
  ]);
});

test('create fails closed when the workspace hub is unavailable', async () => {
  const source = path.resolve('source-root');
  await mkdir(path.join(source, '.git'), { recursive: true });
  const execute: Execute = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') {
      return {
        stdout: args.includes('--show-toplevel') ? source : path.join(source, '.git'),
        stderr: '',
        code: 0,
        killed: false,
      };
    }
    if (command === 'git') return { stdout: '', stderr: '', code: 0, killed: false };
    return { stdout: '', stderr: 'mpx not found', code: 1, killed: false };
  };
  await assert.rejects(
    prepareWorktree(
      { action: 'create', name: 'feature' },
      source,
      execute,
      new AbortController().signal,
    ),
    /workspace hub.*unavailable/i,
  );
  await rm(source, { recursive: true, force: true });
});
