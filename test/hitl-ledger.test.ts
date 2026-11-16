import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleClaudeHook } from '../src/claude-hooks.js';
import { parseHitlSection } from '../src/hitl-ledger.js';

const session_id = 'a9f558f0-5e8f-4591-ba9f-10520d559e72';
const IN_FLIGHT = [{ id: 'review', type: 'shell', status: 'running' }];
const FIRST_SECTION = '# HITL\n\n## ❓ Questions\n\n1. 🛑 **Scope:** keep it?\n\n   - **A.** yes.\n\n2. **Name:** which one?\n\n## 🛠️ To do\n\n3. **Sign in:** open the page.';

async function promptContext(directory: string, prompt: string): Promise<string> {
  const result = await handleClaudeHook({ hook_event_name: 'UserPromptSubmit', session_id, prompt, cwd: directory }, undefined, undefined, directory);
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
}
/** Returns the reason the stop was refused, or undefined when the message was accepted. */
async function stop(directory: string, message: string, options: { inFlight?: boolean; continued?: boolean } = {}): Promise<string | undefined> {
  const result = await handleClaudeHook({ hook_event_name: 'Stop', session_id, last_assistant_message: message, background_tasks: options.inFlight ? IN_FLIGHT : [], stop_hook_active: options.continued }, undefined, undefined, directory);
  return result.stdout ? JSON.parse(result.stdout).reason as string : undefined;
}
async function withLedger(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'mpx-hitl-ledgers-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('a wake-up message must account for every open item under its session number', () => withLedger(async directory => {
  assert.doesNotMatch(await promptContext(directory, 'Implement the feature'), /HITL/);
  assert.equal(await stop(directory, `Started reviewers.\n\n${FIRST_SECTION}`, { inFlight: true }), undefined);
  const context = await promptContext(directory, '<task-notification>\n<task-id>review</task-id>\n</task-notification>');
  assert.match(context, /1 "Scope" \(question\); 2 "Name" \(question\); 3 "Sign in" \(to do\)/);
  assert.match(context, /from 4 up/);

  const silent = await stop(directory, 'Nothing new: the review is still running.', { inFlight: true });
  assert.match(silent ?? '', /Not accounted for: 1 "Scope" \(question\), 2 "Name" \(question\), 3 "Sign in" \(to do\)\. List each one under Still open/);

  const restarted = await stop(directory, '# HITL\n\n## ❓ Questions\n\n1. **Voice:** which one?\n\n## ⏳ Still open\n\n2. **Name** (question)\n3. **Sign in** (to do)', { inFlight: true });
  assert.match(restarted ?? '', /Number 1 still belongs to "Scope" \(question\), so keep that title; a new item takes a number from 4 up/);

  assert.equal(await stop(directory, 'Review done.\n\n# HITL\n\n## ❓ Questions\n\n4. **Voice:** which one?\n\n## ⏳ Still open\n\n1. 🛑 **Scope** (question)\n2. **Name** (question)\n3. **Sign in** (to do)', { inFlight: true }), undefined);
  assert.match(await promptContext(directory, 'status?'), /4 "Voice" \(question\).*from 5 up/);
}));

test('the message that ends a run restates open items in full and closes only what it names', () => withLedger(async directory => {
  await stop(directory, FIRST_SECTION, { inFlight: true });
  const abbreviated = await stop(directory, 'All done.\n\n# HITL\n\n## ⏳ Still open\n\n1. 🛑 **Scope** (question)\n2. **Name** (question)\n3. **Sign in** (to do)');
  assert.match(abbreviated ?? '', /Nothing is in flight.*write 1, 2, 3 in full/);
  assert.equal(await stop(directory, `All done.\n\n${FIRST_SECTION}`), undefined);

  const dropped = await stop(directory, 'Applied your answers.\n\n# HITL\n\n## ❓ Questions\n\n2. **Name:** which one?\n\nClosed: 1 (A, see PR #3)');
  assert.match(dropped ?? '', /Not accounted for: 3 "Sign in" \(to do\)\. Write each one in full/);
  assert.equal(await stop(directory, '# HITL\n\n## ❓ Questions\n\n2. **Name:** which one?\n\nClosed: 1 (A, see PR #3), 3 (signed in)'), undefined);
  assert.match(await promptContext(directory, 'next'), /Open HITL items: 2 "Name" \(question\)\./);

  const reused = await stop(directory, '# HITL\n\n## ❓ Questions\n\n1. **Colour:** which one?\n\n2. **Name:** which one?');
  assert.match(reused ?? '', /Number 1 was used before; a new item takes a number from 4 up/);
  assert.equal(await stop(directory, 'Named.\n\n# HITL\n\nClosed: 2 (Alfred)'), undefined);
  assert.equal(await promptContext(directory, 'next'), 'Response style: answer first, concise, structured.\n\nNew HITL items take numbers from 4 up.');
  assert.equal(await stop(directory, 'Nothing needs you.'), undefined);
}));

test('a continued stop is never refused twice and keeps unaccounted items open', () => withLedger(async directory => {
  await stop(directory, FIRST_SECTION);
  assert.match(await stop(directory, 'Done.') ?? '', /Not accounted for/);
  assert.equal(await stop(directory, '# HITL\n\n## ❓ Questions\n\n1. **Scope:** keep it?', { continued: true }), undefined);
  assert.match(await promptContext(directory, 'next'), /1 "Scope" \(question\); 2 "Name" \(question\); 3 "Sign in" \(to do\)/);
  const withoutMessage = await handleClaudeHook({ hook_event_name: 'Stop', session_id }, undefined, undefined, directory);
  assert.equal(withoutMessage.stdout, '', 'a stop event without the final message cannot be judged');
}));

test('the section parser reads the real section and ignores quoted examples and untracked parts', () => {
  const section = parseHitlSection('See the format:\n\n```markdown\n# HITL\n\n1. **Example:** ignored.\n```\n\n# HITL\n\n## ❓ Questions\n\n7. **Voice:** which one?\n\n   1. **Nested:** a step inside the body.\n\n## ⏳ Still open\n\n5. 🛑 **Enable Serve** (to do)\n\n**Closed:** 2 (A), 4 (done in 3 steps)\n\n## ℹ️ FYI\n\n9. **Legacy numbered note:** one line.');
  assert.deepEqual(section, {
    fullItems: [{ number: 7, title: 'Voice', kind: 'question' }],
    stillOpenItems: [{ number: 5, title: 'Enable Serve', kind: 'to do' }],
    closedNumbers: [2, 4],
    highestNumber: 9,
  });
  assert.equal(parseHitlSection('No section here.\n\n```\n# HITL\n```'), undefined);
});
