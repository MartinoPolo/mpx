import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { renderPilotShell } from '../migration/pilot-shell.js';

const source = [
  '# user-owned content stays',
  '_pi_account_launch() { (',
  '    case "${MPX_MODE:-}" in',
  '      MPX_RUNTIME*|MPX_ACTIVE_CONTENT*|MPX_COMPILED_AGENTS_DIR|MPX_SESSION_LIFECYCLE_*|MPX_IDENTITY|MPX_MODE) unset MPX_MODE ;;',
  '    esac',
  '    PI_CODING_AGENT_DIR="$(cygpath -w "$config_dir")" PI_PANE_ACCOUNT="$account" \\',
  '      command pi --use-theme dark "${extension_args[@]}" "$@"',
  ') }',
  'xpi()  { _pi_account_launch personal "$HOME/.pi/agent"      "$@"; }',
  'xpiw() { _pi_account_launch work     "$HOME/.pi/agent-work" "$@"; }',
  'pi() { pi-mpx "$@"; }',
  'piw() { piw-mpx "$@"; }',
].join('\n') + '\n';

test('pilot shell routes preserve work/current MPX and original legacy without PATH replacement', async () => {
  const output = renderPilotShell(source);
  assert.ok(output.startsWith('# user-owned content stays\n'));
  assert.ok(output.includes('piw() { piw-mpx "$@"; }'));
  assert.ok(output.includes('xpi()  { pi-mpx "$@"; }'));
  assert.ok(output.includes('lpi()  { _pi_account_launch personal'));
  assert.ok(output.includes('lpiw() { _pi_account_launch work'));
  assert.ok(output.includes('MPX_ACCOUNT|MPX_COMPILED_AGENTS_DIR'));
  assert.ok(output.includes('legacy_skills=(--skill "$HOME/.agents/skills/mpx")'));
  assert.ok(output.includes('[[ "$native_argument" != --no-skills && "$native_argument" != -ns ]] || legacy_skills=()'));
  assert.ok(output.includes('pi() { bash "${MPX_PROJECTS:?pi requires MPX_PROJECTS}/mpx2/bin/pi" "$@"; }'));
  await promisify(execFile)('bash', ['--noprofile', '--norc', '-n', '-c', output], { timeout: 5000 });
});

test('pilot shell preserves line endings and refuses drift or repeat installation', () => {
  const output = renderPilotShell(source.replaceAll('\n', '\r\n'));
  assert.equal(output.replaceAll('\r\n', '').includes('\n'), false);
  assert.throws(() => renderPilotShell(source.replace('pi() { pi-mpx', 'pi() { custom')), /layout changed/);
  assert.throws(() => renderPilotShell(output), /already present/);
});
