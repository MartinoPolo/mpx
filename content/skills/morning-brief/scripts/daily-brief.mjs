#!/usr/bin/env node
// Writes <day>/daily-brief.json, the document the Alfred control center serves, and checks it with the app's
// validator. Calendar, mail and Slack come from the gatherers' sources, Code and Agents from the session's brief.json
// (Code only for the active repositories of sources/repos.json and the reviews requested from me, naming each change
// left out), the capture lines and move destinations from sources/triage.json, bookmarks from the bookmarks bridge, AI
// news from sources/news.json with the picks and summaries of sources/news-digest.json; sources/triage-judgement.json
// and <day>/daily-brief.judgement.json add the judgement and <day>/daily-brief.clips.json the narration's clips. The
// latest outcome the app wrote leaves out dismissed items and kept lines and brings back snoozed and undecided ones. Prints the items with their ids, every item and bookmark still
// without judgement with its default, the move destinations, the open health episode notes by path (never their
// contents), and a summary line counting what is unjudged and the narration sentences without a clip and naming the
// chapters without narration, and keeps the same report in <day>/daily-brief.log. Unless --no-state, records the brief
// in <home>/state.json as the last one, so start.mjs begins the next window where this one ended. Exit code 2 when the
// document is invalid or could not be validated.
// Usage: daily-brief.mjs <day-directory> [--no-state]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { briefItemId } from './brief-id.mjs';
import {
  DOCUMENT_CLIPS_FILE, documentSentences, JUDGEMENT_FILE, NARRATION_SENTENCE_LIMIT, NEWS_DIGEST_FILE, NEWS_FILE, TRIAGE_FILE, TRIAGE_JUDGEMENT_FILE,
} from './document-narration.mjs';
import { localIso } from './local-time.mjs';
import { nestedLines, readNote } from './note-lines.mjs';
import { sessionIdOfTranscript } from './session-id.mjs';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAIL_ADDRESS_PATTERN = /^[^\s@<>,]+@[^\s@<>,]+$/;
const END_OF_DAY = '24:00';
const SHORT_LENGTH = 60;
const VALIDATOR_TIMEOUT_MILLISECONDS = 120_000;
const CALENDAR_NAMES = { work: 'Work', personal: 'Personal', wife: 'Wife' };
const FORGES = ['github', 'gitlab'];
const AGENT_OUTCOMES = { ok: 'succeeded', fail: 'failed', check: 'blocked', partial: 'running' };
// A partial run that ended stopped short of its goal; only its own end time says so, as a running one has a duration.
const ENDED_PARTIAL_OUTCOME = 'blocked';
const ALERT_SENDERS = { sentry: 'Sentry', pipeline: 'Pipeline', monitoring: 'Monitoring' };
const IMAP_REASON = 'Not read yet: its password needs your Windows Hello approval, so Unlock reads it at the desk.';
// Projects targets are Orca's project names, which only the app reads; Plan and Health sentences target nothing.
const UNCHECKED_TARGET_CHAPTERS = ['projects'];
const UNTARGETED_CHAPTERS = ['plan', 'health'];
const MEDICAL_RECORDS_FOLDER = 'Medical records';
const FRONTMATTER_FENCE = /^---\s*$/;
// The app's vault writers: a move or delete takes the line out, refused while lines are nested under it; done and
// progress change the checkbox, refused on a plain bullet.
const REMOVING_ACTIONS = ['move', 'delete'];
const CHECKBOX_ACTIONS = ['done', 'progress'];
const SEEN = { kind: 'seen' };
const SNOOZE = { kind: 'snooze' };
// A card state that needs a decision, with the options suggested until the session judges the item. The app
// always offers Snooze and Dismiss, so a list with a real suggestion does not repeat them.
const CODE_STATE_OPTIONS = {
  ready: [{ kind: 'action', label: 'Merge', icon: 'git-merge', execution: { kind: 'merge' } }],
  failing: [{ kind: 'action', label: 'Rerun', icon: 'rotate-ccw', execution: { kind: 'rerun' } }],
  review: [{ kind: 'action', label: 'Review today', icon: 'eye', execution: { kind: 'reminder' } }],
};
// The judgement's value for an item whose default options or capture suggestion stand.
const ACCEPT_DEFAULT = 'default';
const OPTION_LABELS = { snooze: 'Snooze', seen: 'Dismiss', reply: 'Reply', event: 'Event', task: 'Task' };
const KEEP_LINE = { action: 'keep', destination: null, wording: null, priority: null, because: null, link: null };

const { positionals, values } = parseArgs({ allowPositionals: true, options: { 'no-state': { type: 'boolean' } } });
const [dayDirectory] = positionals;
if (!dayDirectory || !isAbsolute(dayDirectory)) {
  console.error('Usage: daily-brief.mjs <absolute day directory> [--no-state]');
  process.exit(1);
}
const day = basename(dayDirectory);
const problems = [];

async function readJson(path) {
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''));
  } catch (error) {
    if (error.code !== 'ENOENT') problems.push(`${path} is unreadable: ${error.message}`);
    return undefined;
  }
}

