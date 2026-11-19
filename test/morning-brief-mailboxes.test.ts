import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const mailboxesScript = resolve('content/skills/morning-brief/scripts/mailboxes.mjs');
const idScript = resolve('content/skills/morning-brief/scripts/brief-id.mjs');
const DAY = '2026-11-19';
const WINDOW = { start: '2026-11-18T05:00:00.000Z', end: '2026-11-19T05:00:00.000Z' };
const APP_DIRECTORY = process.env.MPX_PROJECTS ? join(process.env.MPX_PROJECTS, 'alfred-control-center') : '';
const appSkip = !existsSync(join(APP_DIRECTORY, 'package.json')) && 'the alfred-control-center repository is not checked out';

const CENTRUM = { id: 'centrum', label: 'Centrum', provider: 'centrum', account: 'me@centrum.example' };
const SECOND = { id: 'snapyy11', label: 'Second Gmail', provider: 'gmail', account: 'me@gmail.example' };

// Stands in for Alfred's mail command as its interface describes it: one JSON answer on stdout, or exit 1 with a
// readable last line of stderr. A read that starts while another runs fails, so overlapping reads show.
const FAKE_MAIL = String.raw`
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const [command, account, ...options] = process.argv.slice(2);
const lock = process.env.FAKE_MAIL_LOCK;
if (existsSync(lock)) { console.error('Another read is still running.'); process.exit(1); }
writeFileSync(lock, account);
appendFileSync(process.env.FAKE_MAIL_LOG, JSON.stringify({ command, account, options }) + '\n');
await new Promise((resolveWait) => setTimeout(resolveWait, 150));
rmSync(lock);
const mailbox = JSON.parse(readFileSync(process.env.FAKE_MAIL_DATA, 'utf8'))[account];
if (!mailbox || mailbox.failure) {
  console.error('Connecting to the mail server.');
  console.error(mailbox?.failure ?? "Unknown account '" + account + "'.");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ account, address: 'me@example.com', messages: mailbox.messages }));
`;

// Stands in for the headless judging run: it records its arguments and prompt and judges each thread by its subject.
const FAKE_MODEL = String.raw`
import { appendFileSync, readFileSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
appendFileSync(process.env.FAKE_MODEL_LOG, JSON.stringify({ args: process.argv.slice(2), prompt }) + '\n');
const threads = JSON.parse(prompt.trim().split('\n').at(-1));
const judged = threads.map(({ key, subject }) => {
  if (subject.includes('stroller')) return { key, class: 'act', options: [{ kind: 'reply', gist: 'Still available', body: 'Yes, it is still available.' }, { kind: 'snooze' }] };
  if (subject.includes('tickets')) return { key, class: 'act', options: [{ kind: 'event', title: 'Cinema', day: '2026-11-19', start: '20:00', end: '22:00' }] };
  return { key, class: 'quiet' };
});
const garbled = threads.some(({ subject }) => subject.includes('Garbled'));
const result = garbled ? 'I could not decide.' : JSON.stringify({ threads: judged });
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result, total_cost_usd: 0.001, num_turns: 1 }));
`;

type MailMessage = Record<string, unknown>;
type MailData = Record<string, { messages: MailMessage[] } | { failure: string }>;
type Fixture = { home: string; runDirectory: string; partsDirectory: string; contentRoot: string; mailLog: string; modelLog: string };
type Mailbox = { id: string; label: string; provider: string; account: string; transport: string; canSend: boolean; status: string; reason: string | null; items: any[]; quiet: any[] };

function message(uid: number, subject: string, date: string, thread: { messageId?: string | null; threadMessageId?: string | null } = {}): MailMessage {
  return {
    uid,
    messageId: thread.messageId ?? null,
    threadMessageId: thread.threadMessageId ?? thread.messageId ?? null,
    from: { name: 'Radek Pokorný', address: 'radek@example.com' },
    to: [{ name: null, address: 'me@centrum.example' }],
    cc: [],
    date,
    subject,
    text: `About: ${subject}.\n\n  Could you answer by Friday?`,
    textTruncated: false,
  };
}

