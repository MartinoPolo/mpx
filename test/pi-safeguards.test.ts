import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import piSafeguards from '../extensions/pi-safeguards.js';

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown;

async function harness(hasUI: boolean) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-warning-transport-'));
  await writeFile(path.join(cwd, 'package.json'), '{"packageManager":"pnpm@11"}');
  const handlers = new Map<string, Handler>();
  const notifications: string[] = [];
  const context = {
    cwd, hasUI, isProjectTrusted: () => false,
    sessionManager: { getBranch: () => [] },
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext;
  piSafeguards({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  const call = async (name: string, event: Record<string, unknown> = {}) => handlers.get(name)?.(event, context);
  return { cwd, notifications, call, dispose: () => rm(cwd, { recursive: true, force: true }) };
}

const uncertainCommand = 'cd "$TARGET" && pnpm run check';
const toolCall = (id: string, command = uncertainCommand) => ({ toolName: 'bash', toolCallId: id, input: { command } });
const toolResult = (id: string) => ({ toolName: 'bash', toolCallId: id, content: [{ type: 'text', text: 'original output' }], isError: false });

test('actionable warnings notify once but remain attached to every affected tool result', async () => {
  const fixture = await harness(true);
  try {
    await fixture.call('session_start');
    for (const id of ['first', 'repeat']) {
      assert.equal(await fixture.call('tool_call', toolCall(id)), undefined);
      const result = await fixture.call('tool_result', toolResult(id)) as { content: Array<{ type: string; text: string }> };
      assert.equal(result.content[0]?.text, 'original output');
      assert.match(result.content.at(-1)!.text, /pnpm.*dynamic or unresolved/);
      assert.equal(await fixture.call('tool_result', toolResult(id)), undefined, 'annotation is consumed once');
    }
    assert.equal(fixture.notifications.length, 1);
    await fixture.call('tool_call', toolCall('different', 'cd "$TARGET" && npm install'));
    assert.equal(fixture.notifications.length, 2, 'a distinct actionable warning still notifies');
    await fixture.call('session_start');
    await fixture.call('tool_call', toolCall('new-session'));
    assert.equal(fixture.notifications.length, 3, 'deduplication is session scoped');
  } finally { await fixture.dispose(); }
});

test('headless children keep model-visible warnings without writing shared stderr or notifying', async (testContext) => {
  const fixture = await harness(false);
  const stderr: string[] = [];
  testContext.mock.method(process.stderr, 'write', (chunk: unknown) => { stderr.push(String(chunk)); return true; });
  try {
    await fixture.call('tool_call', toolCall('child'));
    const result = await fixture.call('tool_result', toolResult('child')) as { content: Array<{ text: string }> };
    assert.match(result.content.at(-1)!.text, /dynamic or unresolved/);
    assert.deepEqual(stderr, []);
    assert.deepEqual(fixture.notifications, []);
  } finally { await fixture.dispose(); }
});

test('blocking verdicts remain native denials and shutdown clears pending warning annotations', async () => {
  const fixture = await harness(true);
  try {
    for (const [id, command] of [['danger', 'rm -rf src'], ['mismatch', 'npm install']]) {
      const result = await fixture.call('tool_call', toolCall(id!, command)) as { block: boolean; reason: string };
      assert.equal(result.block, true);
      assert.match(result.reason, /Blocked/);
      assert.equal(await fixture.call('tool_result', toolResult(id!)), undefined);
    }
    assert.deepEqual(fixture.notifications, []);
    await fixture.call('tool_call', toolCall('pending'));
    await fixture.call('session_shutdown');
    assert.equal(await fixture.call('tool_result', toolResult('pending')), undefined);
    const notificationsBeforeShutdown = fixture.notifications.length;
    const late = fixture.call('tool_call', toolCall('late'));
    await fixture.call('session_shutdown');
    await late;
    assert.equal(fixture.notifications.length, notificationsBeforeShutdown);
    assert.equal(await fixture.call('tool_result', toolResult('late')), undefined, 'late inspection cannot repopulate a retired session');
  } finally { await fixture.dispose(); }
});
