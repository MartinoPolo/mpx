import { createResolvedSkillManifest, type ResolvedSkillDecision } from '@mpx/runtime-contracts';
import {
  digest,
  type CatalogSkill,
  type ResolveOptions,
  type ResolvedManifest,
} from './contracts.js';
import { skillResolutionKey } from './identity.js';
import { isProjectSkill, skillSourceHash } from './inventory.js';
import { policyExposure } from './policy.js';

export function resolveManifest(
  catalog: readonly CatalogSkill[],
  options: ResolveOptions,
): ResolvedManifest {
  const enabled = new Set(options.selection.packs);
  const resolution = {
    identity: options.identity,
    selection: options.selection,
    mapping: options.mapping ?? {},
  };
  const decisions: ResolvedSkillDecision[] = catalog.map((skill) => {
    const included = isProjectSkill(skill) || skill.skillPacks.some((pack) => enabled.has(pack));
    const effective = policyExposure(skill);
    return {
      identity: skillResolutionKey(skill),
      included,
      exclusionReasons: included ? [] : ['pack-excluded'],
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
        declaredExposure: effective.exposure,
        exposureSource: effective.source,
      }),
      sourceHash: skillSourceHash(skill),
    };
  });
  return createResolvedSkillManifest({
    binding: {
      projectId: options.projectId ?? null,
      repositoryId: options.repositoryId,
      identity: options.identity,
      selection: options.selection,
    },
    decisions,
  });
}
