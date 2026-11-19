// The headless cheap-model recipe shared by gather.mjs, apply.mjs, news-digest.mjs and mailboxes.mjs: one Claude session per
// account, launched through mpx in print mode with only the listed tools allowed.
import { spawn, spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

export const HEADLESS_MODEL = 'sonnet';
export const ACCOUNT_LAUNCHERS = { personal: 'cc', work: 'ccw' };

/** The mpx checkout whose launchers start the sessions, or null when the session was not launched through mpx. */
export function contentRoot() {
  const root = process.env.MPX_ACTIVE_CONTENT_ROOT;
  return root && isAbsolute(root) ? root : null;
}

export function stopTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

export function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the answer contains no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Runs one session with `prompt` on stdin and resolves when it ends: `{ error }` when it could not start, else
 * `{ code, timedOut }`, both with the output and the duration. `settingsPath` adds a settings file such as hooks.
 * Without `tools` the session loads no tool, connector or MCP server and only answers; `systemPrompt` then replaces
 * the default system prompt.
 */
export async function runHeadless({ account, model = HEADLESS_MODEL, tools, prompt, cwd, timeoutMilliseconds, settingsPath, systemPrompt }) {
  const toolArguments = tools.length > 0
    ? ['--connectors', '--allowedTools', ['ToolSearch', ...tools].join(',')]
    : ['--tools', '', '--strict-mcp-config'];
  const args = [join(contentRoot(), 'bin', ACCOUNT_LAUNCHERS[account]), ...toolArguments, '-p', '--output-format', 'json', '--model', model,
    '--permission-mode', 'dontAsk', ...(systemPrompt ? ['--system-prompt', systemPrompt] : []), ...(settingsPath ? ['--settings', settingsPath] : [])];
  // Orca closes an automation run's tab on the first `done` hook from its pane, so these sessions must not
  // report as that pane.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_')));
  const started = Date.now();
  const outcome = await new Promise((resolve) => {
    const child = spawn('bash', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stopTree(child); }, timeoutMilliseconds);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ error: error.message, stdout, stderr }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut, stdout, stderr }); });
    child.stdin.end(prompt);
  });
  return { ...outcome, durationMilliseconds: Date.now() - started };
}

/** The session's final JSON envelope; throws with the reason when the session failed or timed out. */
export function readEnvelope(outcome, timeoutMilliseconds) {
  if (outcome.error) throw new Error(outcome.error);
  if (outcome.timedOut) throw new Error(`timed out after ${timeoutMilliseconds / 60000} minutes`);
  const envelope = extractJson(outcome.stdout);
  if (envelope.is_error) throw new Error(String(envelope.result ?? 'the session reported an error'));
  return envelope;
}

/** The session's error output and answer, kept beside its results. */
export function sessionLog(outcome) {
  return `${outcome.stderr}\n--- stdout ---\n${outcome.stdout}`;
}
