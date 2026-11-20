import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fakeVoiceStudio, narrate } from './morning-brief-voice-studio.js';

const exec = promisify(execFile);
const documentScript = resolve('content/skills/morning-brief/scripts/daily-brief.mjs');
const startScript = resolve('content/skills/morning-brief/scripts/start.mjs');
const triageScript = resolve('content/skills/morning-brief/scripts/triage.mjs');
const idScript = resolve('content/skills/morning-brief/scripts/brief-id.mjs');
const DAY = '2026-11-18';
const PERMALINK = 'https://example.slack.com/archives/C1/p1794779220000100?thread_ts=1794779220.000100&cid=C1';
const APP_DIRECTORY = process.env.MPX_PROJECTS ? join(process.env.MPX_PROJECTS, 'alfred-control-center') : '';
const RENDER_SESSION_ID = '6f1c2a9e-0b3d-4c7e-9a41-2d6f8e7b1c90';
const RENDER_LOG_LINK = { label: 'Render log', link: 'file:///C:/render.log' };
const RENDER_FRAME_LINK = { label: 'Last frame', link: 'file:///C:/out/frame 6.png' };

type BriefDocument = { sources: { name: string; status: string; reason: string | null }[]; chapters: Record<string, any> };
type Fixture = { home: string; dayDirectory: string; vault: string; data: string };
type DocumentRun = { exitCode: number; stdout: string; document: BriefDocument };

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

function personalSource() {
  return {
    status: 'ok',
    data: {
      account: 'me@example.com',
      calendars: [
        { id: 'me@example.com', name: 'me', access: 'owner', primary: true },
        { id: 'partner@example.com', name: 'Partner', access: 'reader' },
        { id: 'holidays', name: 'Holidays', access: 'reader' },
        { id: 'work@example.com', name: 'work', access: 'freeBusy' },
      ],
      events: [
        { id: 'dentist', calendarId: 'me@example.com', day: '2026-11-18', start: '17:30', end: '18:15', allDay: false, title: 'Dentist', place: 'Main street 12', url: 'https://calendar.example/dentist' },
        { id: 'standup', calendarId: 'work@example.com', day: '2026-11-18', start: '09:50', end: '10:00', allDay: false, title: '', busyOnly: true, url: 'https://calendar.example/busy' },
        { id: 'train', calendarId: 'me@example.com', day: '2026-11-17', start: '23:00', end: '01:00', allDay: false, title: 'Night train', place: '' },
        { id: 'name-day', calendarId: 'partner@example.com', day: '2026-11-19', allDay: true, title: 'Name day' },
        { id: 'holiday', calendarId: 'holidays', day: '2026-11-17', allDay: true, title: 'Holiday' },
        { id: 'later', calendarId: 'me@example.com', day: '2026-11-25', start: '10:00', end: '11:00', title: 'Outside the calendar days' },
      ],
      mail: [
        { id: 'thread-vat', messageId: 'message-vat-2', class: 'act', from: 'Accountant', fromAddress: 'accountant@example.com', otherRecipients: ['Partner Name <partner@example.com>'], subject: 'VAT draft', snippet: 'Please approve by Friday', received: '2026-11-17T20:12:00+01:00', url: 'https://mail.google.com/mail/u/me@example.com/#all/thread-vat' },
        { id: 'thread-parcel', class: 'fyi', from: 'Shop', subject: 'Your parcel shipped', received: '2026-11-17T10:00:00+01:00' },
      ],
      quiet: [{ from: 'Strava', subject: 'Weekly summary', received: '2026-11-17T19:00:00+01:00' }],
    },
  };
}

function workSource() {
  return {
    status: 'ok',
    data: {
      account: 'me@work.example',
      slack: {
        directed: [
          { channel: '#release', author: 'Tom', when: '2026-11-17T22:47:00+01:00', text: 'Can the freeze move to Wednesday?', summary: 'Move the freeze', answered: false, repliers: ['Ann'], reactions: [{ emoji: '👍', users: ['Ann'] }], url: PERMALINK },
          { channel: 'Direct message', author: 'Petra', when: '2026-11-17T18:05:00+01:00', text: 'Thanks for the review', answered: true, url: 'https://example.slack.com/archives/D1/p1794762300000200' },
        ],
        interesting: [{ channel: '#devel', author: 'Hermes', when: '2026-11-17T18:56:38+01:00', text: 'Feature tests failed', url: '' }],
        skipped: 12,
      },
      mail: [],
      alerts: [{ kind: 'sentry', project: 'web', title: 'TypeError in checkout', count: 2, first: '2026-11-17T02:56:02+01:00', last: '2026-11-18T03:11:08+01:00', resolved: false, url: 'https://mail.google.com/mail/u/me@work.example/#all/alert-1' }],
      calendars: [{ id: 'work@example.com', name: 'work', access: 'owner', primary: true }],
      events: [{ id: 'standup', calendarId: 'work@example.com', day: '2026-11-18', start: '09:50', end: '10:00', allDay: false, title: 'Standup', place: 'Zoom', url: 'https://calendar.example/standup', attendees: 3 }],
    },
  };
}

function sessionBrief() {
  return {
    projects: [{ id: 'videolab', name: 'videoLab' }],
    chapters: [
      { type: 'overnight', data: { runs: [
        { project: 'videolab', outcome: 'fail', title: 'Proxy render', startedAt: '2026-11-18T03:10:00+01:00', endedAt: '2026-11-18T04:15:00+01:00', logTail: ['Disk D is full'], url: 'file:///C:/render.log',
          sessionId: RENDER_SESSION_ID, links: [RENDER_LOG_LINK, { label: ' ', link: 'https://example.com/unlabelled' }, { label: 'Frames', link: 'not a link' }, 'file:///C:/bare.png', RENDER_FRAME_LINK] },
        { project: 'videolab', outcome: 'partial', title: 'Staging', startedAt: '2026-11-17T23:30:00+01:00', session: 'C:/sessions/2026-11-17T22-00-00-000Z_staging-session.jsonl' },
        { project: 'videolab', outcome: 'partial', title: 'Migration', startedAt: '2026-11-18T01:00:00+01:00', endedAt: '2026-11-18T02:40:00+01:00', session: 'orca-automation-run-17' },
        { project: 'videolab', outcome: 'ok', title: 'No start time' },
      ] } },
      { type: 'work', data: { projects: [
        { id: 'mpx', name: 'mpx', app: 'github', cards: [
          { ref: '#218', title: 'Skill palette aliases', state: 'ready', url: 'https://github.com/owner/mpx/pull/218', pipeline: { status: 'success' } },
          { ref: '#219', title: 'Work in progress', state: 'draft', url: 'https://github.com/owner/mpx/pull/219' },
          { ref: '#216', title: 'Changelog skips merge commits', state: 'merged', url: 'https://github.com/owner/mpx/pull/216' },
        ] },
        { id: 'platform', name: 'platform', app: 'gerrit', cards: [{ ref: '4711', title: 'Fix', state: 'review', url: 'https://gerrit.example/c/4711' }] },
      ] } },
    ],
  };
}

