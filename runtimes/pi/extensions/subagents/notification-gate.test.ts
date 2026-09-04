// VENDOR EDIT (mpx-pi): regression coverage for parent-run notification gating.
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ParentRunNotificationGate,
  registerParentRunNotificationGate,
} from './notification-gate.js';

test('binds notification gating to the parent run lifecycle', () => {
  const hooks = new Map<string, () => void>();
  const delivered: Array<{ id: string; triggerTurn: boolean }> = [];
  const gate = registerParentRunNotificationGate((event, handler) => hooks.set(event, handler));
  const record = { id: 'agent-1', resultConsumed: false };

  hooks.get('agent_start')?.();
  gate.scheduleIndividual(record, (unread, triggerTurn) =>
    delivered.push({ id: unread.id, triggerTurn }),
  );
  assert.deepEqual(delivered, []);
  hooks.get('agent_settled')?.();

  assert.deepEqual(delivered, [{ id: 'agent-1', triggerTurn: true }]);
});

test('drops a completion consumed during the parent run', () => {
  const delivered: string[] = [];
  const gate = new ParentRunNotificationGate();

  gate.onParentAgentStart();
  const record = { id: 'agent-1', resultConsumed: false };
  gate.scheduleIndividual(record, (unread) => delivered.push(unread.id));
  gate.consume(record);
  gate.onParentAgentSettled();

  assert.deepEqual(delivered, []);
});

test('flushes all unread completions with one turn trigger', () => {
  const delivered: Array<{ id: string; triggerTurn: boolean }> = [];
  const gate = new ParentRunNotificationGate();
  const firstRecord = { id: 'agent-1', resultConsumed: false };
  const secondRecord = { id: 'agent-2', resultConsumed: false };

  gate.onParentAgentStart();
  gate.scheduleIndividual(firstRecord, (unread, triggerTurn) => {
    delivered.push({ id: unread.id, triggerTurn });
  });
  gate.scheduleIndividual(secondRecord, (unread, triggerTurn) => {
    delivered.push({ id: unread.id, triggerTurn });
  });
  gate.onParentAgentSettled();

  assert.deepEqual(delivered, [
    { id: 'agent-1', triggerTurn: false },
    { id: 'agent-2', triggerTurn: true },
  ]);
});

test('waits for active background agents before continuing a settled parent', () => {
  const delivered: Array<{ id: string; triggerTurn: boolean }> = [];
  const gate = new ParentRunNotificationGate();
  const record = { id: 'agent-1', resultConsumed: false };

  gate.onParentAgentStart();
  gate.onBackgroundAgentsActiveChanged(true);
  gate.scheduleIndividual(record, (unread, triggerTurn) => {
    delivered.push({ id: unread.id, triggerTurn });
  });
  gate.onParentAgentSettled();
  assert.deepEqual(delivered, []);

  gate.onBackgroundAgentsActiveChanged(false);
  assert.deepEqual(delivered, [{ id: 'agent-1', triggerTurn: true }]);
});

test('batches idle background completions into one continuation', () => {
  const delivered: Array<{ id: string; triggerTurn: boolean }> = [];
  const gate = new ParentRunNotificationGate();
  const firstRecord = { id: 'agent-1', resultConsumed: false };
  const secondRecord = { id: 'agent-2', resultConsumed: false };

  gate.onBackgroundAgentsActiveChanged(true);
  gate.scheduleIndividual(firstRecord, (unread, triggerTurn) => {
    delivered.push({ id: unread.id, triggerTurn });
  });
  gate.scheduleIndividual(secondRecord, (unread, triggerTurn) => {
    delivered.push({ id: unread.id, triggerTurn });
  });
  assert.deepEqual(delivered, []);

  gate.onBackgroundAgentsActiveChanged(false);
  assert.deepEqual(delivered, [
    { id: 'agent-1', triggerTurn: false },
    { id: 'agent-2', triggerTurn: true },
  ]);
});

test('re-checks mutable consumption state when a grouped completion is flushed', () => {
  const delivered: string[][] = [];
  const records = [
    { id: 'agent-1', resultConsumed: false },
    { id: 'agent-2', resultConsumed: false },
  ];
  const gate = new ParentRunNotificationGate();

  gate.onParentAgentStart();
  gate.scheduleGroup('group:agent-1,agent-2', records, (unread) => {
    delivered.push(unread.map((record) => record.id));
  });
  gate.consume(records[0]);
  gate.onParentAgentSettled();

  assert.deepEqual(delivered, [['agent-2']]);
});

test('drops a grouped completion when every result is consumed', () => {
  const delivered: string[][] = [];
  const records = [
    { id: 'agent-1', resultConsumed: false },
    { id: 'agent-2', resultConsumed: false },
  ];
  const gate = new ParentRunNotificationGate();

  gate.onParentAgentStart();
  gate.scheduleGroup('group:agent-1,agent-2', records, (unread) => {
    delivered.push(unread.map((record) => record.id));
  });
  for (const record of records) gate.consume(record);
  gate.onParentAgentSettled();

  assert.deepEqual(delivered, []);
});

test('delivers unread completions immediately while the parent is idle', () => {
  const delivered: string[] = [];
  const gate = new ParentRunNotificationGate();

  const record = { id: 'agent-1', resultConsumed: false };
  gate.scheduleIndividual(record, (unread) => delivered.push(unread.id));

  assert.deepEqual(delivered, ['agent-1']);
});

test('does not deliver queued completions after disposal', () => {
  const delivered: string[] = [];
  const gate = new ParentRunNotificationGate();

  gate.onParentAgentStart();
  const firstRecord = { id: 'agent-1', resultConsumed: false };
  const secondRecord = { id: 'agent-2', resultConsumed: false };
  gate.scheduleIndividual(firstRecord, (unread) => delivered.push(unread.id));
  gate.dispose();
  gate.onParentAgentSettled();
  gate.scheduleIndividual(secondRecord, (unread) => delivered.push(unread.id));

  assert.deepEqual(delivered, []);
});
