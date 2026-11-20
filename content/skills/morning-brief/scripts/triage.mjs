#!/usr/bin/env node
// Writes <day>/sources/triage.json without a model: every capture of Ideas.md and of the daily notes from the first
// day of the window in <day>/start.json to the brief's day, and the headings a capture can move under. A capture is an
// open list line (no checkbox or `[ ]`) that is not empty and not nested under another list line, with the headings
// above it and the lines nested under it. Ticked, started and empty lines, paragraphs and the sections named below are
// left out and counted.
// Usage: triage.mjs <day-directory>
import { stat, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { briefItemId } from './brief-id.mjs';
import { TRIAGE_FILE } from './document-narration.mjs';
import { nestedLines, readNote } from './note-lines.mjs';

// My priority list, which the weekly brief keeps.
const CURRENT_PRIORITIES_HEADING = 'Current Priorities';
// My backlog of token-heavy jobs, launched when tokens are spare; it is a move destination, never triaged daily.
const TOKEN_BURN_HEADING = 'Token burn ideas';
const IDEAS_NOTE = 'Ideas.md';
const DAILY_FOLDER = 'Daily';
const PROJECTS_FOLDER = '_Projekty';
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const OPEN_BOXES = [null, ' '];
const TICKED_BOXES = ['x', 'X'];
const STARTED_BOX = '/';

const [dayDirectory] = process.argv.slice(2);
if (!dayDirectory || !isAbsolute(dayDirectory)) {
  console.error('Usage: triage.mjs <absolute day directory>');
  process.exit(1);
}
const vaultDirectory = process.env.MPX_OBSIDIAN_VAULT;
if (!vaultDirectory || !(await stat(vaultDirectory).catch(() => undefined))?.isDirectory()) {
  console.error(`No Obsidian vault at MPX_OBSIDIAN_VAULT (${vaultDirectory || 'not set'}); nothing to triage.`);
  process.exit(1);
}
let start;
try {
  start = JSON.parse((await readFile(join(dayDirectory, 'start.json'), 'utf8')).replace(/^﻿/, ''));
} catch {
  console.error(`${dayDirectory} has no start.json; run start.mjs first.`);
  process.exit(1);
}

// A wiki link reads as its alias, else its target, as Obsidian shows it.
const visibleText = (headingText) => headingText.replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (link, target, alias) => alias ?? target).trim() || headingText;
const isNamed = (headingText, name) => headingText.toLowerCase() === name.toLowerCase();

// The days from the window's first local day to the brief's day, each YYYY-MM-DD.
function windowDays() {
  const days = [];
  for (let time = Date.parse(`${String(start.since).slice(0, 10)}T00:00:00Z`); time <= Date.parse(`${basename(dayDirectory)}T00:00:00Z`); time += DAY_MILLISECONDS) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

async function readVaultNote(notePath) {
  return readFile(join(vaultDirectory, notePath), 'utf8').catch(() => undefined);
}

function capturesOf(notePath, noteText, leftOut) {
  const entries = readNote(noteText);
  const headings = [];
  const captures = [];
  // The indentation of the last top-level line; a list line's deeper lines belong to it.
  let listIndent = null;
  entries.forEach((entry, index) => {
    if (entry.kind === 'blank') return;
    if (entry.kind === 'heading') {
      while (headings.length && headings.at(-1).level >= entry.level) headings.pop();
      headings.push({ level: entry.level, text: visibleText(entry.text) });
      listIndent = null;
      return;
    }
    if (listIndent !== null && entry.indent > listIndent) return;
    listIndent = entry.kind === 'list' ? entry.indent : null;
    const heading = headings.map(({ text }) => text);
    if (heading.some((text) => isNamed(text, CURRENT_PRIORITIES_HEADING))) leftOut.currentPriorities++;
    else if (heading.some((text) => isNamed(text, TOKEN_BURN_HEADING))) leftOut.tokenBurnIdeas++;
    else if (entry.kind === 'text') leftOut.paragraphs++;
    else if (!entry.text) leftOut.empty++;
    else if (TICKED_BOXES.includes(entry.box)) leftOut.ticked++;
    else if (entry.box === STARTED_BOX) leftOut.started++;
    else if (!OPEN_BOXES.includes(entry.box)) leftOut.otherStatus++;
    else {
      const nested = nestedLines(entries, index);
      captures.push({ id: briefItemId('note', notePath, entry.text), notePath, line: entry.text, heading, task: entry.box !== null, hasNested: nested.length > 0, nested });
    }
  });
  return captures;
}

// The headings below each project note's title, and Ideas.md's token burn heading as it is written, the places the
// app moves a capture under.
async function moveDestinations() {
  const headingsOf = (noteText) => readNote(noteText).filter((entry) => entry.kind === 'heading' && entry.level > 1).map((entry) => entry.text);
  const projectFolders = (await readdir(join(vaultDirectory, PROJECTS_FOLDER), { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const destinations = [];
  for (const folder of projectFolders) {
    const notePath = `${PROJECTS_FOLDER}/${folder}/${folder}.md`;
    const noteText = await readVaultNote(notePath);
    if (noteText !== undefined) destinations.push({ notePath, headings: headingsOf(noteText) });
  }
  const tokenBurnHeading = headingsOf((await readVaultNote(IDEAS_NOTE)) ?? '').find((text) => isNamed(visibleText(text), TOKEN_BURN_HEADING));
  if (tokenBurnHeading) destinations.push({ notePath: IDEAS_NOTE, headings: [tokenBurnHeading] });
  return destinations;
}

const leftOut = { ticked: 0, started: 0, otherStatus: 0, empty: 0, paragraphs: 0, currentPriorities: 0, tokenBurnIdeas: 0 };
const notes = [];
const captures = [];
for (const notePath of [IDEAS_NOTE, ...windowDays().map((day) => `${DAILY_FOLDER}/${day}.md`)]) {
  const noteText = await readVaultNote(notePath);
  if (noteText === undefined) continue;
  notes.push(notePath);
  captures.push(...capturesOf(notePath, noteText, leftOut));
}
const triage = { notes, captures, leftOut, destinations: await moveDestinations() };
const triagePath = join(dayDirectory, TRIAGE_FILE);
await writeFile(`${triagePath}.partial`, `${JSON.stringify(triage, null, 2)}\n`);
await rename(`${triagePath}.partial`, triagePath);
console.log(`${captures.length} captures from ${notes.join(', ') || 'no note'} in ${triagePath}`);
console.log(`Left out: ${leftOut.ticked} ticked, ${leftOut.started} started, ${leftOut.otherStatus} with another status, ${leftOut.empty} empty, `
  + `${leftOut.paragraphs} paragraphs, ${leftOut.currentPriorities} under ${CURRENT_PRIORITIES_HEADING}, ${leftOut.tokenBurnIdeas} under ${TOKEN_BURN_HEADING}.`);