const start = await readJson(join(dayDirectory, 'start.json'));
if (!DAY_PATTERN.test(day) || !Array.isArray(start?.calendarDays)) {
  console.error(`${dayDirectory} is not a day folder with a start.json; run start.mjs first.`);
  process.exit(1);
}
const personal = gathererResult(await readJson(join(dayDirectory, 'sources', 'personal.json')), 'personal');
const work = gathererResult(await readJson(join(dayDirectory, 'sources', 'work.json')), 'work');
const brief = await readJson(join(dayDirectory, 'brief.json'));
const repositories = await readJson(join(dayDirectory, 'sources', 'repos.json'));
// The document sits in <home>/work/morning-brief/<day>; the bookmarks bridge writes <home>/work/bookmarks.
const capture = await readJson(join(dayDirectory, '..', '..', 'bookmarks', 'capture.json'));
const judgement = (await readJson(join(dayDirectory, JUDGEMENT_FILE))) ?? {};
const triage = await readJson(join(dayDirectory, TRIAGE_FILE));
// The session's judgement may replace a suggestion of the triage area.
const noteSuggestions = { ...(await readJson(join(dayDirectory, TRIAGE_JUDGEMENT_FILE))), ...judgement.notes };
const clipsByText = (await readJson(join(dayDirectory, DOCUMENT_CLIPS_FILE))) ?? {};
const news = await readJson(join(dayDirectory, NEWS_FILE));
const newsDigest = await readJson(join(dayDirectory, NEWS_DIGEST_FILE));
const vaultDirectory = process.env.MPX_OBSIDIAN_VAULT;
const noteLineCache = new Map();
const mailPeopleByItemId = new Map();
const codeLeftOut = [];
const capturedBookmarkIds = new Set((capture?.bookmarks ?? []).map((bookmark) => String(bookmark.id)));

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const link = (value) => (typeof value === 'string' && URL.canParse(value) ? value : null);
const isInstant = (value) => typeof value === 'string' && INSTANT_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
const shorten = (value) => (value.length > SHORT_LENGTH ? `${value.slice(0, SHORT_LENGTH - 1)}…` : value);
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const texts = (values) =>(Array.isArray(values) ? values.map(text).filter(Boolean) : []);
const idsIn = (list) => (Array.isArray(list) ? list : []).map((entry) => (typeof entry === 'string' ? entry : entry?.id)).filter(Boolean);

function gathererResult(record, name) {
  if (!record) return { data: undefined, status: 'not-read', reason: `The ${name} gatherer left no result.` };
  if (record.status !== 'ok') return { data: undefined, status: 'not-read', reason: record.reason ?? `The ${name} gatherer failed.` };
  return { data: record.data ?? {}, status: 'read', reason: null };
}

function briefChapter(type) {
  return brief?.chapters?.find((chapter) => chapter.type === type);
}

function briefChapterSource(name, type) {
  if (!brief) return { name, status: 'not-read', reason: 'The session wrote no brief.json.' };
  const chapter = briefChapter(type);
  if (!chapter) return { name, status: 'not-read', reason: `brief.json has no ${type} chapter.` };
  if (chapter.status === 'unavailable') return { name, status: 'not-read', reason: text(chapter.detail) || 'The area was unavailable.' };
  return { name, status: 'read', reason: null };
}

function triageSource() {
  const name = 'Obsidian triage';
  if (!Array.isArray(triage?.captures)) return { name, status: 'not-read', reason: 'No readable sources/triage.json; triage.mjs did not run or found no vault.' };
  return { name, status: 'read', reason: null };
}

function captureSource() {
  const name = 'Bookmarks bridge';
  if (!capture) return { name, status: 'not-read', reason: 'The bridge has written no capture.json.' };
  if (capture.error) return { name, status: 'not-read', reason: String(capture.error) };
  return { name, status: 'read', reason: null };
}

// The clip narrate.mjs voiced for a sentence's exact text, while its file is still in audio/.
function clipOf(sentenceText) {
  const clip = typeof sentenceText === 'string' && Object.hasOwn(clipsByText, sentenceText) ? clipsByText[sentenceText] : undefined;
  const isClip = typeof clip?.audio === 'string' && Number.isFinite(clip.audioSeconds) && clip.audioSeconds > 0;
  return isClip && existsSync(join(dayDirectory, 'audio', clip.audio)) ? { audio: clip.audio, audioSeconds: clip.audioSeconds } : {};
}

// A chapter keeps its first sentences, each with its clip; the rest is reported.
function narrationOf(chapterName) {
  const sentences = documentSentences(judgement, newsDigest, chapterName);
  if (sentences.length > NARRATION_SENTENCE_LIMIT) {
    const cut = sentences.slice(NARRATION_SENTENCE_LIMIT).map((sentence) => `"${shorten(text(sentence?.text))}"`).join(', ');
    problems.push(`${chapterName} narration has ${sentences.length} sentences; kept the first two, cut ${cut}.`);
  }
  return sentences.slice(0, NARRATION_SENTENCE_LIMIT).map((sentence) => ({ text: sentence?.text, targets: sentence?.targets, ...clipOf(sentence?.text) }));
}

// The text of every list line of a vault note, as the app finds a task: without its marker and checkbox. A started
// line (`[/]`) is no capture: it is work in progress or a line handed to research. The app refuses to move, tick or
// delete a line with lines nested under it.
async function noteLines(notePath) {
  if (!noteLineCache.has(notePath)) {
    const entries = readNote(await readFile(join(vaultDirectory, notePath), 'utf8').catch(() => ''));
    const open = new Set();
    const started = new Set();
    const nested = new Set();
    const plain = new Set();
    entries.forEach((entry, index) => {
      if (entry.kind !== 'list' || !entry.text) return;
      (entry.box === '/' ? started : open).add(entry.text);
      if (entry.box === null) plain.add(entry.text);
      if (nestedLines(entries, index).length > 0) nested.add(entry.text);
    });
    noteLineCache.set(notePath, { open, started, nested, plain });
  }
  return noteLineCache.get(notePath);
}

