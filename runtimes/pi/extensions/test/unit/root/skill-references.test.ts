import assert from 'node:assert/strict';

import { test } from 'vitest';

import { findSubmittedSkillReferences } from '../../../skill-references.js';

test('submitted references inside quotes, inline code, fences, escapes, or partial names are literal', () => {
  const text =
    '“/mpx:review” `/mpx:review` \\/mpx:review /mpx:rev\n~~~~ markdown\n/mpx:review\n~~~~\n````ts\n/mpx:review\n````';
  assert.deepEqual(
    findSubmittedSkillReferences(text, { mpx: new Set(['review']), skill: new Set() }),
    [],
  );
});
