import { expect, it } from 'vitest';
import { bareSkillIdentity } from '../../src/index.js';

it.each([
  ['commit', 'canonical', 'commit'],
  ['skill:commit', 'project', 'commit'],
  ['commit', 'project', undefined],
  ['skill:commit', 'canonical', undefined],
  ['mpx:commit', 'canonical', undefined],
  ['skill:skill:commit', 'project', undefined],
  ['skill:../commit', 'project', undefined],
  ['skill:commit/other', 'project', undefined],
  ['skill:Commit', 'project', undefined],
  ['skill:commit--push', 'project', undefined],
] as const)('validates resolution identity %s for %s origin', (identity, origin, expected) => {
  expect(bareSkillIdentity(identity, origin)).toBe(expected);
});
