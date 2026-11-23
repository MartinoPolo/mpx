#!/usr/bin/env node
// Start's run in the Alfred control center. Reads the IMAP mailboxes of <run directory>/run.json one at a time with
// Alfred's mail command, which asks Windows Hello for each password, so two prompts never overlap. One headless run
// without tools then sorts each mailbox's threads and drafts their replies following gatherers/mailboxes.md: mail
// text is untrusted, and a model without tools cannot act on it. Dismissed threads stay out unless a newer message
// arrived. Writes <partsDirectory>/mail-<mailbox id>.json whole, a complete Mail mailbox of the daily brief, and ends
// with result.json beside run.json naming every mailbox read or failed with its reason. Exit code 2 unless every
// mailbox was read.
// Usage: mailboxes.mjs <absolute run directory>
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { briefItemId } from './brief-id.mjs';
import { contentRoot, extractJson, readEnvelope, runHeadless, sessionLog, stopTree } from './headless.mjs';
import { localIso } from './local-time.mjs';

// The core stops the run at ten minutes; ending a minute earlier leaves time to write result.json.
const RUN_BUDGET_MILLISECONDS = 9 * 60 * 1000;
// The mail command waits up to two minutes for Windows Hello, then logs in and reads.
const READ_TIMEOUT_MILLISECONDS = 3 * 60 * 1000;
const JUDGING_TIMEOUT_MILLISECONDS = 3 * 60 * 1000;
const MINIMUM_STEP_MILLISECONDS = 20 * 1000;
const JUDGING_ATTEMPTS = 2;
const SHORT_LENGTH = 60;
const SNIPPET_LENGTH = 160;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const END_TIME_PATTERN = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
const SNOOZE = { kind: 'snooze' };
const promptPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'gatherers', 'mailboxes.md');

const [runDirectory] = process.argv.slice(2);
if (!runDirectory || !isAbsolute(runDirectory)) {
  console.error('Usage: mailboxes.mjs <absolute run directory>');
  process.exit(1);
}
let run;
try {
  run = JSON.parse((await readFile(join(runDirectory, 'run.json'), 'utf8')).replace(/^﻿/, ''));
} catch (error) {
  console.error(`No readable run.json in ${runDirectory}: ${error.message}`);
  await writeResult([]);
  process.exit(1);
}
const deadline = Date.now() + RUN_BUDGET_MILLISECONDS;
// The day folder: a session there runs under MPX_AI_RETAINED, which mpx launches without its ownership prompt.
const sessionDirectory = dirname(run.partsDirectory);
const dismissedAt = new Map((run.dismissed ?? []).map(({ id, at }) => [id, at]));

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const isText = (value) => text(value).length > 0;
const shorten = (value, length) => (value.length > length ? `${value.slice(0, length - 1)}…` : value);
const personOf = (person) => (person?.name ? `${person.name} <${person.address}>` : text(person?.address));
const senderOf = (message) => text(message.from?.name) || text(message.from?.address) || 'Unknown sender';
const subjectOf = (message) => text(message.subject) || '(no subject)';
const lastLine = (output) => output.trim().split(/\r?\n/).at(-1)?.trim() ?? '';

async function writeResult(results) {
  await writeFile(join(runDirectory, 'result.json'), `${JSON.stringify({ endedAt: new Date().toISOString(), mailboxes: results }, null, 2)}\n`);
}

/** The time a step may take: its own limit within what is left of the run. */
function stepTimeout(limitMilliseconds, step) {
  const left = deadline - Date.now();
  if (left < MINIMUM_STEP_MILLISECONDS) throw new Error(`Unlock ran out of time before ${step}. Press Unlock again.`);
  return Math.min(limitMilliseconds, left);
}