function repository(name: string, active: boolean, host: string, fullName: string) {
  return { name, domain: 'personal', active, changedInWindow: false, remote: { forge: host === 'github.com' ? 'github' : 'gitlab', host, fullName, web: `https://${host}/${fullName}` } };
}

function repositoriesSource() {
  return {
    since: new Date(2026, 10, 17, 6).toISOString(),
    activeSince: new Date(2026, 9, 19, 6).toISOString(),
    repositories: [
      repository('mpx', true, 'github.com', 'owner/mpx'),
      repository('ui-components', true, 'gitlab.example.com', 'ui'),
      repository('grovekeeper', false, 'github.com', 'owner/grovekeeper'),
    ],
  };
}

async function withFixture<Result>(use: (fixture: Fixture) => Promise<Result>): Promise<Result> {
  const home = await mkdtemp(join(tmpdir(), 'mpx-daily-brief-'));
  const fixture: Fixture = { home, dayDirectory: join(home, 'work', 'morning-brief', DAY), vault: join(home, 'vault'), data: join(home, 'data') };
  try {
    await writeJson(join(fixture.dayDirectory, 'start.json'), {
      date: DAY,
      since: new Date(2026, 10, 17, 6).toISOString(),
      until: new Date(2026, 10, 18, 6).toISOString(),
      calendarDays: ['2026-11-17', '2026-11-18', '2026-11-19'],
    });
    await writeJson(join(fixture.dayDirectory, 'sources', 'personal.json'), personalSource());
    await writeJson(join(fixture.dayDirectory, 'sources', 'work.json'), workSource());
    await writeJson(join(fixture.dayDirectory, 'sources', 'repos.json'), repositoriesSource());
    await writeJson(join(fixture.dayDirectory, 'brief.json'), sessionBrief());
    await writeJson(join(home, 'work', 'bookmarks', 'capture.json'), {
      syncedAt: '2026-11-18T05:00:00Z',
      bookmarks: [
        { id: '1001', title: 'Headlamp', url: 'https://shop.example/headlamp' },
        { id: '1002', title: 'Calm article', url: 'https://blog.example/calm' },
      ],
    });
    await mkdir(join(fixture.vault, 'Daily'), { recursive: true });
    await writeFile(join(fixture.vault, 'Daily', '2026-11-18.md'), '# Dump\n\n- [ ] buy present sam 🔼\n- [x] Book the winter tyres\n- what would a weekly brief need?\n- [/] Started already\n- call the plumber\n');
    await mkdir(join(fixture.vault, '_Projekty', 'alfred'), { recursive: true });
    await writeFile(join(fixture.vault, '_Projekty', 'alfred', 'alfred.md'), '# alfred\n\n## Ideas\n\n## Tasks\n- [ ] an existing task\n');
    await mkdir(fixture.data);
    await runTriage(fixture);
    return await use(fixture);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function runTriage(fixture: Fixture): Promise<void> {
  await exec(process.execPath, [triageScript, fixture.dayDirectory], { env: { ...process.env, MPX_OBSIDIAN_VAULT: fixture.vault }, timeout: 20_000 });
}

async function runDocument(fixture: Fixture, projectsRoot = join(fixture.home, 'projects'), ...flags: string[]): Promise<DocumentRun> {
  const env = { ...process.env, MPX_OBSIDIAN_VAULT: fixture.vault, ALFRED_CONTROL_CENTER_DATA: fixture.data, MPX_PROJECTS: projectsRoot };
  let exitCode = 0;
  let stdout = '';
  try {
    ({ stdout } = await exec(process.execPath, [documentScript, fixture.dayDirectory, ...flags], { env, timeout: 150_000 }));
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    exitCode = failure.code ?? -1;
    stdout = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
  }
  const document = JSON.parse(await readFile(join(fixture.dayDirectory, 'daily-brief.json'), 'utf8')) as BriefDocument;
  return { exitCode, stdout, document };
}

async function idOf(kind: string, ...referenceParts: string[]): Promise<string> {
  const { stdout } = await exec(process.execPath, [idScript, kind, ...referenceParts], { timeout: 20_000 });
  return stdout.trim();
}

function mailbox(document: BriefDocument, id: string) {
  return document.chapters.mail.mailboxes.find((candidate: { id: string }) => candidate.id === id);
}

async function judgement() {
  const vatId = await idOf('mail', 'thread-vat');
  const presentId = await idOf('note', 'Daily/2026-11-18.md', 'buy present sam 🔼');
  const weeklyId = await idOf('note', 'Daily/2026-11-18.md', 'what would a weekly brief need?');
  return {
    vatId,
    presentId,
    weeklyId,
    judgement: {
      calendars: { 'partner@example.com': 'wife' },
      calendarNames: { wife: 'Kája' },
      mailboxes: [{ id: 'centrum', label: 'Centrum', provider: 'centrum', account: 'me@centrum.example' }],
      options: { [vatId]: [{ kind: 'reply', gist: 'Approve it', to: 'Accountant', subject: 'Re: VAT draft', body: 'Looks right, please file it.', attachments: [] }, { kind: 'snooze' }] },
      notes: {
        [presentId]: { action: 'move', destination: { notePath: '_Projekty/alfred/alfred.md', heading: 'Tasks' }, wording: 'Buy a birthday present for Sam', priority: 4 },
        [weeklyId]: { action: 'research', wording: 'What should a weekly brief show that the daily one does not?', because: 'Reads as brainstorming' },
      },
      bookmarks: { 1001: { kind: 'shop', suggestion: { action: 'move', destination: 'mine', because: 'Looked at it twice' } } },
      wishlists: [{ id: 'mine', label: 'My wishlist' }],
      reminders: [
        { title: 'November invoice', reason: 'Invoice case: due every month', link: 'file:///C:/home/state/invoice.md', due: '2026-11-25' },
        { title: 'Answer the freeze question', reason: 'Slack, Tom: asked last night', link: PERMALINK, due: null },
        { title: 'Plan the weekly brief', reason: 'Alfred note: open idea', link: 'obsidian://open?vault=Vault&file=_Projekty%2Falfred%2Falfred', due: null },
      ],
      narration: {
        calendar: [{ text: 'Today the stand-up, then the dentist.', targets: ['2026-11-18'] }],
        mail: [{ text: 'Approve the VAT draft.', targets: [vatId] }, { text: 'Centrum was not read.', targets: ['centrum'] }],
      },
    },
  };
}

test('item ids are a stable hash of the kind and source reference', async () => {
  const first = await idOf('mail', 'thread-1');
  assert.match(first, /^mail-[0-9a-f]{12}$/);
  assert.equal(await idOf('mail', 'thread-1'), first);
  assert.notEqual(await idOf('mail', 'thread-2'), first);
  assert.notEqual(await idOf('slack', 'thread-1'), first);
  assert.notEqual(await idOf('note', 'Ideas.md', 'a b'), await idOf('note', 'Ideas.md a', 'b'));
});

test('the document maps gathered data to the contract before any judgement', async () => {
  await withFixture(async (fixture) => {
    const { exitCode, stdout, document } = await runDocument(fixture);
    assert.equal(exitCode, 2, 'no app repository means the document is not validated');
    assert.match(stdout, /Not validated: no app repository/);
    assert.match(stdout, /No outcome from the app yet\./);

    const calendar = document.chapters.calendar;
    assert.deepEqual(calendar.calendars, [{ id: 'work', name: 'Work' }, { id: 'personal', name: 'Personal' }]);
    assert.deepEqual(calendar.days.map((day: { date: string }) => day.date), ['2026-11-17', '2026-11-18', '2026-11-19']);
    const [yesterday, today, tomorrow] = calendar.days;
    assert.deepEqual(yesterday, { date: '2026-11-17', allDay: [], events: [{ start: '23:00', end: '24:00', title: 'Night train', calendar: 'personal', place: null, link: null }] });
    assert.deepEqual(today.events.map((event: { title: string; calendar: string; place: string | null }) => [event.title, event.calendar, event.place]),
      [['Standup', 'work', 'Zoom'], ['Dentist', 'personal', 'Main street 12']]);
    assert.deepEqual(tomorrow, { date: '2026-11-19', allDay: [], events: [] });

    assert.deepEqual(document.chapters.mail.mailboxes.map((entry: { id: string }) => entry.id), ['personal', 'work']);
    const personal = mailbox(document, 'personal');
    assert.equal(personal.account, 'me@example.com');
    assert.equal(personal.transport, 'connector');
    assert.deepEqual(personal.items.map((item: { id: string; threadId: string; messageId: string | null; snippet: string; options: unknown }) => [item.id, item.threadId, item.messageId, item.snippet, item.options]),
      [[await idOf('mail', 'thread-vat'), 'thread-vat', 'message-vat-2', 'Please approve by Friday', [{ kind: 'snooze' }]]]);
    assert.deepEqual(personal.quiet.map((message: { from: string }) => message.from), ['Shop', 'Strava']);
    const [alert] = mailbox(document, 'work').items;
    assert.deepEqual([alert.id, alert.from, alert.subject, alert.receivedAt, alert.messageId, alert.options], [await idOf('mail', 'alert-1'), 'Sentry', 'TypeError in checkout', '2026-11-18T03:11:08+01:00', null, [{ kind: 'seen' }]]);

    const slack = document.chapters.slack;
    assert.equal(slack.items.length, 1);
    assert.equal(slack.items[0].permalink, PERMALINK);
    assert.equal(slack.items[0].id, await idOf('slack', PERMALINK));
    assert.deepEqual([slack.items[0].repliers, slack.items[0].reactions], [['Ann'], [{ emoji: '👍', users: ['Ann'] }]]);
    assert.deepEqual(slack.handled.map((post: { author: string }) => post.author), ['Petra']);
    assert.equal(slack.skippedCount, 12);
    assert.match(stdout, /Slack message from Hermes in #devel has no permalink/);

    const code = document.chapters.code;
    assert.deepEqual(code.items.map((item: { id: string; reference: { label: string } }) => [item.id, item.reference.label]), [[await idOf('code', 'https://github.com/owner/mpx/pull/218', 'ready'), '#218']]);
    assert.equal(code.items[0].options[0].execution.kind, 'merge');
    assert.deepEqual(code.items[0].chips, [{ label: 'approved', tone: 'good' }, { label: 'checks', tone: 'good' }]);
    assert.deepEqual(code.merged.map((change: { reference: { label: string } }) => change.reference.label), ['#216']);
    assert.match(stdout, /platform: gerrit changes are left out/);

    const [render, staging, migration] = document.chapters.agents.items;
    assert.deepEqual([render.id, render.projectName, render.outcome, render.logTail], [await idOf('agent', 'file:///C:/render.log'), 'videoLab', 'failed', ['Disk D is full']]);
    assert.deepEqual([render.startedAt, render.endedAt], ['2026-11-18T03:10:00+01:00', '2026-11-18T04:15:00+01:00']);
    assert.deepEqual([render.link, render.sessionId, render.links], ['file:///C:/render.log', RENDER_SESSION_ID, [RENDER_LOG_LINK, RENDER_FRAME_LINK]]);
    assert.match(stdout, /Overnight run "Proxy render" has 3 links without a label or a valid address; left out\./);
    assert.equal(staging.id, await idOf('agent', 'C:/sessions/2026-11-17T22-00-00-000Z_staging-session.jsonl'));
    assert.deepEqual([staging.sessionId, staging.links], ['staging-session', []], 'without a sessionId, the id comes from the transcript name');
    assert.deepEqual([migration.sessionId, migration.links], [null, []], 'an automation run has no session id');
    assert.deepEqual([staging.outcome, staging.endedAt], ['running', null], 'a partial run without an end is still running');
    assert.deepEqual([migration.outcome, migration.endedAt], ['blocked', '2026-11-18T02:40:00+01:00'], 'a partial run that ended stopped short');
    assert.equal(document.chapters.agents.items.length, 3);
    assert.match(stdout, /Overnight run "No start time" has no known outcome or no startedAt instant; left out\./);

    const capture = document.chapters.capture;
    assert.deepEqual(capture.notes, await Promise.all(['buy present sam 🔼', 'what would a weekly brief need?', 'call the plumber'].map(async (lineText) => ({
      id: await idOf('note', 'Daily/2026-11-18.md', lineText), notePath: 'Daily/2026-11-18.md', lineText, heading: ['Dump'], nested: [],
      suggestion: { action: 'keep', destination: null, wording: null, priority: null, because: null, link: null },
    }))), 'every open line triage.mjs lists, without the ticked and started ones');
    assert.doesNotMatch(stdout, /has no messageId/, 'a mail without a reply needs no messageId');
    assert.deepEqual(capture.bookmarks, []);
    assert.match(stdout, /Bookmarks without judgement:\n {2}1001 {2}Headlamp/);
    assert.match(stdout, new RegExp(`Items without judgement[^\\n]*:\\n {2}mail personal:\\n {4}${await idOf('mail', 'thread-vat')} {2}Accountant: VAT draft {2}\\[default: Snooze\\]\\n {2}mail work:\\n {4}mail-[0-9a-f]{12} {2}Sentry: TypeError in checkout {2}\\[default: Dismiss\\]\\n`));
    assert.match(stdout, / {4}code-[0-9a-f]{12} {2}mpx #218 Skill palette aliases {2}\[default: Merge\]\n/);
    assert.match(stdout, /\n {2}capture notes:\n {4}note-[0-9a-f]{12} {2}buy present sam 🔼 {2}\[under Dump\] {2}\[default: keep\]\n/);
    assert.match(stdout, /Summary: 10 items and 2 bookmarks without judgement; 0 narration sentences without a clip; the document is not valid\. No narration: calendar, mail, slack, code, agents, capture, projects, plan, health\.\n?$/);
    assert.ok(document.sources.every((source) => source.status === 'read'));
  });
});

test('the judgement adds options, suggestions, bookmarks, mailboxes without a connector and narration', async () => {
  await withFixture(async (fixture) => {
    const before = await runDocument(fixture);
    const { vatId, presentId, weeklyId, judgement: sessionJudgement } = await judgement();
    const calendarNarration = [
      ...sessionJudgement.narration.calendar,
      { text: 'Tomorrow is empty.', targets: ['2026-11-19'] },
      { text: 'Yesterday ended on the night train.', targets: ['2026-11-17'] },
    ];
    await writeJson(join(fixture.dayDirectory, 'daily-brief.judgement.json'), {
      ...sessionJudgement,
      narration: {
        ...sessionJudgement.narration,
        calendar: calendarNarration,
        slack: [{ text: 'Nothing waits.', targets: ['slack-unknown'] }],
        triage: [{ text: 'Three captures.', targets: [] }],
      },
    });
    const { stdout, document } = await runDocument(fixture);

    assert.deepEqual(document.chapters.calendar.narration, calendarNarration.slice(0, 2), 'a chapter keeps its first two sentences');
    assert.match(stdout, /calendar narration has 3 sentences; kept the first two, cut "Yesterday ended on the night train\."/);
    assert.match(stdout, /The judgement narrates chapters the document does not have: triage\./);
    assert.deepEqual(document.chapters.capture.notes.find((note: { id: string }) => note.id === weeklyId).suggestion.action, 'research');
    assert.match(stdout, /Summary: 7 items and 1 bookmark without judgement; 5 narration sentences without a clip; the document is not valid\. No narration: code, agents, capture, projects, plan, health\./);

    assert.deepEqual(document.chapters.calendar.calendars.at(-1), { id: 'wife', name: 'Kája' });
    assert.deepEqual(document.chapters.calendar.days[2].allDay, [{ title: 'Name day', calendar: 'wife', link: null }]);
    const [vatReply, vatSnooze] = sessionJudgement.options[vatId] ?? [];
    assert.deepEqual(mailbox(document, 'personal').items[0].options, [{ ...vatReply, to: 'Accountant <accountant@example.com>' }, vatSnooze]);
    assert.deepEqual(mailbox(document, 'centrum'), {
      id: 'centrum', label: 'Centrum', provider: 'centrum', account: 'me@centrum.example', transport: 'imap', canSend: false,
      status: 'not-read', reason: 'Not read yet: its password needs your Windows Hello approval, so Start reads it at the desk.', items: [], quiet: [],
    });
    assert.ok(document.sources.some((source) => source.name === 'Centrum mail' && source.status === 'not-read'));
    const presentNote = document.chapters.capture.notes.find((note: { id: string }) => note.id === presentId);
    assert.deepEqual(presentNote.suggestion, sessionJudgement.notes[presentId]);
    assert.deepEqual(document.chapters.capture.bookmarks, [{ id: await idOf('bookmark', '1001'), bookmarkId: '1001', kind: 'shop', suggestion: sessionJudgement.bookmarks[1001].suggestion, csfd: null }]);
    assert.deepEqual(document.chapters.plan.reminders, sessionJudgement.reminders);
    assert.deepEqual(document.chapters.mail.narration, sessionJudgement.narration.mail);
    assert.match(stdout, /slack narration targets nothing on the page: slack-unknown/);
    assert.doesNotMatch(stdout, /mail narration targets nothing/);

    const itemIds = (run: BriefDocument) => ['slack', 'code', 'agents'].flatMap((name) => run.chapters[name].items.map((item: { id: string }) => item.id));
    assert.deepEqual(itemIds(document), itemIds(before.document), 'a rebuilt document keeps its ids');
  });
});

test('the report lists move destinations and the capture suggestions the app would refuse, and is kept in the log', async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.vault, 'Daily', '2026-11-18.md'),
      '# Dump\n\n- [ ] buy present sam 🔼\n- idea with details\n\t- a detail\n- plain and resolved\n- plain and judged done\n- crawl every receipt\n');
    await writeFile(join(fixture.vault, 'Ideas.md'), '## Token burn ideas\n- harvest the old photos\n');
    await runTriage(fixture);
    const noteId = (line: string) => idOf('note', 'Daily/2026-11-18.md', line);
    const resolvedSuggestion = { action: 'delete', because: 'Done yesterday' };
    const tokenBurnMove = { action: 'move', destination: { notePath: 'Ideas.md', heading: 'Token burn ideas' }, priority: 2, because: 'Token burn candidate: crawls every mailbox' };
    await writeJson(join(fixture.dayDirectory, 'sources', 'triage-judgement.json'), {
      [await noteId('plain and resolved')]: resolvedSuggestion,
      [await noteId('crawl every receipt')]: tokenBurnMove,
      [await noteId('plain and judged done')]: { action: 'delete', because: 'Replaced by the judgement' },
    });
    await writeJson(join(fixture.dayDirectory, 'daily-brief.judgement.json'), {
      notes: {
        [await noteId('buy present sam 🔼')]: { action: 'move', destination: { notePath: '_Projekty/alfred/alfred.md', heading: 'Someday' }, priority: 3 },
        [await noteId('idea with details')]: { action: 'delete', because: 'Stale' },
        [await noteId('plain and judged done')]: { action: 'done', because: 'Finished' },
      },
      narration: { plan: [{ text: 'The invoice first.', targets: ['invoice'] }] },
    });
    const { stdout, document } = await runDocument(fixture);

    assert.match(stdout, /Move destinations \(note: headings\):\n {2}_Projekty\/alfred\/alfred\.md: Ideas \| Tasks\n {2}Ideas\.md: Token burn ideas\n/);
    assert.match(stdout, /"buy present sam 🔼" moves to _Projekty\/alfred\/alfred\.md under "Someday", which is not among the move destinations/);
    assert.doesNotMatch(stdout, /"crawl every receipt" moves to/, 'Ideas.md\'s token burn heading is a move destination');
    assert.match(stdout, /note-[0-9a-f]{12} {2}capture notes: idea with details {2}\[under Dump\] {2}\[lines nested under it: keep\] {2}\[plain bullet: no done or progress\]/);
    assert.match(stdout, /"idea with details" has lines nested under it; the app refuses to delete it, so suggest keep\./);
    assert.match(stdout, /"plain and judged done" has no checkbox; the app refuses done on it/);
    const noteOf = (lineText: string) => document.chapters.capture.notes.find((note: { lineText: string }) => note.lineText === lineText);
    assert.deepEqual(noteOf('idea with details').nested, [{ depth: 1, text: 'a detail' }]);
    assert.deepEqual(noteOf('plain and resolved').suggestion, resolvedSuggestion, 'the triage area\'s suggestion stands');
    assert.deepEqual(noteOf('crawl every receipt').suggestion, tokenBurnMove);
    assert.equal(noteOf('plain and judged done').suggestion.action, 'done', 'the session\'s judgement replaces the triage area\'s');
    assert.equal(noteOf('harvest the old photos'), undefined, 'the token burn ideas are not triaged');
    assert.match(stdout, /Summary: 7 items and 2 bookmarks without judgement;/);
    assert.match(stdout, /plan narration targets nothing on the page: invoice \(its sentences target \[\]\)/);
    assert.equal(await readFile(join(fixture.dayDirectory, 'daily-brief.log'), 'utf8'), stdout);
  });
});

