import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const startScript = resolve('content/skills/morning-brief/scripts/start.mjs');

function localDay(offsetDays: number, hour = 0): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays, hour);
}

function isoDay(offsetDays: number): string {
  const date = localDay(offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function calendarDaysAfter(lastSuccess: Date | undefined): Promise<string[]> {
  const retainedRoot = await mkdtemp(join(tmpdir(), 'mpx-morning-brief-start-'));
  try {
    if (lastSuccess) {
      await mkdir(join(retainedRoot, 'morning-brief'));
      await writeFile(join(retainedRoot, 'morning-brief', 'state.json'), JSON.stringify({ lastSuccess: lastSuccess.toISOString() }));
    }
    const { stdout } = await exec(process.execPath, [startScript], { env: { ...process.env, MPX_AI_RETAINED: retainedRoot }, timeout: 20_000 });
    return JSON.parse(stdout).calendarDays;
  } finally {
    await rm(retainedRoot, { recursive: true, force: true });
  }
}

test('the calendar always covers yesterday, today and tomorrow', async () => {
  const expected = [isoDay(-1), isoDay(0), isoDay(1)];
  assert.deepEqual(await calendarDaysAfter(undefined), expected);
  assert.deepEqual(await calendarDaysAfter(localDay(-1, 6)), expected);
  assert.deepEqual(await calendarDaysAfter(localDay(-2, 6)), expected);
});

test('the calendar adds up to two earlier days no brief covered', async () => {
  assert.deepEqual(await calendarDaysAfter(localDay(-3, 6)), [isoDay(-2), isoDay(-1), isoDay(0), isoDay(1)]);
  assert.deepEqual(await calendarDaysAfter(localDay(-9, 6)), [isoDay(-3), isoDay(-2), isoDay(-1), isoDay(0), isoDay(1)]);
});
