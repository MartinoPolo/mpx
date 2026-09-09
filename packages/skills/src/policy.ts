import type { CatalogSkill, Exposure } from './contracts.js';
import { isProjectSkill } from './inventory.js';

export function policyExposure(skill: CatalogSkill): { exposure: Exposure; source: string } {
  return isProjectSkill(skill)
    ? { exposure: skill.projectExposure, source: 'managed project declaration' }
    : { exposure: skill.defaultExposure, source: 'canonical declaration' };
}
