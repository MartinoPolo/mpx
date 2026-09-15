import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { renderAccountRolloutShell } from '../migration/rollout-shell.js';

const source = [
  '# Unrelated shell configuration stays unchanged.',
  'xcc()  { _claude_account_launch personal "$HOME/.claude"      "$@"; }',
  'xccw() { _claude_account_launch work     "$HOME/.claude-work" "$@"; }',
  'cc() { cc-mpx "$@"; }',
  'ccw() { ccw-mpx "$@"; }',
  'pi() { bash "${MPX_PROJECTS:?pi requires MPX_PROJECTS}/mpx2/bin/pi" "$@"; }',
  'piw() { piw-mpx "$@"; }',
  'lpi() { original-pi "$@"; }',
  '',
].join('\n');

test('account launcher rollout is scoped and preserves installed and original Claude routes', () => {
  const result = renderAccountRolloutShell(source, [{ account: 'work', harness: 'pi' }, { account: 'work', harness: 'claude' }]);
  assert.ok(result.includes('piw() { bash "${MPX_PROJECTS:?piw requires MPX_PROJECTS}/mpx2/bin/piw" "$@"; }'));
  assert.ok(result.includes('ccw() { bash "${MPX_PROJECTS:?ccw requires MPX_PROJECTS}/mpx2/bin/ccw" "$@"; }'));
  assert.ok(result.includes('lccw() { _claude_account_launch work     "$HOME/.claude-work" "$@"; }'));
  assert.ok(result.includes('xccw() { ccw-mpx "$@"; }'));
  for (const line of source.split('\n').filter(line => !line.startsWith('piw()') && !line.startsWith('ccw()') && !line.startsWith('xccw()'))) assert.ok(result.split('\n').includes(line), line);
  const syntax = spawnSync('bash', ['--noprofile', '--norc', '-n'], { input: result, encoding: 'utf8', timeout: 5000 });
  assert.equal(syntax.status, 0, syntax.stderr);
  const next = renderAccountRolloutShell(result, [{ account: 'personal', harness: 'claude' }]);
  assert.ok(next.includes('lcc()  { _claude_account_launch personal "$HOME/.claude"      "$@"; }'));
  assert.ok(next.includes('xcc() { cc-mpx "$@"; }'));
});

test('launcher changes retain newline style and reject drift, conflicts, duplicates and reapply', () => {
  const scope = { account: 'work', harness: 'pi' } as const;
  const result = renderAccountRolloutShell(source.replaceAll('\n', '\r\n'), [scope]);
  assert.equal(result.replaceAll('\r\n', '').includes('\n'), false);
  assert.throws(() => renderAccountRolloutShell(result, [scope]), /layout changed/);
  assert.throws(() => renderAccountRolloutShell(source, [scope, scope]), /Duplicate/);
  assert.throws(() => renderAccountRolloutShell(source.replace('piw-mpx', 'custom-launch'), [scope]), /layout changed/);
  assert.throws(() => renderAccountRolloutShell(`${source}lccw() { custom; }\n`, [{ account: 'work', harness: 'claude' }]), /already exists/);
  assert.throws(() => renderAccountRolloutShell(source, [{ account: 'personal', harness: 'pi' }]), /accepted pilot/);
});
