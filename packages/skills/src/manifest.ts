import {
  createResolvedSkillManifestV4,
  type ResolvedSkillDecisionV4,
} from '@mpx/runtime-contracts';
import {
  digest,
  type CatalogSkill,
  type ResolveOptions,
  type ResolvedManifest,
} from './contracts.js';
import { isProjectSkill, skillSourceHash } from './inventory.js';
import { effectiveSkillPacks, policyExposure } from './policy.js';

export function resolveManifest(
  catalog: readonly CatalogSkill[],
  options: ResolveOptions,
): ResolvedManifest {
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
      identity: skill.identity,
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
        identity: skill.identity,
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
