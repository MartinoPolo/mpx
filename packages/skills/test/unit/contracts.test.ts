import { expect, it } from 'vitest';
import { resolveEffectiveSkillPacks } from '../../src/contracts.js';

it('returns a stable unique selected subset allowed by identity', () => {
  expect(
    resolveEffectiveSkillPacks(
      ['personal', 'development', 'personal'],
      ['development', 'personal'],
    ),
  ).toEqual(['development', 'personal']);
});
