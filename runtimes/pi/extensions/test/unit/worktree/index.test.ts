import assert from 'node:assert/strict';
import path from 'node:path';
import { setImmediate as nextImmediate } from 'node:timers/promises';

import { test } from 'vitest';

import registerWorktree from '../../../worktree/index.js';

class FakePi {
  commands = new Map<string, any>();
  tools = new Map<string, any>();
  handlers = new Map<string, any[]>();
  sentUserMessages: Array<{ message: string; options: unknown }> = [];
  registerCommand(name: string, definition: unknown) {
    this.commands.set(name, definition);
  }
  registerTool(definition: any) {
    this.tools.set(definition.name, definition);
  }
  on(event: string, handler: unknown) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  sendUserMessage(message: string, options: unknown) {
    this.sentUserMessages.push({ message, options });
  }
  sendMessage() {}
  exec() {
    throw new Error('not configured');
  }
}

function context(overrides: Record<string, unknown> = {}) {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    cwd: process.cwd(),
    mode: 'tui',
    sessionManager: {
      getSessionFile: () => path.resolve('saved-session.jsonl'),
      getSessionId: () => 'session-id',
      getBranch: () => [],
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: {
      notifications,
      setStatus() {},
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
    ...overrides,
  } as any;
}

test('extension registers one worktree command and tool with lifecycle handoff gates', () => {
  const pi = new FakePi();
  registerWorktree(pi as never);

  assert.deepEqual([...pi.commands.keys()], ['worktree']);
  assert.deepEqual([...pi.tools.keys()], ['worktree']);
  assert.equal(JSON.stringify(pi.tools.get('worktree').parameters).includes('color'), false);
  assert.deepEqual([...pi.handlers.keys()].sort(), [
    'agent_settled',
    'input',
    'session_shutdown',
    'tool_call',
  ]);
});

test('tool handoff terminates the run and dispatches only after the agent settles', async () => {
  const pi = new FakePi();
  registerWorktree(pi as never);
  const ctx = context();
  const result = await pi.tools
    .get('worktree')
    .execute(
      'call',
      { action: 'create', name: 'feature', task: 'continue' },
      new AbortController().signal,
      undefined,
      ctx,
    );

  assert.equal(result.terminate, true);
  assert.deepEqual(pi.handlers.get('tool_call')![0]({}, ctx), {
    block: true,
    terminate: true,
    reason: 'Worktree handoff pending. Do not execute tools in the old checkout.',
  });
  assert.equal(pi.sentUserMessages.length, 0);
  pi.handlers.get('agent_settled')![0]({}, ctx);
  await nextImmediate();
  assert.match(pi.sentUserMessages[0]!.message, /^\/worktree --handoff /u);
});

test('new user input cancels pending worktree use instead of auto-creating', async () => {
  const pi = new FakePi();
  registerWorktree(pi as never);
  const ctx = context();
  await pi.tools
    .get('worktree')
    .execute(
      'call',
      { action: 'create', name: 'feature', task: 'continue' },
      undefined,
      undefined,
      ctx,
    );
  pi.handlers.get('agent_settled')![0]({}, ctx);
  const outcome = pi.handlers.get('input')![0]({ source: 'interactive' }, ctx);
  await nextImmediate();

  assert.equal(outcome, undefined);
  assert.equal(pi.sentUserMessages.length, 0);
  assert.match(ctx.ui.notifications.at(-1)!.message, /cancelled by your new message/u);
});

test('worktree is unavailable outside a saved main TUI or RPC session', async () => {
  const pi = new FakePi();
  registerWorktree(pi as never);
  await assert.rejects(
    pi.tools
      .get('worktree')
      .execute(
        'call',
        { action: 'enter', path: '.', task: 'continue' },
        undefined,
        undefined,
        context({ mode: 'print' }),
      ),
    /main sessions/u,
  );
});
