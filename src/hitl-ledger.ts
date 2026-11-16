import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface ClaudeRunEvent { session_id?: string; prompt?: string; last_assistant_message?: string; background_tasks?: unknown[]; stop_hook_active?: boolean }
export const HITL_ITEM_KIND = { question: 'question', toDo: 'to do' } as const;
export type HitlItemKind = (typeof HITL_ITEM_KIND)[keyof typeof HITL_ITEM_KIND];
export interface HitlItem { number: number; title: string; kind: HitlItemKind }
export interface HitlLedger { nextNumber: number; openItems: HitlItem[] }
export interface HitlSection { fullItems: HitlItem[]; stillOpenItems: HitlItem[]; closedNumbers: number[]; highestNumber: number }

const HITL_HEADING = /^#\s+HITL\b/;
const PART_HEADING = /^##\s+(.*)$/;
const ITEM = /^(\d+)\.\s+(?:🛑\s*)?\*\*(.+?)\*\*(.*)$/u;
const CLOSED_LINE = /^\**Closed\**:\**\s*(.*)$/i;
const FENCE = /^\s*(?:```|~~~)/;
const TO_DO = /to.?do/i;
/** A cache of what the transcript already holds: losing it only restarts the check from the next message. */
export const HITL_LEDGER_DIRECTORY = path.join(tmpdir(), 'mpx-hitl-ledgers');
const EMPTY_LEDGER: HitlLedger = { nextNumber: 1, openItems: [] };

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
  for (const line of lines) {
    const heading = PART_HEADING.exec(line);
    if (heading) {
      const name = heading[1] ?? '';
      isStillOpenPart = /still open/i.test(name);
      kind = /question/i.test(name) ? HITL_ITEM_KIND.question : TO_DO.test(name) ? HITL_ITEM_KIND.toDo : undefined;
      continue;
    }
    const closed = CLOSED_LINE.exec(line);
    if (closed) { section.closedNumbers.push(...((closed[1] ?? '').replace(/\([^)]*\)/g, ' ').match(/\d+/g) ?? []).map(Number)); continue; }
    const item = ITEM.exec(line);
    if (!item) continue;
    const number = Number(item[1]);
    const title = (item[2] ?? '').replace(/:$/, '').trim();
    section.highestNumber = Math.max(section.highestNumber, number);
    if (isStillOpenPart) section.stillOpenItems.push({ number, title, kind: TO_DO.test(item[3] ?? '') ? HITL_ITEM_KIND.toDo : HITL_ITEM_KIND.question });
    else if (kind) section.fullItems.push({ number, title, kind });
  }
  return section;
}

function listedAndClosed(section: HitlSection | undefined): { listed: HitlItem[]; closed: Set<number> } {
  const listed = [...(section?.fullItems ?? []), ...(section?.stillOpenItems ?? [])];
  const listedNumbers = new Set(listed.map(item => item.number));
  return { listed, closed: new Set((section?.closedNumbers ?? []).filter(number => !listedNumbers.has(number))) };
}

/** Returns what the section must still fix so that the latest message alone tells the user everything open. */
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
  const missing = ledger.openItems.filter(item => !seen.has(item.number) && !closed.has(item.number));
  const whereToList = nothingInFlight ? 'Write each one in full under Questions or To do' : 'List each one under Still open';
  if (missing.length) violations.push(`Not accounted for: ${missing.map(describe).join(', ')}. ${whereToList}, or name it in the \`Closed:\` line with what closed it.`);
  const fullNumbers = new Set(section?.fullItems.map(item => item.number));
  const abbreviated = nothingInFlight ? (section?.stillOpenItems ?? []).filter(item => !fullNumbers.has(item.number)) : [];
  if (abbreviated.length) violations.push(`Nothing is in flight, so the user is alerted now and reads only this message: write ${abbreviated.map(item => item.number).join(', ')} in full under Questions or To do, from the original wording with options and recommendation, instead of under Still open.`);
  return violations;
}

export function applyHitlSection(ledger: HitlLedger, section: HitlSection | undefined): HitlLedger {
  if (!section) return ledger;
  const { listed, closed } = listedAndClosed(section);
  const openItems = ledger.openItems.filter(item => !closed.has(item.number));
  const openNumbers = new Set(openItems.map(item => item.number));
  for (const item of listed) {
    if (openNumbers.has(item.number) || item.number < ledger.nextNumber) continue;
    openItems.push(item);
    openNumbers.add(item.number);
  }
  return { nextNumber: Math.max(ledger.nextNumber, section.highestNumber + 1), openItems: openItems.sort((left, right) => left.number - right.number) };
}

function isHitlItem(value: unknown): value is HitlItem {
  return typeof value === 'object' && value !== null && 'number' in value && typeof value.number === 'number' && 'title' in value && typeof value.title === 'string'
    && 'kind' in value && Object.values<unknown>(HITL_ITEM_KIND).includes(value.kind);
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

/** Returns the reason to keep Claude working when its final message loses track of an open item; a second refusal in one turn would loop, so a continued stop is recorded as it is. */
export async function checkClaudeStop(event: ClaudeRunEvent, directory = HITL_LEDGER_DIRECTORY): Promise<string | undefined> {
  const file = ledgerFile(event, directory);
  if (!file || typeof event.last_assistant_message !== 'string') return undefined;
  const ledger = await readLedger(file);
  const section = parseHitlSection(event.last_assistant_message);
  if (!event.stop_hook_active) {
    const violations = hitlViolations(ledger, section, (event.background_tasks ?? []).length === 0);
    if (violations.length) return [
      'The user reads only the latest message, so its `# HITL` section must account for every open item of this session. Reply with only a corrected `# HITL` section.',
      ...violations.map(violation => `- ${violation}`),
      'Parts in order: `## ❓ Questions` and `## 🛠️ To do` hold items in full; `## ⏳ Still open` holds one line per earlier item, `N. **Title** (question)` or `(to do)`, only while background work is in flight; `Closed: N (what closed it), …` names the items closed since the previous section.',
    ].join('\n');
  }
  const updated = applyHitlSection(ledger, section);
  if (updated !== ledger) { await mkdir(directory, { recursive: true }); await writeFile(file, JSON.stringify(updated)); }
  return undefined;
}

/** Restates the ledger on every prompt, because wake-ups and compaction are where numbers and open items get lost. */
export async function claudeLedgerContext(event: ClaudeRunEvent, directory = HITL_LEDGER_DIRECTORY): Promise<string | undefined> {
  const file = ledgerFile(event, directory);
  if (!file) return undefined;
  const ledger = await readLedger(file);
  if (ledger.nextNumber === 1) return undefined;
  const fromNext = `New HITL items take numbers from ${ledger.nextNumber} up.`;
  return ledger.openItems.length ? `Open HITL items: ${ledger.openItems.map(describe).join('; ')}. Each keeps its number and title; account for every one in this turn's \`# HITL\` section. ${fromNext}` : fromNext;
}