// As the app reads an episode note: open while its frontmatter has `illness` and `ended` is empty or missing.
function isOpenEpisode(noteText) {
  const lines = noteText.replace(/^﻿/, '').split(/\r?\n/);
  const closingIndex = FRONTMATTER_FENCE.test(lines[0]) ? lines.findIndex((line, index) => index > 0 && FRONTMATTER_FENCE.test(line)) : -1;
  if (closingIndex === -1) return false;
  const fields = new Map();
  for (const line of lines.slice(1, closingIndex)) {
    const key = line.match(/^([^\s:#][^:]*):/)?.[1]?.trim();
    if (key !== undefined && !fields.has(key)) fields.set(key, line.replace(/^[^:]*:/, '').trim().replace(/^(["'])(.*)\1$/, '$2').trim());
  }
  return fields.has('illness') && !fields.get('ended');
}

// The vault paths of the open episode notes directly in Medical records/, the conditions the hints are keyed by.
async function openEpisodePaths() {
  if (!vaultDirectory) return [];
  const folder = join(vaultDirectory, MEDICAL_RECORDS_FOLDER);
  const noteNames = (await readdir(folder, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name).sort();
  const paths = [];
  for (const noteName of noteNames) {
    if (isOpenEpisode(await readFile(join(folder, noteName), 'utf8').catch(() => ''))) paths.push(`${MEDICAL_RECORDS_FOLDER}/${noteName}`);
  }
  return paths;
}

function healthHints(episodePaths) {
  return (Array.isArray(judgement.hints) ? judgement.hints : []).filter((hint) => {
    if (episodePaths.includes(hint?.conditionId)) return true;
    problems.push(`A hint names ${hint?.conditionId}, which is not an open episode note; left out.`);
    return false;
  });
}

async function isNoteLineOpen(notePath, lineText) {
  return !vaultDirectory || (await noteLines(notePath)).open.has(lineText);
}

// What the app's writers would refuse for a capture line already read: `nested` and `plain` are both false without a vault.
function lineShapeOf({ notePath, lineText }) {
  const lines = noteLineCache.get(notePath);
  return { nested: Boolean(lines?.nested.has(lineText)), plain: Boolean(lines?.plain.has(lineText)) };
}

function calendarChapter() {
  const assignments = judgement.calendars ?? {};
  const calendarTargets = new Map();
  const eventsById = new Map();
  // Personal first: the work account's titled copy of a work event replaces the busy block the personal account sees.
  for (const [result, isWorkAccount] of [[personal, false], [work, true]]) {
    for (const calendar of result.data?.calendars ?? []) {
      const ownTarget = isWorkAccount || calendar.access === 'freeBusy' ? 'work' : calendar.access === 'owner' ? 'personal' : 'skip';
      calendarTargets.set(calendar.id, assignments[calendar.id] ?? ownTarget);
    }
    for (const event of result.data?.events ?? []) {
      const known = eventsById.get(event.id);
      if (!known || (!text(known.title) && text(event.title))) eventsById.set(event.id, event);
    }
  }
  const days = start.calendarDays.map((date) => ({ date, allDay: [], events: [] }));
  const shownCalendars = new Set();
  for (const event of eventsById.values()) {
    const calendar = calendarTargets.get(event.calendarId) ?? assignments[event.calendarId] ?? 'skip';
    const calendarDay = days.find((candidate) => candidate.date === event.day);
    if (calendar === 'skip' || !calendarDay) continue;
    if (!Object.hasOwn(CALENDAR_NAMES, calendar)) {
      problems.push(`Calendar ${event.calendarId} is assigned to "${calendar}"; use work, personal, wife or skip.`);
      continue;
    }
    const title = text(event.title) || 'Busy';
    if (event.allDay) {
      calendarDay.allDay.push({ title, calendar, link: link(event.url) });
    } else {
      const eventStart = text(event.start);
      if (!TIME_PATTERN.test(eventStart)) {
        problems.push(`Calendar event "${title}" on ${event.day} has no start time; left out.`);
        continue;
      }
      // An event running past midnight, or ending at it, ends with the day.
      const eventEnd = TIME_PATTERN.test(text(event.end)) && text(event.end) > eventStart ? text(event.end) : END_OF_DAY;
      calendarDay.events.push({ start: eventStart, end: eventEnd, title, calendar, place: text(event.place) || null, link: link(event.url) });
    }
    shownCalendars.add(calendar);
  }
  for (const calendarDay of days) calendarDay.events.sort((left, right) => left.start.localeCompare(right.start));
  const calendars = Object.keys(CALENDAR_NAMES).filter((id) => shownCalendars.has(id))
    .map((id) => ({ id, name: judgement.calendarNames?.[id] ?? CALENDAR_NAMES[id] }));
  return { narration: narrationOf('calendar'), calendars, days };
}

function threadIdOf(mail) {
  return text(mail.url).match(/#[^/]+\/([^/?#]+)$/)?.[1] ?? text(mail.id);
}

function mailMessage(mail, { options, ...message }) {
  const threadId = threadIdOf(mail);
  if (!threadId || !isInstant(message.receivedAt)) {
    problems.push(`Mail "${message.subject}" has no thread id or no received time with a zone; left out.`);
    return undefined;
  }
  const messageId = text(mail.messageId) || null;
  const short = shorten(`${message.from}: ${message.subject}`);
  return { id: briefItemId('mail', threadId), short, link: link(mail.url), options, threadId, messageId, ...message };
}

// A gathered `Name <address>` or bare address.
function mailPerson(entry) {
  const value = text(entry);
  const named = value.match(/^(.*?)\s*<([^<>]+)>$/);
  const address = (named ? named[2] : value).trim();
  return MAIL_ADDRESS_PATTERN.test(address) ? { name: named ? named[1].trim() : '', address } : undefined;
}

const recipientLine = ({ name, address }) => (name ? `${name} <${address}>` : address);

// The sender of the message a reply answers, then its other recipients, as the gatherer read them.
function mailPeople(mail) {
  const fromAddress = text(mail.fromAddress);
  const sender = MAIL_ADDRESS_PATTERN.test(fromAddress) ? { name: text(mail.from), address: fromAddress } : undefined;
  return { sender, everyone: [sender, ...texts(mail.otherRecipients).map(mailPerson)].filter(Boolean) };
}

// The judgement names a reply's recipients; the app sends only to addresses, so each is written Name <address>.
function addressedReply(option, item, people) {
  if (option.kind !== 'reply') return option;
  const entries = text(option.to).split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    if (people.sender) return { ...option, to: recipientLine(people.sender) };
    problems.push(`A reply to "${item.short}" names no recipient, and the mail has no sender address.`);
    return option;
  }
  const to = entries.map((entry) => {
    if (mailPerson(entry)) return entry;
    const person = people.everyone.find((candidate) => candidate.name.toLowerCase() === entry.toLowerCase());
    if (person) return recipientLine(person);
    problems.push(`A reply to "${item.short}" names "${entry}" without an address; the app refuses it until To has one.`);
    return entry;
  });
  return { ...option, to: to.join(', ') };
}

function quietMail({ from, received, subject }) {
  if (!isInstant(received)) return undefined;
  return { from: text(from) || 'Unknown sender', receivedAt: received, subject: text(subject) || '(no subject)' };
}

function connectorMailbox(id, label, result) {
  const data = result.data ?? {};
  const primaryCalendar = (data.calendars ?? []).find((calendar) => calendar.primary)?.id;
  const items = [];
  const quiet = [];
  for (const mail of data.mail ?? []) {
    if (mail.class !== 'act') {
      quiet.push(quietMail(mail));
      continue;
    }
    const from = text(mail.from) || 'Unknown sender';
    const subject = text(mail.subject) || '(no subject)';
    const snippet = text(mail.snippet) || text(mail.summary) || subject;
    const item = mailMessage(mail, { from, receivedAt: text(mail.received), subject, snippet, options: [SNOOZE] });
    if (item) mailPeopleByItemId.set(item.id, mailPeople(mail));
    items.push(item);
  }
  for (const alert of data.alerts ?? []) {
    const from = ALERT_SENDERS[alert.kind] ?? 'Alert';
    const subject = text(alert.title) || 'Alert';
    const receivedAt = text(alert.last) || text(alert.first);
    if (alert.resolved) {
      quiet.push(quietMail({ from, received: receivedAt, subject }));
      continue;
    }
    const snippet = [text(alert.project), alert.count > 1 ? `${alert.count} times` : ''].filter(Boolean).join(', ') || subject;
    items.push(mailMessage(alert, { from, receivedAt, subject, snippet, options: [SEEN] }));
  }
  quiet.push(...(data.quiet ?? []).map(quietMail));
  return {
    id,
    label,
    provider: 'gmail',
    account: text(data.account) || primaryCalendar || label,
    transport: 'connector',
    canSend: true,
    status: result.status,
    reason: result.reason,
    items: items.filter(Boolean),
    quiet: quiet.filter(Boolean),
  };
}

function imapMailbox(mailbox) {
  return {
    id: mailbox.id,
    label: mailbox.label,
    provider: mailbox.provider,
    account: mailbox.account,
    transport: 'imap',
    canSend: false,
    status: 'not-read',
    reason: IMAP_REASON,
    items: [],
    quiet: [],
  };
}

function mailChapter(imapMailboxes) {
  const mailboxes = [connectorMailbox('personal', 'Personal', personal), connectorMailbox('work', 'Work', work), ...imapMailboxes];
  return { narration: narrationOf('mail'), mailboxes };
}

function slackPost(message) {
  const channel = text(message.channel) || 'Slack';
  const author = text(message.author) || 'Unknown';
  // Slack's own permalink, never one built from the channel and timestamp.
  const permalink = link(message.url);
  if (!permalink || !isInstant(message.when)) {
    problems.push(`Slack message from ${author} in ${channel} has no permalink or no posted time with a zone; left out.`);
    return undefined;
  }
  return { channel, author, postedAt: message.when, text: text(message.text) || text(message.summary) || '(no text)', permalink };
}

function slackChapter() {
  const slack = work.data?.slack ?? {};
  const items = [];
  const handled = [];
  const messages = [...(slack.directed ?? []).map((message) => [message, true]), ...(slack.interesting ?? []).map((message) => [message, false])];
  for (const [message, isDirected] of messages) {
    const post = slackPost(message);
    if (!post) continue;
    if (isDirected && message.answered) {
      handled.push(post);
      continue;
    }
    const reactions = (Array.isArray(message.reactions) ? message.reactions : [])
      .map((reaction) => ({ emoji: text(reaction?.emoji), users: texts(reaction?.users) }))
      .filter((reaction) => reaction.emoji);
    items.push({
      id: briefItemId('slack', post.permalink),
      short: shorten(`${post.author}: ${text(message.summary) || post.text}`),
      link: post.permalink,
      options: [isDirected ? SNOOZE : SEEN],
      ...post,
      repliers: texts(message.repliers),
      reactions,
    });
  }
  const skippedCount = Number.isInteger(slack.skipped) && slack.skipped >= 0 ? slack.skipped : 0;
  return { narration: narrationOf('slack'), items, handled, skippedCount };
}

function codeChips(card) {
  const chips = [];
  if (card.state === 'ready') chips.push({ label: 'approved', tone: 'good' });
  if (card.state === 'review') chips.push({ label: text(card.author) ? `review · ${text(card.author)}` : 'waiting for review', tone: 'neutral' });
  const pipeline = card.pipeline ?? {};
  if (pipeline.status === 'success') chips.push({ label: 'checks', tone: 'good' });
  if (pipeline.status === 'failed') chips.push({ label: `${text(pipeline.job) || 'checks'} failed`, tone: 'bad' });
  if (pipeline.status === 'running') chips.push({ label: 'checks running', tone: 'neutral' });
  return chips;
}

const repositoryKey = (host, fullName) => `${host}/${fullName}`.toLowerCase();

// The repository of a pull or merge request, read from its address: the host and the path before /pull/ or
// /-/merge_requests/.
function changeRepositoryKey(address) {
  const url = URL.canParse(address) ? new URL(address) : undefined;
  const fullName = url?.pathname.match(/^\/(.+?)\/(?:pull|-\/merge_requests)\/\d+/)?.[1];
  return fullName ? repositoryKey(url.hostname, fullName) : undefined;
}

function activeRepositoryKeys() {
  if (!Array.isArray(repositories?.repositories)) {
    problems.push('No readable sources/repos.json, so Code shows only the reviews requested from you; run repos.mjs.');
    return new Set();
  }
  return new Set(repositories.repositories.filter((repository) => repository.active === true && repository.remote)
    .map((repository) => repositoryKey(repository.remote.host, repository.remote.fullName)));
}

function codeChapter() {
  const items = [];
  const merged = [];
  const activeKeys = activeRepositoryKeys();
  for (const project of briefChapter('work')?.data?.projects ?? []) {
    const projectName = text(project.name) || text(project.id);
    const cards = (project.cards ?? []).filter((card) => card.state === 'merged' || CODE_STATE_OPTIONS[card.state]);
    if (!FORGES.includes(project.app)) {
      if (cards.length) problems.push(`${projectName}: ${project.app} changes are left out; the app shows GitHub and GitLab.`);
      continue;
    }
    for (const card of cards) {
      const reference = { label: text(card.ref), link: link(card.url) };
      if (!reference.label || !reference.link) continue;
      if (card.reviewRequested !== true && !activeKeys.has(changeRepositoryKey(reference.link))) {
        codeLeftOut.push(`${projectName} ${reference.label} ${reference.link}`);
        continue;
      }
      const title = text(card.title) || reference.label;
      if (card.state === 'merged') {
        merged.push({ forge: project.app, projectName, reference, title });
        continue;
      }
      items.push({
        // The state is part of the id: a dismissed pull request returns once its state changes.
        id: briefItemId('code', reference.link, card.state),
        short: shorten(`${projectName} ${reference.label} ${title}`),
        link: reference.link,
        options: CODE_STATE_OPTIONS[card.state],
        forge: project.app,
        projectName,
        reference,
        title,
        chips: codeChips(card),
      });
    }
  }
  return { narration: narrationOf('code'), items, merged };
}

function agentsChapter() {
  const projectNames = new Map((brief?.projects ?? []).map((project) => [project.id, project.name]));
  const items = [];
  for (const run of briefChapter('overnight')?.data?.runs ?? []) {
    const projectName = text(projectNames.get(run.project)) || text(run.project) || 'unknown';
    const title = text(run.title) || 'Run';
    const outcome = run.outcome === 'partial' && isInstant(run.endedAt) ? ENDED_PARTIAL_OUTCOME : AGENT_OUTCOMES[run.outcome];
    const startedAt = isInstant(run.startedAt) ? run.startedAt : undefined;
    if (!outcome || !startedAt) {
      problems.push(`Overnight run "${title}" has no known outcome or no startedAt instant; left out.`);
      continue;
    }
    const logTail = Array.isArray(run.logTail) ? run.logTail.filter((line) => typeof line === 'string') : [];
    const sourceReference = text(run.session) || text(run.url) || `${projectName} ${new Date(startedAt).toISOString()} ${title}`;
    const links = (Array.isArray(run.links) ? run.links : [])
      .map((entry) => ({ label: text(entry?.label), link: link(entry?.link) }))
      .filter((entry) => entry.label && entry.link);
    const droppedLinkCount = (Array.isArray(run.links) ? run.links.length : 0) - links.length;
    if (droppedLinkCount > 0) problems.push(`Overnight run "${title}" has ${plural(droppedLinkCount, 'link')} without a label or a valid address; left out.`);
    items.push({
      id: briefItemId('agent', sourceReference),
      short: shorten(`${projectName}: ${title}`),
      link: link(run.url),
      options: [SEEN],
      projectName,
      title,
      outcome,
      startedAt,
      endedAt: outcome !== 'running' && isInstant(run.endedAt) ? run.endedAt : null,
      logTail,
      // A run names its session by sessionId; a run written before carries only the transcript path as `session`.
      sessionId: text(run.sessionId) || sessionIdOfTranscript(text(run.session)) || null,
      links,
    });
  }
  return { narration: narrationOf('agents'), items, quiet: judgement.quietRuns ?? [] };
}

// The captures triage.mjs listed whose line still stands in its note, each with its heading path and nested lines.
async function captureChapter() {
  const notes = [];
  for (const capture of triage?.captures ?? []) {
    const notePath = text(capture.notePath);
    const lineText = text(capture.line);
    if (!notePath || !lineText) continue;
    if (!(await isNoteLineOpen(notePath, lineText))) {
      problems.push((await noteLines(notePath)).started.has(lineText)
        ? `"${shorten(lineText)}" was started ([/]) in ${notePath} after triage.mjs ran; left out.`
        : `"${shorten(lineText)}" is no longer a list line of ${notePath}; left out.`);
      continue;
    }
    const heading = texts(capture.heading);
    const nested = (Array.isArray(capture.nested) ? capture.nested : [])
      .filter((line) => Number.isInteger(line?.depth) && line.depth > 0 && text(line.text))
      .map((line) => ({ depth: line.depth, text: text(line.text) }));
    notes.push({ id: briefItemId('note', notePath, lineText), notePath, lineText, heading, nested, suggestion: KEEP_LINE });
  }
  const bookmarks = [];
  for (const bookmark of capture?.bookmarks ?? []) {
    const bookmarkId = String(bookmark.id);
    const bookmarkJudgement = judgement.bookmarks?.[bookmarkId];
    if (!bookmarkJudgement) continue;
    bookmarks.push({
      id: briefItemId('bookmark', bookmarkId),
      bookmarkId,
      kind: bookmarkJudgement.kind,
      suggestion: bookmarkJudgement.suggestion,
      csfd: bookmarkJudgement.csfd ?? null,
    });
  }
  return { narration: narrationOf('capture'), notes, bookmarks, wishlists: judgement.wishlists ?? [] };
}

// Each news source as a document source: a dead one is a problem, one waiting for access is only listed.
function newsSources() {
  return (news?.sources ?? []).map(({ name, status, reason }) => {
    if (status === 'dead') problems.push(`News source ${name} is dead: ${reason}.`);
    return status === 'read'
      ? { name: `AI news: ${name}`, status: 'read', reason: null }
      : { name: `AI news: ${name}`, status: 'not-read', reason: text(reason) || 'Not read.' };
  });
}

// The digest's picks, each a link with its summary; without a digest the top-scored story leads and each release
// source's newest release follows, all without a summary.
function newsPicks(candidates) {
  if (newsDigest?.status === 'ok') return [[newsDigest.lead, 'lead'], ...(newsDigest.releases ?? []).map((pick) => [pick, 'release'])];
  problems.push(`${newsDigest ? `The news digest failed (${newsDigest.reason})` : 'No news digest was written'}; the news chapter has its picks without summaries.`);
  const lead = candidates.filter((candidate) => Number.isInteger(candidate.score)).sort((left, right) => right.score - left.score)[0];
  const releaseSources = new Set();
  const releases = candidates.filter((candidate) => candidate.kind === 'release' && !releaseSources.has(candidate.source) && releaseSources.add(candidate.source));
  return [[lead, 'lead'], ...releases.map((candidate) => [candidate, 'release'])];
}

const countOrNull = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

function newsChapter() {
  const candidates = Array.isArray(news.candidates) ? news.candidates : [];
  const candidatesByLink = new Map(candidates.map((candidate) => [candidate.link, candidate]));
  const items = [];
  for (const [pick, kind] of newsPicks(candidates)) {
    if (!pick) continue;
    const candidate = candidatesByLink.get(pick.link);
    if (!candidate) {
      problems.push(`The news digest picks ${pick.link}, which is not a candidate; left out.`);
      continue;
    }
    const id = briefItemId('news', candidate.link);
    if (items.some((item) => item.id === id)) continue;
    items.push({
      id,
      kind,
      title: text(candidate.title),
      summary: text(pick.summary) || null,
      source: text(candidate.source),
      link: candidate.link,
      publishedAt: isInstant(candidate.publishedAt) ? candidate.publishedAt : null,
      score: countOrNull(candidate.score),
      commentCount: countOrNull(candidate.commentCount),
    });
  }
  return { narration: narrationOf('news'), items };
}

function itemLists(document) {
  const chapters = document?.chapters ?? {};
  return [
    ...(chapters.mail?.mailboxes ?? []).map((mailbox) => [`mail ${mailbox.id}`, mailbox.items]),
    ['slack', chapters.slack?.items],
    ['code', chapters.code?.items],
    ['agents', chapters.agents?.items],
    ['capture notes', chapters.capture?.notes],
    ['capture bookmarks', chapters.capture?.bookmarks],
  ].filter(([, items]) => Array.isArray(items));
}

// Two entries from one source reference are one item; the app refuses a chapter that repeats an id.
function dropRepeatedItems(document) {
  for (const [listName, items] of itemLists(document)) {
    const seenIds = new Set();
    for (let index = 0; index < items.length; index++) {
      if (!seenIds.has(items[index].id)) {
        seenIds.add(items[index].id);
        continue;
      }
      problems.push(`${listName}: "${items[index].short ?? items[index].lineText}" repeats the source of an earlier item; left out.`);
      items.splice(index--, 1);
    }
  }
}

function dataDirectory() {
  if (process.env.ALFRED_CONTROL_CENTER_DATA) return process.env.ALFRED_CONTROL_CENTER_DATA;
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'alfred-control-center');
  return join(homedir(), '.local', 'share', 'alfred-control-center');
}

async function latestOutcome() {
  const outcomesDirectory = join(dataDirectory(), 'brief');
  const days = (await readdir(outcomesDirectory).catch(() => [])).filter((name) => DAY_PATTERN.test(name) && name <= day).sort().reverse();
  for (const outcomeDay of days) {
    const outcome = await readJson(join(outcomesDirectory, outcomeDay, 'outcome.json'));
    if (outcome) return { outcomeDay, outcome };
  }
  return undefined;
}

async function isStillCurrent(listName, item) {
  if (listName === 'capture notes') return isNoteLineOpen(item.notePath, item.lineText);
  if (listName === 'capture bookmarks') return capturedBookmarkIds.has(item.bookmarkId);
  return true;
}

// Item id to the time it was dismissed, or null when the outcome gives none. `dismissed` is the app's standing list of
// every day; an app that does not yet write it lists only the day's dismissals, as `seen`.
function dismissalsOf(outcome) {
  if (!Array.isArray(outcome.dismissed)) return new Map(idsIn(outcome.seen).map((id) => [id, null]));
  return new Map(outcome.dismissed.filter((entry) => typeof entry?.id === 'string').map(({ id, at }) => [id, isInstant(at) ? at : null]));
}

// A mail thread whose message arrived after its dismissal returns; any other dismissed item stays out, as its id names
// one message, one state of a pull request or one run.
function hasNewsSince(item, dismissedAt) {
  return dismissedAt !== null && isInstant(item.receivedAt) && Date.parse(item.receivedAt) > Date.parse(dismissedAt);
}

// Dismissed items and kept lines are left out; snoozed and undecided items of the outcome's document come back.
async function applyOutcome(document, { outcomeDay, outcome }) {
  const dismissals = dismissalsOf(outcome);
  const keptIds = new Set(idsIn(outcome.kept));
  const returning = new Set([...idsIn(outcome.snoozed), ...idsIn(outcome.undecided)]);
  const earlierDocument = outcomeDay === day ? undefined : await readJson(join(dayDirectory, '..', outcomeDay, 'daily-brief.json'));
  const earlierLists = new Map(itemLists(earlierDocument));
  const returnedIds = new Set();
  let leftOutCount = 0;
  let renewedCount = 0;
  for (const [listName, items] of itemLists(document)) {
    for (let index = items.length - 1; index >= 0; index--) {
      const { id } = items[index];
      if (dismissals.has(id) && hasNewsSince(items[index], dismissals.get(id))) {
        renewedCount++;
      } else if (dismissals.has(id) || keptIds.has(id)) {
        items.splice(index, 1);
        leftOutCount++;
      }
    }
    const presentIds = new Set(items.map((item) => item.id));
    for (const item of earlierLists.get(listName) ?? []) {
      if (!returning.has(item.id) || presentIds.has(item.id) || !(await isStillCurrent(listName, item))) continue;
      items.push(item);
      returnedIds.add(item.id);
    }
  }
  const report = `Outcome of ${outcomeDay}: ${leftOutCount} dismissed or kept items left out, ${returnedIds.size} snoozed or undecided items returned, `
    + `${renewedCount} dismissed mails back with a newer message.`
    + (Object.keys(outcome.feedback ?? {}).length > 0 ? `\nChapter feedback to respect: ${JSON.stringify(outcome.feedback)}` : '');
  return { report, returnedIds };
}

// The problems the app's writers would meet when the suggestion is accepted.
function checkNoteSuggestion(note, destinations) {
  const { action, destination } = note.suggestion;
  const { nested, plain } = lineShapeOf(note);
  const label = `"${shorten(note.lineText)}"`;
  if (nested && REMOVING_ACTIONS.includes(action)) problems.push(`${label} has lines nested under it; the app refuses to ${action} it, so suggest keep.`);
  if (plain && CHECKBOX_ACTIONS.includes(action)) problems.push(`${label} has no checkbox; the app refuses ${action} on it, so suggest delete or keep.`);
  if (action !== 'move' || !vaultDirectory || !triage) return;
  const offered = destinations.find((candidate) => candidate.notePath === destination?.notePath);
  if (!offered?.headings.includes(destination?.heading)) {
    problems.push(`${label} moves to ${destination?.notePath} under "${destination?.heading}", which is not among the move destinations.`);
  }
}

function applyJudgement(document, destinations) {
  const knownIds = new Set();
  for (const [listName, items] of itemLists(document)) {
    for (const item of items) {
      knownIds.add(item.id);
      const people = mailPeopleByItemId.get(item.id);
      const options = judgement.options?.[item.id];
      if (Array.isArray(options)) item.options = options.map((option) => (people ? addressedReply(option, item, people) : option));
      else if (options !== undefined && options !== ACCEPT_DEFAULT) problems.push(`The options of ${item.id} are neither a list nor "${ACCEPT_DEFAULT}"; its default stands.`);
      const suggestion = noteSuggestions[item.id];
      if (suggestion && suggestion !== ACCEPT_DEFAULT) item.suggestion = suggestion;
      if (listName === 'capture notes') checkNoteSuggestion(item, destinations);
      const offersReply = item.options?.some((option) => option.kind === 'reply');
      if (listName.startsWith('mail') && offersReply && !item.messageId) {
        problems.push(`Mail "${item.short}" has no messageId; its reply draft would start a new mail instead of replying.`);
      }
    }
  }
  const unknownIds = [...Object.keys(judgement.options ?? {}), ...Object.keys(noteSuggestions)].filter((id) => !knownIds.has(id));
  if (unknownIds.length) problems.push(`The judgement names items the document does not have: ${unknownIds.join(', ')}.`);
}

function checkNarrationTargets(document) {
  const targets = new Set([
    ...itemLists(document).flatMap(([, items]) => items.map((item) => item.id)),
    ...document.chapters.mail.mailboxes.map((mailbox) => mailbox.id),
    ...document.chapters.calendar.days.map((calendarDay) => calendarDay.date),
    ...(document.chapters.news?.items ?? []).map((item) => item.id),
  ]);
  for (const [chapterName, chapter] of Object.entries(document.chapters)) {
    if (UNCHECKED_TARGET_CHAPTERS.includes(chapterName)) continue;
    const unknown = (chapter.narration ?? []).flatMap((sentence) => sentence.targets ?? [])
      .filter((target) => UNTARGETED_CHAPTERS.includes(chapterName) || !targets.has(target));
    const hint = UNTARGETED_CHAPTERS.includes(chapterName) ? ` (its sentences target [])` : '';
    if (unknown.length) problems.push(`${chapterName} narration targets nothing on the page: ${unknown.join(', ')}${hint}.`);
  }
  const unknownChapters = Object.keys(judgement.narration ?? {}).filter((chapterName) => !Object.hasOwn(document.chapters, chapterName));
  if (unknownChapters.length) problems.push(`The judgement narrates chapters the document does not have: ${unknownChapters.join(', ')}.`);
}

function validate(documentPath) {
  const appDirectory = process.env.MPX_PROJECTS && join(process.env.MPX_PROJECTS, 'alfred-control-center');
  if (!appDirectory || !existsSync(join(appDirectory, 'package.json'))) {
    return { valid: false, report: `Not validated: no app repository at ${appDirectory ?? '$MPX_PROJECTS/alfred-control-center'}.` };
  }
  // Run from the app's folder: corepack picks the pnpm version of the working directory's package.json.
  const validation = spawnSync(`pnpm --dir "${appDirectory}" brief:validate "${documentPath}"`, {
    cwd: appDirectory, shell: true, encoding: 'utf8', timeout: VALIDATOR_TIMEOUT_MILLISECONDS, windowsHide: true,
  });
  const report = `${validation.stdout ?? ''}${validation.stderr ?? ''}`.trim() || validation.error?.message || 'The validator printed nothing.';
  return { valid: validation.status === 0, report };
}

const imapMailboxes = (judgement.mailboxes ?? []).map(imapMailbox);
const episodePaths = await openEpisodePaths();
const document = {
  schemaVersion: 1,
  day,
  builtAt: localIso(new Date()),
  window: { start: start.since, end: start.until },
  sources: [
    { name: 'Personal Gmail and Calendar', status: personal.status, reason: personal.reason },
    { name: 'Work Slack, Gmail and Calendar', status: work.status, reason: work.reason },
    ...imapMailboxes.map((mailbox) => ({ name: `${mailbox.label} mail`, status: mailbox.status, reason: mailbox.reason })),
    briefChapterSource('Merge requests', 'work'),
    briefChapterSource('Overnight runs', 'overnight'),
    triageSource(),
    captureSource(),
    ...newsSources(),
  ],
  chapters: {
    calendar: calendarChapter(),
    mail: mailChapter(imapMailboxes),
    slack: slackChapter(),
    code: codeChapter(),
    agents: agentsChapter(),
    capture: await captureChapter(),
    projects: { narration: narrationOf('projects') },
    plan: { narration: narrationOf('plan'), reminders: judgement.reminders ?? [] },
    ...(news ? { news: newsChapter() } : {}),
    health: { narration: narrationOf('health'), hints: healthHints(episodePaths) },
  },
};
dropRepeatedItems(document);
const latest = await latestOutcome();
const { report: outcomeReport, returnedIds } = latest ? await applyOutcome(document, latest) : { report: 'No outcome from the app yet.', returnedIds: new Set() };
const destinations = Array.isArray(triage?.destinations) ? triage.destinations : [];
applyJudgement(document, destinations);
checkNarrationTargets(document);

const documentPath = join(dayDirectory, 'daily-brief.json');
// The app may read the document at any moment; it never sees half of one.
await writeFile(`${documentPath}.partial`, `${JSON.stringify(document, null, 2)}\n`);
await rename(`${documentPath}.partial`, documentPath);
if (!values['no-state']) await recordLastBrief();

// The next window starts where this brief's ended; a rebuild of an earlier day never moves it back.
async function recordLastBrief() {
  const statePath = join(dayDirectory, '..', 'state.json');
  const recorded = Date.parse((await readJson(statePath))?.lastSuccess);
  if (recorded > Date.parse(start.until)) return;
  await writeFile(statePath, `${JSON.stringify({ lastSuccess: start.until, lastBrief: dayDirectory }, null, 2)}\n`);
}

function itemLabel(item) {
  if (!item.lineText) return item.short ?? item.bookmarkId;
  const { nested, plain } = lineShapeOf(item);
  const heading = item.heading?.length ? `  [under ${item.heading.join(' > ')}]` : '';
  return `${item.lineText}${heading}${nested ? '  [lines nested under it: keep]' : ''}${plain ? '  [plain bullet: no done or progress]' : ''}`;
}
const itemLines = itemLists(document).flatMap(([listName, items]) => items.map((item) => `  ${item.id}  ${listName}: ${itemLabel(item)}`));
// A bookmark is judged once it is in the document; a returned item keeps the judgement of the day it came from.
const judgedIds = new Set([...Object.keys(judgement.options ?? {}), ...Object.keys(noteSuggestions), ...returnedIds]);
const unjudgedLists = itemLists(document).filter(([listName]) => listName !== 'capture bookmarks')
  .map(([listName, items]) => [listName, items.filter((item) => !judgedIds.has(item.id))])
  .filter(([, items]) => items.length > 0);
const unjudgedItemCount = unjudgedLists.reduce((count, [, items]) => count + items.length, 0);
// What "default" in the judgement accepts: a capture's suggested action, or an item's options in order.
function defaultLabel(item) {
  if (item.suggestion) return item.suggestion.action;
  return (item.options ?? []).map((option) => OPTION_LABELS[option.kind] ?? option.label ?? option.kind).join(', ');
}
const unjudgedItemLines = unjudgedLists.flatMap(([listName, items]) => [`  ${listName}:`, ...items.map((item) => `    ${item.id}  ${itemLabel(item)}  [default: ${defaultLabel(item)}]`)]);
const documentBookmarkIds = new Set(document.chapters.capture.bookmarks.map((bookmark) => bookmark.bookmarkId));
const keptArticleIds = new Set(idsIn(latest?.outcome.keptBookmarks).map(String));
// A judged bookmark the outcome left out (kept or dismissed earlier) is not missing its judgement.
const unjudgedBookmarks = (capture?.bookmarks ?? [])
  .filter((bookmark) => !documentBookmarkIds.has(String(bookmark.id)) && !keptArticleIds.has(String(bookmark.id))
    && !judgement.bookmarks?.[String(bookmark.id)])
  .map((bookmark) => `  ${bookmark.id}  ${bookmark.title}  ${bookmark.url}`);
const unnarratedChapters = Object.entries(document.chapters).filter(([, chapter]) => chapter.narration.length === 0).map(([chapterName]) => chapterName);
const unvoicedSentenceCount = Object.values(document.chapters).flatMap((chapter) => chapter.narration).filter((sentence) => !sentence.audio).length;
const validation = validate(documentPath);
const destinationLines = destinations.map(({ notePath, headings }) => `  ${notePath}: ${headings.join(' | ') || 'no headings'}`);
const hintedPaths = new Set(document.chapters.health.hints.map((hint) => hint.conditionId));
const episodeLines = episodePaths.map((notePath) => `  ${notePath}${hintedPaths.has(notePath) ? '' : '  [no hint]'}`);
const report = [
  `Wrote ${documentPath}`,
  outcomeReport,
  `Items:\n${itemLines.join('\n') || '  none'}`,
  `Left out of Code (not an active repository in sources/repos.json):\n${codeLeftOut.map((change) => `  ${change}`).join('\n') || '  none'}`,
  ...(document.chapters.news ? [`News:\n${document.chapters.news.items.map((item) => `  ${item.id}  ${item.kind}: ${item.title} (${item.source})`).join('\n') || '  none'}`] : []),
  `Items without judgement (judge each in daily-brief.judgement.json, or "${ACCEPT_DEFAULT}" to accept the default shown):\n${unjudgedItemLines.join('\n') || '  none'}`,
  `Bookmarks without judgement:\n${unjudgedBookmarks.join('\n') || '  none'}`,
  `Move destinations (note: headings):\n${destinationLines.join('\n') || '  none'}`,
  `Open health episodes (read each note, one hint per path):\n${episodeLines.join('\n') || '  none'}`,
  `Problems:\n${problems.map((problem) => `  ${problem}`).join('\n') || '  none'}`,
  validation.report,
  `Summary: ${plural(unjudgedItemCount, 'item')} and ${plural(unjudgedBookmarks.length, 'bookmark')} without judgement; `
    + `${plural(unvoicedSentenceCount, 'narration sentence')} without a clip; the document is ${validation.valid ? 'valid' : 'not valid'}.`
    + (unnarratedChapters.length ? ` No narration: ${unnarratedChapters.join(', ')}.` : ''),
].join('\n');
await writeFile(join(dayDirectory, 'daily-brief.log'), `${report}\n`);
console.log(report);
process.exit(validation.valid ? 0 : 2);
