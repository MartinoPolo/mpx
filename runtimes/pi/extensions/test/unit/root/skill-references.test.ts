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

const accepted = {
  mpx: new Set(['review']),
  skill: new Set(['audit']),
};

for (const [name, text] of [
  [
    'backtick fence with consecutive empty lines and surrounding blanks',
    '\n```text\n/mpx:review\n\n\n/skill:audit\n```\n\n/mpx:review /skill:audit',
  ],
  [
    'tilde fence with consecutive empty lines and surrounding blanks',
    '\n~~~text\n/mpx:review\n\n\n/skill:audit\n~~~\n\n/mpx:review /skill:audit',
  ],
  [
    'CRLF fence with consecutive empty lines',
    '\r\n```text\r\n/mpx:review\r\n\r\n\r\n/skill:audit\r\n```\r\n/mpx:review /skill:audit',
  ],
] as const) {
  test(`fenced references are literal in ${name}`, () => {
    const visibleMpx = text.lastIndexOf('/mpx:review');
    const visibleSkill = text.lastIndexOf('/skill:audit');
    assert.deepEqual(findSubmittedSkillReferences(text, accepted), [
      {
        namespace: 'mpx',
        identity: 'review',
        start: visibleMpx,
        end: visibleMpx + '/mpx:review'.length,
      },
      {
        namespace: 'skill',
        identity: 'audit',
        start: visibleSkill,
        end: visibleSkill + '/skill:audit'.length,
      },
    ]);
  });
}

test('unclosed fence ending on empty lines remains literal', () => {
  const text = '```text\n/mpx:review\n/skill:audit\n\n';
  assert.deepEqual(findSubmittedSkillReferences(text, accepted), []);
});
