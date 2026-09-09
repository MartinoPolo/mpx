import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test } from 'vitest';

import {
  findWorktreeForBranch,
  parseCommand,
  parseWorkspaceCreateResult,
  prepareWorktree,
  resolveWorkspaceHubInvocation,
  validateRequest,
  type Execute,
} from '../../../worktree/operations.js';

async function runFailingWorkspaceCreate(
  runMpx: Execute,
  signal = new AbortController().signal,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-worktree-create-failure-'));
  const source = path.join(root, 'source');
  const commonDirectory = path.join(source, '.git');
  await mkdir(commonDirectory, { recursive: true });
  const execute: Execute = async (command, args, options) => {
    if (args.includes('workspace') && args.includes('create')) {
      return runMpx(command, args, options);
    }
    if (args.includes('--show-toplevel')) {
      return { stdout: source, stderr: '', code: 0, killed: false };
    }
    if (args.includes('--git-common-dir')) {
      return { stdout: commonDirectory, stderr: '', code: 0, killed: false };
    }
    return { stdout: '', stderr: '', code: 0, killed: false };
  };

  try {
    await prepareWorktree({ action: 'create', name: 'feature' }, source, execute, signal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function captureWorkspaceCreateFailure(runMpx: Execute): Promise<string> {
  try {
    await runFailingWorkspaceCreate(runMpx);
    assert.fail('workspace creation should fail');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

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

test('workspace Hub invocation bypasses Windows command-script lookup', () => {
  assert.deepEqual(
    resolveWorkspaceHubInvocation({ MPX_APPS: 'C:\\MP Apps' }, 'win32', 'C:\\Node\\node.exe'),
    {
      command: 'C:\\Node\\node.exe',
      argumentPrefix: ['C:\\MP Apps\\mpx\\bin\\mpx-node.mjs'],
    },
  );
  assert.deepEqual(resolveWorkspaceHubInvocation({}, 'linux', '/usr/bin/node'), {
    command: 'mpx',
    argumentPrefix: [],
  });
  for (const applicationsRoot of [undefined, '/rooted', '\\rooted']) {
    assert.throws(
      () =>
        resolveWorkspaceHubInvocation(
          applicationsRoot === undefined ? {} : { MPX_APPS: applicationsRoot },
          'win32',
          'C:\\Node\\node.exe',
        ),
      /MPX_APPS.*drive-qualified or UNC/u,
    );
  }
  assert.deepEqual(
    resolveWorkspaceHubInvocation(
      { MPX_APPS: '\\\\server\\applications' },
      'win32',
      'C:\\Node\\node.exe',
    ),
    {
      command: 'C:\\Node\\node.exe',
      argumentPrefix: ['\\\\server\\applications\\mpx\\bin\\mpx-node.mjs'],
    },
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

test('worktree inventory resolves only the usable checkout for an exact branch', () => {
  const target = path.resolve('partial-worktree');
  const other = path.resolve('other-worktree');
  const prunable = path.resolve('prunable-worktree');
  const inventory = [
    `worktree ${other}`,
    'HEAD a',
    'branch refs/heads/feature-other',
    '',
    `worktree ${prunable}`,
    'HEAD b',
    'branch refs/heads/feature',
    'prunable stale metadata',
    '',
    `worktree ${target}`,
    'HEAD c',
    'branch refs/heads/feature',
    '',
  ].join('\0');

  assert.equal(findWorktreeForBranch(inventory, 'feature'), target);
  assert.equal(findWorktreeForBranch(inventory, 'missing'), undefined);
  assert.throws(
    () =>
      findWorktreeForBranch(
        `${inventory}\0worktree ${path.resolve('duplicate')}\0branch refs/heads/feature\0\0`,
        'feature',
      ),
    /multiple worktrees/,
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
    if (command === 'git' && args[0] === 'worktree') {
      return {
        stdout: `worktree ${source}\0HEAD a\0branch refs/heads/main\0\0`,
        stderr: '',
        code: 0,
        killed: false,
      };
    }
    if (args.includes('workspace') && args.includes('create')) {
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
  const hub = resolveWorkspaceHubInvocation();
  assert.deepEqual(
    calls.find(({ args }) => args.includes('workspace') && args.includes('create')),
    {
      command: hub.command,
      args: [
        ...hub.argumentPrefix,
        '--cwd',
        source,
        '--json',
        'workspace',
        'create',
        'feature',
        '--base',
        'HEAD~1',
      ],
      cwd: source,
    },
  );
  await Promise.all([
    rm(source, { recursive: true, force: true }),
    rm(target, { recursive: true, force: true }),
  ]);
});

test('create recovers a checkout that the Hub created before reporting failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-worktree-partial-create-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'source.worktrees', 'feature');
  const commonDirectory = path.join(root, 'common');
  await Promise.all(
    [source, target, commonDirectory].map((directory) => mkdir(directory, { recursive: true })),
  );
  let inventoryCalls = 0;
  const execute: Execute = async (command, args, options) => {
    if (args.includes('workspace') && args.includes('create')) {
      return { stdout: '', stderr: '', code: 1, killed: false };
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      inventoryCalls += 1;
      return {
        stdout:
          inventoryCalls === 1
            ? `worktree ${source}\0HEAD a\0branch refs/heads/main\0\0`
            : `worktree ${source}\0HEAD a\0branch refs/heads/main\0\0worktree ${target}\0HEAD b\0branch refs/heads/feature\0\0`,
        stderr: '',
        code: 0,
        killed: false,
      };
    }
    if (args.includes('--show-toplevel')) {
      return {
        stdout: options?.cwd === target ? target : source,
        stderr: '',
        code: 0,
        killed: false,
      };
    }
    if (args.includes('--git-common-dir')) {
      return { stdout: commonDirectory, stderr: '', code: 0, killed: false };
    }
    return { stdout: '', stderr: '', code: 0, killed: false };
  };

  try {
    assert.equal(
      await prepareWorktree(
        { action: 'create', name: 'feature' },
        source,
        execute,
        new AbortController().signal,
      ),
      target,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('create does not enter a matching worktree that predates the Hub request', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-worktree-existing-create-'));
  const source = path.join(root, 'source');
  const existing = path.join(root, 'existing');
  const commonDirectory = path.join(root, 'common');
  await Promise.all(
    [source, existing, commonDirectory].map((directory) => mkdir(directory, { recursive: true })),
  );
  const execute: Execute = async (command, args) => {
    if (args.includes('workspace') && args.includes('create')) {
      return { stdout: '', stderr: '', code: 1, killed: false };
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return {
        stdout: `worktree ${source}\0HEAD a\0branch refs/heads/main\0\0worktree ${existing}\0HEAD b\0branch refs/heads/feature\0\0`,
        stderr: '',
        code: 0,
        killed: false,
      };
    }
    if (args.includes('--show-toplevel')) {
      return { stdout: source, stderr: '', code: 0, killed: false };
    }
    if (args.includes('--git-common-dir')) {
      return { stdout: commonDirectory, stderr: '', code: 0, killed: false };
    }
    return { stdout: '', stderr: '', code: 0, killed: false };
  };

  try {
    await assert.rejects(
      prepareWorktree(
        { action: 'create', name: 'feature' },
        source,
        execute,
        new AbortController().signal,
      ),
      /existed before this request.*--enter/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed execution reports invocation metadata and explicit empty output streams', async () => {
  const message = await captureWorkspaceCreateFailure(async () => ({
    stdout: '',
    stderr: '',
    code: 1,
    killed: false,
  }));

  assert.ok(
    message.includes(`Command: ${JSON.stringify(resolveWorkspaceHubInvocation().command)}`),
  );
  assert.match(message, /Arguments: \[.*"--cwd",/u);
  assert.match(message, /Cwd: ".*source"/u);
  assert.match(message, /Exit code: 1/u);
  assert.match(message, /Killed\/timeout: false/u);
  assert.match(message, /stdout:\n<empty>/u);
  assert.match(message, /stderr:\n<empty>/u);
});

test('failed execution retains JSON stdout and whitespace-prefixed nonempty stderr', async () => {
  const stdout = JSON.stringify({ ok: false, error: { code: 'workspace_failed' } });
  const stderr = '  \nwarning: retry refused';
  const message = await captureWorkspaceCreateFailure(async () => ({
    stdout,
    stderr,
    code: 2,
    killed: false,
  }));

  assert.ok(message.includes(stdout));
  assert.ok(message.includes(stderr));
});

test('rejected execution reports invocation context and the original failure', async () => {
  const message = await captureWorkspaceCreateFailure(async () => {
    throw new Error('spawn failed: executable unavailable');
  });

  assert.ok(
    message.includes(`Command: ${JSON.stringify(resolveWorkspaceHubInvocation().command)}`),
  );
  assert.match(message, /Cwd: ".*source"/u);
  assert.match(message, /Execution error: Error: spawn failed: executable unavailable/u);
  assert.match(message, /stdout:\n<unavailable>/u);
  assert.match(message, /stderr:\n<unavailable>/u);
});

test('rejected execution preserves its original failure with unsupported metadata values', async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const message = await captureWorkspaceCreateFailure(async () => {
    const error = Object.assign(new Error('original spawn failure'), {
      code: 1n,
      killed: circular,
    });
    throw error;
  });

  assert.match(message, /Execution error: Error: original spawn failure/u);
});

test('aborting pending execution preserves the exact abort reason', async () => {
  const controller = new AbortController();
  const abortReason = new Error('caller requested abort');
  const pending = runFailingWorkspaceCreate(
    async (_command, _args, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('backend aborted')));
        controller.abort(abortReason);
      }),
    controller.signal,
  );

  await assert.rejects(pending, (error: unknown) => error === abortReason);
});

test('failed execution bounds large diagnostics while retaining both output tails', async () => {
  const stdoutTail = 'STDOUT_TAIL';
  const stderrTail = 'STDERR_TAIL';
  const message = await captureWorkspaceCreateFailure(async () => ({
    stdout: `${'o'.repeat(20_000)}${stdoutTail}`,
    stderr: `${'e'.repeat(20_000)}${stderrTail}`,
    code: 1,
    killed: true,
  }));

  assert.ok(message.length <= 12_500, `diagnostic length was ${message.length}`);
  assert.ok(message.includes(stdoutTail));
  assert.ok(message.includes(stderrTail));
  assert.match(message, /Killed\/timeout: true/u);
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
    if (command === 'git') {
      return { stdout: '', stderr: '', code: 0, killed: false };
    }
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