function runMailCommand(commandArguments, timeoutMilliseconds) {
  const [program, ...programArguments] = run.mailCommand;
  return new Promise((resolve) => {
    const child = spawn(program, [...programArguments, ...commandArguments], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stopTree(child); }, timeoutMilliseconds);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ error: error.message, stdout, stderr }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut, stdout, stderr }); });
  });
}

// The mail command's last stderr line is one sentence; the known ones are put in words that say what to do.
function readFailureReason(line, mailbox) {
  if (/^Secret '.*' is unavailable/.test(line)) {
    return `Windows Hello was not approved, or the ${mailbox.label} password is not stored on this computer. Press Unlock again and approve the prompt.`;
  }
  const waited = line.match(/^Secret '.*' timed out after (\d+) seconds/);
  if (waited) return `Windows Hello was not approved within ${waited[1]} seconds. Press Unlock again and approve the prompt.`;
  if (/^Login to .* failed/.test(line)) return `The ${mailbox.label} mail server refused the login; check the password stored for it. (${line})`;
  if (/^Unknown account/.test(line)) return `Alfred's mail command does not know the ${mailbox.label} mailbox. (${line})`;
  return line;
}

async function readMessages(mailbox) {
  const timeoutMilliseconds = stepTimeout(READ_TIMEOUT_MILLISECONDS, `reading ${mailbox.label}`);
  // The mail command names an account as its server does, which is the mailbox id.
  const outcome = await runMailCommand(['read', mailbox.id, '--since', run.window.start, '--until', run.window.end], timeoutMilliseconds);
  if (outcome.error) throw new Error(`Alfred's mail command could not start: ${outcome.error}`);
  if (outcome.timedOut) {
    throw new Error(`Reading ${mailbox.label} took over ${Math.round(timeoutMilliseconds / 60000)} minutes, so Unlock stopped it. Press Unlock again and approve the Windows Hello prompt.`);
  }
  if (outcome.code !== 0) {
    const line = lastLine(outcome.stderr);
    throw new Error(line ? readFailureReason(line, mailbox) : `Alfred's mail command failed reading ${mailbox.label} without saying why.`);
  }
  let answer;
  try {
    answer = JSON.parse(outcome.stdout);
  } catch {
    throw new Error(`Alfred's mail command gave an answer for ${mailbox.label} that is not JSON.`);
  }
  if (!Array.isArray(answer?.messages)) throw new Error(`Alfred's mail command answered for ${mailbox.label} without a messages list.`);
  return answer.messages.filter((message) => Number.isInteger(message?.uid) && !Number.isNaN(Date.parse(message.date)));
}

/** The window's messages by thread, oldest first in each, as the IMAP ids of the contract name them. */
function threadsOf(mailbox, messages) {
  const threads = new Map();
  for (const message of messages) {
    const threadId = text(message.threadMessageId) || text(message.messageId) || String(message.uid);
    threads.set(threadId, [...(threads.get(threadId) ?? []), message]);
  }
  return [...threads].map(([threadId, threadMessages]) => {
    const ordered = threadMessages.sort((left, right) => Date.parse(left.date) - Date.parse(right.date));
    return { id: briefItemId('mail', mailbox.id, threadId), threadId, messages: ordered, newest: ordered.at(-1) };
  });
}

// A dismissed thread returns only with a message that arrived after its dismissal.
function isDismissed(thread) {
  return dismissedAt.has(thread.id) && !(Date.parse(thread.newest.date) > Date.parse(dismissedAt.get(thread.id)));
}

function judgingInput(mailbox, threads, taste) {
  const modelThreads = threads.map((thread, index) => ({
    key: `t${index + 1}`,
    subject: subjectOf(thread.newest),
    messages: thread.messages.map((message) => ({
      from: personOf(message.from) || 'no sender',
      to: (message.to ?? []).map(personOf),
      cc: (message.cc ?? []).map(personOf),
      receivedAt: localIso(new Date(message.date)),
      subject: subjectOf(message),
      text: typeof message.text === 'string' ? message.text : '',
      textCut: Boolean(message.textTruncated),
    })),
  }));
  return [
    taste.trim() ? `The reader's taste:\n\n${taste.trim()}\n` : 'The reader has written no taste yet.\n',
    `Mailbox: ${mailbox.label} (${mailbox.account}).`,
    'The threads:',
    JSON.stringify(modelThreads),
  ].join('\n');
}

