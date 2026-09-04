import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { test } from 'vitest';

import { resolvePiCodingAgentDir } from '../../../lib/agent-directory.js';
import { resolveSafeAgentFile } from '../../../subagents/index.js';

test('resolves relative Pi agent directories from the session cwd and falls back to home', () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const cwd = resolve('workspace');

  try {
    process.env.PI_CODING_AGENT_DIR = join('state', 'pi-agent');
    assert.equal(resolvePiCodingAgentDir(cwd), resolve(cwd, 'state', 'pi-agent'));

    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(resolvePiCodingAgentDir(cwd), join(homedir(), '.pi', 'agent'));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test('accepts safe agent names as direct children', () => {
  const targetDirectory = resolve('agents');
  assert.equal(
    resolveSafeAgentFile(targetDirectory, 'review-agent_2'),
    join(targetDirectory, 'review-agent_2.md'),
  );
});

test('rejects traversal, control characters, and absolute agent names', () => {
  const targetDirectory = resolve('agents');
  for (const name of [
    '../escape',
    '..\\escape',
    'nested/escape',
    'line\nbreak',
    '\u0000name',
    '/absolute',
    'C:\\absolute',
  ]) {
    assert.throws(() => resolveSafeAgentFile(targetDirectory, name), /Unsafe agent name/);
  }
});

test('rejects Windows reserved agent names', () => {
  const targetDirectory = resolve('agents');
  for (const name of ['CON', 'nul.txt', 'Com1', 'LPT9.agent', 'aux']) {
    assert.throws(() => resolveSafeAgentFile(targetDirectory, name), /Unsafe agent name/);
  }
});
