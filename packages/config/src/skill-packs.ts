import type { SkillPack } from './types.js';

export interface EffectiveSkillPackOptions {
  readonly contentScopeSkillPacks?: readonly SkillPack[] | undefined;
  readonly projectSkillPacks?: readonly SkillPack[] | undefined;
  readonly skillPolicySkillPacks?: readonly SkillPack[] | undefined;
}

export function resolveEffectiveSkillPacks(options: EffectiveSkillPackOptions): SkillPack[] {
  const selectedPacks = options.projectSkillPacks ?? options.contentScopeSkillPacks ?? ['core'];
  const allowedPacks = options.skillPolicySkillPacks
    ? new Set(options.skillPolicySkillPacks)
    : undefined;
  return [
    ...new Set(selectedPacks.filter((pack) => !allowedPacks || allowedPacks.has(pack))),
  ].sort();
}
