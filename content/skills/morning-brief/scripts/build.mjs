#!/usr/bin/env node
// Renders <day>/brief.json into a self-contained <day>/index.html. With --commit-state, records the
// brief as the last successful one so the next window starts here.
// Usage: build.mjs <day-directory> [--commit-state] [--out <file>]
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const CHAPTER_TYPES = ['calendar', 'overnight', 'work', 'issues', 'slack', 'mail', 'triage', 'retro', 'instructions', 'news', 'actions'];
const HANDOFFS = ['agent', 'you'];
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

const brief = JSON.parse(await readFile(join(dayDirectory, 'brief.json'), 'utf8'));
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
  const narrated = !['quiet', 'unavailable'].includes(chapter.status);
  if (narrated && (!Array.isArray(chapter.beats) || chapter.beats.length === 0)) problems.push(`${where}: beats need at least one entry`);
  for (const beat of chapter.beats ?? []) {
    if (!beat.say || !beat.note) problems.push(`${where}: every beat needs say and note`);
    if (String(beat.note ?? '').split(/\s+/).length > NOTE_MAXIMUM_WORDS) problems.push(`${where}: note "${beat.note}" must be a label of at most ${NOTE_MAXIMUM_WORDS} words`);
    if (/—/.test(`${beat.say ?? ''}${chapter.title ?? ''}`)) problems.push(`${where}: replace em dashes in title and say with commas or full stops`);
    if (narrated && !beat.hold && !beat.targets?.length) problems.push(`${where}: beat "${beat.note}" names no targets; every spoken point lights what it is about`);
  }
}
for (const source of brief.sources ?? []) {
  for (const id of source.chapters ?? []) if (!chapterIds.has(id)) problems.push(`sources "${source.name}": unknown chapter "${id}"`);
}
for (const item of brief.chapters?.find((chapter) => chapter.type === 'actions')?.data?.items ?? []) {
  if (!item.id || !item.text) problems.push('every action point needs id and text');
  if (!chapterIds.has(item.chapter)) problems.push(`action "${item.id}": chapter "${item.chapter}" is not a chapter id; its decision shows on that slide`);
  if (!HANDOFFS.includes(item.handoff)) problems.push(`action "${item.id}": handoff must be one of ${HANDOFFS.join(', ')}`);
}
if (problems.length) {
  console.error(`brief.json is invalid:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

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