test('a capture started or removed after triage.mjs ran is left out', async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.vault, 'Daily', '2026-11-18.md'), '# Dump\n\n- [ ] buy present sam 🔼\n- [/] call the plumber\n');
    const { stdout, document } = await runDocument(fixture);
    assert.deepEqual(document.chapters.capture.notes.map((note: { lineText: string }) => note.lineText), ['buy present sam 🔼']);
    assert.match(stdout, /"what would a weekly brief need\?" is no longer a list line of Daily\/2026-11-18\.md; left out\./);
    assert.match(stdout, /"call the plumber" was started \(\[\/\]\) in Daily\/2026-11-18\.md after triage\.mjs ran; left out\./);
  });
});

test('without sources/triage.json the Obsidian triage source is not read', async () => {
  await withFixture(async (fixture) => {
    await rm(join(fixture.dayDirectory, 'sources', 'triage.json'));
    const { stdout, document } = await runDocument(fixture);
    assert.deepEqual(document.chapters.capture.notes, []);
    assert.deepEqual(document.sources.find((source) => source.name === 'Obsidian triage')?.status, 'not-read');
    assert.match(stdout, /Move destinations \(note: headings\):\n {2}none\n/);
  });
});

test('"default" accepts an item\'s default, and only a mail whose options reply needs a messageId', async () => {
  await withFixture(async (fixture) => {
    const vatId = await idOf('mail', 'thread-vat');
    const alertId = await idOf('mail', 'alert-1');
    const codeId = await idOf('code', 'https://github.com/owner/mpx/pull/218', 'ready');
    const presentId = await idOf('note', 'Daily/2026-11-18.md', 'buy present sam 🔼');
    const reply = { kind: 'reply', gist: 'On it', subject: 'Re: TypeError in checkout', body: 'Looking at it.', attachments: [] };
    await writeJson(join(fixture.dayDirectory, 'daily-brief.judgement.json'), {
      options: { [vatId]: 'default', [codeId]: 'default', [alertId]: [reply] },
      notes: { [presentId]: 'default' },
    });
    const { stdout, document } = await runDocument(fixture);
    assert.deepEqual(mailbox(document, 'personal').items[0].options, [{ kind: 'snooze' }]);
    assert.deepEqual(document.chapters.code.items[0].options.map((option: { label: string }) => option.label), ['Merge']);
    assert.equal(document.chapters.capture.notes.find((note: { id: string }) => note.id === presentId).suggestion.action, 'keep');
    assert.match(stdout, /Summary: 6 items and 2 bookmarks without judgement;/);
    assert.doesNotMatch(stdout, /The judgement names items the document does not have/);
    assert.match(stdout, /Mail "Sentry: TypeError in checkout" has no messageId; its reply draft would start a new mail instead of replying\./);
  });
});

