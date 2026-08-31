import { expect, expectTypeOf, it } from 'vitest';
import * as config from '../../src/index.js';
import {
  EXPOSURES,
  SKILL_PACKS,
  resolveEffectiveSkillPacks,
  type ExposureConfig,
  type SkillPolicyConfig,
} from '@mpx/skills/contracts';

it('keeps config contract exports identical to the skills-owned contracts', () => {
  expect(config.EXPOSURES).toBe(EXPOSURES);
  expect(config.SKILL_PACKS).toBe(SKILL_PACKS);
  expect(config.resolveEffectiveSkillPacks).toBe(resolveEffectiveSkillPacks);
});

it('keeps config skill policy types compatible with the canonical contract shape', () => {
  expectTypeOf<config.ExposureConfig>().toEqualTypeOf<ExposureConfig>();
  expectTypeOf<config.SkillPolicyConfig>().toEqualTypeOf<SkillPolicyConfig>();
});
