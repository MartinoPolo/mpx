import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const triageScript = resolve('content/skills/morning-brief/scripts/triage.mjs');
const idScript = resolve('content/skills/morning-brief/scripts/brief-id.mjs');
const DAY = '2026-11-18';

const IDEAS_NOTE = [
  '## Token burn ideas',
  '- crawl the photo archive',
  '\t- and rename everything',
  '### Media library',
  '- harvest the watch history',
  '',
  '## Inbox',
  '- [ ] check the backup job',
  '- [ ] ',
  '- [x] connect the mail',
  '- [/] started idea',
  '\t- [ ] its own step',
  '- [-] cancelled idea',
  'A paragraph that is no capture.',
  '### [[alfred|Alfred home]]',
  '- tidy the instructions',
  '\t- [ ] first the shared ones',
  '\t\t- then the skills',
  '\t-',
  '\twith a nested paragraph',
  '',
  '- [ ]  ask about orca',
  '#### Weekly brief/automation',
  '- [ ] look at the temp folder',
  '##### Current Priorities ',
  '- keep the job',
  '\t- and its parts',
  '### [[mpx]]',
  '* plain star bullet',
  '  - two spaces',
  '    - four spaces',
  '1. numbered idea',
  '',
].join('\r\n');

type Capture = { id: string; notePath: string; line: string; heading: string[]; task: boolean; hasNested: boolean; nested: { depth: number; text: string }[] };
type Triage = { notes: string[]; captures: Capture[]; leftOut: Record<string, number>; destinations: { notePath: string; headings: string[] }[] };
type TriageRun = { exitCode: number; stdout: string; stderr: string };

async function writeNote(vault: string, notePath: string, noteText: string): Promise<void> {
  await mkdir(dirname(join(vault, notePath)), { recursive: true });
  await writeFile(join(vault, notePath), noteText);
}

