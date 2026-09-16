import assert from 'node:assert/strict';
import test from 'node:test';
import {
  execute,
  parseArguments,
  parseStream,
  sanitizeProbeEnvironment,
  validateAuthResult,
  validateCatalog,
  type CommandRunner,
  type ExpectedSkill,
} from '../migration/native-claude-acceptance.js';
import type { LaunchSpec } from '../src/contracts.js';

const absolutePath = (name: string) => process.platform === 'win32' ? `C:\\${name}` : `/${name}`;
const spec: LaunchSpec = {
  executable: absolutePath('claude'),
  args: ['--add-dir', absolutePath('pack')],
  cwd: absolutePath('repo'),
  env: {},
  label: 'test',
  warnings: [],
  requiresConfirmation: false,
};
const expected: ExpectedSkill[] = [
  { name: 'mp-visible', path: absolutePath('pack/visible/SKILL.md'), explicitOnly: false },
  { name: 'mp-explicit', path: absolutePath('pack/explicit/SKILL.md'), explicitOnly: true },
];

function stream(sessionId: string, marker: string, options: {
  skills?: string[];
  commands?: string[];
  cwd?: string;
  model?: string;
  permissionMode?: string;
  result?: 'success' | 'error' | 'missing';
} = {}): string {
  const records: object[] = [{
    type: 'system', subtype: 'init', session_id: sessionId,
    cwd: options.cwd ?? spec.cwd, model: options.model ?? 'claude-test',
    permissionMode: options.permissionMode ?? 'default', skills: options.skills ?? ['mp-visible'],
    slash_commands: options.commands ?? ['mp-explicit'],
  }, { type: 'assistant', message: { content: [{ type: 'text', text: marker }] } }];
  if (options.result !== 'missing') records.push({ type: 'result', subtype: options.result ?? 'success', is_error: options.result === 'error', result: marker });
  return records.map(record => JSON.stringify(record)).join('\n');
}

function runnerFor(marker: string, mutate?: (call: number, output: string) => string): CommandRunner {
  let sessionId = '';
  let calls = 0;
  return async (_spec, args) => {
    assert.equal(args.includes('--permission-mode'), false, 'probe must observe the configured native permission default');
    const sessionIndex = args.indexOf('--session-id');
    if (sessionIndex >= 0) sessionId = args[sessionIndex + 1]!;
    else {
      const resumeIndex = args.indexOf('--resume');
      assert.ok(resumeIndex >= 0);
      assert.equal(args[resumeIndex + 1], sessionId);
      assert.equal(args.at(-1)?.includes(marker), false, 'resume prompt must not repeat marker');
    }
    const output = stream(sessionId, marker);
    return { code: 0, stdout: mutate ? mutate(calls++, output) : output };
  };
}

test('requires flag-form live gate, known arguments, and absolute selectors', () => {
  assert.throws(() => parseArguments(['--live', 'true', '--account', 'work', '--cwd', absolutePath('r'), '--artifacts', absolutePath('a')]), /unsupported/);
  assert.throws(() => parseArguments(['--live', '--wat', 'x', '--account', 'work', '--cwd', absolutePath('r'), '--artifacts', absolutePath('a')]), /unsupported/);
  assert.throws(() => parseArguments(['--live', '--account', 'work', '--cwd', 'relative', '--artifacts', absolutePath('a')]), /requires/);
  assert.equal(parseArguments(['--live', '--account', 'personal', '--cwd', absolutePath('r'), '--artifacts', absolutePath('a')]).account, 'personal');
});