test('a judged mail reply goes to the sender and the named recipients, each with their address', async () => {
  await withFixture(async (fixture) => {
    const vatId = await idOf('mail', 'thread-vat');
    const reply = { kind: 'reply', gist: 'Approve it', subject: 'Re: VAT draft', body: 'Looks right.', attachments: [] };
    await writeJson(join(fixture.dayDirectory, 'daily-brief.judgement.json'), {
      options: { [vatId]: [
        { ...reply, to: 'accountant, Partner Name' },
        reply,
        { ...reply, to: 'Someone Unknown, Office <office@example.com>' },
      ] },
    });
    const { stdout, document } = await runDocument(fixture);
    assert.deepEqual(mailbox(document, 'personal').items[0].options.map((option: { to: string }) => option.to), [
      'Accountant <accountant@example.com>, Partner Name <partner@example.com>',
      'Accountant <accountant@example.com>',
      'Someone Unknown, Office <office@example.com>',
    ]);
    assert.match(stdout, /A reply to "Accountant: VAT draft" names "Someone Unknown" without an address/);
  });
});

async function writeClip(fixture: Fixture, fileName: string): Promise<void> {
  await mkdir(join(fixture.dayDirectory, 'audio'), { recursive: true });
  await writeFile(join(fixture.dayDirectory, 'audio', fileName), 'RIFF');
}

