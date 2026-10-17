#!/usr/bin/env node
// Prints the brief's day folder and covered window as JSON, creating the folder.
import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const MAXIMUM_WINDOW_DAYS = 7;

const dump = process.env.MPX_AI_DUMP;
if (!dump || !isAbsolute(dump)) {
  console.error('MPX_AI_DUMP must be set to an absolute path.');
  process.exit(1);
}
const home = join(dump, 'morning-brief');
const now = new Date();
const startOfDay = (offsetDays) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);

let lastSuccess;
try {
  lastSuccess = new Date(JSON.parse(await readFile(join(home, 'state.json'), 'utf8')).lastSuccess);
} catch {
  lastSuccess = undefined;
}
// The window starts at the last brief, but always covers the whole previous day.
let since = startOfDay(-1);
if (lastSuccess && !Number.isNaN(lastSuccess.getTime()) && lastSuccess < since) {
  since = lastSuccess < startOfDay(-MAXIMUM_WINDOW_DAYS) ? startOfDay(-MAXIMUM_WINDOW_DAYS) : lastSuccess;
}

const pad = (value) => String(value).padStart(2, '0');
const localDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const localIso = (date) => {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
};

const date = localDate(now);
const dayDirectory = join(home, date);
await mkdir(join(dayDirectory, 'sources'), { recursive: true });
console.log(JSON.stringify({
  date,
  dayDirectory,
  since: localIso(since),
  until: localIso(now),
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  lastSuccess: lastSuccess && !Number.isNaN(lastSuccess.getTime()) ? localIso(lastSuccess) : null,
}, null, 2));
