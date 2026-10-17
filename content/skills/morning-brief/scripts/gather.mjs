#!/usr/bin/env node
// Runs one headless, connector-enabled Claude session per account and stores each JSON answer in
// <day>/sources/. Usage: gather.mjs <day-directory> --since <iso> --until <iso> [--only personal|work]
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const TIMEOUT_MILLISECONDS = 12 * 60 * 1000;
const GATHERER_MODEL = 'sonnet';
const CALENDAR_READ_TOOLS = ['list_calendars', 'list_events', 'get_event', 'search_events'].map((tool) => `mcp__claude_ai_Google_Calendar__${tool}`);
const GMAIL_READ_TOOLS = ['search_threads', 'get_thread', 'get_message', 'list_labels'].map((tool) => `mcp__claude_ai_Gmail__${tool}`);
const SLACK_READ_TOOLS = ['search_public_and_private', 'search_public', 'search_channels', 'search_users', 'read_channel', 'read_thread',
  'read_user_profile', 'list_user_channels', 'get_reactions'].map((tool) => `mcp__claude_ai_Slack__slack_${tool}`);

// Work calendar tools are listed before the connector exists so it is picked up once approved.
const GATHERERS = {
  personal: { launcher: 'cc', tools: [...CALENDAR_READ_TOOLS, ...GMAIL_READ_TOOLS] },
  work: { launcher: 'ccw', tools: [...SLACK_READ_TOOLS, ...GMAIL_READ_TOOLS, ...CALENDAR_READ_TOOLS] },
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { since: { type: 'string' }, until: { type: 'string' }, only: { type: 'string' } },
});
const [dayDirectory] = positionals;
const root = process.env.MPX_ACTIVE_CONTENT_ROOT;
if (!dayDirectory || !isAbsolute(dayDirectory) || !values.since || !values.until) {
  console.error('Usage: gather.mjs <absolute day directory> --since <iso> --until <iso> [--only personal|work]');
  process.exit(1);
}
if (!root || !isAbsolute(root)) {
  console.error('MPX_ACTIVE_CONTENT_ROOT is not set; launch through cc or ccw.');
  process.exit(1);
}
const selected = values.only ? [values.only] : Object.keys(GATHERERS);
if (selected.some((name) => !(name in GATHERERS))) {
  console.error(`--only must be one of: ${Object.keys(GATHERERS).join(', ')}`);
  process.exit(1);
}

const promptDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'gatherers');
const today = dayDirectory.split(/[\\/]/).at(-1);

function stopTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the answer contains no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

async function runGatherer(name) {
  const gatherer = GATHERERS[name];
  const prompt = (await readFile(join(promptDirectory, `${name}.md`), 'utf8'))
    .replaceAll('%SINCE%', values.since)
    .replaceAll('%UNTIL%', values.until)
    .replaceAll('%TODAY%', today);
  const args = [join(root, 'bin', gatherer.launcher), '--connectors', '-p', '--output-format', 'json', '--model', GATHERER_MODEL,
    '--permission-mode', 'dontAsk', '--allowedTools', ['ToolSearch', ...gatherer.tools].join(',')];
  // Orca closes an automation run's tab on the first `done` hook from its pane, so gatherers must not
  // report as that pane.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_')));
  const started = Date.now();
  const outcome = await new Promise((resolve) => {
    const child = spawn('bash', args, { cwd: dayDirectory, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stopTree(child); }, TIMEOUT_MILLISECONDS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ error: error.message, stdout, stderr }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut, stdout, stderr }); });
    child.stdin.end(prompt);
  });
  const durationMilliseconds = Date.now() - started;
  await writeFile(join(dayDirectory, 'sources', `${name}.log`), `${outcome.stderr}\n--- stdout ---\n${outcome.stdout}`);
  let record;
  try {
    if (outcome.error) throw new Error(outcome.error);
    if (outcome.timedOut) throw new Error(`timed out after ${TIMEOUT_MILLISECONDS / 60000} minutes`);
    const envelope = extractJson(outcome.stdout);
    if (envelope.is_error) throw new Error(String(envelope.result ?? 'the session reported an error'));
    record = { status: 'ok', durationMilliseconds, costUsd: envelope.total_cost_usd ?? null, data: extractJson(String(envelope.result ?? '')) };
  } catch (error) {
    record = { status: 'unavailable', durationMilliseconds, reason: `${name} gatherer: ${error.message}` };
  }
  await writeFile(join(dayDirectory, 'sources', `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return [name, record.status, record.reason ?? `${Math.round(durationMilliseconds / 1000)} s`];
}

const results = await Promise.all(selected.map(runGatherer));
for (const [name, status, detail] of results) console.log(`${name}: ${status} (${detail})`);
process.exit(results.every(([, status]) => status === 'ok') ? 0 : 2);
