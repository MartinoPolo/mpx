import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const buildScript = resolve('content/skills/morning-brief/scripts/build.mjs');
const samplePath = resolve('content/skills/morning-brief/templates/brief.sample.json');
const BRIEF_DAY = '2026-10-16';

type Beat = { say: string; note: string; targets?: string[] };
type Chapter = { id: string; type: string; status: string; beats?: Beat[]; apps?: unknown; data?: Record<string, any> };
type Brief = { date: string; process?: { token?: string; account?: string }; chapters: Chapter[] };
type BuildResult = { exitCode: number; stderr: string };

async function sampleBrief(): Promise<Brief> {
  return JSON.parse(await readFile(samplePath, 'utf8'));
}

function chapterOfType(brief: Brief, type: string): Chapter {
  const chapter = brief.chapters.find((candidate) => candidate.type === type);
  assert.ok(chapter, `sample has a ${type} chapter`);
  return chapter;
}

async function withDayDirectory<Result>(use: (dayDirectory: string) => Promise<Result>): Promise<Result> {
  const briefsDirectory = await mkdtemp(join(tmpdir(), 'mpx-morning-brief-'));
  try {
    const dayDirectory = join(briefsDirectory, BRIEF_DAY);
    await mkdir(dayDirectory);
    return await use(dayDirectory);
  } finally {
    await rm(briefsDirectory, { recursive: true, force: true });
  }
}

async function buildDay(dayDirectory: string): Promise<BuildResult> {
  try {
    const { stderr } = await exec(process.execPath, [buildScript, dayDirectory, '--out', join(dayDirectory, 'index.html')], { timeout: 20_000 });
    return { exitCode: 0, stderr };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { exitCode: failure.code ?? -1, stderr: failure.stderr ?? '' };
  }
}

function build(brief: Brief): Promise<BuildResult> {
  return withDayDirectory(async (dayDirectory) => {
    await writeFile(join(dayDirectory, 'brief.json'), JSON.stringify(brief));
    return buildDay(dayDirectory);
  });
}

test('the sample brief builds', async () => {
  const result = await build(await sampleBrief());
  assert.equal(result.exitCode, 0, result.stderr);
});

test('the first build writes a process token back to brief.json and a rebuild keeps it', async () => {
  await withDayDirectory(async (dayDirectory) => {
    const briefPath = join(dayDirectory, 'brief.json');
    const brief = await sampleBrief();
    delete brief.process;
    await writeFile(briefPath, JSON.stringify(brief));

    const firstResult = await buildDay(dayDirectory);
    assert.equal(firstResult.exitCode, 0, firstResult.stderr);
    const firstProcess = (JSON.parse(await readFile(briefPath, 'utf8')) as Brief).process;
    assert.match(firstProcess?.token ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(firstProcess?.account, 'work');
    assert.deepEqual(JSON.parse(await readFile(join(dayDirectory, 'process.json'), 'utf8')), firstProcess);

    const secondResult = await buildDay(dayDirectory);
    assert.equal(secondResult.exitCode, 0, secondResult.stderr);
    const secondProcess = (JSON.parse(await readFile(briefPath, 'utf8')) as Brief).process;
    assert.deepEqual(secondProcess, firstProcess);
    assert.match(await readFile(join(dayDirectory, 'index.html'), 'utf8'), new RegExp(firstProcess!.token!));
  });
});

test('a seeded process is kept in brief.json and written to process.json', async () => {
  await withDayDirectory(async (dayDirectory) => {
    const brief = await sampleBrief();
    brief.process = { token: 'fixed-token', account: 'personal' };
    await writeFile(join(dayDirectory, 'brief.json'), JSON.stringify(brief));

    const result = await buildDay(dayDirectory);
    assert.equal(result.exitCode, 0, result.stderr);
    const keptProcess = (JSON.parse(await readFile(join(dayDirectory, 'brief.json'), 'utf8')) as Brief).process;
    assert.deepEqual(keptProcess, { token: 'fixed-token', account: 'personal' });
    assert.deepEqual(JSON.parse(await readFile(join(dayDirectory, 'process.json'), 'utf8')), { token: 'fixed-token', account: 'personal' });
  });
});

test('a rejected build leaves brief.json untouched and writes no process.json', async () => {
  await withDayDirectory(async (dayDirectory) => {
    const briefPath = join(dayDirectory, 'brief.json');
    const brief = await sampleBrief();
    delete brief.process;
    chapterOfType(brief, 'instructions').data!.counts.push({ scope: 'mpx', text: 'no id' });
    const briefText = JSON.stringify(brief);
    await writeFile(briefPath, briefText);

    const result = await buildDay(dayDirectory);
    assert.equal(result.exitCode, 1);
    assert.equal(await readFile(briefPath, 'utf8'), briefText);
    await assert.rejects(access(join(dayDirectory, 'process.json')), { code: 'ENOENT' });
  });
});

test('an unknown process account is rejected', async () => {
  const brief = await sampleBrief();
  brief.process = { account: 'home' };
  const result = await build(brief);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /process\.account must be one of personal, work/);
});

