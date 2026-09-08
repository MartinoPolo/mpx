import {
  createResolvedSkillManifestV4,
  type ResolvedSkillDecisionV4,
} from '@mpx/runtime-contracts';
import {
  SkillCatalogError,
  digest,
  type CatalogSkill,
  type ResolveOptions,
  type ResolvedManifest,
} from './contracts.js';
import { skillResolutionKey } from './identity.js';
import { isProjectSkill, skillSourceHash } from './inventory.js';
import { effectiveSkillPacks, policyExposure } from './policy.js';

export function resolveManifest(
  catalog: readonly CatalogSkill[],
  options: ResolveOptions,
): ResolvedManifest {
  const canonicalIdentities = new Set(
    catalog.filter((skill) => !isProjectSkill(skill)).map((skill) => skill.identity),
  );
  const exposureSettings = [
    ['skillPolicyConfig.skillExposure', options.skillPolicyConfig.skillExposure],
    ['contentScopeExposure', options.contentScopeExposure],
    ['projectExposure', options.projectExposure],
  ] as const;
  for (const skill of catalog.filter(isProjectSkill)) {
    if (canonicalIdentities.has(skill.identity)) {
      continue;
    }
    for (const [setting, exposure] of exposureSettings) {
      if (Object.hasOwn(exposure?.skills ?? {}, skill.identity)) {
        throw new SkillCatalogError([
          {
            code: 'PROJECT_SKILL_POLICY_KEY_INVALID',
            message: `${setting}.skills['${skill.identity}'] names a canonical skill, but only the project skill exists. Change the key to '${skillResolutionKey(skill)}' to preserve its exposure restriction`,
            path: skill.sourcePath,
          },
        ]);
      }
    }
  }
  const enabled = new Set(effectiveSkillPacks(options));
  const resolution = {
    identity: options.identity,
    skillPolicy: options.skillPolicy,
    skillPolicyConfig: options.skillPolicyConfig,
    enabledPacks: [...enabled].sort(),
    contentScopeExposure: options.contentScopeExposure ?? null,
    projectExposure: options.projectExposure ?? null,
    mapping: options.mapping ?? {},
  };
  const decisions: ResolvedSkillDecisionV4[] = catalog.map((skill) => {
    const packIncluded =
      isProjectSkill(skill) || skill.skillPacks.some((pack) => enabled.has(pack));
    const effective = policyExposure(skill, options);
    const off = effective.exposure === 'off';
    const included = packIncluded && !off;
    return {
      identity: skillResolutionKey(skill),
      included,
      exclusionReasons: [
        ...(!packIncluded ? ['pack-excluded'] : []),
        ...(packIncluded && off ? ['off'] : []),
      ],
      exposure: effective.exposure,
      permissions: {
        humanInvocation: included,
        modelInvocation:
          included && (effective.exposure === 'full' || effective.exposure === 'name-only'),
      },
      metadataHash: digest({
        resolution,
        identity: skillResolutionKey(skill),
        description: skill.description,
        triggers: isProjectSkill(skill) ? null : (skill.triggers ?? null),
        origin: isProjectSkill(skill)
          ? {
              kind: 'project',
              projectRoot: skill.realProjectRoot,
              directoryHash: skill.directoryHash,
            }
          : { kind: 'canonical' },
        packs: isProjectSkill(skill) ? [] : [...skill.skillPacks].sort(),
        defaultExposure: isProjectSkill(skill) ? skill.projectExposure : skill.defaultExposure,
        effectiveExposure: effective.exposure,
        exposureSource: effective.source,
      }),
      sourceHash: skillSourceHash(skill),
    };
  });
  return createResolvedSkillManifestV4({
    binding: {
      projectId: options.projectId ?? null,
      repositoryId: options.repositoryId,
      contentScope: options.contentScope,
    },
    decisions,
  });
}
