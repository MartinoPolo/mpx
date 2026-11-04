import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const buildScript = resolve('content/skills/morning-brief/scripts/build.mjs');
const samplePath = resolve('content/skills/morning-brief/templates/brief.sample.json');
const BRIEF_DAY = '2026-10-16';

type Teaser = { id?: string; kind?: string; question?: string; answer?: string };
type Beat = { say: string; note: string; targets?: string[] };
type Chapter = { id: string; type: string; status: string; beats?: Beat[]; data?: Record<string, any> };
type Brief = { date: string; chapters: Chapter[] };
type BuildResult = { exitCode: number; stderr: string };

async function sampleBrief(): Promise<Brief> {
  return JSON.parse(await readFile(samplePath, 'utf8'));
}

function chapterOfType(brief: Brief, type: string): Chapter {
  const chapter = brief.chapters.find((candidate) => candidate.type === type);
  assert.ok(chapter, `sample has a ${type} chapter`);
  return chapter;
}

function teasersOf(brief: Brief): Teaser[] {
  return chapterOfType(brief, 'teasers').data!.items;
}

function briefWithTeasers(teasers: Teaser[]): Promise<Brief> {
  return sampleBrief().then((brief) => {
    chapterOfType(brief, 'teasers').data!.items = teasers;
    return brief;
  });
}

// Writes the brief into a dated day folder beside sibling folders (string contents are written raw) and builds it.
async function build(brief: Brief, siblings: Record<string, Brief | string | null> = {}): Promise<BuildResult> {
  const briefsDirectory = await mkdtemp(join(tmpdir(), 'mpx-morning-brief-'));
  try {
    for (const [folder, contents] of Object.entries({ ...siblings, [BRIEF_DAY]: brief })) {
      await mkdir(join(briefsDirectory, folder));
      if (contents !== null) await writeFile(join(briefsDirectory, folder, 'brief.json'), typeof contents === 'string' ? contents : JSON.stringify(contents));
    }
    const dayDirectory = join(briefsDirectory, BRIEF_DAY);
    try {
      const { stderr } = await exec(process.execPath, [buildScript, dayDirectory, '--out', join(dayDirectory, 'index.html')], { timeout: 20_000 });
      return { exitCode: 0, stderr };
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      return { exitCode: failure.code ?? -1, stderr: failure.stderr ?? '' };
    }
  } finally {
    await rm(briefsDirectory, { recursive: true, force: true });
  }
}

test('the sample brief builds', async () => {
  const result = await build(await sampleBrief());
  assert.equal(result.exitCode, 0, result.stderr);
});

test('a teaser repeated from an earlier day fails and names the latest earlier day', async () => {
  const brief = await sampleBrief();
  const earlier = await sampleBrief();
  const [firstTeaser] = teasersOf(earlier);
  firstTeaser!.question = `  ${firstTeaser!.question!.toUpperCase().replace(/\. /g, '!  ').replace(/\?$/, '')}`;
  const result = await build(brief, { '2026-10-10': earlier, '2026-10-14': earlier });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /teaser "bat-ball": the question already ran on 2026-10-14/);
});

test('later, same-date, non-date and unreadable folders do not reject teasers', async () => {
  const brief = await sampleBrief();
  const result = await build(brief, {
    '2026-10-20': brief,
    archive: brief,
    '2026-10-11': null,
    '2026-10-12': '{ not json',
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stderr, /warning: teasers from 2026-10-12 were not checked/);
  assert.doesNotMatch(result.stderr, /2026-10-11/);
});

test('math questions that differ only by operator or decimal point are different questions', async () => {
  const earlier = await briefWithTeasers([
    { id: 'sum', kind: 'math', question: 'What is 12 + 7?', answer: '19' },
    { id: 'number', kind: 'logic', question: 'What is 127?', answer: '127' },
  ]);
  const brief = await sampleBrief();
  teasersOf(brief)[0]!.question = 'What is 12 × 7?';
  teasersOf(brief)[1]!.question = 'What is 1.27?';
  const result = await build(brief, { '2026-10-15': earlier });
  assert.equal(result.exitCode, 0, result.stderr);
});

test('teaser items are validated within the brief', async () => {
  const brief = await briefWithTeasers([
    { id: 'first', kind: 'math', question: 'What is 2 + 2?', answer: '4' },
    { id: 'first', kind: 'logic', question: 'Which comes first?', answer: 'The egg' },
    { id: 'third', kind: 'Math', question: 'What is 3 + 3?', answer: '6' },
    { id: 'fourth', kind: 'riddle', question: 'what is 2 + 2', answer: '' },
  ]);
  const result = await build(brief);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /exactly 3 items are required, found 4/);
  assert.match(result.stderr, /each item needs a different id/);
  assert.match(result.stderr, /each item needs a different kind/);
  assert.match(result.stderr, /each item needs a different question/);
  assert.match(result.stderr, /teaser "fourth": id, kind, question and answer are required/);
});

test('a quiet teasers chapter skips teaser validation', async () => {
  const brief = await briefWithTeasers([]);
  const teasers = chapterOfType(brief, 'teasers');
  teasers.status = 'quiet';
  teasers.beats = [];
  const result = await build(brief);
  assert.equal(result.exitCode, 0, result.stderr);
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
  sharedCalendar.data!.events.push({ id: 'alex-review', calendarId: 'partner', day: 'today', start: '10:00', end: '11:00', title: 'Design review', attendees: 4 });
  const sharedResult = await build(shared);
  assert.equal(sharedResult.exitCode, 0, sharedResult.stderr);
});
