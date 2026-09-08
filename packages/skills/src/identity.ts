import type { CatalogSkill } from './contracts.js';
import { isProjectSkill } from './inventory.js';

const PROJECT_PREFIX = 'skill:';

/** Internal resolution key. Canonical identities retain their established bare contract. */
export function skillResolutionKey(skill: CatalogSkill): string {
  return isProjectSkill(skill) ? `${PROJECT_PREFIX}${skill.identity}` : skill.identity;
}
