import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { GroupJoinManager } from '../../../subagents/group-join.js';
import type { AgentRecord } from '../../../subagents/types.js';

function record(id: string): AgentRecord {
  return { id } as AgentRecord;
}

afterEach(() => vi.useRealTimers());

test('delivers all members together when the group completes before timeout', () => {
  vi.useFakeTimers();
  const deliveries: Array<{ ids: string[]; partial: boolean }> = [];
  const join = new GroupJoinManager((records, partial) => {
    deliveries.push({ ids: records.map((item) => item.id), partial });
  }, 1_000);

  join.registerGroup('group', ['a', 'b']);
  assert.equal(join.onAgentComplete(record('a')), 'held');
  assert.equal(join.onAgentComplete(record('b')), 'delivered');
  vi.advanceTimersByTime(1_000);

  assert.deepEqual(deliveries, [{ ids: ['a', 'b'], partial: false }]);
  assert.equal(join.isGrouped('a'), false);
  assert.equal(join.isGrouped('b'), false);
  join.dispose();
});

test('delivers a timed-out partial batch and re-batches its stragglers', () => {
  vi.useFakeTimers();
  const deliveries: Array<{ ids: string[]; partial: boolean }> = [];
  const join = new GroupJoinManager((records, partial) => {
    deliveries.push({ ids: records.map((item) => item.id), partial });
  }, 1_000);

  join.registerGroup('group', ['a', 'b', 'c']);
  assert.equal(join.onAgentComplete(record('a')), 'held');
  vi.advanceTimersByTime(1_000);
  assert.deepEqual(deliveries, [{ ids: ['a'], partial: true }]);

  assert.equal(join.onAgentComplete(record('b')), 'held');
  vi.advanceTimersByTime(15_000);
  assert.deepEqual(deliveries, [
    { ids: ['a'], partial: true },
    { ids: ['b'], partial: true },
  ]);
  assert.equal(join.onAgentComplete(record('c')), 'delivered');

  assert.deepEqual(deliveries, [
    { ids: ['a'], partial: true },
    { ids: ['b'], partial: true },
    { ids: ['c'], partial: false },
  ]);
  join.dispose();
});

test('canceling a queued member immediately delivers completed peers', () => {
  const deliveries: Array<{ ids: string[]; partial: boolean }> = [];
  const join = new GroupJoinManager((records, partial) => {
    deliveries.push({ ids: records.map((item) => item.id), partial });
  });

  join.registerGroup('group', ['a', 'b']);
  assert.equal(join.onAgentComplete(record('a')), 'held');
  join.cancelAgent('b');

  assert.deepEqual(deliveries, [{ ids: ['a'], partial: false }]);
  assert.equal(join.isGrouped('b'), false);
  join.dispose();
});

test('a remaining member delivers alone when it completes after cancellation', () => {
  const deliveries: Array<{ ids: string[]; partial: boolean }> = [];
  const join = new GroupJoinManager((records, partial) => {
    deliveries.push({ ids: records.map((item) => item.id), partial });
  });

  join.registerGroup('group', ['a', 'b']);
  join.cancelAgent('b');
  assert.deepEqual(deliveries, []);
  assert.equal(join.onAgentComplete(record('a')), 'delivered');

  assert.deepEqual(deliveries, [{ ids: ['a'], partial: false }]);
  join.dispose();
});

test('removing every member without completions emits nothing', () => {
  const deliveries: Array<{ ids: string[]; partial: boolean }> = [];
  const join = new GroupJoinManager((records, partial) => {
    deliveries.push({ ids: records.map((item) => item.id), partial });
  });

  join.registerGroup('group', ['a', 'b']);
  join.cancelAgent('a');
  join.cancelAgent('b');

  assert.deepEqual(deliveries, []);
  assert.equal(join.isGrouped('a'), false);
  assert.equal(join.isGrouped('b'), false);
  join.dispose();
});
