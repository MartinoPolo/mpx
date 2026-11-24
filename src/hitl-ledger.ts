import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HITL_ITEM_LINE, questionsFilePath } from './claude-statusline/scripts/lib/questions-file.mts';

export interface ClaudeRunEvent { session_id?: string; transcript_path?: string; prompt?: string; last_assistant_message?: string; background_tasks?: unknown[]; stop_hook_active?: boolean }
/** `reason` keeps Claude working; `notice` is shown to the user below the message and never reaches the model. */
export interface ClaudeStopOutcome { reason?: string; notice?: string }
export const HITL_ITEM_KIND = { question: 'question', toDo: 'to do' } as const;
export type HitlItemKind = (typeof HITL_ITEM_KIND)[keyof typeof HITL_ITEM_KIND];
/** `body` is the item as last written in full; an item first seen as a `Still open` line has none. */
export interface HitlItem { number: number; title: string; kind: HitlItemKind; body?: string }
export interface HitlLedger { nextNumber: number; openItems: HitlItem[] }
export interface HitlSection { fullItems: HitlItem[]; stillOpenItems: HitlItem[]; closedNumbers: number[]; highestNumber: number }

const HITL_HEADING = /^#\s+HITL\b/;
const PART_HEADING = /^##\s+(.*)$/;
const CLOSED_LINE = /^\**Closed\**:\**\s*(.*)$/i;
const FENCE = /^\s*(?:```|~~~)/;
const TO_DO = /to.?do/i;
/** Holds the wording the user is shown, so losing it empties the questions file until an item is next written in full. */
export const HITL_LEDGER_DIRECTORY = path.join(tmpdir(), 'mpx-hitl-ledgers');
const EMPTY_LEDGER: HitlLedger = { nextNumber: 1, openItems: [] };
// Claude Code moves a longer hook message into a file and shows only its opening.
const NOTICE_CHARACTER_LIMIT = 9000;

const normaliseTitle = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const describe = (item: HitlItem) => `${item.number} "${item.title}" (${item.kind})`;

/** Reads the last `# HITL` section outside code fences, so a quoted example of the format is never taken for the real one. */
export function parseHitlSection(message: string): HitlSection | undefined {
  let insideFence = false;
  let lines: string[] | undefined;
  for (const line of message.split(/\r?\n/)) {
    if (FENCE.test(line)) { insideFence = !insideFence; continue; }
    if (insideFence) continue;
    if (HITL_HEADING.test(line)) lines = []; else lines?.push(line);
  }
  if (!lines) return undefined;
  const section: HitlSection = { fullItems: [], stillOpenItems: [], closedNumbers: [], highestNumber: 0 };
  let kind: HitlItemKind | undefined = HITL_ITEM_KIND.question;
  let isStillOpenPart = false;
  let fullItem: HitlItem | undefined;
  for (const line of lines) {
    const heading = PART_HEADING.exec(line);
    if (heading) {
      const name = heading[1] ?? '';
      fullItem = undefined;
      isStillOpenPart = /still open/i.test(name);
      kind = /question/i.test(name) ? HITL_ITEM_KIND.question : TO_DO.test(name) ? HITL_ITEM_KIND.toDo : undefined;
      continue;
    }
    const closed = CLOSED_LINE.exec(line);
    if (closed) { fullItem = undefined; section.closedNumbers.push(...((closed[1] ?? '').replace(/\([^)]*\)/g, ' ').match(/\d+/g) ?? []).map(Number)); continue; }
    const item = HITL_ITEM_LINE.exec(line);
    if (!item) { if (fullItem) fullItem.body += `\n${line}`; continue; }
    fullItem = undefined;
    const number = Number(item[1]);
    const title = (item[2] ?? '').replace(/:$/, '').trim();
    section.highestNumber = Math.max(section.highestNumber, number);
    if (isStillOpenPart) section.stillOpenItems.push({ number, title, kind: TO_DO.test(item[3] ?? '') ? HITL_ITEM_KIND.toDo : HITL_ITEM_KIND.question });
    else if (kind) section.fullItems.push(fullItem = { number, title, kind, body: line });
  }
  for (const item of section.fullItems) item.body = item.body?.trimEnd();
  return section;
}