async function withVault<Result>(use: (paths: { dayDirectory: string; vault: string }) => Promise<Result>): Promise<Result> {
  const home = await mkdtemp(join(tmpdir(), 'mpx-brief-triage-'));
  const dayDirectory = join(home, 'morning-brief', DAY);
  const vault = join(home, 'vault');
  try {
    await mkdir(join(dayDirectory, 'sources'), { recursive: true });
    await writeFile(join(dayDirectory, 'start.json'), JSON.stringify({ date: DAY, since: '2026-11-17T06:00:00+01:00', until: '2026-11-18T06:00:00+01:00' }));
    await mkdir(vault);
    return await use({ dayDirectory, vault });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function runTriage(dayDirectory: string, vault: string | undefined): Promise<TriageRun> {
  const env = { ...process.env, MPX_OBSIDIAN_VAULT: vault ?? '' };
  try {
    const { stdout, stderr } = await exec(process.execPath, [triageScript, dayDirectory], { env, timeout: 20_000 });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

async function readTriage(dayDirectory: string): Promise<Triage> {
  return JSON.parse(await readFile(join(dayDirectory, 'sources', 'triage.json'), 'utf8')) as Triage;
}

async function capture(notePath: string, line: string, heading: string[], task: boolean, nested: Capture['nested'] = []): Promise<Capture> {
  const { stdout } = await exec(process.execPath, [idScript, 'note', notePath, line], { timeout: 20_000 });
  return { id: stdout.trim(), notePath, line, heading, task, hasNested: nested.length > 0, nested };
}

test('every open top-level list line of Ideas.md and the window\'s daily notes is a capture with its headings and nested lines', async () => {
  await withVault(async ({ dayDirectory, vault }) => {
    await writeNote(vault, 'Ideas.md', IDEAS_NOTE);
    await writeNote(vault, 'Daily/2026-11-16.md', '- before the window\n');
    await writeNote(vault, 'Daily/2026-11-17.md', '---\ntags:\n  - daily\n---\n# Dump\n- call the plumber\n- [X] paid the bill\n');
    await writeNote(vault, 'Daily/2026-11-18.md', '- buy present sam 🔼\n');
    await writeNote(vault, '_Projekty/alfred/alfred.md', '# alfred\n\n## Ideas\n\n## Tasks\n- [ ] an existing task\n');

    const { exitCode, stdout } = await runTriage(dayDirectory, vault);
    assert.equal(exitCode, 0);
    const triage = await readTriage(dayDirectory);
    assert.deepEqual(triage.notes, ['Ideas.md', 'Daily/2026-11-17.md', 'Daily/2026-11-18.md']);
    assert.deepEqual(triage.captures, [
      await capture('Ideas.md', 'check the backup job', ['Inbox'], true),
      await capture('Ideas.md', 'tidy the instructions', ['Inbox', 'Alfred home'], false, [
        { depth: 1, text: '[ ] first the shared ones' },
        { depth: 2, text: 'then the skills' },
        { depth: 1, text: 'with a nested paragraph' },
      ]),
      await capture('Ideas.md', 'ask about orca', ['Inbox', 'Alfred home'], true),
      await capture('Ideas.md', 'look at the temp folder', ['Inbox', 'Alfred home', 'Weekly brief/automation'], true),
      await capture('Ideas.md', 'plain star bullet', ['Inbox', 'mpx'], false, [{ depth: 1, text: 'two spaces' }, { depth: 2, text: 'four spaces' }]),
      await capture('Ideas.md', 'numbered idea', ['Inbox', 'mpx'], false),
      await capture('Daily/2026-11-17.md', 'call the plumber', ['Dump'], false),
      await capture('Daily/2026-11-18.md', 'buy present sam 🔼', [], false),
    ]);
    assert.deepEqual(triage.leftOut, { ticked: 2, started: 1, otherStatus: 1, empty: 1, paragraphs: 1, currentPriorities: 1, tokenBurnIdeas: 2 });
    assert.deepEqual(triage.destinations, [
      { notePath: '_Projekty/alfred/alfred.md', headings: ['Ideas', 'Tasks'] },
      { notePath: 'Ideas.md', headings: ['Token burn ideas'] },
    ]);
    assert.match(stdout, /^8 captures from Ideas\.md, Daily\/2026-11-17\.md, Daily\/2026-11-18\.md in .*triage\.json\n/);
    assert.match(stdout, /Left out: 2 ticked, 1 started, 1 with another status, 1 empty, 1 paragraphs, 1 under Current Priorities, 2 under Token burn ideas\.\n$/);
  });
});

test('a token burn heading written as a wiki link is left out and offered as written, and without one Ideas.md is no destination', async () => {
  await withVault(async ({ dayDirectory, vault }) => {
    await writeNote(vault, 'Ideas.md', '# Ideas\n## [[Token burn ideas]]\n- harvest the receipts\n## Inbox\n- an idea\n');
    assert.equal((await runTriage(dayDirectory, vault)).exitCode, 0);
    const triage = await readTriage(dayDirectory);
    assert.deepEqual(triage.captures.map((entry) => [entry.line, entry.heading]), [['an idea', ['Ideas', 'Inbox']]]);
    assert.deepEqual(triage.destinations, [{ notePath: 'Ideas.md', headings: ['[[Token burn ideas]]'] }]);

    await writeNote(vault, 'Ideas.md', '# Token burn ideas\n- a line under the title\n');
    assert.equal((await runTriage(dayDirectory, vault)).exitCode, 0);
    const titled = await readTriage(dayDirectory);
    assert.deepEqual(titled.destinations, [], 'a note\'s title is no heading to move under');
    assert.equal(titled.leftOut.tokenBurnIdeas, 1);
  });
});

test('without a vault the script names it and writes nothing', async () => {
  await withVault(async ({ dayDirectory, vault }) => {
    for (const missingVault of [undefined, join(vault, 'missing')]) {
      const { exitCode, stderr } = await runTriage(dayDirectory, missingVault);
      assert.equal(exitCode, 1);
      assert.match(stderr, /No Obsidian vault at MPX_OBSIDIAN_VAULT/);
    }
    await assert.rejects(readTriage(dayDirectory));
  });
});
