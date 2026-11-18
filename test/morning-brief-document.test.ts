import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const documentScript = resolve('content/skills/morning-brief/scripts/daily-brief.mjs');
const idScript = resolve('content/skills/morning-brief/scripts/brief-id.mjs');
const DAY = '2026-11-18';
const PERMALINK = 'https://example.slack.com/archives/C1/p1794779220000100?thread_ts=1794779220.000100&cid=C1';
const APP_DIRECTORY = process.env.MPX_PROJECTS ? join(process.env.MPX_PROJECTS, 'alfred-control-center') : '';

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

function pageBrief() {
  return {
    projects: [{ id: 'videolab', name: 'videoLab' }],
    chapters: [
      { id: 'overnight', type: 'overnight', status: 'needs', data: { runs: [
        { id: 'r1', project: 'videolab', outcome: 'fail', result: 'Render failed', title: 'Proxy render', detail: 'Disk D is full', when: '03:10', duration: '1 h 5 min', url: 'file:///C:/render.log' },
        { id: 'r2', project: 'videolab', outcome: 'partial', result: 'Staging running', title: 'Staging', detail: 'Still running', when: '23:30', duration: '6 h 30 min', session: 'C:/sessions/staging.jsonl' },
      ] } },
      { id: 'work', type: 'work', status: 'needs', data: { projects: [
        { id: 'mpx', name: 'mpx', app: 'github', cards: [
          { id: 'c1', ref: '#218', title: 'Skill palette aliases', state: 'ready', url: 'https://github.com/owner/mpx/pull/218', pipeline: { status: 'success' } },
          { id: 'c2', ref: '#219', title: 'Work in progress', state: 'draft', url: 'https://github.com/owner/mpx/pull/219' },
          { id: 'c3', ref: '#216', title: 'Changelog skips merge commits', state: 'merged', url: 'https://github.com/owner/mpx/pull/216' },
        ] },
        { id: 'platform', name: 'platform', app: 'gerrit', cards: [{ id: 'g1', ref: '4711', title: 'Fix', state: 'review', url: 'https://gerrit.example/c/4711' }] },
      ] } },
      { id: 'triage', type: 'triage', status: 'fyi', data: { groups: [
        { id: 'daily', note: 'Daily/2026-11-18', items: [
          { id: 't1', text: 'Buy a birthday present for Sam', line: 'buy present sam 🔼' },
          { id: 't2', text: 'Book the winter tyres', line: 'Book the winter tyres', resolved: true, resolution: 'Booked for Saturday' },
          { id: 't3', text: 'A line no longer in the note', line: 'Removed line' },
        ] },
      ] } },
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
    await writeJson(join(fixture.dayDirectory, 'brief.json'), pageBrief());
    await writeJson(join(home, 'work', 'bookmarks', 'capture.json'), {
      syncedAt: '2026-11-18T05:00:00Z',
      bookmarks: [
        { id: '1001', title: 'Headlamp', url: 'https://shop.example/headlamp' },
        { id: '1002', title: 'Calm article', url: 'https://blog.example/calm' },
      ],
    });
    await mkdir(join(fixture.vault, 'Daily'), { recursive: true });
    await writeFile(join(fixture.vault, 'Daily', '2026-11-18.md'), '# Dump\n\n- [ ] buy present sam 🔼\n- [x] Book the winter tyres\n');
    await mkdir(fixture.data);
    return await use(fixture);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function runDocument(fixture: Fixture, projectsRoot = join(fixture.home, 'projects')): Promise<DocumentRun> {
  const env = { ...process.env, MPX_OBSIDIAN_VAULT: fixture.vault, ALFRED_CONTROL_CENTER_DATA: fixture.data, MPX_PROJECTS: projectsRoot };
  let exitCode = 0;
  let stdout = '';
  try {
    ({ stdout } = await exec(process.execPath, [documentScript, fixture.dayDirectory], { env, timeout: 150_000 }));
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
  return {
    vatId,
    presentId,
    judgement: {
      calendars: { 'partner@example.com': 'wife' },
      calendarNames: { wife: 'Kája' },
      mailboxes: [{ id: 'centrum', label: 'Centrum', provider: 'centrum', account: 'me@centrum.example' }],
      options: { [vatId]: [{ kind: 'reply', gist: 'Approve it', to: 'Accountant', subject: 'Re: VAT draft', body: 'Looks right, please file it.', attachments: [] }, { kind: 'snooze' }] },
      notes: { [presentId]: { action: 'move', destination: { notePath: '_Projekty/alfred/alfred.md', heading: 'Tasks' }, wording: 'Buy a birthday present for Sam', priority: 4 } },
      bookmarks: { 1001: { kind: 'shop', suggestion: { action: 'move', destination: 'mine', because: 'Looked at it twice' } } },
      wishlists: [{ id: 'mine', label: 'My wishlist' }],
      reminders: [{ title: 'November invoice', reason: 'Monthly', due: '2026-11-25' }],
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
    assert.deepEqual(code.items.map((item: { id: string; reference: { label: string } }) => [item.id, item.reference.label]), [[await idOf('code', 'https://github.com/owner/mpx/pull/218'), '#218']]);
    assert.equal(code.items[0].options[0].execution.kind, 'merge');
    assert.deepEqual(code.items[0].chips, [{ label: 'approved', tone: 'good' }, { label: 'checks', tone: 'good' }]);
    assert.deepEqual(code.merged.map((change: { reference: { label: string } }) => change.reference.label), ['#216']);
    assert.match(stdout, /platform: gerrit changes are left out/);

    const [render, staging] = document.chapters.agents.items;
    assert.deepEqual([render.id, render.projectName, render.outcome, render.logTail], [await idOf('agent', 'file:///C:/render.log'), 'videoLab', 'failed', ['Disk D is full']]);
    assert.equal(Date.parse(render.startedAt), new Date(2026, 10, 18, 3, 10).getTime());
    assert.equal(Date.parse(render.endedAt), new Date(2026, 10, 18, 4, 15).getTime());
    assert.equal(staging.id, await idOf('agent', 'C:/sessions/staging.jsonl'));
    assert.equal(Date.parse(staging.startedAt), new Date(2026, 10, 17, 23, 30).getTime(), 'a clock time after the window ended was the evening before');
    assert.deepEqual([staging.outcome, staging.endedAt], ['running', null]);

    const capture = document.chapters.capture;
    assert.deepEqual(capture.notes.map((note: { id: string; lineText: string; suggestion: { action: string; because: string | null } }) => [note.id, note.lineText, note.suggestion.action, note.suggestion.because]), [
      [await idOf('note', 'Daily/2026-11-18.md', 'buy present sam 🔼'), 'buy present sam 🔼', 'keep', null],
      [await idOf('note', 'Daily/2026-11-18.md', 'Book the winter tyres'), 'Book the winter tyres', 'done', 'Booked for Saturday'],
    ]);
    assert.match(stdout, /"Removed line" is not a list line of Daily\/2026-11-18\.md/);
    assert.deepEqual(capture.bookmarks, []);
    assert.match(stdout, /Bookmarks without judgement:\n {2}1001 {2}Headlamp/);
    assert.ok(document.sources.every((source) => source.status === 'read'));
  });
});

test('the judgement adds options, suggestions, bookmarks, mailboxes without a connector and narration', async () => {
  await withFixture(async (fixture) => {
    const before = await runDocument(fixture);
    const { vatId, presentId, judgement: sessionJudgement } = await judgement();
    await writeJson(join(fixture.dayDirectory, 'daily-brief.judgement.json'), {
      ...sessionJudgement,
      narration: { ...sessionJudgement.narration, slack: [{ text: 'Nothing waits.', targets: ['slack-unknown'] }] },
    });
    const { stdout, document } = await runDocument(fixture);

    assert.deepEqual(document.chapters.calendar.calendars.at(-1), { id: 'wife', name: 'Kája' });
    assert.deepEqual(document.chapters.calendar.days[2].allDay, [{ title: 'Name day', calendar: 'wife', link: null }]);
    const [vatReply, vatSnooze] = sessionJudgement.options[vatId] ?? [];
    assert.deepEqual(mailbox(document, 'personal').items[0].options, [{ ...vatReply, to: 'Accountant <accountant@example.com>' }, vatSnooze]);
    assert.deepEqual(mailbox(document, 'centrum'), {
      id: 'centrum', label: 'Centrum', provider: 'centrum', account: 'me@centrum.example', transport: 'imap', canSend: false,
      status: 'not-read', reason: 'The headless morning run cannot unlock IMAP passwords; Unlock reads this mailbox at the desk.', items: [], quiet: [],
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

test('the latest outcome drops seen and kept items and brings back snoozed and undecided ones', async () => {
  await withFixture(async (fixture) => {
    const vatId = await idOf('mail', 'thread-vat');
    const tyresId = await idOf('note', 'Daily/2026-11-18.md', 'Book the winter tyres');
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
      seen: [vatId], kept: [tyresId], snoozed: ['slack-earlier'], undecided: [goneNoteId],
      feedback: [{ chapter: 'mail', text: 'Fewer notifications' }],
    });
    await writeJson(join(fixture.data, 'brief', '2026-11-19', 'outcome.json'), { seen: [await idOf('slack', PERMALINK)] });

    const { stdout, document } = await runDocument(fixture);
    assert.deepEqual(mailbox(document, 'personal').items, []);
    assert.deepEqual(document.chapters.capture.notes.map((note: { lineText: string }) => note.lineText), ['buy present sam 🔼']);
    assert.deepEqual(document.chapters.slack.items.map((item: { id: string }) => item.id), [await idOf('slack', PERMALINK), 'slack-earlier']);
    assert.match(stdout, /Outcome of 2026-11-17: 2 seen or kept items dropped, 1 snoozed or undecided items returned\./);
    assert.match(stdout, /Chapter feedback to respect: .*Fewer notifications/);
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

const appSkip = !existsSync(join(APP_DIRECTORY, 'package.json')) && 'the alfred-control-center repository is not checked out';

test('a judged document passes the app validator', { skip: appSkip }, async () => {
  await withFixture(async (fixture) => {
    await writeJson(join(fixture.dayDirectory, 'daily-brief.judgement.json'), (await judgement()).judgement);
    const { exitCode, stdout } = await runDocument(fixture, process.env.MPX_PROJECTS);
    assert.equal(exitCode, 0, stdout);
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