test('a narration sentence carries the clip recorded for its exact text while the clip file exists', async () => {
  await withFixture(async (fixture) => {
    const voiced = { text: 'Today the stand-up, then the dentist.', targets: ['2026-11-18'] };
    const clipGone = { text: 'Tomorrow is empty.', targets: ['2026-11-19'] };
    const edited = { text: 'Approve the VAT draft today.', targets: [], audio: 'chosen-by-the-session.wav', audioSeconds: 2 };
    await writeJson(join(fixture.dayDirectory, 'daily-brief.judgement.json'), { narration: { calendar: [voiced, clipGone], mail: [edited] } });
    await writeJson(join(fixture.dayDirectory, 'daily-brief.clips.json'), {
      [voiced.text]: { audio: '0a1b2c3d4e5f6a7b.wav', audioSeconds: 2.4 },
      [clipGone.text]: { audio: 'ffffffffffffffff.wav', audioSeconds: 1.1 },
      'Approve the VAT draft.': { audio: '1111111111111111.wav', audioSeconds: 1.8 },
    });
    await writeClip(fixture, '0a1b2c3d4e5f6a7b.wav');
    await writeClip(fixture, '1111111111111111.wav');
    await writeClip(fixture, 'chosen-by-the-session.wav');

    const { stdout, document } = await runDocument(fixture);
    assert.deepEqual(document.chapters.calendar.narration, [{ ...voiced, audio: '0a1b2c3d4e5f6a7b.wav', audioSeconds: 2.4 }, clipGone]);
    assert.deepEqual(document.chapters.mail.narration, [{ text: edited.text, targets: [] }], 'clips come only from narrate.mjs, by the sentence as written');
    assert.match(stdout, /; 2 narration sentences without a clip;/);
  });
});

