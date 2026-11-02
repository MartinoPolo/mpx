import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleClaudeHook } from '../src/claude-hooks.js';

const session_id = 'a9f558f0-5e8f-4591-ba9f-10520d559e72';
const wake = (...taskIds: string[]) => taskIds.map(id => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>`).join('\n');
const shell = (id: string) => ({ id, type: 'shell', status: 'running' });

async function promptContext(directory: string, prompt: string): Promise<string> {
  const result = await handleClaudeHook({ hook_event_name: 'UserPromptSubmit', session_id, prompt, cwd: directory }, undefined, undefined, directory);
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
}
async function stop(directory: string, message: string, inFlight: string[]): Promise<void> {
  const result = await handleClaudeHook({ hook_event_name: 'Stop', session_id, last_assistant_message: message, background_tasks: inFlight.map(shell) }, undefined, undefined, directory);
  assert.equal(result.stdout, '');
}

test('the wake-up completing the last background work of a run with open items requests HITL once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mpx-claude-runs-'));
  try {
    assert.doesNotMatch(await promptContext(directory, 'Implement the feature'), /mpx-hitl/);
    await stop(directory, 'Started reviewers.\n\n# HITL\n\n## ❓ Questions\n\n1. **Scope:** keep it?', ['first', 'second']);
    assert.doesNotMatch(await promptContext(directory, wake('first')), /mpx-hitl/, 'another task is still in flight');
    await stop(directory, 'First review handled.', ['second']);
    const runEnd = await promptContext(directory, wake('second'));
    assert.match(runEnd, /mpx-hitl/);
    assert.match(runEnd, /since \d{4}-\d{2}-\d{2}T/);
    await stop(directory, 'All done.\n\n# HITL', []);
    assert.deepEqual(await readdir(directory), [], 'run state clears when nothing is in flight');
    assert.doesNotMatch(await promptContext(directory, wake('second')), /mpx-hitl/, 'a repeated notification after the run end stays quiet');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('runs without open items, simultaneous completions and user replies follow the run boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mpx-claude-runs-'));
  try {
    await promptContext(directory, 'Run checks');
    await stop(directory, 'Checks started.', ['first', 'second']);
    assert.doesNotMatch(await promptContext(directory, wake('first', 'second')), /mpx-hitl/, 'no open items were raised');

    await stop(directory, '# HITL\n\n1. **Pick:** A or B?', ['third']);
    assert.match(await promptContext(directory, wake('third')), /mpx-hitl/, 'one prompt can complete the last task');

    await stop(directory, '# HITL\n\n1. **Pick:** A or B?', ['fourth']);
    assert.doesNotMatch(await promptContext(directory, 'A'), /mpx-hitl/);
    assert.doesNotMatch(await promptContext(directory, wake('fourth')), /mpx-hitl/, 'the user already saw items raised before their reply');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
