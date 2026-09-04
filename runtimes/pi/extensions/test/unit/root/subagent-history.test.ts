import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  countLabel,
  formatDuration,
  formatTokens,
  groupMembers,
  selectDetailRows,
  type FinishedAgent,
} from '../../../lib/subagent-history.js';

test('preserves footer formatting helpers', () => {
  assert.equal(formatDuration(95_000), '1m35s');
  assert.equal(formatDuration(3_661_000), '1h01m');
  assert.equal(formatTokens(25_032), '25.0k');
  assert.equal(countLabel(2, 'Explore'), '2×Explore');
  assert.deepEqual(
    groupMembers([
      { label: 'model', tokens: 10, drifted: false },
      { label: 'model', tokens: 20, drifted: true },
    ]),
    [{ label: 'model', count: 2, tokens: 30, drifted: true }],
  );
});

test('prioritizes broken and running rows, then the highest-token completed rows', () => {
  const agent = (id: string, status: string, tokens: number): FinishedAgent => ({
    id,
    type: id,
    tier: 'model',
    effort: '',
    tokens,
    elapsedMs: 0,
    status,
    drifted: false,
  });
  const rows = [
    agent('completed-low', 'completed', 10),
    agent('running', 'running', 1),
    agent('completed-highest', 'completed', 900),
    agent('failed', 'error', 2),
    agent('completed-high', 'completed', 700),
    agent('completed-lower', 'completed', 100),
    agent('completed-third', 'completed', 500),
  ];

  assert.deepEqual(
    selectDetailRows(rows, 5).map(({ id }) => id),
    ['running', 'failed', 'completed-highest', 'completed-high', 'completed-third'],
  );
});