test('action parameters need a known type, and a select needs options', async () => {
  const brief = await sampleBrief();
  const [firstAction, secondAction] = chapterOfType(brief, 'actions').data!.items;
  firstAction.parameters = [{ id: 'when', label: 'When', type: 'date' }];
  secondAction.parameters = [{ id: 'channel', label: 'Channel', type: 'select' }, { id: 'note', type: 'text' }];
  const result = await build(brief);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, new RegExp(`action "${firstAction.id}" parameter "when": type must be one of select, text, textarea`));
  assert.match(result.stderr, new RegExp(`action "${secondAction.id}" parameter "channel": a select needs options, each with value and label`));
  assert.match(result.stderr, new RegExp(`action "${secondAction.id}" parameter "note": id and label are required`));
});

test('a select value must be one of its options, and parameter ids and option values must be unique', async () => {
  const brief = await sampleBrief();
  const [firstAction, secondAction] = chapterOfType(brief, 'actions').data!.items;
  const options = [{ value: 'thread', label: 'Thread' }, { value: 'thread', label: 'Thread again' }];
  firstAction.parameters = [{ id: 'channel', label: 'Channel', type: 'select', value: 'email', options: [{ value: 'thread', label: 'Thread' }] }];
  secondAction.parameters = [{ id: 'channel', label: 'Channel', type: 'select', options }, { id: 'channel', label: 'Again', type: 'text' }];
  const result = await build(brief);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, new RegExp(`action "${firstAction.id}" parameter "channel": value "email" must be one of its options`));
  assert.match(result.stderr, new RegExp(`action "${secondAction.id}" parameter "channel": option values must be unique`));
  assert.match(result.stderr, new RegExp(`action "${secondAction.id}" parameter "channel": id must be unique within the action`));
});

test('a null parameter entry is rejected without a crash', async () => {
  const brief = await sampleBrief();
  const [firstAction] = chapterOfType(brief, 'actions').data!.items;
  firstAction.parameters = [null];
  const result = await build(brief);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, new RegExp(`action "${firstAction.id}" parameters\\[0\\]: must be an object`));
  assert.doesNotMatch(result.stderr, /TypeError/);
});

test('chapter apps need app and url, a known scope and no other keys', async () => {
  const brief = await sampleBrief();
  chapterOfType(brief, 'calendar').apps = [
    { app: 'googlecalendar', scope: 'home', url: 'https://calendar.google.com/' },
    { app: 'googlecalendar', scope: 'work' },
    { app: 'googlecalendar', url: 'https://calendar.google.com/', label: 'Calendar' },
    null,
  ];
  chapterOfType(brief, 'slack').apps = { app: 'slack', url: 'https://example.slack.com/' };
  const result = await build(brief);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /chapters\[0\] \(calendar\) apps\[0\]: scope must be one of personal, work/);
  assert.match(result.stderr, /chapters\[0\] \(calendar\) apps\[1\]: app and url are required/);
  assert.match(result.stderr, /chapters\[0\] \(calendar\) apps\[2\]: unknown key label; use app, scope and url/);
  assert.match(result.stderr, /chapters\[0\] \(calendar\) apps\[3\]: must be an object/);
  assert.match(result.stderr, /\(slack\): apps must be an array/);
  assert.doesNotMatch(result.stderr, /TypeError/);
});

test('exactly two instruction highlights build', async () => {
  const brief = await sampleBrief();
  const instructions = chapterOfType(brief, 'instructions').data!;
  instructions.highlights = ['first', 'second'].map((id) => ({ id, scope: 'mpx', summary: `Change ${id}` }));
  const result = await build(brief);
  assert.equal(result.exitCode, 0, result.stderr);
});

test('an instructions entry without an id is rejected', async () => {
  const brief = await sampleBrief();
  chapterOfType(brief, 'instructions').data!.highlights.push({ scope: 'mpx', summary: 'Change without id' });
  const result = await build(brief);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /instructions: every skill, highlight and count needs an id/);
});

test('more than two instruction highlights are rejected', async () => {
  const brief = await sampleBrief();
  const instructions = chapterOfType(brief, 'instructions').data!;
  instructions.highlights = ['first', 'second', 'third'].map((id) => ({ id, scope: 'mpx', summary: `Change ${id}` }));
  const result = await build(brief);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /instructions: at most 2 highlights/);
});

test('a meeting today on my calendar must be narrated; one on a reader calendar need not be', async () => {
  const unnarrated = await sampleBrief();
  const calendar = chapterOfType(unnarrated, 'calendar');
  calendar.beats = calendar.beats!.filter((beat) => !beat.targets?.includes('event-accountant'));
  const unnarratedResult = await build(unnarrated);
  assert.equal(unnarratedResult.exitCode, 1);
  assert.match(unnarratedResult.stderr, /calendar event "accountant" \(Tax return call with Dana\)/);

  const shared = await sampleBrief();
  const sharedCalendar = chapterOfType(shared, 'calendar');
  sharedCalendar.data!.calendars.push({ id: 'partner', name: 'Alex', account: 'personal', access: 'reader', color: '#e67c73' });
  sharedCalendar.data!.events.push({ id: 'alex-review', calendarId: 'partner', day: BRIEF_DAY, start: '10:00', end: '11:00', title: 'Design review', attendees: 4 });
  const sharedResult = await build(shared);
  assert.equal(sharedResult.exitCode, 0, sharedResult.stderr);
});