function optionsRefusal(options) {
  if (!Array.isArray(options) || options.length === 0) return 'an act thread needs at least one option';
  if (options.filter((option) => option?.kind === 'reply').length > 1) return 'it lists more than one reply';
  for (const option of options) {
    if (option?.kind === 'reply') {
      if (!isText(option.gist) || !isText(option.body)) return 'a reply needs a gist and a body';
    } else if (option?.kind === 'event') {
      const { title, day, start, end } = option;
      if (!isText(title) || !DAY_PATTERN.test(day) || !TIME_PATTERN.test(start) || !END_TIME_PATTERN.test(end) || end <= start) {
        return 'an event needs a title, a day written YYYY-MM-DD, and a start before its end written HH:MM';
      }
    } else if (option?.kind !== 'snooze') {
      return `${JSON.stringify(option?.kind)} is not reply, event or snooze`;
    }
  }
  return null;
}

/** Why an answer cannot stand, or null when it judges every thread once. */
function refusalOf(answer, keys) {
  if (!Array.isArray(answer?.threads)) return 'the answer has no threads list';
  const answered = new Set();
  for (const judged of answer.threads) {
    if (!keys.includes(judged?.key)) return `${JSON.stringify(judged?.key)} is not a thread key`;
    if (answered.has(judged.key)) return `thread ${judged.key} is answered twice`;
    answered.add(judged.key);
    if (judged.class === 'quiet') continue;
    if (judged.class !== 'act') return `thread ${judged.key} is neither act nor quiet`;
    const refusal = optionsRefusal(judged.options);
    if (refusal) return `thread ${judged.key}: ${refusal}`;
  }
  const missing = keys.filter((key) => !answered.has(key));
  return missing.length > 0 ? `threads ${missing.join(', ')} have no answer` : null;
}

async function judge(mailbox, threads) {
  const taste = await readFile(join(sessionDirectory, '..', 'taste.md'), 'utf8').catch(() => '');
  const systemPrompt = (await readFile(promptPath, 'utf8')).replaceAll('%TODAY%', run.day);
  const input = judgingInput(mailbox, threads, taste);
  const keys = threads.map((_, index) => `t${index + 1}`);
  const logs = [];
  let prompt = input;
  try {
    for (let attempt = 1; attempt <= JUDGING_ATTEMPTS; attempt++) {
      const timeoutMilliseconds = stepTimeout(JUDGING_TIMEOUT_MILLISECONDS, `sorting the ${mailbox.label} mail`);
      const outcome = await runHeadless({ account: 'personal', model: run.model, tools: [], systemPrompt, prompt, cwd: sessionDirectory, timeoutMilliseconds });
      logs.push(`--- attempt ${attempt} ---\n${sessionLog(outcome)}`);
      const envelope = readEnvelope(outcome, timeoutMilliseconds);
      let answer;
      let refusal;
      try {
        answer = extractJson(String(envelope.result ?? ''));
        refusal = refusalOf(answer, keys);
      } catch (error) {
        refusal = `the answer is not JSON: ${error.message}`;
      }
      if (!refusal) {
        console.log(`${mailbox.id}: judged in ${attempt} attempt(s), ${envelope.num_turns ?? '?'} turn(s), $${envelope.total_cost_usd ?? '?'}.`);
        return new Map(answer.threads.map((judged) => [judged.key, judged]));
      }
      if (attempt === JUDGING_ATTEMPTS) throw new Error(`the answer was refused twice, last because ${refusal}.`);
      prompt = `${input}\n\nYour previous answer was refused because ${refusal}. Answer again with the JSON object only.`;
    }
  } catch (error) {
    throw new Error(`${mailbox.label} was read, but sorting its mail failed: ${error.message.replace(/\.?$/, '.')} Press Unlock to try again.`);
  } finally {
    await writeFile(join(runDirectory, `judge-${mailbox.id}.log`), logs.join('\n'));
  }
}