function listedAndClosed(section: HitlSection | undefined): { listed: HitlItem[]; closed: Set<number> } {
  const listed = [...(section?.fullItems ?? []), ...(section?.stillOpenItems ?? [])];
  const listedNumbers = new Set(listed.map(item => item.number));
  return { listed, closed: new Set((section?.closedNumbers ?? []).filter(number => !listedNumbers.has(number))) };
}

/** Returns what the section must still fix; open items are accounted for only when the turn alerts the user, so wake-ups stay short. */
export function hitlViolations(ledger: HitlLedger, section: HitlSection | undefined, nothingInFlight: boolean): string[] {
  const open = new Map(ledger.openItems.map(item => [item.number, item]));
  const { listed, closed } = listedAndClosed(section);
  const seen = new Set<number>();
  const violations: string[] = [];
  const fromNext = `a new item takes a number from ${Math.max(ledger.nextNumber, (section?.highestNumber ?? 0) + 1)} up`;
  for (const item of listed) {
    const known = open.get(item.number);
    if (seen.has(item.number)) violations.push(`Number ${item.number} appears twice; ${fromNext}.`);
    else if (known && normaliseTitle(known.title) !== normaliseTitle(item.title)) violations.push(`Number ${item.number} still belongs to "${known.title}" (${known.kind}), so keep that title; ${fromNext}.`);
    else if (!known && item.number < ledger.nextNumber) violations.push(`Number ${item.number} was used before; ${fromNext}.`);
    seen.add(item.number);
  }
  const missing = nothingInFlight ? ledger.openItems.filter(item => !seen.has(item.number) && !closed.has(item.number)) : [];
  if (missing.length) violations.push(`Not accounted for: ${missing.map(describe).join(', ')}. List each one under Still open, or name it in the \`Closed:\` line with what closed it.`);
  return violations;
}

export function applyHitlSection(ledger: HitlLedger, section: HitlSection | undefined): HitlLedger {
  if (!section) return ledger;
  const { listed, closed } = listedAndClosed(section);
  const open = new Map(ledger.openItems.filter(item => !closed.has(item.number)).map(item => [item.number, item]));
  for (const item of listed) {
    const known = open.get(item.number);
    if (known) { if (item.body) open.set(item.number, { ...known, body: item.body }); }
    else if (item.number >= ledger.nextNumber) open.set(item.number, item);
  }
  return { nextNumber: Math.max(ledger.nextNumber, section.highestNumber + 1), openItems: [...open.values()].sort((left, right) => left.number - right.number) };
}

function isHitlItem(value: unknown): value is HitlItem {
  return typeof value === 'object' && value !== null && 'number' in value && typeof value.number === 'number' && 'title' in value && typeof value.title === 'string'
    && 'kind' in value && Object.values<unknown>(HITL_ITEM_KIND).includes(value.kind) && (!('body' in value) || typeof value.body === 'string');
}
function ledgerFile(event: ClaudeRunEvent, directory: string): string | undefined {
  return event.session_id && /^[\w-]+$/.test(event.session_id) ? path.join(directory, `${event.session_id}.json`) : undefined;
}
async function readLedger(file: string): Promise<HitlLedger> {
  try {
    const stored: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (typeof stored !== 'object' || stored === null || !('nextNumber' in stored) || typeof stored.nextNumber !== 'number' || !('openItems' in stored) || !Array.isArray(stored.openItems)) return EMPTY_LEDGER;
    return { nextNumber: stored.nextNumber, openItems: stored.openItems.filter(isHitlItem) };
  } catch { return EMPTY_LEDGER; }
}

// Markdown viewers number a list from its first item, so 4 and 6 would show as 4 and 5; a comment ends the list and each item keeps its number.
const LIST_BREAK = '\n\n<!-- -->\n\n';

