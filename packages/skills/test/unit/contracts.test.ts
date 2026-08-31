import { expect, it } from 'vitest';
import { resolveEffectiveSkillPacks } from '../../src/contracts.js';

it('resolves effective packs from project, content-scope, and policy precedence', () => {
  expect(resolveEffectiveSkillPacks({})).toEqual(['core']);
  expect(resolveEffectiveSkillPacks({ contentScopeSkillPacks: ['work', 'core', 'work'] })).toEqual([
    'core',
    'work',
  ]);
  expect(
    resolveEffectiveSkillPacks({
      contentScopeSkillPacks: ['core', 'personal'],
      projectSkillPacks: ['work', 'core'],
      skillPolicySkillPacks: ['core', 'personal'],
    }),
  ).toEqual(['core']);
});
