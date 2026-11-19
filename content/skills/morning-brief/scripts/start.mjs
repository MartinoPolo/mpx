#!/usr/bin/env node
// Prints the brief's day folder, covered window and calendar days as JSON, creating the folder and
// keeping the same JSON in its start.json.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { localDate, localIso } from './local-time.mjs';

const MAXIMUM_WINDOW_DAYS = 7;
const MAXIMUM_CATCH_UP_DAYS = 2;

const retainedRoot = process.env.MPX_AI_RETAINED;
if (!retainedRoot || !isAbsolute(retainedRoot)) {
  console.error('MPX_AI_RETAINED must be set to an absolute path.');
  process.exit(1);
}
const home = join(retainedRoot, 'morning-brief');
const now = new Date();
const startOfDay = (offsetDays) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);

let lastSuccess;
try {
  lastSuccess = new Date(JSON.parse(await readFile(join(home, 'state.json'), 'utf8')).lastSuccess);
} catch {
  lastSuccess = undefined;
}
if (lastSuccess && Number.isNaN(lastSuccess.getTime())) lastSuccess = undefined;
// The window starts at the last brief, but always covers the whole previous day.
let since = startOfDay(-1);
if (lastSuccess && lastSuccess < since) {
  since = lastSuccess < startOfDay(-MAXIMUM_WINDOW_DAYS) ? startOfDay(-MAXIMUM_WINDOW_DAYS) : lastSuccess;
}
// Yesterday, today and tomorrow, after the days before yesterday that began after the last brief, so
// no brief showed them.
const calendarOffsets = [-1, 0, 1];
for (let offset = -2; offset >= -1 - MAXIMUM_CATCH_UP_DAYS; offset--) {
  if (!lastSuccess || lastSuccess >= startOfDay(offset)) break;
  calendarOffsets.unshift(offset);
}

const date = localDate(now);
const dayDirectory = join(home, date);
await mkdir(join(dayDirectory, 'sources'), { recursive: true });
const run = `${JSON.stringify({
  date,
  dayDirectory,
  since: localIso(since),
  until: localIso(now),
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  lastSuccess: lastSuccess ? localIso(lastSuccess) : null,
  calendarDays: calendarOffsets.map((offset) => localDate(startOfDay(offset))),
}, null, 2)}\n`;
// Later steps read the run from here: writing the document moves state.json on, so it cannot be recomputed.
await writeFile(join(dayDirectory, 'start.json'), run);
process.stdout.write(run);