const OPEN_EPISODE = 'Medical records/2026-11-12 Lower back pain.md';
const SYNTHETIC_CHECK_IN = 'stretched before the synthetic walk';

async function writeEpisodeNotes(fixture: Fixture): Promise<void> {
  const notes: Record<string, string> = {
    [OPEN_EPISODE]: `---\nillness: "Lower back pain"\nstarted: 2026-11-12\nended:\ntreatment: ""\n---\n\n- 2026-11-17 · pain 4 · better · ${SYNTHETIC_CHECK_IN} ·\n`,
    'Medical records/2026-10-01 Flu.md': '---\nillness: "Flu"\nstarted: 2026-10-01\nended: 2026-10-08\n---\n',
    'Medical records/Diet.md': '---\ntopic: diet\n---\n',
    'Medical records/Archive/2026-01-03 Cold.md': '---\nillness: "Cold"\nended:\n---\n',
  };
  for (const [notePath, noteText] of Object.entries(notes)) {
    await mkdir(dirname(join(fixture.vault, notePath)), { recursive: true });
    await writeFile(join(fixture.vault, notePath), noteText);
  }
}

test('the open episode notes are listed by path and a hint for any other note is left out', async () => {
  await withFixture(async (fixture) => {
    await writeEpisodeNotes(fixture);
    const openHint = { conditionId: OPEN_EPISODE, text: 'Keep the short walks; see a doctor if it gets worse over several days.' };
    await writeJson(join(fixture.dayDirectory, 'daily-brief.judgement.json'), {
      hints: [openHint, { conditionId: 'Medical records/2026-10-01 Flu.md', text: 'Rest.' }],
    });
    const { stdout, document } = await runDocument(fixture);
    assert.deepEqual(document.chapters.health.hints, [openHint]);
    assert.match(stdout, /Open health episodes \(read each note, one hint per path\):\n {2}Medical records\/2026-11-12 Lower back pain\.md\nProblems:/);
    assert.match(stdout, /A hint names Medical records\/2026-10-01 Flu\.md, which is not an open episode note; left out\./);
    assert.doesNotMatch(stdout, new RegExp(SYNTHETIC_CHECK_IN), 'a note is listed by its path, never by its contents');

    await writeJson(join(fixture.dayDirectory, 'daily-brief.judgement.json'), {});
    assert.match((await runDocument(fixture)).stdout, /Medical records\/2026-11-12 Lower back pain\.md {2}\[no hint\]\n/);
  });
});

test('without open episodes there are no hints', async () => {
  await withFixture(async (fixture) => {
    await writeJson(join(fixture.dayDirectory, 'daily-brief.judgement.json'), { hints: [{ conditionId: OPEN_EPISODE, text: 'Walk.' }] });
    const { stdout, document } = await runDocument(fixture);
    assert.deepEqual(document.chapters.health.hints, []);
    assert.match(stdout, /Open health episodes \(read each note, one hint per path\):\n {2}none\n/);
    assert.match(stdout, /A hint names Medical records\/2026-11-12 Lower back pain\.md, which is not an open episode note/);
  });
});

test('a gatherer that failed leaves its mailbox and source not read', async () => {
  await withFixture(async (fixture) => {
    await writeJson(join(fixture.dayDirectory, 'sources', 'work.json'), { status: 'unavailable', reason: 'work gatherer: timed out after 12 minutes' });
    const { document } = await runDocument(fixture);
    const work = mailbox(document, 'work');
    assert.deepEqual([work.status, work.reason, work.items], ['not-read', 'work gatherer: timed out after 12 minutes', []]);
    assert.deepEqual(document.sources.find((source) => source.name.startsWith('Work')), { name: 'Work Slack, Gmail and Calendar', status: 'not-read', reason: 'work gatherer: timed out after 12 minutes' });
    assert.deepEqual(document.chapters.slack.items, []);
  });
});

test('an outcome without dismissals leaves out the day\'s seen items and kept lines and brings back snoozed and undecided ones', async () => {
  await withFixture(async (fixture) => {
    const vatId = await idOf('mail', 'thread-vat');
    const plumberId = await idOf('note', 'Daily/2026-11-18.md', 'call the plumber');
    const goneNoteId = await idOf('note', 'Ideas.md', 'An idea deleted since');
    const earlierSlackItem = {
      id: 'slack-earlier', short: 'Ann: lunch?', link: 'https://example.slack.com/archives/D2/p1', options: [{ kind: 'snooze' }],
      channel: 'Direct message', author: 'Ann', postedAt: '2026-11-16T12:00:00+01:00', text: 'Lunch on Thursday?',
      permalink: 'https://example.slack.com/archives/D2/p1', repliers: [], reactions: [],
    };
    await writeJson(join(fixture.home, 'work', 'morning-brief', '2026-11-17', 'daily-brief.json'), {
      chapters: {
        slack: { narration: [], items: [earlierSlackItem], handled: [], skippedCount: 0 },
        capture: { narration: [], notes: [{ id: goneNoteId, notePath: 'Ideas.md', lineText: 'An idea deleted since', suggestion: { action: 'keep' } }], bookmarks: [], wishlists: [] },
      },
    });
    await writeJson(join(fixture.data, 'brief', '2026-11-17', 'outcome.json'), {
      seen: [vatId], kept: [plumberId], snoozed: ['slack-earlier'], undecided: [goneNoteId],
      feedback: [{ chapter: 'mail', text: 'Fewer notifications' }],
    });
    await writeJson(join(fixture.data, 'brief', '2026-11-19', 'outcome.json'), { seen: [await idOf('slack', PERMALINK)] });

    const { stdout, document } = await runDocument(fixture);
    assert.deepEqual(mailbox(document, 'personal').items, []);
    assert.deepEqual(document.chapters.capture.notes.map((note: { lineText: string }) => note.lineText), ['buy present sam 🔼', 'what would a weekly brief need?']);
    assert.deepEqual(document.chapters.slack.items.map((item: { id: string }) => item.id), [await idOf('slack', PERMALINK), 'slack-earlier']);
    assert.match(stdout, /Outcome of 2026-11-17: 2 dismissed or kept items left out, 1 snoozed or undecided items returned, 0 dismissed mails back with a newer message\./);
    assert.match(stdout, /Chapter feedback to respect: .*Fewer notifications/);
  });
});

