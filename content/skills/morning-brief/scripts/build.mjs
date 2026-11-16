#!/usr/bin/env node
// Renders <day>/brief.json into a self-contained <day>/index.html. Gives the brief a process token and
// account on the first build and writes them back into brief.json, so rebuilds keep them, and on every
// build writes them to <day>/process.json for the agent-launch handler. With --commit-state, records the
// brief as the last successful one so the next window starts here.
// Usage: build.mjs <day-directory> [--commit-state] [--out <file>]
import { randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const CHAPTER_TYPES = ['calendar', 'overnight', 'work', 'issues', 'slack', 'mail', 'triage', 'retro', 'instructions', 'news', 'actions'];
const PARAMETER_TYPES = ['select', 'text', 'textarea'];
const ACCOUNTS = ['personal', 'work'];
const DEFAULT_PROCESS_ACCOUNT = ACCOUNTS[1];
const APP_LINK_KEYS = ['app', 'scope', 'url'];
const MAXIMUM_INSTRUCTION_HIGHLIGHTS = 2;
const STATUSES = ['needs', 'fyi', 'quiet', 'unavailable'];
const NOTE_MAXIMUM_WORDS = 4;
// simple-icons ship paths without colour; these are the brands' own.
const BRAND_COLORS = {
  anthropic: '#191919', claude: '#D97757', gerrit: '#2F7E3A', github: '#24292F', gitlab: '#FC6D26', gmail: '#EA4335',
  googlecalendar: '#1A73E8', googlegemini: '#8E75B2', huggingface: '#FFB000', jenkins: '#D24939', obsidian: '#7C3AED',
  openai: '#111111', sentry: '#362D59', slack: '#4A154B', windowsterminal: '#4D4D4D', ycombinator: '#F0652F',
};

const { positionals, values } = parseArgs({ allowPositionals: true, options: { 'commit-state': { type: 'boolean' }, out: { type: 'string' } } });
const [dayDirectory] = positionals;
if (!dayDirectory || !isAbsolute(dayDirectory)) {
  console.error('Usage: build.mjs <absolute day directory> [--commit-state] [--out <file>]');
  process.exit(1);
}

const briefPath = join(dayDirectory, 'brief.json');
const brief = JSON.parse(await readFile(briefPath, 'utf8'));
const problems = [];
if (!brief.date || !brief.window?.since || !brief.window?.until) problems.push('date and window.since/until are required');
if (!Array.isArray(brief.chapters) || brief.chapters.length === 0) problems.push('chapters must be a non-empty array');
const chapterIds = new Set();
for (const [index, chapter] of (brief.chapters ?? []).entries()) {
  const where = `chapters[${index}] (${chapter.id ?? 'no id'})`;
  if (!chapter.id || chapterIds.has(chapter.id)) problems.push(`${where}: id must be present and unique`);
  chapterIds.add(chapter.id);
  if (!CHAPTER_TYPES.includes(chapter.type)) problems.push(`${where}: type must be one of ${CHAPTER_TYPES.join(', ')}`);
  if (!STATUSES.includes(chapter.status)) problems.push(`${where}: status must be one of ${STATUSES.join(', ')}`);
  if (!chapter.name || !chapter.title) problems.push(`${where}: name and title are required`);
  const narrated = isNarrated(chapter);
  if (narrated && (!Array.isArray(chapter.beats) || chapter.beats.length === 0)) problems.push(`${where}: beats need at least one entry`);
  for (const beat of chapter.beats ?? []) {
    if (!beat.say || !beat.note) problems.push(`${where}: every beat needs say and note`);
    if (String(beat.note ?? '').split(/\s+/).length > NOTE_MAXIMUM_WORDS) problems.push(`${where}: note "${beat.note}" must be a label of at most ${NOTE_MAXIMUM_WORDS} words`);
    if (/—/.test(`${beat.say ?? ''}${chapter.title ?? ''}`)) problems.push(`${where}: replace em dashes in title and say with commas or full stops`);
    if (narrated && !beat.hold && !beat.targets?.length) problems.push(`${where}: beat "${beat.note}" names no targets; every spoken point lights what it is about`);
  }
  if (chapter.apps !== undefined && !Array.isArray(chapter.apps)) problems.push(`${where}: apps must be an array`);
  for (const [index, appLink] of (Array.isArray(chapter.apps) ? chapter.apps : []).entries()) {
    if (typeof appLink !== 'object' || appLink === null) {
      problems.push(`${where} apps[${index}]: must be an object`);
      continue;
    }
    const unknownKeys = Object.keys(appLink).filter((key) => !APP_LINK_KEYS.includes(key));
    if (unknownKeys.length) problems.push(`${where} apps[${index}]: unknown key ${unknownKeys.join(', ')}; use app, scope and url`);
    if (!appLink.app || !appLink.url) problems.push(`${where} apps[${index}]: app and url are required`);
    if (appLink.scope !== undefined && !ACCOUNTS.includes(appLink.scope)) problems.push(`${where} apps[${index}]: scope must be one of ${ACCOUNTS.join(', ')}`);
  }
}
for (const source of brief.sources ?? []) {
  for (const id of source.chapters ?? []) if (!chapterIds.has(id)) problems.push(`sources "${source.name}": unknown chapter "${id}"`);
}
for (const item of brief.chapters?.find((chapter) => chapter.type === 'actions')?.data?.items ?? []) {
  if (!item.id || !item.text) problems.push('every action point needs id and text');
  if (!chapterIds.has(item.chapter)) problems.push(`action "${item.id}": chapter "${item.chapter}" is not a chapter id; its decision shows on that slide`);
  if (!item.project) problems.push(`action "${item.id}": project is required; action points are grouped by it`);
  if (item.agent === false && !item.why) problems.push(`action "${item.id}": a manual point needs why no agent can do it`);
  if (item.parameters !== undefined && !Array.isArray(item.parameters)) problems.push(`action "${item.id}": parameters must be an array`);
  const parameterIds = new Set();
  for (const [index, parameter] of (Array.isArray(item.parameters) ? item.parameters : []).entries()) {
    if (typeof parameter !== 'object' || parameter === null) {
      problems.push(`action "${item.id}" parameters[${index}]: must be an object`);
      continue;
    }
    const where = `action "${item.id}" parameter "${parameter.id ?? 'no id'}"`;
    if (!parameter.id || !parameter.label) problems.push(`${where}: id and label are required`);
    if (parameter.id && parameterIds.has(parameter.id)) problems.push(`${where}: id must be unique within the action`);
    parameterIds.add(parameter.id);
    if (!PARAMETER_TYPES.includes(parameter.type)) problems.push(`${where}: type must be one of ${PARAMETER_TYPES.join(', ')}`);
    if (parameter.type !== 'select') continue;
    const options = Array.isArray(parameter.options) ? parameter.options : [];
    const hasOptions = options.length > 0 && options.every((option) => typeof option === 'object' && option !== null && option.value !== undefined && option.label);
    if (!hasOptions) {
      problems.push(`${where}: a select needs options, each with value and label`);
      continue;
    }
    const optionValues = options.map((option) => String(option.value));
    if (new Set(optionValues).size !== optionValues.length) problems.push(`${where}: option values must be unique`);
    if (parameter.value !== undefined && !optionValues.includes(String(parameter.value))) problems.push(`${where}: value "${parameter.value}" must be one of its options`);
  }
}
const instructions = brief.chapters?.find((chapter) => chapter.type === 'instructions')?.data ?? {};
if ((instructions.highlights ?? []).length > MAXIMUM_INSTRUCTION_HIGHLIGHTS) problems.push(`instructions: at most ${MAXIMUM_INSTRUCTION_HIGHLIGHTS} highlights; give the rest as counts`);
for (const entry of [...(instructions.skills ?? []), ...(instructions.highlights ?? []), ...(instructions.counts ?? [])]) {
  if (!entry?.id) problems.push('instructions: every skill, highlight and count needs an id; beats target change-<id>');
}
if (brief.process !== undefined) {
  if (typeof brief.process !== 'object' || brief.process === null) problems.push('process must be an object with token and account');
  else {
    if (brief.process.token !== undefined && (typeof brief.process.token !== 'string' || !brief.process.token)) problems.push('process.token must be a non-empty string');
    if (brief.process.account !== undefined && !ACCOUNTS.includes(brief.process.account)) problems.push(`process.account must be one of ${ACCOUNTS.join(', ')}`);
  }
}
const calendarChapter = brief.chapters?.find((chapter) => chapter.type === 'calendar' && isNarrated(chapter));
if (calendarChapter) {
  const { calendars = [], days = [], events = [] } = calendarChapter.data ?? {};
  const focusDayIds = new Set(days.filter((day) => day.focus).map((day) => day.id));
  // Another person's calendar reaches me as `reader`; its meetings are narrated only when they change my day.
  const myCalendarIds = new Set(calendars.filter((calendar) => (calendar.access ?? 'owner') === 'owner').map((calendar) => calendar.id));
  const narratedTargets = new Set(calendarChapter.beats?.flatMap((beat) => beat.targets ?? []));
  for (const event of events) {
    const isMyMeetingToday = focusDayIds.has(event.day) && event.title && event.attendees > 0 && !event.busyOnly && myCalendarIds.has(event.calendarId);
    if (isMyMeetingToday && !narratedTargets.has(`event-${event.id}`)) problems.push(`calendar event "${event.id}" (${event.title}): a meeting today on my calendar needs a beat targeting event-${event.id}`);
  }
}
if (problems.length) {
  console.error(`brief.json is invalid:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

// The token ties decisions sent from the page to this brief; the processing session ignores any other.
if (!brief.process?.token || !brief.process?.account) {
  brief.process = { token: brief.process?.token ?? randomUUID(), account: brief.process?.account ?? DEFAULT_PROCESS_ACCOUNT };
  await writeFile(briefPath, `${JSON.stringify(brief, null, 2)}\n`);
}
// The handler reads this small file because Windows PowerShell 5.1 cannot parse a brief.json over 2 MB.
await writeFile(join(dayDirectory, 'process.json'), `${JSON.stringify({ token: brief.process.token, account: brief.process.account }, null, 2)}\n`);

const templates = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const icons = {};
for (const file of (await readdir(join(templates, 'icons'))).filter((name) => name.endsWith('.svg'))) {
  const name = file.replace(/\.svg$/, '');
  const path = (await readFile(join(templates, 'icons', file), 'utf8')).match(/<path d="([^"]*)"/)?.[1];
  if (path) icons[name] = { color: BRAND_COLORS[name] ?? '#16385c', path };
}
const tokens = await readFile(join(templates, 'tokens.css'), 'utf8');
const template = await readFile(join(templates, 'page.html'), 'utf8');
// Escaping `<` keeps message text from closing the data script element.
const data = JSON.stringify(brief).replace(/</g, '\\u003c');
const page = template
  .replace('<link rel="stylesheet" href="tokens.css">', () => `<style>\n${tokens}</style>`)
  .replace('{"placeholder-icons":true}', () => JSON.stringify(icons))
  .replace('{"placeholder":true}', () => data);
const output = values.out ?? join(dayDirectory, 'index.html');
await writeFile(output, page);

if (values['commit-state']) {
  const statePath = join(dayDirectory, '..', 'state.json');
  await writeFile(statePath, `${JSON.stringify({ lastSuccess: brief.window.until, lastBrief: dayDirectory }, null, 2)}\n`);
}
console.log(pathToFileURL(output).href);

function isNarrated(chapter) {
  return !['quiet', 'unavailable'].includes(chapter.status);
}
