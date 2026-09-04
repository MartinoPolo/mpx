import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

import {
  runFormatLintHook,
  UNTRUSTED_FORMAT_LINT_RESULT,
  type HookScriptRunner,
} from '../../../guard-hooks.js';

const success = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  spawnErrorMessage: null,
};

test('does not run formatter hook for an untrusted project', async () => {
  const runner = vi.fn<HookScriptRunner>(async () => success);

  const result = await runFormatLintHook(false, '/project/file.ts', '/project', runner);

  assert.equal(result, UNTRUSTED_FORMAT_LINT_RESULT);
  assert.equal(runner.mock.calls.length, 0);
});

test('runs formatter hook unchanged for a trusted project', async () => {
  const runner = vi.fn<HookScriptRunner>(async () => success);

  const result = await runFormatLintHook(true, '/project/file.ts', '/project', runner, '/hooks');

  assert.equal(result, 'Formatting and linting completed.');
  assert.equal(runner.mock.calls.length, 1);
  assert.match(String(runner.mock.calls[0]![0]), /format-lint-file\.mjs$/);
});