test('a dismissed mail stays out on the following days and returns with a newer message', async () => {
  await withFixture(async (fixture) => {
    const vatId = await idOf('mail', 'thread-vat');
    const slackId = await idOf('slack', PERMALINK);
    const writeOutcome = (day: string, dismissedAt: string) => writeJson(join(fixture.data, 'brief', day, 'outcome.json'), {
      snoozed: [], undecided: [], kept: [], seen: [], keptBookmarks: [], feedback: {},
      dismissed: [{ id: vatId, at: dismissedAt }, { id: slackId, at: '2026-11-16T09:00:00.000Z' }],
    });
    const personalItemIds = async () => mailbox((await runDocument(fixture)).document, 'personal').items.map((item: { id: string }) => item.id);

    await writeOutcome('2026-11-16', '2026-11-17T21:00:00.000Z');
    assert.deepEqual(await personalItemIds(), [], 'the third day, read from the outcome two days back');
    await writeOutcome('2026-11-17', '2026-11-17T21:00:00.000Z');
    const secondDay = await runDocument(fixture);
    assert.deepEqual(mailbox(secondDay.document, 'personal').items, [], 'the second day');
    assert.deepEqual(secondDay.document.chapters.slack.items, [], 'a Slack permalink is one message, so it stays out');
    assert.match(secondDay.stdout, /Outcome of 2026-11-17: 2 dismissed or kept items left out, 0 snoozed or undecided items returned, 0 dismissed mails back with a newer message\./);

    await writeOutcome('2026-11-17', '2026-11-17T18:00:00.000Z');
    const newerMessage = await runDocument(fixture);
    assert.deepEqual(mailbox(newerMessage.document, 'personal').items.map((item: { id: string }) => item.id), [vatId], 'the thread received a message after the dismissal');
    assert.match(newerMessage.stdout, /1 dismissed mails back with a newer message/);
  });
});

test('a dismissed pull request returns when its state changes', async () => {
  await withFixture(async (fixture) => {
    const pullRequest = 'https://github.com/owner/mpx/pull/218';
    const writeDismissed = (id: string) => writeJson(join(fixture.data, 'brief', '2026-11-17', 'outcome.json'), {
      snoozed: [], undecided: [], kept: [], seen: [], dismissed: [{ id, at: '2026-11-17T21:00:00.000Z' }], keptBookmarks: [], feedback: {},
    });
    await writeDismissed(await idOf('code', pullRequest, 'review'));
    assert.deepEqual((await runDocument(fixture)).document.chapters.code.items.map((item: { id: string }) => item.id), [await idOf('code', pullRequest, 'ready')]);
    await writeDismissed(await idOf('code', pullRequest, 'ready'));
    assert.deepEqual((await runDocument(fixture)).document.chapters.code.items, []);
  });
});

test('Code shows only changes of active repositories and reviews requested from me', async () => {
  await withFixture(async (fixture) => {
    const brief = sessionBrief();
    (brief.chapters[1]!.data as { projects: unknown[] }).projects = [
      { id: 'mpx', name: 'mpx', app: 'github', cards: [
        { ref: '#218', title: 'Skill palette aliases', state: 'ready', url: 'https://github.com/owner/mpx/pull/218' },
        { ref: '#216', title: 'Changelog skips merge commits', state: 'merged', url: 'https://github.com/owner/mpx/pull/216' },
      ] },
      { id: 'claude-queue', name: 'claude-queue', app: 'github', cards: [
        { ref: '#3', title: 'cqueue: queue prompts for timed delivery', state: 'review', url: 'https://github.com/owner/claude-queue/pull/3' },
      ] },
      { id: 'grovekeeper', name: 'Grovekeeper', app: 'github', cards: [
        { ref: '#425', title: 'Seasonal planting', state: 'review', url: 'https://github.com/owner/Grovekeeper/pull/425' },
        { ref: '#424', title: 'Old merge', state: 'merged', url: 'https://github.com/owner/grovekeeper/pull/424' },
      ] },
      { id: 'grovekeeper-e2e-testing', name: 'grovekeeper-e2e-testing', app: 'github', cards: [
        { ref: '#17', title: 'Smoke suite', state: 'failing', url: 'https://github.com/owner/grovekeeper-e2e-testing/pull/17' },
      ] },
      { id: 'design-system', name: 'design-system', app: 'gitlab', cards: [
        { ref: '!88', title: 'Tokens for dark mode', state: 'review', author: 'Alex', reviewRequested: true, url: 'https://gitlab.example.com/design/system/-/merge_requests/88' },
      ] },
    ];
    await writeJson(join(fixture.dayDirectory, 'brief.json'), brief);
    const { stdout, document } = await runDocument(fixture);

    assert.deepEqual(document.chapters.code.items.map((item: { projectName: string; reference: { label: string } }) => [item.projectName, item.reference.label]),
      [['mpx', '#218'], ['design-system', '!88']]);
    assert.deepEqual(document.chapters.code.merged.map((change: { reference: { label: string } }) => change.reference.label), ['#216']);
    assert.match(stdout, /Left out of Code \(not an active repository in sources\/repos\.json\):\n {2}claude-queue #3 https:\/\/github\.com\/owner\/claude-queue\/pull\/3\n {2}Grovekeeper #425 https:\/\/github\.com\/owner\/Grovekeeper\/pull\/425\n {2}Grovekeeper #424 https:\/\/github\.com\/owner\/grovekeeper\/pull\/424\n {2}grovekeeper-e2e-testing #17 https:\/\/github\.com\/owner\/grovekeeper-e2e-testing\/pull\/17\n/);
    assert.doesNotMatch(stdout.slice(stdout.indexOf('Problems:')), /claude-queue/, 'a change left out is a note, not a problem');

    await rm(join(fixture.dayDirectory, 'sources', 'repos.json'));
    const withoutRepositories = await runDocument(fixture);
    assert.deepEqual(withoutRepositories.document.chapters.code.items.map((item: { reference: { label: string } }) => item.reference.label), ['!88']);
    assert.match(withoutRepositories.stdout, /No readable sources\/repos\.json, so Code shows only the reviews requested from you; run repos\.mjs\./);
  });
});

test('a snoozed line of a note before the window and a snoozed bookmark return, and kept articles are not judged again', async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.vault, 'Daily', '2026-11-10.md'), '- call the plumber\n');
    const plumberId = await idOf('note', 'Daily/2026-11-10.md', 'call the plumber');
    const calmId = await idOf('bookmark', '1002');
    const calmBookmark = { id: calmId, bookmarkId: '1002', kind: 'article', suggestion: { action: 'keep', destination: null, because: null }, csfd: null };
    await writeJson(join(fixture.home, 'work', 'morning-brief', '2026-11-17', 'daily-brief.json'), {
      chapters: {
        capture: {
          narration: [],
          notes: [{ id: plumberId, notePath: 'Daily/2026-11-10.md', lineText: 'call the plumber', suggestion: { action: 'keep' } }],
          bookmarks: [calmBookmark],
          wishlists: [],
        },
      },
    });
    await writeJson(join(fixture.data, 'brief', '2026-11-17', 'outcome.json'), {
      snoozed: [plumberId, calmId], undecided: [], kept: [], seen: [], dismissed: [], keptBookmarks: ['1001'], feedback: {},
    });
    const { stdout, document } = await runDocument(fixture);
    assert.ok(document.chapters.capture.notes.some((note: { id: string }) => note.id === plumberId));
    assert.deepEqual(document.chapters.capture.bookmarks, [calmBookmark]);
    assert.match(stdout, /Bookmarks without judgement:\n {2}none\n/);
  });
});

