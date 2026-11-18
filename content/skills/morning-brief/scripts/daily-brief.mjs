#!/usr/bin/env node
// Writes <day>/daily-brief.json, the document the Alfred control center serves, and checks it with the app's
// validator. Calendar, mail and Slack come from the gatherers' sources, Code, Agents and the capture lines from the
// page's brief.json, bookmarks from the bookmarks bridge; <day>/daily-brief.judgement.json adds the session's
// judgement. The latest outcome the app wrote drops seen and kept items and brings back snoozed and undecided ones.
// Prints the items with their ids and what still lacks judgement. Exit code 2 when the document is invalid or could
// not be validated. Usage: daily-brief.mjs <day-directory>
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { briefItemId } from './brief-id.mjs';
import { localIso } from './local-time.mjs';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const END_OF_DAY = '24:00';
const SHORT_LENGTH = 60;
const VALIDATOR_TIMEOUT_MILLISECONDS = 120_000;
const CALENDAR_NAMES = { work: 'Work', personal: 'Personal', wife: 'Wife' };
const FORGES = ['github', 'gitlab'];
const AGENT_OUTCOMES = { ok: 'succeeded', fail: 'failed', check: 'blocked', partial: 'running' };
const ALERT_SENDERS = { sentry: 'Sentry', pipeline: 'Pipeline', monitoring: 'Monitoring' };
const IMAP_REASON = 'The headless morning run cannot unlock IMAP passwords; Unlock reads this mailbox at the desk.';
const UNCHECKED_TARGET_CHAPTERS = ['projects', 'plan', 'health'];
const SEEN = { kind: 'seen' };
const SNOOZE = { kind: 'snooze' };
// A state the page shows that needs a decision, with the options suggested until the session judges the item.
const CODE_STATE_OPTIONS = {
  ready: [{ kind: 'action', label: 'Merge', icon: 'git-merge', execution: { kind: 'merge' } }, SNOOZE],
  failing: [{ kind: 'action', label: 'Rerun', icon: 'rotate-ccw', execution: { kind: 'rerun' } }, SNOOZE],
  review: [{ kind: 'action', label: 'Review today', icon: 'eye', execution: { kind: 'reminder' } }, SNOOZE],
};
const KEEP_LINE = { action: 'keep', destination: null, wording: null, priority: null, because: null, link: null };

const [dayDirectory] = process.argv.slice(2);
if (!dayDirectory || !isAbsolute(dayDirectory)) {
  console.error('Usage: daily-brief.mjs <absolute day directory>');
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
// The document sits in <home>/work/morning-brief/<day>; the bookmarks bridge writes <home>/work/bookmarks.
const capture = await readJson(join(dayDirectory, '..', '..', 'bookmarks', 'capture.json'));
const judgement = (await readJson(join(dayDirectory, 'daily-brief.judgement.json'))) ?? {};
const vaultDirectory = process.env.MPX_OBSIDIAN_VAULT;
const noteLineCache = new Map();
const capturedBookmarkIds = new Set((capture?.bookmarks ?? []).map((bookmark) => String(bookmark.id)));

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const link = (value) => (typeof value === 'string' && URL.canParse(value) ? value : null);
const isInstant = (value) => typeof value === 'string' && INSTANT_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
const shorten = (value) => (value.length > SHORT_LENGTH ? `${value.slice(0, SHORT_LENGTH - 1)}…` : value);
const texts = (values) => (Array.isArray(values) ? values.map(text).filter(Boolean) : []);
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
  if (!brief) return { name, status: 'not-read', reason: 'The page data brief.json was not written.' };
  const chapter = briefChapter(type);
  if (!chapter) return { name, status: 'not-read', reason: `brief.json has no ${type} chapter.` };
  if (chapter.status === 'unavailable') return { name, status: 'not-read', reason: text(chapter.detail) || 'The area was unavailable.' };
  return { name, status: 'read', reason: null };
}

function captureSource() {
  const name = 'Bookmarks bridge';
  if (!capture) return { name, status: 'not-read', reason: 'The bridge has written no capture.json.' };
  if (capture.error) return { name, status: 'not-read', reason: String(capture.error) };
  return { name, status: 'read', reason: null };
}

function narrationOf(chapterName) {
  return judgement.narration?.[chapterName] ?? [];
}

// The text of every list line of a vault note, as the app finds a task: without its marker and checkbox.
async function noteLineTexts(notePath) {
  if (!noteLineCache.has(notePath)) {
    const noteText = await readFile(join(vaultDirectory, notePath), 'utf8').catch(() => '');
    const lineTexts = noteText.split(/\r?\n/).map((line) => line.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?(.*\S)\s*$/)?.[1]).filter(Boolean);
    noteLineCache.set(notePath, new Set(lineTexts));
  }
  return noteLineCache.get(notePath);
}

