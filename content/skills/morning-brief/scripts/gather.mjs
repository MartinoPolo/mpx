#!/usr/bin/env node
// Runs one headless, connector-enabled Claude session per account and stores each JSON answer in
// <day>/sources/. Calendars cover the calendarDays of <day>/start.json.
// Usage: gather.mjs <day-directory> --since <iso> --until <iso> [--only personal|work]
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { contentRoot, extractJson, readEnvelope, runHeadless, sessionLog } from './headless.mjs';

const TIMEOUT_MILLISECONDS = 12 * 60 * 1000;
const CALENDAR_READ_TOOLS = ['list_calendars', 'list_events', 'get_event', 'search_events'].map((tool) => `mcp__claude_ai_Google_Calendar__${tool}`);
const GMAIL_READ_TOOLS = ['search_threads', 'get_thread', 'get_message', 'list_labels'].map((tool) => `mcp__claude_ai_Gmail__${tool}`);
const SLACK_READ_TOOLS = ['search_public_and_private', 'search_public', 'search_channels', 'search_users', 'read_channel', 'read_thread',
  'read_user_profile', 'list_user_channels', 'get_reactions'].map((tool) => `mcp__claude_ai_Slack__slack_${tool}`);

// Work calendar tools are listed before the connector exists so it is picked up once approved.
const GATHERER_TOOLS = {
  personal: [...CALENDAR_READ_TOOLS, ...GMAIL_READ_TOOLS],
  work: [...SLACK_READ_TOOLS, ...GMAIL_READ_TOOLS, ...CALENDAR_READ_TOOLS],
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { since: { type: 'string' }, until: { type: 'string' }, only: { type: 'string' } },
});
const [dayDirectory] = positionals;
if (!dayDirectory || !isAbsolute(dayDirectory) || !values.since || !values.until) {
  console.error('Usage: gather.mjs <absolute day directory> --since <iso> --until <iso> [--only personal|work]');
  process.exit(1);
}
if (!contentRoot()) {
  console.error('MPX_ACTIVE_CONTENT_ROOT is not set; launch through cc or ccw.');
  process.exit(1);
}
const selected = values.only ? [values.only] : Object.keys(GATHERER_TOOLS);
if (selected.some((name) => !(name in GATHERER_TOOLS))) {
  console.error(`--only must be one of: ${Object.keys(GATHERER_TOOLS).join(', ')}`);
  process.exit(1);
}

const promptDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'gatherers');
const today = dayDirectory.split(/[\\/]/).at(-1);
let calendarDays;
try {
  calendarDays = JSON.parse(await readFile(join(dayDirectory, 'start.json'), 'utf8')).calendarDays.join(', ');
} catch {
  console.error(`${dayDirectory} has no start.json with calendarDays; run start.mjs first.`);
  process.exit(1);
}

async function runGatherer(name) {
  const prompt = (await readFile(join(promptDirectory, `${name}.md`), 'utf8'))
    .replaceAll('%SINCE%', values.since)
    .replaceAll('%UNTIL%', values.until)
    .replaceAll('%TODAY%', today)
    .replaceAll('%CALENDAR_DAYS%', calendarDays);
  const outcome = await runHeadless({ account: name, tools: GATHERER_TOOLS[name], prompt, cwd: dayDirectory, timeoutMilliseconds: TIMEOUT_MILLISECONDS });
  const { durationMilliseconds } = outcome;
  await writeFile(join(dayDirectory, 'sources', `${name}.log`), sessionLog(outcome));
  let record;
  try {
    const envelope = readEnvelope(outcome, TIMEOUT_MILLISECONDS);
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
