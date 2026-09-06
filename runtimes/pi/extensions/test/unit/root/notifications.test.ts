import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate as nextImmediate } from 'node:timers/promises';
import { test } from 'vitest';

import { registerNotifications } from '../../../notifications.js';

function setup(mode = 'tui', hasUI = true) {
  const handlers = new Map<string, (event: any, context: any) => void>();
  let sounds = 0;
  let idle = true;
  let pendingMessages = false;
  const context = {
    mode,
    hasUI,
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
  };
  registerNotifications(
    { on: (name: string, handler: any) => handlers.set(name, handler) } as never,
    async () => {
      sounds++;
    },
  );
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, context);
  return {
    emit,
    get sounds() {
      return sounds;
    },
    set idle(value: boolean) {
      idle = value;
    },
    set pendingMessages(value: boolean) {
      pendingMessages = value;
    },
    start(source = 'interactive') {
      emit('input', { source });
      emit('agent_start');
    },
  };
}

test('main completion sounds once, not at tool, turn, or low-level run end', async () => {
  const harness = setup();
  harness.start();
  for (const event of ['tool_execution_end', 'turn_end', 'agent_end']) {
    harness.emit(event);
  }
  await nextImmediate();
  assert.equal(harness.sounds, 0);
  harness.emit('agent_settled');
  await nextImmediate();
  harness.emit('agent_settled');
  await nextImmediate();
  assert.equal(harness.sounds, 1);
});

test.each(['print', 'json', 'rpc', 'tui'])(
  'headless child in %s mode is always silent',
  async (mode) => {
    const harness = setup(mode, false);
    harness.start();
    harness.emit('ui_prompt_start');
    harness.emit('agent_settled');
    await nextImmediate();
    assert.equal(harness.sounds, 0);
  },
);

test.each(['print', 'json'])('%s stays silent even with an inconsistent UI flag', async (mode) => {
  const harness = setup(mode);
  harness.start();
  harness.emit('agent_settled');
  await nextImmediate();
  assert.equal(harness.sounds, 0);
});

test('foreground and background child completions cannot notify while main is running', async () => {
  const main = setup();
  const child = setup('print', false);
  main.start();
  for (const _kind of ['foreground', 'background']) {
    child.start();
    child.emit('agent_settled');
    main.emit('tool_execution_end');
    await nextImmediate();
  }
  assert.equal(main.sounds + child.sounds, 0);
  main.emit('agent_settled');
  await nextImmediate();
  assert.equal(main.sounds, 1);
});

test('automatic subagent-result runs after main completion do not rearm sound', async () => {
  const harness = setup();
  harness.start();
  harness.emit('agent_settled');
  await nextImmediate();
  harness.start('extension');
  harness.emit('agent_settled');
  await nextImmediate();
  assert.equal(harness.sounds, 1);
});

test('retries and continuation queued by later settled handlers wait for final idle', async () => {
  const harness = setup();
  harness.start();
  harness.emit('agent_end');
  harness.emit('agent_start');
  harness.emit('agent_settled');
  harness.idle = false;
  await nextImmediate();
  assert.equal(harness.sounds, 0);
  harness.emit('agent_start');
  harness.idle = true;
  harness.emit('agent_settled');
  await nextImmediate();
  assert.equal(harness.sounds, 1);
});

test('queued follow-ups prevent notification until the queue is empty', async () => {
  const harness = setup();
  harness.start();
  harness.pendingMessages = true;
  harness.emit('agent_settled');
  await nextImmediate();
  assert.equal(harness.sounds, 0);
  harness.pendingMessages = false;
  harness.emit('agent_start');
  harness.emit('agent_settled');
  await nextImmediate();
  assert.equal(harness.sounds, 1);
});

test('blocking main questions notify, idle menus and child questions do not', () => {
  const harness = setup();
  harness.emit('ui_prompt_start');
  assert.equal(harness.sounds, 0);
  harness.start();
  harness.emit('ui_prompt_start');
  harness.emit('ui_prompt_end');
  assert.equal(harness.sounds, 1);
});

test('an automatic main run can still request real human attention', () => {
  const harness = setup();
  harness.start('extension');
  harness.emit('ui_prompt_start');
  assert.equal(harness.sounds, 1);
});

test.each(['session_shutdown', 'session_start'])(
  '%s cancels queued notification and state',
  async (event) => {
    const harness = setup();
    harness.start();
    harness.emit('agent_settled');
    harness.emit(event);
    await nextImmediate();
    harness.emit('agent_settled');
    await nextImmediate();
    assert.equal(harness.sounds, 0);
  },
);

test('user cancellation is silent but a later user request can notify', async () => {
  const harness = setup();
  harness.start();
  harness.emit('message_end', { message: { role: 'assistant', stopReason: 'aborted' } });
  harness.emit('agent_settled');
  await nextImmediate();
  assert.equal(harness.sounds, 0);
  harness.start();
  harness.emit('agent_settled');
  await nextImmediate();
  assert.equal(harness.sounds, 1);
});

test('main RPC UI supports human prompts and completion', async () => {
  const harness = setup('rpc');
  harness.start('rpc');
  harness.emit('ui_prompt_start');
  harness.emit('agent_settled');
  await nextImmediate();
  assert.equal(harness.sounds, 2);
});

test('Windows sound uses the OS tada asset, never an account copy or beep fallback', () => {
  const source = readFileSync(
    new URL('../../../guards/notify-flash-beep.ps1', import.meta.url),
    'utf8',
  );
  assert.match(source, /Join-Path \$env:WINDIR 'Media\\tada\.wav'/);
  assert.doesNotMatch(source, /Console\]::Beep|FallbackBeep|sounds\\notify\.wav/);
  assert.match(source, /\$player\.Load\(\)/);
  assert.match(source, /\$player\.PlaySync\(\)/);
  assert.match(source, /PI_NOTIFY_SILENT/);
  assert.match(source, /notify-mute/);
});
