import assert from 'node:assert/strict';
import { test } from 'vitest';

import { registerTerminalProgress } from './index.js';
import { ATTENTION_SEQUENCE, IDLE_SEQUENCE } from './state.js';

function setup() {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const sharedHandlers = new Map<string, (payload: unknown) => void>();
  const writes: string[] = [];
  let unsubscribed = false;
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => void) => handlers.set(event, handler),
    events: {
      on: (event: string, handler: (payload: unknown) => void) => {
        sharedHandlers.set(event, handler);
        return () => {
          unsubscribed = true;
        };
      },
    },
  };
  registerTerminalProgress(pi as never, {
    write: (sequence) => writes.push(sequence),
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
  });
  return {
    handlers,
    sharedHandlers,
    writes,
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

test('adapter does not create terminal progress outside TUI mode', () => {
  const harness = setup();
  harness.handlers.get('session_start')?.({}, { mode: 'rpc' });
  harness.handlers.get('agent_start')?.({}, { mode: 'rpc' });

  assert.deepEqual(harness.writes, []);
  assert.equal(harness.sharedHandlers.size, 0);
});

test('adapter maps stable blocked events and all fallback question tool names', () => {
  const harness = setup();
  harness.handlers.get('session_start')?.({}, { mode: 'tui' });
  const blocked = harness.sharedHandlers.get('rpiv:ask-user:blocked')!;
  blocked({ active: true });
  blocked({ active: false });

  for (const [index, toolName] of ['ask_user_question', 'question', 'questionnaire'].entries()) {
    harness.handlers.get('tool_execution_start')?.({ toolCallId: String(index), toolName }, {});
  }
  harness.handlers.get('tool_execution_end')?.(
    { toolCallId: '0', toolName: 'ask_user_question' },
    {},
  );
  harness.handlers.get('tool_execution_end')?.({ toolCallId: '1', toolName: 'question' }, {});
  assert.equal(harness.writes.at(-1), ATTENTION_SEQUENCE);
  harness.handlers.get('tool_execution_end')?.({ toolCallId: '2', toolName: 'questionnaire' }, {});

  assert.deepEqual(harness.writes, [
    IDLE_SEQUENCE,
    ATTENTION_SEQUENCE,
    IDLE_SEQUENCE,
    ATTENTION_SEQUENCE,
    IDLE_SEQUENCE,
  ]);
});

test('shutdown clears progress and unsubscribes from shared events', () => {
  const harness = setup();
  harness.handlers.get('session_start')?.({}, { mode: 'tui' });
  harness.handlers.get('agent_start')?.({}, {});
  harness.handlers.get('session_shutdown')?.({}, {});

  assert.equal(harness.writes.at(-1), IDLE_SEQUENCE);
  assert.equal(harness.unsubscribed, true);
});
