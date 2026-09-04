import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

import {
  evaluateBashGuards,
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

test('only trusted git commits can invoke the project pre-commit gate', async () => {
  const runner = vi.fn<HookScriptRunner>(async () => success);

  await evaluateBashGuards('git commit -m test', '/project', false, runner, '/hooks');
  const untrustedScripts = runner.mock.calls.map(([scriptPath]) => scriptPath);
  assert.equal(
    untrustedScripts.some((scriptPath) => /pre-commit-gate\.mjs$/.test(scriptPath)),
    false,
  );

  runner.mockClear();
  await evaluateBashGuards('git commit -m test', '/project', true, runner, '/hooks');
  const trustedScripts = runner.mock.calls.map(([scriptPath]) => scriptPath);
  assert.equal(
    trustedScripts.some((scriptPath) => /pre-commit-gate\.mjs$/.test(scriptPath)),
    true,
  );
});