test('scrubs pane routing and provider credential overrides by name', () => {
  const cleaned = sanitizeProbeEnvironment({ ORCA_PANE: 'x', ANTHROPIC_BASE_URL: 'x', OPENAI_API_KEY: 'secret', PATH: 'ok' });
  assert.deepEqual(cleaned.env, { PATH: 'ok' });
  assert.deepEqual(cleaned.removed, ['ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'ORCA_PANE']);
});

test('parses only authoritative init, assistant text, and successful final result', () => {
  const parsed = parseStream(stream('session', 'MARK'));
  assert.equal(parsed.sessionId, 'session');
  assert.equal(parsed.model, 'claude-test');
  assert.match(parsed.responseText, /MARK/);
  assert.equal(parsed.successfulResult, true);
  assert.equal(parseStream(stream('session', 'MARK', { result: 'missing' })).successfulResult, false);
  assert.equal(parseStream(stream('session', 'MARK', { result: 'error' })).successfulResult, false);
});

test('catalog handles explicit-only skills and rejects missing, duplicate, or unexpected names', () => {
  const metadata = parseStream(stream('session', 'x'));
  assert.doesNotThrow(() => validateCatalog(metadata, expected));
  assert.throws(() => validateCatalog({ ...metadata, skills: ['mp-visible', 'mp-visible'] }, expected), /duplicate/);
  assert.throws(() => validateCatalog({ ...metadata, skills: ['mp-other'] }, expected), /unexpected/);
  assert.throws(() => validateCatalog({ ...metadata, skills: [] }, expected), /missing catalog/);
  assert.throws(() => validateCatalog({ ...metadata, slashCommands: [] }, expected), /explicit-only/);
});

test('fresh and exact resume retain marker and stable default permission state', async () => {
  const result = await execute(spec, expected, runnerFor('MARKER'), 'MARKER');
  assert.equal(result.effort.savedRecoveryVerified, false);
  assert.equal(result.permissionMode, 'default');
});

test('accepts stable native Auto while rejecting bypass and resume permission drift', async () => {
  const automatic = await execute(spec, expected, runnerFor('M', (_call, output) => output.replace('"permissionMode":"default"', '"permissionMode":"auto"')), 'M');
  assert.equal(automatic.permissionMode, 'auto');
  await assert.rejects(execute(spec, expected, runnerFor('M', (_call, output) => output.replace('"permissionMode":"default"', '"permissionMode":"bypassPermissions"')), 'M'), /fresh marker/);
  await assert.rejects(execute(spec, expected, runnerFor('M', (call, output) => call === 1 ? output.replace('"permissionMode":"default"', '"permissionMode":"auto"') : output), 'M'), /resumed marker/);
  await assert.rejects(execute(spec, expected, runnerFor('M', (call, output) => call === 1 ? output.replace('"permissionMode":"default"', '"permissionMode":"bypassPermissions"') : output), 'M'), /resumed marker/);
});

test('rejects missing/error final records, marker mismatch, nonzero, and timeout cleanup failure', async () => {
  await assert.rejects(execute(spec, expected, runnerFor('M', (_call, output) => output.split('\n').slice(0, -1).join('\n')), 'M'), /final result/);
  await assert.rejects(execute(spec, expected, runnerFor('M', (_call, output) => output.replace('"subtype":"success"', '"subtype":"error"')), 'M'), /final result/);
  const nonzero: CommandRunner = async () => ({ code: 1, stdout: '' });
  await assert.rejects(execute(spec, expected, nonzero, 'M'), /exited 1/);
  const timeout: CommandRunner = async () => ({ code: null, stdout: '', incomplete: 'deadline exceeded; process-tree termination FAILED' });
  await assert.rejects(execute(spec, expected, timeout, 'M'), /termination FAILED/);
});

test('expired native OAuth failures provide a bounded diagnosis without echoing provider output', async () => {
  const failing: CommandRunner = async () => ({ code: 1, stdout: '401 OAuth access token has expired. Bearer private-test-value' });
  await assert.rejects(execute(spec, expected, failing, 'MARKER'), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /interactive reauthentication required/);
    assert.equal(error.message.includes('private-test-value'), false);
    return true;
  });
});

test('auth validation reports logged-out accounts specifically and rejects malformed/nonzero status', () => {
  assert.deepEqual(validateAuthResult({ code: 0, stdout: '{"loggedIn":true,"email":"not exposed"}' }), { loggedIn: true });
  assert.throws(() => validateAuthResult({ code: 1, stdout: '{"loggedIn":false}' }), /loggedIn=false/);
  assert.throws(() => validateAuthResult({ code: 0, stdout: '{}' }), /omitted loggedIn/);
  assert.throws(() => validateAuthResult({ code: 1, stdout: '{"loggedIn":true}' }), /exited 1/);
});