const STROLLER_THREAD = '<stroller@example.com>';
const CENTRUM_MESSAGES = [
  message(4711, 'Is the stroller still available?', '2026-11-18T20:30:00.000Z', { messageId: STROLLER_THREAD }),
  message(4713, 'Re: Is the stroller still available?', '2026-11-18T21:00:00.000Z', { messageId: '<stroller-2@example.com>', threadMessageId: STROLLER_THREAD }),
  message(4714, 'Weekly offers', '2026-11-18T08:00:00.000Z'),
  message(4715, 'Your tickets for Thursday', '2026-11-18T18:02:00.000Z', { messageId: '<tickets@example.com>' }),
  message(4716, 'Your parcel is on its way', '2026-11-18T10:00:00.000Z', { messageId: '<parcel@example.com>' }),
  message(4717, 'A question you dismissed', '2026-11-18T15:00:00.000Z', { messageId: '<question@example.com>' }),
];

async function idOf(...referenceParts: string[]): Promise<string> {
  const { stdout } = await exec(process.execPath, [idScript, 'mail', ...referenceParts], { timeout: 20_000 });
  return stdout.trim();
}

async function withFixture<Result>(mailData: MailData, mailboxes: object[], use: (fixture: Fixture) => Promise<Result>): Promise<Result> {
  const home = await mkdtemp(join(tmpdir(), 'mpx-brief-mailboxes-'));
  const fixture: Fixture = {
    home,
    runDirectory: join(home, 'data', 'brief', DAY, 'start', '20261119071500-a1b2c3'),
    partsDirectory: join(home, 'work', 'morning-brief', DAY, 'parts'),
    contentRoot: join(home, 'mpx'),
    mailLog: join(home, 'mail.jsonl'),
    modelLog: join(home, 'model.jsonl'),
  };
  try {
    await mkdir(fixture.runDirectory, { recursive: true });
    await mkdir(join(fixture.contentRoot, 'bin'), { recursive: true });
    await writeFile(join(home, 'fake-mail.mjs'), FAKE_MAIL);
    await writeFile(join(home, 'fake-claude.mjs'), FAKE_MODEL);
    await writeFile(join(fixture.contentRoot, 'bin', 'cc'), `#!/usr/bin/env bash\nexec node "${join(home, 'fake-claude.mjs').replaceAll('\\', '/')}" "$@"\n`);
    await writeFile(join(home, 'mail.json'), JSON.stringify(mailData));
    await mkdir(join(home, 'work', 'morning-brief'), { recursive: true });
    await writeFile(join(home, 'work', 'morning-brief', 'taste.md'), '# Taste\n\n- Too much information is the main complaint.\n');
    await writeFile(fixture.mailLog, '');
    await writeFile(fixture.modelLog, '');
    await writeFile(join(fixture.runDirectory, 'run.json'), JSON.stringify({
      runId: '20261119071500-a1b2c3',
      day: DAY,
      startedAt: new Date().toISOString(),
      model: 'haiku',
      window: WINDOW,
      mailCommand: [process.execPath, join(home, 'fake-mail.mjs')],
      partsDirectory: fixture.partsDirectory,
      mailboxes,
      dismissed: [
        { id: await idOf('centrum', '<parcel@example.com>'), at: '2026-11-18T12:00:00.000Z' },
        { id: await idOf('centrum', '<question@example.com>'), at: '2026-11-18T09:00:00.000Z' },
      ],
    }, null, 2));
    return await use(fixture);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function runMailboxes(fixture: Fixture, env: NodeJS.ProcessEnv = { MPX_ACTIVE_CONTENT_ROOT: fixture.contentRoot }): Promise<{ exitCode: number; output: string }> {
  const fakes = { FAKE_MAIL_DATA: join(fixture.home, 'mail.json'), FAKE_MAIL_LOG: fixture.mailLog, FAKE_MAIL_LOCK: join(fixture.home, 'mail.lock'), FAKE_MODEL_LOG: fixture.modelLog };
  const { MPX_ACTIVE_CONTENT_ROOT: _ignored, ...inherited } = process.env;
  try {
    const { stdout, stderr } = await exec(process.execPath, [mailboxesScript, fixture.runDirectory], { env: { ...inherited, ...fakes, ...env }, timeout: 120_000 });
    return { exitCode: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: failure.code ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const readLog = async (path: string) => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
const partPath = (fixture: Fixture, mailboxId: string) => join(fixture.partsDirectory, `mail-${mailboxId}.json`);

test('each mailbox is read in turn and judged into a whole part, leaving dismissed threads out', async () => {
  await withFixture({ centrum: { messages: CENTRUM_MESSAGES }, snapyy11: { messages: [] } }, [CENTRUM, SECOND], async (fixture) => {
    const { exitCode, output } = await runMailboxes(fixture);
    assert.equal(exitCode, 0, output);

    const reads = await readLog(fixture.mailLog);
    assert.deepEqual(reads, [
      { command: 'read', account: 'centrum', options: ['--since', WINDOW.start, '--until', WINDOW.end] },
      { command: 'read', account: 'snapyy11', options: ['--since', WINDOW.start, '--until', WINDOW.end] },
    ]);
    const result = await readJson(join(fixture.runDirectory, 'result.json'));
    assert.ok(!Number.isNaN(Date.parse(result.endedAt)));
    assert.deepEqual(result.mailboxes, [{ id: 'centrum', state: 'read', reason: null }, { id: 'snapyy11', state: 'read', reason: null }]);

    const centrum: Mailbox = await readJson(partPath(fixture, 'centrum'));
    assert.deepEqual(
      { ...centrum, items: undefined, quiet: undefined },
      { ...CENTRUM, transport: 'imap', canSend: false, status: 'read', reason: null, items: undefined, quiet: undefined },
    );
    const [stroller, tickets, ...otherItems] = centrum.items;
    assert.equal(otherItems.length, 0, 'the newsletter and the renewed question are quiet; the dismissed parcel is left out');
    assert.equal(stroller.id, await idOf('centrum', STROLLER_THREAD));
    assert.equal(stroller.threadId, STROLLER_THREAD, 'a thread is named by its first message id');
    assert.equal(stroller.messageId, '4713', 'a reply answers the thread\'s newest message by its UID');
    assert.equal(stroller.from, 'Radek Pokorný');
    assert.equal(Date.parse(stroller.receivedAt), Date.parse('2026-11-18T21:00:00.000Z'));
    assert.equal(stroller.link, null);
    assert.equal(stroller.snippet, 'About: Re: Is the stroller still available?. Could you answer by Friday?');
    assert.deepEqual(stroller.options, [{
      kind: 'reply', gist: 'Still available', to: 'Radek Pokorný <radek@example.com>', subject: 'Re: Is the stroller still available?',
      where: null, body: 'Yes, it is still available.', attachments: [],
    }], 'Snooze beside a reply is dropped, as the app always offers it');
    assert.equal(tickets.threadId, '<tickets@example.com>');
    assert.deepEqual(tickets.options, [{ kind: 'event', title: 'Cinema', day: '2026-11-19', start: '20:00', end: '22:00', calendar: 'personal' }]);
    assert.deepEqual(centrum.quiet.map((entry: { subject: string }) => entry.subject).sort(), ['A question you dismissed', 'Weekly offers']);

    const second: Mailbox = await readJson(partPath(fixture, 'snapyy11'));
    assert.deepEqual(second, { ...SECOND, transport: 'imap', canSend: false, status: 'read', reason: null, items: [], quiet: [] });

    const judgingRuns = await readLog(fixture.modelLog);
    assert.equal(judgingRuns.length, 1, 'a mailbox without messages needs no judging run');
    const [{ args, prompt }] = judgingRuns;
    assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 3), ['--tools', '', '--strict-mcp-config'], 'the judging run has no tool');
    assert.equal(args[args.indexOf('--model') + 1], 'haiku');
    assert.ok(!prompt.includes('parcel'), 'a dismissed thread never reaches the model');
    assert.match(prompt, /Too much information/);
  });
});

test('a failed read gives its reason in plain words, and the next mailbox is still read', async () => {
  const declined = "Secret 'mail-centrum' is unavailable (not stored, or approval was declined).";
  const anonymous = { ...message(9002, '', '2026-11-18T10:00:00.000Z'), from: null };
  const secondMessages = [message(9001, 'Your tickets for Friday', '2026-11-18T09:00:00.000Z'), anonymous];
  await withFixture({ centrum: { failure: declined }, snapyy11: { messages: secondMessages } }, [CENTRUM, SECOND], async (fixture) => {
    const { exitCode } = await runMailboxes(fixture);
    assert.equal(exitCode, 2);
    const result = await readJson(join(fixture.runDirectory, 'result.json'));
    assert.deepEqual(result.mailboxes, [
      { id: 'centrum', state: 'failed', reason: 'Windows Hello was not approved, or the Centrum password is not stored on this computer. Press Start again and approve the prompt.' },
      { id: 'snapyy11', state: 'read', reason: null },
    ]);
    assert.ok(!existsSync(partPath(fixture, 'centrum')));
    const second: Mailbox = await readJson(partPath(fixture, 'snapyy11'));
    assert.equal(second.items[0].threadId, '9001', 'a message without ids is named by its UID');
    assert.equal(second.items[0].messageId, '9001');
    assert.deepEqual(second.quiet.map(({ from, subject }: { from: string; subject: string }) => ({ from, subject })), [{ from: 'Unknown sender', subject: '(no subject)' }]);
  });
});

test('an answer the judging run gets wrong twice fails that mailbox without a part', async () => {
  const garbled = [message(4720, 'Garbled offer', '2026-11-18T09:00:00.000Z')];
  await withFixture({ centrum: { messages: garbled }, snapyy11: { messages: [] } }, [CENTRUM, SECOND], async (fixture) => {
    const { exitCode } = await runMailboxes(fixture);
    assert.equal(exitCode, 2);
    const [centrum, second] = (await readJson(join(fixture.runDirectory, 'result.json'))).mailboxes;
    assert.equal(centrum.state, 'failed');
    assert.match(centrum.reason, /^Centrum was read, but sorting its mail failed: .+ Press Start to try again\.$/);
    assert.equal(second.state, 'read');
    assert.ok(!existsSync(partPath(fixture, 'centrum')));
    assert.equal((await readLog(fixture.modelLog)).length, 2, 'a refused answer is asked for once more');
  });
});

test('without the mpx checkout no mailbox is read, so no Windows Hello prompt is wasted', async () => {
  await withFixture({ centrum: { messages: CENTRUM_MESSAGES } }, [CENTRUM], async (fixture) => {
    const { exitCode } = await runMailboxes(fixture, {});
    assert.equal(exitCode, 2);
    const [centrum] = (await readJson(join(fixture.runDirectory, 'result.json'))).mailboxes;
    assert.equal(centrum.state, 'failed');
    assert.match(centrum.reason, /MPX_ACTIVE_CONTENT_ROOT/);
    assert.deepEqual(await readLog(fixture.mailLog), []);
  });
});

function documentWith(mailbox: Mailbox) {
  return {
    schemaVersion: 1,
    day: DAY,
    builtAt: '2026-11-19T06:10:00+01:00',
    window: WINDOW,
    sources: [],
    chapters: {
      calendar: { narration: [], calendars: [], days: [] },
      mail: { narration: [], mailboxes: [mailbox] },
      slack: { narration: [], items: [], handled: [], skippedCount: 0 },
      code: { narration: [], items: [], merged: [] },
      agents: { narration: [], items: [], quiet: [] },
      capture: { narration: [], notes: [], bookmarks: [], wishlists: [] },
      projects: { narration: [] },
      plan: { narration: [], reminders: [] },
    },
  };
}

test('a written part passes the app validator as a Mail mailbox', { skip: appSkip }, async () => {
  await withFixture({ centrum: { messages: CENTRUM_MESSAGES } }, [CENTRUM], async (fixture) => {
    await runMailboxes(fixture);
    const documentPath = join(fixture.home, 'validate', DAY, 'daily-brief.json');
    await mkdir(join(fixture.home, 'validate', DAY), { recursive: true });
    await writeFile(documentPath, JSON.stringify(documentWith(await readJson(partPath(fixture, 'centrum')))));
    const { stdout } = await exec(`pnpm --dir "${APP_DIRECTORY}" brief:validate "${documentPath}"`, { cwd: APP_DIRECTORY, shell: true, timeout: 120_000 } as never)
      .catch((error: { stdout?: string; stderr?: string }) => ({ stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` }));
    assert.match(stdout, /ok {7}mail/);
    assert.match(stdout, /Valid: every chapter can be shown\./);
  });
});
