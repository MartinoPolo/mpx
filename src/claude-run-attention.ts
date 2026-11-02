import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface ClaudeRunEvent { session_id?: string; prompt?: string; last_assistant_message?: string; background_tasks?: Array<{ id?: unknown }> }
interface RunState { userPromptAt: string; inFlightTaskIds: string[]; openItemsRaised: boolean }

const TASK_NOTIFICATION = '<task-notification>';
const HITL_HEADING = /^#\s+HITL\b/m;
export const RUN_STATE_DIRECTORY = path.join(tmpdir(), 'mpx-claude-runs');

function stateFile(event: ClaudeRunEvent, directory: string): string | undefined {
  return event.session_id && /^[\w-]+$/.test(event.session_id) ? path.join(directory, `${event.session_id}.json`) : undefined;
}
async function readState(file: string): Promise<RunState | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as RunState; } catch { return undefined; }
}
async function writeState(file: string, state: RunState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state));
}

/** Orca alerts only when the lead stops with nothing in flight, so open items raised by earlier wake-ups must be restated in that final message. */
export async function recordClaudeStop(event: ClaudeRunEvent, directory = RUN_STATE_DIRECTORY): Promise<void> {
  const file = stateFile(event, directory);
  if (!file) return;
  const inFlightTaskIds = (event.background_tasks ?? []).flatMap(task => typeof task.id === 'string' ? [task.id] : []);
  if (inFlightTaskIds.length === 0) { await rm(file, { force: true }); return; }
  const state = await readState(file);
  const openItemsRaised = (state?.openItemsRaised ?? false) || HITL_HEADING.test(event.last_assistant_message ?? '');
  await writeState(file, { userPromptAt: state?.userPromptAt ?? new Date().toISOString(), inFlightTaskIds, openItemsRaised });
}

/** Returns the run-end instruction for the wake-up that completes the last in-flight task of a run that raised open items. */
export async function claudePromptRunContext(event: ClaudeRunEvent, directory = RUN_STATE_DIRECTORY): Promise<string | undefined> {
  const file = stateFile(event, directory);
  if (!file) return undefined;
  const prompt = (event.prompt ?? '').trimStart();
  const state = await readState(file);
  if (!prompt.startsWith(TASK_NOTIFICATION)) {
    // The user is present again: earlier items count as seen, but background work keeps running.
    await writeState(file, { userPromptAt: new Date().toISOString(), inFlightTaskIds: state?.inFlightTaskIds ?? [], openItemsRaised: false });
    return undefined;
  }
  if (!state?.openItemsRaised) return undefined;
  const completed = new Set([...prompt.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map(match => match[1]!.trim()));
  if (state.inFlightTaskIds.some(id => !completed.has(id))) return undefined;
  return `Run end: this wake-up completed the last background work in flight. If you end this turn without starting new background work, the user is alerted once and reads only this message, while earlier messages of this run raised items that need them. Then invoke the mpx-hitl skill with \`since ${state.userPromptAt}\` and end with its result; skip it if you start new background work.`;
}
