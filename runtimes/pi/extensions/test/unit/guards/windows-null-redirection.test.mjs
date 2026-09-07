import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  checkDangerousCommand,
  redirectsToWindowsNullDevice,
} from '../../../guards/dangerous-command-guard.mjs';

test.each(['where.exe pnpm 2>NUL || true', 'tool > nul', 'tool 2> "NUL"', 'tool >NUL 2>&1'])(
  'detects Git Bash redirection that would create a literal NUL file: %s',
  (command) => {
    assert.equal(redirectsToWindowsNullDevice(command), true);
    const result = checkDangerousCommand(command);
    assert.equal(result.blocked, true);
    assert.match(result.message, /use \/dev\/null/u);
  },
);

test.each([
  'tool >/dev/null 2>&1',
  'cmd //c "where node 2>nul"',
  "cmd //c 'where node 2>nul'",
  'printf "2>NUL"',
])('allows redirection that cannot create a literal NUL file: %s', (command) => {
  assert.equal(redirectsToWindowsNullDevice(command), false);
  assert.equal(checkDangerousCommand(command).blocked, false);
});
