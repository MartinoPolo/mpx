import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkReceiverNormalization(receiver, createState) {
  let scenarios = 0;
  const normalize = (module, type, event, payload, state = createState()) =>
    module.normalizePiCompatibleEvent(state, type, event, '', 'fixture-pane', payload);
  for (const type of ['pi', 'omp', 'prime-agent']) {
    for (const interrupted of [undefined, false, true, 'true', 'false', 1, null, {}]) {
      const payload = { interrupted };
      const original = normalize(receiver.original, type, 'agent_end', payload);
      const candidate = normalize(receiver.candidate, type, 'agent_end', payload);
      assert.deepEqual(candidate, type === 'pi' && interrupted === true ? { ...original, interrupted: true } : original);
      scenarios++;
    }
  }
  for (const event of ['session_start', 'before_agent_start', 'agent_start', 'message_end', 'tool_execution_end', 'ui_prompt_start', 'ui_prompt_end']) {
    const payload = { interrupted: true, is_idle: true };
    assert.deepEqual(normalize(receiver.candidate, 'pi', event, payload), normalize(receiver.original, 'pi', event, payload));
    scenarios++;
  }
  const waiting = normalize(receiver.candidate, 'pi', 'agent_end', { interrupted: true, ui_prompt_active: true });
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.interrupted, undefined);
  scenarios++;
  const state = createState();
  assert.equal(normalize(receiver.candidate, 'pi', 'agent_end', { interrupted: true }, state).interrupted, true);
  assert.equal(normalize(receiver.candidate, 'pi', 'agent_start', {}, state).interrupted, undefined);
  assert.equal(normalize(receiver.candidate, 'pi', 'agent_end', {}, state).interrupted, undefined);
  return scenarios + 1;
}

export async function loadReceiverPresentation(orcaRoot, temporary) {
  const renderer = await import(pathToFileURL(path.join(orcaRoot, 'src/renderer/src/hooks/ipc-events/normalize-agent-status-event.ts')).href);
  // Execute unchanged notification formatting logic, replacing only Electron/i18n with English fallback.
  const source = await readFile(path.join(orcaRoot, 'src/main/ipc/notification-options.ts'), 'utf8');
  const anchor = "import { translateMain } from '../i18n/main-i18n'";
  if (source.split(anchor).length !== 2) throw new Error('Unexpected notification translation boundary.');
  const file = path.join(temporary, 'notification-options.mts');
  await writeFile(file, source.replace(anchor, 'const translateMain = (_key: string, fallback: string) => fallback'));
  return { ...renderer, ...await import(pathToFileURL(file).href) };
}

export function checkReceiverPresentation(presentation, cancelled, completed) {
  const cancelledIpc = presentation.normalizeAgentStatusEvent(cancelled);
  const completedIpc = presentation.normalizeAgentStatusEvent(completed);
  assert.equal(cancelledIpc.interrupted, true);
  assert.equal(completedIpc.interrupted, undefined);
  const format = status => presentation.buildNotificationOptions({
    source: 'agent-task-complete', worktreeLabel: 'fixture', agentType: status.agentType,
    agentState: status.state, agentInterrupted: status.interrupted,
  });
  assert.equal(format(cancelledIpc).title, 'fixture - Pi stopped');
  assert.equal(format(completedIpc).title, 'fixture - Pi finished');
  return { cancelled: 'stopped', completed: 'finished', locale: 'English fallback fixture', delivery: 'not suppressed or exercised' };
}