test('an outcome without chapter feedback prints no feedback line', async () => {
  await withFixture(async (fixture) => {
    await writeJson(join(fixture.data, 'brief', '2026-11-17', 'outcome.json'), { snoozed: [], undecided: [], kept: [], seen: [], feedback: {} });
    const { stdout } = await runDocument(fixture);
    assert.match(stdout, /Outcome of 2026-11-17:/);
    assert.doesNotMatch(stdout, /Chapter feedback/);
  });
});

test('the sample brief.json gives Code and Agents', async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.dayDirectory, 'brief.json'), await readFile(resolve('content/skills/morning-brief/brief.sample.json')));
    const { stdout, document } = await runDocument(fixture);
    assert.deepEqual(document.chapters.code.items.map((item: { reference: { label: string } }) => item.reference.label), ['!318', '!321', '!320']);
    assert.deepEqual(document.chapters.code.merged.map((change: { reference: { label: string } }) => change.reference.label), ['!316']);
    assert.deepEqual(document.chapters.agents.items.map((run: { projectName: string; outcome: string; sessionId: string; links: unknown[] }) => [run.projectName, run.outcome, run.sessionId, run.links.length]),
      [['videoLab', 'failed', RENDER_SESSION_ID, 2]]);
    assert.doesNotMatch(stdout, /Overnight run .* left out/);
  });
});

const statePath = (fixture: Fixture) => join(fixture.home, 'work', 'morning-brief', 'state.json');

test('writing the document records the brief as the last one, and start.mjs begins the next window there', async () => {
  await withFixture(async (fixture) => {
    await runDocument(fixture);
    const until = new Date(2026, 10, 18, 6).toISOString();
    assert.deepEqual(JSON.parse(await readFile(statePath(fixture), 'utf8')), { lastSuccess: until, lastBrief: fixture.dayDirectory });
    const { stdout } = await exec(process.execPath, [startScript], { env: { ...process.env, MPX_AI_RETAINED: join(fixture.home, 'work') }, timeout: 20_000 });
    assert.equal(Date.parse(JSON.parse(stdout).lastSuccess), Date.parse(until));
  });
});

test('a --no-state run and a rebuild of an earlier day leave the record of the last brief', async () => {
  await withFixture(async (fixture) => {
    await runDocument(fixture, undefined, '--no-state');
    assert.equal(existsSync(statePath(fixture)), false);
    const laterBrief = { lastSuccess: new Date(2026, 10, 19, 6).toISOString(), lastBrief: 'the next day' };
    await writeJson(statePath(fixture), laterBrief);
    await runDocument(fixture);
    assert.deepEqual(JSON.parse(await readFile(statePath(fixture), 'utf8')), laterBrief);
  });
});

const appSkip = !existsSync(join(APP_DIRECTORY, 'package.json')) && 'the alfred-control-center repository is not checked out';

test('a --no-state run gives a valid document with clips and writes no page and no record of the last brief', { skip: appSkip }, async () => {
  const voiceStudio = await fakeVoiceStudio();
  try {
    await withFixture(async (fixture) => {
      const sessionJudgement = (await judgement()).judgement;
      await writeJson(join(fixture.dayDirectory, 'daily-brief.judgement.json'), sessionJudgement);
      const voicing = await narrate(fixture.dayDirectory, voiceStudio.url);
      assert.equal(voicing.exitCode, 0, voicing.stderr);
      const { exitCode, stdout, document } = await runDocument(fixture, process.env.MPX_PROJECTS, '--no-state');
      assert.equal(exitCode, 0, stdout);
      assert.match(stdout, /Valid: every chapter can be shown\./);
      assert.match(stdout, /; 0 narration sentences without a clip; the document is valid\./);
      const sentences = Object.values(document.chapters).flatMap((chapter) => chapter.narration);
      assert.equal(sentences.length, 3);
      for (const sentence of sentences) assert.match(sentence.audio, /^[0-9a-f]{16}\.wav$/);
      for (const pageFile of ['index.html', 'process.json']) assert.equal(existsSync(join(fixture.dayDirectory, pageFile)), false, pageFile);
      assert.equal(existsSync(statePath(fixture)), false);
    });
  } finally {
    await voiceStudio.close();
  }
});

test('a judged document with clips and a health hint passes the app validator', { skip: appSkip }, async () => {
  await withFixture(async (fixture) => {
    const sessionJudgement = (await judgement()).judgement;
    await writeFile(join(fixture.vault, 'Daily', '2026-11-18.md'), '# Dump\n\n- [ ] buy present sam 🔼\n- what would a weekly brief need?\n\t- [ ] book a slot\n');
    await runTriage(fixture);
    await writeEpisodeNotes(fixture);
    await writeJson(join(fixture.dayDirectory, 'daily-brief.judgement.json'), { ...sessionJudgement, hints: [{ conditionId: OPEN_EPISODE, text: 'Keep walking.' }] });
    await writeJson(join(fixture.dayDirectory, 'daily-brief.clips.json'), { [sessionJudgement.narration.calendar[0]!.text]: { audio: '0a1b2c3d4e5f6a7b.wav', audioSeconds: 2.4 } });
    await writeClip(fixture, '0a1b2c3d4e5f6a7b.wav');
    const { exitCode, stdout, document } = await runDocument(fixture, process.env.MPX_PROJECTS);
    assert.equal(exitCode, 0, stdout);
    assert.equal(document.chapters.calendar.narration[0].audio, '0a1b2c3d4e5f6a7b.wav');
    assert.equal(document.chapters.health.hints.length, 1);
    const weekly = document.chapters.capture.notes.find((note: { lineText: string }) => note.lineText === 'what would a weekly brief need?');
    assert.deepEqual([weekly.heading, weekly.nested], [['Dump'], [{ depth: 1, text: '[ ] book a slot' }]]);
    assert.match(stdout, /Valid: every chapter can be shown\./);
  });
});

test('the app validator names an invalid chapter', { skip: appSkip }, async () => {
  await withFixture(async (fixture) => {
    const sessionJudgement = (await judgement()).judgement;
    await writeJson(join(fixture.dayDirectory, 'daily-brief.judgement.json'), { ...sessionJudgement, wishlists: [] });
    const { exitCode, stdout } = await runDocument(fixture, process.env.MPX_PROJECTS);
    assert.equal(exitCode, 2);
    assert.match(stdout, /invalid {2}capture .*destination/);
    assert.match(stdout, /ok {7}mail/);
  });
});
