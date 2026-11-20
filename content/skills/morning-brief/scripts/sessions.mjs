#!/usr/bin/env node
// Lists Claude and Pi sessions of both accounts that changed in the window, with their id, first and last prompt, plus
// `away`: last night, the longest gap between my prompts in the day before `until`. Sessions with `activeWhileAway`
// kept working in it and carry `reportLinks`, the https and file links of their last report.
// Usage: sessions.mjs --since <iso> [--until <iso>] [--out <file>]
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { sessionIdOfTranscript } from './session-id.mjs';

const TITLE_LENGTH = 160;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const MAXIMUM_REPORT_LINKS = 8;
const LINK_TARGET = String.raw`(?:https://|file:///)`;
// A Markdown link, its target in angle brackets when it holds spaces.
const MARKDOWN_LINK = new RegExp(String.raw`\[([^\]\n]+)\]\((?:<(${LINK_TARGET}[^>\n]+)>|(${LINK_TARGET}[^\s)]+))\)`, 'g');
const BARE_LINK = new RegExp(String.raw`${LINK_TARGET}[^\s<>()\[\]"'\x60]+`, 'g');
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

function assistantText(entry) {
  const message = entry.message ?? entry;
  return message?.role === 'assistant' && !entry.isSidechain ? textOf(message.content).trim() : '';
}

// The entries' times and prompts, and the text of the last assistant message that has text: the session's report.
function readEntries(lines) {
  const entries = [];
  let lastReport = '';
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const time = new Date(entry.timestamp ?? entry.message?.timestamp ?? '');
      if (!Number.isNaN(time.getTime())) entries.push({ time, prompt: humanPromptText(entry) });
      lastReport = assistantText(entry) || lastReport;
    } catch {
      continue;
    }
  }
  return { entries, lastReport };
}

// A report's https and file links in order, each once with its link text as label (a bare link is its own label).
function reportLinksOf(report) {
  const markdownLinks = [...report.matchAll(MARKDOWN_LINK)]
    .map((match) => ({ index: match.index, label: match[1].trim(), link: match[2] ?? match[3] }));
  // Blanking the Markdown links keeps the other links' positions, so the result follows the report's order.
  const withoutMarkdownLinks = report.replace(MARKDOWN_LINK, (match) => ' '.repeat(match.length));
  const bareLinks = [...withoutMarkdownLinks.matchAll(BARE_LINK)].map((match) => {
    const link = match[0].replace(/[.,;:!?]+$/, '');
    return { index: match.index, label: link, link };
  });
  const linksByAddress = new Map();
  for (const { label, link } of [...markdownLinks, ...bareLinks].sort((left, right) => left.index - right.index)) {
    if (!linksByAddress.has(link)) linksByAddress.set(link, { label, link });
  }
  return [...linksByAddress.values()].slice(0, MAXIMUM_REPORT_LINKS);
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
      const { entries, lastReport } = readEntries(lines);
      const prompts = entries.filter((entry) => entry.prompt && entry.time >= since);
      found.push({
        account, harness, project: project.name, file: path, sessionId: sessionIdOfTranscript(path), modified: info.mtime.toISOString(),
        sizeKilobytes: Math.round(info.size / 1024), lines: lines.length,
        title: (entries.find((entry) => entry.prompt)?.prompt ?? '').slice(0, TITLE_LENGTH),
        lastPrompt: prompts.at(-1)?.time.toISOString(),
        promptTimes: prompts.map((entry) => entry.time),
        entryTimes: entries.map((entry) => entry.time),
        reportLinks: reportLinksOf(lastReport),
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
  else delete session.reportLinks;
  delete session.promptTimes;
  delete session.entryTimes;
}
const text = `${JSON.stringify({ since: values.since, until: until.toISOString(), away: away && { from: away.from.toISOString(), to: away.to.toISOString() }, sessions }, null, 2)}\n`;
if (values.out) await writeFile(values.out, text);
else process.stdout.write(text);