async function isNoteLinePresent(notePath, lineText) {
  return !vaultDirectory || (await noteLineTexts(notePath)).has(lineText);
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
  return { id: briefItemId('mail', threadId), short: shorten(`${message.from}: ${message.subject}`), link: link(mail.url), options, threadId, ...message };
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
    items.push(mailMessage(mail, { from, receivedAt: text(mail.received), subject, snippet, options: [SNOOZE] }));
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

function codeChapter() {
  const items = [];
  const merged = [];
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
      const title = text(card.title) || reference.label;
      if (card.state === 'merged') {
        merged.push({ forge: project.app, projectName, reference, title });
        continue;
      }
      items.push({
        id: briefItemId('code', reference.link),
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

// A run the page lists by its clock time started on the brief's day, or the day before when that time is still ahead.
function startOfRun(run) {
  if (isInstant(run.startedAt)) return run.startedAt;
  const clock = text(run.when).match(/^(\d{1,2}):(\d{2})$/);
  if (!clock) return undefined;
  const [year, month, dayOfMonth] = day.split('-').map(Number);
  const started = new Date(year, month - 1, dayOfMonth, Number(clock[1]), Number(clock[2]));
  if (started > new Date(start.until)) started.setDate(started.getDate() - 1);
  return localIso(started);
}

function endOfRun(run, startedAt) {
  if (isInstant(run.endedAt)) return run.endedAt;
  const hours = text(run.duration).match(/(\d+)\s*h/)?.[1];
  const minutes = text(run.duration).match(/(\d+)\s*min/)?.[1];
  if (!hours && !minutes) return null;
  return localIso(new Date(Date.parse(startedAt) + (Number(hours ?? 0) * 60 + Number(minutes ?? 0)) * 60_000));
}

function agentsChapter() {
  const projectNames = new Map((brief?.projects ?? []).map((project) => [project.id, project.name]));
  const items = [];
  for (const run of briefChapter('overnight')?.data?.runs ?? []) {
    const projectName = text(projectNames.get(run.project)) || text(run.project) || 'unknown';
    const title = text(run.title) || text(run.result) || 'Run';
    const outcome = AGENT_OUTCOMES[run.outcome];
    const startedAt = startOfRun(run);
    if (!outcome || !startedAt) {
      problems.push(`Overnight run "${title}" has no known outcome or start time; left out.`);
      continue;
    }
    const logTail = Array.isArray(run.logTail) ? run.logTail.filter((line) => typeof line === 'string') : texts([run.detail]);
    const sourceReference = text(run.session) || text(run.url) || `${projectName} ${new Date(startedAt).toISOString()} ${title}`;
    items.push({
      id: briefItemId('agent', sourceReference),
      short: shorten(`${projectName}: ${title}`),
      link: link(run.url),
      options: [SEEN],
      projectName,
      title,
      outcome,
      startedAt,
      endedAt: outcome === 'running' ? null : endOfRun(run, startedAt),
      logTail,
    });
  }
  return { narration: narrationOf('agents'), items, quiet: judgement.quietRuns ?? [] };
}

async function captureChapter() {
  const notes = [];
  for (const group of briefChapter('triage')?.data?.groups ?? []) {
    const note = text(group.note).replaceAll('\\', '/');
    if (!note) continue;
    const notePath = note.endsWith('.md') ? note : `${note}.md`;
    for (const item of group.items ?? []) {
      const lineText = text(item.line) || text(item.text);
      if (!lineText) continue;
      if (!(await isNoteLinePresent(notePath, lineText))) {
        problems.push(`"${shorten(lineText)}" is not a list line of ${notePath}; left out (give the triage item its exact line).`);
        continue;
      }
      const suggestion = item.resolved ? { ...KEEP_LINE, action: 'done', because: text(item.resolution) || null } : KEEP_LINE;
      notes.push({ id: briefItemId('note', notePath, lineText), notePath, lineText, suggestion });
    }
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
  if (listName === 'capture notes') return isNoteLinePresent(item.notePath, item.lineText);
  if (listName === 'capture bookmarks') return capturedBookmarkIds.has(item.bookmarkId);
  return true;
}

// Seen items and kept lines are dropped; snoozed and undecided items of the outcome's document come back.
async function applyOutcome(document, { outcomeDay, outcome }) {
  const dropped = new Set([...idsIn(outcome.seen), ...idsIn(outcome.kept)]);
  const returning = new Set([...idsIn(outcome.snoozed), ...idsIn(outcome.undecided)]);
  const earlierDocument = outcomeDay === day ? undefined : await readJson(join(dayDirectory, '..', outcomeDay, 'daily-brief.json'));
  const earlierLists = new Map(itemLists(earlierDocument));
  let returnedCount = 0;
  let droppedCount = 0;
  for (const [listName, items] of itemLists(document)) {
    for (let index = items.length - 1; index >= 0; index--) {
      if (dropped.has(items[index].id)) {
        items.splice(index, 1);
        droppedCount++;
      }
    }
    const presentIds = new Set(items.map((item) => item.id));
    for (const item of earlierLists.get(listName) ?? []) {
      if (!returning.has(item.id) || presentIds.has(item.id) || !(await isStillCurrent(listName, item))) continue;
      items.push(item);
      returnedCount++;
    }
  }
  return `Outcome of ${outcomeDay}: ${droppedCount} seen or kept items dropped, ${returnedCount} snoozed or undecided items returned.`
    + (Object.keys(outcome.feedback ?? {}).length > 0 ? `\nChapter feedback to respect: ${JSON.stringify(outcome.feedback)}` : '');
}

function applyJudgement(document) {
  const knownIds = new Set();
  for (const [, items] of itemLists(document)) {
    for (const item of items) {
      knownIds.add(item.id);
      if (judgement.options?.[item.id]) item.options = judgement.options[item.id];
      if (judgement.notes?.[item.id]) item.suggestion = judgement.notes[item.id];
    }
  }
  const unknownIds = [...Object.keys(judgement.options ?? {}), ...Object.keys(judgement.notes ?? {})].filter((id) => !knownIds.has(id));
  if (unknownIds.length) problems.push(`The judgement names items the document does not have: ${unknownIds.join(', ')}.`);
}

function checkNarrationTargets(document) {
  const targets = new Set([
    ...itemLists(document).flatMap(([, items]) => items.map((item) => item.id)),
    ...document.chapters.mail.mailboxes.map((mailbox) => mailbox.id),
    ...document.chapters.calendar.days.map((calendarDay) => calendarDay.date),
  ]);
  for (const [chapterName, chapter] of Object.entries(document.chapters)) {
    if (UNCHECKED_TARGET_CHAPTERS.includes(chapterName)) continue;
    const unknown = (chapter.narration ?? []).flatMap((sentence) => sentence.targets ?? []).filter((target) => !targets.has(target));
    if (unknown.length) problems.push(`${chapterName} narration targets nothing on the page: ${unknown.join(', ')}.`);
  }
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
    briefChapterSource('Obsidian triage', 'triage'),
    captureSource(),
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
    health: { narration: narrationOf('health'), hints: judgement.hints ?? [] },
  },
};
dropRepeatedItems(document);
const latest = await latestOutcome();
const outcomeReport = latest ? await applyOutcome(document, latest) : 'No outcome from the app yet.';
applyJudgement(document);
checkNarrationTargets(document);

const documentPath = join(dayDirectory, 'daily-brief.json');
// The app may read the document at any moment; it never sees half of one.
await writeFile(`${documentPath}.partial`, `${JSON.stringify(document, null, 2)}\n`);
await rename(`${documentPath}.partial`, documentPath);

const judgedIds = new Set([...Object.keys(judgement.options ?? {}), ...Object.keys(judgement.notes ?? {})]);
const itemLines = itemLists(document).flatMap(([listName, items]) => items.map((item) => {
  const judged = listName === 'capture bookmarks' || judgedIds.has(item.id) ? 'judged ' : 'default';
  return `  ${judged}  ${item.id}  ${listName}: ${item.short ?? item.lineText ?? item.bookmarkId}`;
}));
const unjudgedBookmarks = (capture?.bookmarks ?? []).filter((bookmark) => !judgement.bookmarks?.[String(bookmark.id)])
  .map((bookmark) => `  ${bookmark.id}  ${bookmark.title}  ${bookmark.url}`);
const validation = validate(documentPath);
console.log([
  `Wrote ${documentPath}`,
  outcomeReport,
  `Items:\n${itemLines.join('\n') || '  none'}`,
  `Bookmarks without judgement:\n${unjudgedBookmarks.join('\n') || '  none'}`,
  `Problems:\n${problems.map((problem) => `  ${problem}`).join('\n') || '  none'}`,
  validation.report,
].join('\n'));
process.exit(validation.valid ? 0 : 2);