// The app always offers Snooze, so it is listed only when nothing else is suggested.
function messageOptions(judgedOptions, thread) {
  const sender = thread.newest.from?.address ? personOf(thread.newest.from) : null;
  const subject = subjectOf(thread.newest);
  const suggestions = judgedOptions.flatMap((option) => {
    if (option.kind === 'reply') {
      if (!sender) return [];
      const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
      return [{ kind: 'reply', gist: text(option.gist), to: sender, subject: replySubject, where: null, body: option.body.trim(), attachments: [] }];
    }
    if (option.kind === 'event') return [{ kind: 'event', title: text(option.title), day: option.day, start: option.start, end: option.end, calendar: 'personal' }];
    return [];
  });
  return suggestions.length > 0 ? suggestions : [SNOOZE];
}

function mailItem(thread, judgedOptions) {
  const { newest } = thread;
  const from = senderOf(newest);
  const subject = subjectOf(newest);
  const body = text(newest.text).replace(/\s+/g, ' ');
  return {
    id: thread.id,
    short: shorten(`${from}: ${subject}`, SHORT_LENGTH),
    link: null,
    options: messageOptions(judgedOptions, thread),
    threadId: thread.threadId,
    messageId: String(newest.uid),
    from,
    receivedAt: localIso(new Date(newest.date)),
    subject,
    snippet: shorten(body || subject, SNIPPET_LENGTH),
  };
}

async function writePart(part) {
  const partPath = join(run.partsDirectory, `mail-${part.id}.json`);
  await writeFile(`${partPath}.tmp`, `${JSON.stringify(part, null, 2)}\n`);
  await rename(`${partPath}.tmp`, partPath);
}

async function readMailbox(mailbox) {
  const messages = await readMessages(mailbox);
  const threads = threadsOf(mailbox, messages).filter((thread) => !isDismissed(thread))
    .sort((left, right) => Date.parse(right.newest.date) - Date.parse(left.newest.date));
  const judged = threads.length > 0 ? await judge(mailbox, threads) : new Map();
  const items = [];
  const quiet = [];
  threads.forEach((thread, index) => {
    const judgement = judged.get(`t${index + 1}`);
    if (judgement.class === 'act') items.push(mailItem(thread, judgement.options));
    else quiet.push({ from: senderOf(thread.newest), receivedAt: localIso(new Date(thread.newest.date)), subject: subjectOf(thread.newest) });
  });
  const { id, label, provider, account } = mailbox;
  await writePart({ id, label, provider, account, transport: 'imap', canSend: false, status: 'read', reason: null, items, quiet });
  console.log(`${id}: read, ${items.length} to act on, ${quiet.length} quiet, ${messages.length - threads.reduce((count, thread) => count + thread.messages.length, 0)} dismissed messages left out.`);
}

const preflightReason = contentRoot() ? null : 'Unlock cannot sort mail: MPX_ACTIVE_CONTENT_ROOT does not point to the mpx checkout.';
const results = [];
await mkdir(run.partsDirectory, { recursive: true });
for (const mailbox of run.mailboxes) {
  try {
    if (preflightReason) throw new Error(preflightReason);
    await readMailbox(mailbox);
    results.push({ id: mailbox.id, state: 'read', reason: null });
  } catch (error) {
    console.log(`${mailbox.id}: failed (${error.message})`);
    results.push({ id: mailbox.id, state: 'failed', reason: error.message });
  }
}
await writeResult(results);
process.exit(results.every((result) => result.state === 'read') ? 0 : 2);
