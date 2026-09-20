import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderFinalCutoverShell, renderFinalPowerShellProfile } from '../migration/rollout-shell.js';

const legacySource = [
  '# unrelated before',
  '# allow cd after creating a worktree',
  'source "$MPX_PROJECTS/mpx-claude-code/old.sh"',
  'setup-worktree() { old; }',
  '# >>> MPX MANAGED LAUNCHERS >>>',
  'pi() { pi-mpx "$@"; }',
  '# <<< MPX MANAGED LAUNCHERS <<<',
  'cc-mpx() { old; }',
  'alias y="yarn"',
  "alias gw='setup-worktree'",
  "alias gwr='remove-worktree'",
  'alias p0="cd \\"$mpProjectsFolder/mpx-claude-code\\""',
  '# mpx-ports standalone',
  '# mpx-worktrees standalone',
  '# agent-resurrect standalone',
  '# unrelated after',
  '',
].join('\n');

test('final shell cutover removes legacy routes and preserves unrelated content and newline style', () => {
  const result = renderFinalCutoverShell(legacySource.replaceAll('\n', '\r\n'));
  for (const command of ['mpx', 'pi', 'piw', 'cc', 'ccw']) {
    assert.ok(result.includes(`${command}() { bash "\${MPX_PROJECTS:?${command} requires MPX_PROJECTS}/mpx/bin/${command}" "$@"; }`));
  }
  assert.doesNotMatch(result, /MANAGED LAUNCHERS|setup-worktree|remove-worktree|cc-mpx|pi-mpx|mpx-claude-code/);
  assert.match(result, /alias y="yarn"/);
  assert.match(result, /mpx-ports standalone[\s\S]*mpx-worktrees standalone[\s\S]*agent-resurrect standalone/);
  assert.ok(result.includes('alias p0=\'cd "${MPX_PROJECTS:?p0 requires MPX_PROJECTS}/mpx"\''));
  assert.equal(result.replaceAll('\r\n', '').includes('\n'), false);
  assert.equal(spawnSync('bash', ['--noprofile', '--norc', '-n'], { input: result, encoding: 'utf8' }).status, 0);
});

test('shell launchers forward arguments and report a missing root', () => {
  const result = renderFinalCutoverShell(legacySource);
  const root = mkdtempSync(path.join(os.tmpdir(), 'mpx-rollout-'));
  try {
    mkdirSync(path.join(root, 'mpx', 'bin'), { recursive: true });
    writeFileSync(path.join(root, 'mpx', 'bin', 'pi'), 'printf "%s\\n" "$@"\n');
    const forwarded = spawnSync('bash', ['--noprofile', '--norc'], { input: `${result}\npi 'first value' second\n`, encoding: 'utf8', env: { ...process.env, MPX_PROJECTS: root } });
    assert.equal(forwarded.status, 0, forwarded.stderr);
    assert.equal(forwarded.stdout, 'first value\nsecond\n');
    const missing = spawnSync('bash', ['--noprofile', '--norc'], { input: `${result}\nunset MPX_PROJECTS\npi value\n`, encoding: 'utf8' });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /pi requires MPX_PROJECTS/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shell cutover refuses missing, duplicate, and reordered markers', () => {
  assert.throws(() => renderFinalCutoverShell(legacySource.replace('# allow cd after creating a worktree', '# drift')), /exactly one/);
  assert.throws(() => renderFinalCutoverShell(`${legacySource}# >>> MPX MANAGED LAUNCHERS >>>\n`), /exactly one/);
  const reordered = legacySource.replace('# allow cd after creating a worktree', '__START__').replace('alias y="yarn"', '# allow cd after creating a worktree').replace('__START__', 'alias y="yarn"');
  assert.throws(() => renderFinalCutoverShell(reordered), /marker order/);
});

test('PowerShell profile managed block is replaced without touching surrounding text', () => {
  const source = ['# before', '# >>> MPX MANAGED LAUNCHERS >>>', 'function old { legacy }', '# <<< MPX MANAGED LAUNCHERS <<<', '# after', ''].join('\r\n');
  const result = renderFinalPowerShellProfile(source);
  assert.match(result, /^# before\r\n/);
  assert.ok(result.includes('function pi { if (-not $env:MPX_PROJECTS -or -not $env:MPX_APPS)'));
  assert.ok(result.includes('& "$env:MPX_APPS/Git/bin/bash.exe" --login "$env:MPX_PROJECTS/mpx/bin/pi" @args }'));
  assert.doesNotMatch(result, /& bash /);
  assert.doesNotMatch(result, /function old/);
  assert.match(result, /# after\r\n$/);
  assert.throws(() => renderFinalPowerShellProfile('# no markers\n'), /exactly one/);
});
