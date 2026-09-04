import assert from 'node:assert/strict';

import { test } from 'vitest';

import { COMPACTION_ROWS, formatClock, formatTokensK } from '../../../lib/compaction.js';

test('preserves the compact history row limit and token formatting', () => {
  assert.equal(COMPACTION_ROWS, 3);
  assert.equal(formatTokensK(227_148), '227k');
  assert.equal(formatTokensK(10_000), ' 10k');
  assert.equal(formatTokensK(10_500), ' 11k');
});

test('formats valid timestamps as local clocks and rejects invalid timestamps', () => {
  const localTimestamp = new Date(2026, 0, 2, 3, 4).toISOString();

  assert.equal(formatClock(localTimestamp), '03:04');
  assert.equal(formatClock('not-a-timestamp'), '');
});
