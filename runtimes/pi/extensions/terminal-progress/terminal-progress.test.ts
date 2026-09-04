import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  IDLE_SEQUENCE,
  ATTENTION_SEQUENCE,
  WORKING_SEQUENCE,
  TerminalProgressController,
} from './state.js';

interface FakeTimer {
  callback: () => void;
  cleared: boolean;
  unrefCalled: boolean;
}

test('exports complete Windows Terminal progress sequences', () => {
  assert.equal(IDLE_SEQUENCE, '\x1b]9;4;0;0\x07');
  assert.equal(WORKING_SEQUENCE, '\x1b]9;4;3;0\x07');
  assert.equal(ATTENTION_SEQUENCE, '\x1b]9;4;4;100\x07');
});

function setup() {
  const writes: string[] = [];
  let timer: FakeTimer | undefined;
  const controller = new TerminalProgressController({
    write: (sequence) => writes.push(sequence),
    setInterval: (callback, milliseconds) => {
      assert.equal(milliseconds, 1_000);
      timer = { callback, cleared: false, unrefCalled: false };
      return {
        unref: () => {
          timer!.unrefCalled = true;
        },
      } as NodeJS.Timeout;
    },
    clearInterval: () => {
      timer!.cleared = true;
    },
  });
  return {
    controller,
    writes,
    get timer() {
      return timer!;
    },
  };
}

test('agent lifecycle changes working to idle without duplicate writes', () => {
  const harness = setup();
  assert.deepEqual(harness.writes, [IDLE_SEQUENCE]);

  harness.controller.onAgentStart();
  harness.controller.onAgentStart();
  harness.controller.onAgentSettled();
  harness.controller.onAgentSettled();

  assert.deepEqual(harness.writes, [IDLE_SEQUENCE, WORKING_SEQUENCE, IDLE_SEQUENCE]);
});

test('blocked user input takes priority over working', () => {
  const { controller, writes } = setup();
  controller.onAgentStart();
  controller.onBlocked(true);
  controller.onAgentSettled();
  controller.onBlocked(false);

  assert.deepEqual(writes, [IDLE_SEQUENCE, WORKING_SEQUENCE, ATTENTION_SEQUENCE, IDLE_SEQUENCE]);
});

test('blocked event activation and deactivation are idempotent', () => {
  const { controller, writes } = setup();
  controller.onBlocked(true);
  controller.onBlocked(true);
  controller.onBlocked(false);
  controller.onBlocked(false);

  assert.deepEqual(writes, [IDLE_SEQUENCE, ATTENTION_SEQUENCE, IDLE_SEQUENCE]);
});

test('multiple compatible question calls retain attention until all finish', () => {
  const { controller, writes } = setup();
  controller.onQuestionStart('one');
  controller.onQuestionStart('two');
  controller.onQuestionEnd('one');
  assert.equal(controller.currentSequence, ATTENTION_SEQUENCE);
  controller.onQuestionEnd('two');

  assert.deepEqual(writes, [IDLE_SEQUENCE, ATTENTION_SEQUENCE, IDLE_SEQUENCE]);
});

test('keepalive repeats only the current non-idle state', () => {
  const harness = setup();
  assert.equal(harness.timer.unrefCalled, true);
  harness.timer.callback();
  harness.controller.onAgentStart();
  harness.timer.callback();
  harness.controller.onBlocked(true);
  harness.timer.callback();

  assert.deepEqual(harness.writes, [
    IDLE_SEQUENCE,
    WORKING_SEQUENCE,
    WORKING_SEQUENCE,
    ATTENTION_SEQUENCE,
    ATTENTION_SEQUENCE,
  ]);
});

test('dispose clears attention, timer, and is idempotent', () => {
  const harness = setup();
  harness.controller.onBlocked(true);
  harness.controller.dispose();
  harness.controller.dispose();
  harness.timer.callback();

  assert.equal(harness.timer.cleared, true);
  assert.deepEqual(harness.writes, [IDLE_SEQUENCE, ATTENTION_SEQUENCE, IDLE_SEQUENCE]);
});
