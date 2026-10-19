#!/usr/bin/env node
// Lists Claude and Pi sessions of both accounts that changed in the window, with their first prompt,
// last prompt and failed tool results, plus `away`: last night, the longest gap between my prompts in
// the day before `until`. Sessions with `activeWhileAway` kept working in it.
// Usage: sessions.mjs --since <iso> [--until <iso>] [--out <file>]
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const TITLE_LENGTH = 160;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const { values } = parseArgs({ options: { since: { type: 'string' }, until: { type: 'string' }, out: { type: 'string' } } });
const since = new Date(values.since ?? '');
const until = new Date(values.until ?? Date.now());
if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || !process.env.APPDATA) {
  console.error('Usage: sessions.mjs --since <iso> [--until <iso>] [--out <file>] (needs APPDATA for the MPX configuration)');
  process.exit(1);
}
const config = JSON.parse(await readFile(join(process.env.APPDATA, 'mpx', 'config.json'), 'utf8'));

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((part) => part?.type === 'text').map((part) => part.text).join(' ');
  return '';
}

// A prompt I typed: not a tool result, command wrapper, compaction summary or message from another session.
function humanPromptText(entry) {
  const message = entry.message ?? entry;
  if (message?.role !== 'user' || entry.isCompactSummary || entry.isMeta || entry.toolUseResult) return '';
  const text = textOf(message.content).replace(/\s+/g, ' ').trim();
  if (!text || text.startsWith('<') || /^(This session is being continued|Another Claude session sent a message)/.test(text)) return '';
  return text;
}

function readEntries(lines) {
  const entries = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const time = new Date(entry.timestamp ?? entry.message?.timestamp ?? '');
      if (!Number.isNaN(time.getTime())) entries.push({ time, prompt: humanPromptText(entry) });
    } catch {
      continue;
    }
  }
  return entries;
}

async function sessionsIn(account, harness, projectsDirectory) {
  const found = [];
  for (const project of await readdir(projectsDirectory, { withFileTypes: true }).catch(() => [])) {
    // The brief's own gatherer sessions run in its day folders and are not work to review.
    if (!project.isDirectory() || /morning-brief/i.test(project.name)) continue;
    const directory = join(projectsDirectory, project.name);
    for (const file of await readdir(directory).catch(() => [])) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(directory, file);
      const info = await stat(path).catch(() => undefined);
      if (!info || info.mtime < since) continue;
      const text = await readFile(path, 'utf8').catch(() => '');
      const lines = text.split('\n');
      const entries = readEntries(lines);
      const prompts = entries.filter((entry) => entry.prompt && entry.time >= since);
      found.push({
        account, harness, project: project.name, file: path, modified: info.mtime.toISOString(),
        sizeKilobytes: Math.round(info.size / 1024), lines: lines.length,
        toolErrors: text.split('"is_error":true').length - 1,
        title: (entries.find((entry) => entry.prompt)?.prompt ?? '').slice(0, TITLE_LENGTH),
        lastPrompt: prompts.at(-1)?.time.toISOString(),
        promptTimes: prompts.map((entry) => entry.time),
        entryTimes: entries.map((entry) => entry.time),
      });
    }
  }
  return found;
}

const sessions = [];
for (const [account, roots] of Object.entries(config.accounts)) {
  if (roots.claude) sessions.push(...await sessionsIn(account, 'claude', join(roots.claude, 'projects')));
  if (roots.pi) sessions.push(...await sessionsIn(account, 'pi', join(roots.pi, 'sessions')));
}
sessions.sort((left, right) => right.modified.localeCompare(left.modified));

// Last night is the longest gap between my prompts in the day before `until`, counting the gap from
// my last prompt to `until` when I have not prompted yet this morning. A window spanning several days
// still reports only that night; what kept running then is overnight work.
const promptTimes = sessions.flatMap((session) => session.promptTimes).filter((time) => time <= until).sort((left, right) => left - right);
const dayStart = new Date(until.getTime() - DAY_MILLISECONDS);
const marks = [promptTimes.filter((time) => time < dayStart).at(-1), ...promptTimes.filter((time) => time >= dayStart), until].filter(Boolean);
let away;
for (let index = 1; index < marks.length; index++) {
  if (!away || marks[index] - marks[index - 1] > away.to - away.from) away = { from: marks[index - 1], to: marks[index] };
}
for (const session of sessions) {
  const whileAway = away ? session.entryTimes.filter((time) => time > away.from && time < away.to) : [];
  if (whileAway.length) session.activeWhileAway = { entries: whileAway.length, from: whileAway[0].toISOString(), until: whileAway.at(-1).toISOString() };
  delete session.promptTimes;
  delete session.entryTimes;
}
const text = `${JSON.stringify({ since: values.since, until: until.toISOString(), away: away && { from: away.from.toISOString(), to: away.to.toISOString() }, sessions }, null, 2)}\n`;
if (values.out) await writeFile(values.out, text);
else process.stdout.write(text);
