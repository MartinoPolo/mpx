import {
  resolveEffectiveSkillPacks,
  type CanonicalSkill,
  type CatalogSkill,
  type Exposure,
  type ResolveOptions,
  type SkillPack,
} from './contracts.js';
import { isProjectSkill } from './inventory.js';

function effectiveExposure(
  skill: CanonicalSkill,
  options: ResolveOptions,
): { exposure: Exposure; source: string } {
  const p = options.projectExposure,
    s = options.contentScopeExposure;
  if (p?.skills?.[skill.identity]) {
    return { exposure: p.skills[skill.identity]!, source: 'project skill override' };
  }
  if (p?.default) {
    return { exposure: p.default, source: 'project default' };
  }
  if (s?.skills?.[skill.identity]) {
    return { exposure: s.skills[skill.identity]!, source: 'content-scope skill override' };
  }
  if (s?.default) {
    return { exposure: s.default, source: 'content-scope default' };
  }
  const catalogExposure = {
    exposure: skill.defaultExposure ?? 'name-only',
    source: skill.defaultExposure ? 'canonical default' : 'fallback',
  };
  return catalogExposure;
}

/** Disclosure descends from initial body metadata to name, explicit human lookup, then absence. */
const disclosureRank: Record<Exposure, number> = {
  full: 3,
  'name-only': 2,
  'explicit-only': 1,
  off: 0,
};

function narrower(left: Exposure, right: Exposure): Exposure {
  return disclosureRank[left] <= disclosureRank[right] ? left : right;
}
export function policyExposure(
  skill: CatalogSkill,
  options: ResolveOptions,
): { exposure: Exposure; source: string } {
  const policy = options.skillPolicyConfig.skillExposure;
  const selectedPolicyExposure = policy.skills?.[skill.identity] ?? policy.default;
  if (isProjectSkill(skill)) {
    const scopeExposure =
      options.contentScopeExposure?.skills?.[skill.identity] ??
      options.contentScopeExposure?.default ??
      'full';
    const projectExposure =
      options.projectExposure?.skills?.[skill.identity] ??
      options.projectExposure?.default ??
      'full';
    return {
      exposure: [scopeExposure, projectExposure, selectedPolicyExposure].reduce(
        narrower,
        skill.projectExposure as Exposure,
      ),
      source: `project catalog ceiling (${skill.projectExposure}); narrowed by content scope (${scopeExposure}), project (${projectExposure}), and skill policy '${options.skillPolicy}' (${selectedPolicyExposure})`,
    };
  }
  const base = effectiveExposure(skill, options);
  return {
    exposure: narrower(base.exposure, selectedPolicyExposure),
    source: `${base.source}; narrowed by skill policy '${options.skillPolicy}' (${selectedPolicyExposure})`,
  };
}

export function effectiveSkillPacks(options: ResolveOptions): SkillPack[] {
  return resolveEffectiveSkillPacks({
    contentScopeSkillPacks: options.enabledPacks,
    skillPolicySkillPacks: options.skillPolicyConfig.skillPacks,
  });
}

export function explainSkill(
  skill: CatalogSkill,
  options: ResolveOptions,
): { identity: string; included: boolean; exposure?: Exposure; source?: string } {
  const enabled = new Set(effectiveSkillPacks(options));
  const packIncluded = isProjectSkill(skill) || skill.skillPacks.some((pack) => enabled.has(pack));
  if (!packIncluded) {
    return { identity: skill.identity, included: false };
  }
  const result = policyExposure(skill, options);
  return {
    identity: skill.identity,
    included: result.exposure !== 'off',
    exposure: result.exposure,
    source: result.source,
  };
}