function renderItems(items: HitlItem[], inFull: boolean, itemSeparator = inFull ? '\n\n' : '\n'): string {
  const part = (heading: string, kind: HitlItemKind) => {
    const ofKind = items.filter(item => item.kind === kind);
    const rendered = ofKind.map(item => (inFull ? item.body : undefined) ?? `${item.number}. **${item.title}**`);
    return ofKind.length ? [`## ${heading}`, rendered.join(itemSeparator)] : [];
  };
  return [...part('❓ Questions', HITL_ITEM_KIND.question), ...part('🛠️ To do', HITL_ITEM_KIND.toDo)].join('\n\n');
}

/** Keeps the session's questions file equal to the ledger and returns its link, or undefined when there is nothing to link. */
async function syncQuestionsFile(event: ClaudeRunEvent, ledger: HitlLedger): Promise<string | undefined> {
  if (!event.transcript_path) return undefined;
  const file = questionsFilePath(event.transcript_path);
  try {
    if (!ledger.openItems.length) { await rm(file, { force: true }); return undefined; }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `# Waiting for you\n\n${renderItems(ledger.openItems, true, LIST_BREAK)}\n`);
    return pathToFileURL(file).href;
  } catch { return undefined; }
}

/** The open items the message did not write in full, so the message that alerts the user is followed by everything waiting for them. */
function openItemsNotice(ledger: HitlLedger, section: HitlSection | undefined, questionsFileUrl: string | undefined): string | undefined {
  const writtenInFull = new Set(section?.fullItems.map(item => item.number));
  const carried = ledger.openItems.filter(item => !writtenInFull.has(item.number));
  if (!carried.length) return undefined;
  const heading = questionsFileUrl ? `Still waiting for you (${questionsFileUrl}):` : 'Still waiting for you:';
  const inFull = `${heading}\n\n${renderItems(carried, true)}`;
  return inFull.length <= NOTICE_CHARACTER_LIMIT ? inFull : `${heading}\n\n${renderItems(carried, false)}`;
}

/** Refuses a final message that loses track of an open item; a second refusal in one turn would loop, so a continued stop is recorded as it is. */
export async function checkClaudeStop(event: ClaudeRunEvent, directory = HITL_LEDGER_DIRECTORY): Promise<ClaudeStopOutcome> {
  const file = ledgerFile(event, directory);
  if (!file || typeof event.last_assistant_message !== 'string') return {};
  const ledger = await readLedger(file);
  const section = parseHitlSection(event.last_assistant_message);
  const nothingInFlight = (event.background_tasks ?? []).length === 0;
  if (!event.stop_hook_active) {
    const violations = hitlViolations(ledger, section, nothingInFlight);
    if (violations.length) return { reason: [
      'The `# HITL` section of the message that ends a run must account for every open item of this session. Reply with only a corrected `# HITL` section.',
      ...violations.map(violation => `- ${violation}`),
      'Parts in order: `## ❓ Questions` and `## 🛠️ To do` hold new or reworded items in full; `## ⏳ Still open` holds one line per unchanged earlier item, `N. **Title** (question)` or `(to do)`; `Closed: N (what closed it), …` names the items closed since the previous section.',
    ].join('\n') };
  }
  const updated = applyHitlSection(ledger, section);
  if (updated !== ledger) { await mkdir(directory, { recursive: true }); await writeFile(file, JSON.stringify(updated)); }
  const questionsFileUrl = await syncQuestionsFile(event, updated);
  return nothingInFlight ? { notice: openItemsNotice(updated, section, questionsFileUrl) } : {};
}

/** Restates the ledger on every prompt, because wake-ups and compaction are where numbers and open items get lost. */
export async function claudeLedgerContext(event: ClaudeRunEvent, directory = HITL_LEDGER_DIRECTORY): Promise<string | undefined> {
  const file = ledgerFile(event, directory);
  if (!file) return undefined;
  const ledger = await readLedger(file);
  if (ledger.nextNumber === 1) return undefined;
  const fromNext = `New HITL items take numbers from ${ledger.nextNumber} up.`;
  if (!ledger.openItems.length) return fromNext;
  const fullWording = event.transcript_path ? ` Their full wording is in ${questionsFilePath(event.transcript_path)}.` : '';
  return `Open HITL items: ${ledger.openItems.map(describe).join('; ')}. Each keeps its number and title; the user is shown them in full, so restate one only when its wording changes.${fullWording} ${fromNext}`;
}
