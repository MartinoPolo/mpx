import assert from 'node:assert/strict';
import { basename } from 'node:path';

import { test, vi } from 'vitest';

import {
  collectPostBashContext,
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

const executableGuardScripts = [
  'fallow-gate.mjs',
  'format-lint-file.mjs',
  'post-bash-context.mjs',
  'pre-commit-gate.mjs',
];

async function dispatchHooks(trusted: boolean, runner: HookScriptRunner): Promise<string> {
  await evaluateBashGuards('git commit -m test', '/project', trusted, runner, '/hooks');
  const formatResult = await runFormatLintHook(
    trusted,
    '/project/file.ts',
    '/project',
    runner,
    '/hooks',
  );
  await collectPostBashContext('git push', '/project', 'pushed', 0, trusted, runner, '/hooks');
  return formatResult;
}

test('skips executable guards when untrusted and dispatches them when trusted', async () => {
  const runner = vi.fn<HookScriptRunner>(async () => success);

  const untrustedFormatResult = await dispatchHooks(false, runner);
  const untrustedScripts = runner.mock.calls.map(([scriptPath]) => basename(scriptPath));

  assert.equal(untrustedFormatResult, UNTRUSTED_FORMAT_LINT_RESULT);
  assert.deepEqual(untrustedScripts, ['enforce-pkg-mgr.mjs', 'dangerous-command-guard.mjs']);
  for (const fileName of executableGuardScripts) {
    assert.equal(untrustedScripts.includes(fileName), false, fileName);
  }

  runner.mockClear();
  const trustedFormatResult = await dispatchHooks(true, runner);
  const trustedScripts = runner.mock.calls.map(([scriptPath]) => basename(scriptPath));

  assert.equal(trustedFormatResult, 'Formatting and linting completed.');
  assert.deepEqual(
    new Set(trustedScripts),
    new Set([
      'enforce-pkg-mgr.mjs',
      'pre-commit-gate.mjs',
      'dangerous-command-guard.mjs',
      'fallow-gate.mjs',
      'format-lint-file.mjs',
      'post-bash-context.mjs',
    ]),
  );
});
