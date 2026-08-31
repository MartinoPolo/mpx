import { type CatalogSkill, type RuntimeSkillArtifact } from './contracts.js';
import { validateArtifact } from './artifact.js';

export interface HumanSkillName {
  identity: string;
  publicName: string;
}
export function humanListSkills(artifact: RuntimeSkillArtifact): HumanSkillName[] {
  validateArtifact(artifact);
  return artifact.entries
    .filter((x) => x.permissions.humanInvocation)
    .map(({ identity, publicName }) => ({ identity, publicName }))
    .sort((a, b) => a.identity.localeCompare(b.identity));
}
export function humanCompleteSkills(artifact: RuntimeSkillArtifact, prefix: string): string[] {
  const normalized = prefix.toLowerCase();
  return humanListSkills(artifact)
    .map((x) => x.publicName)
    .filter((x) => x.toLowerCase().startsWith(normalized));
}
export function humanSkillDetail(
  artifact: RuntimeSkillArtifact,
  catalog: readonly CatalogSkill[],
  identity: string,
): { identity: string; publicName: string; description: string } | undefined {
  validateArtifact(artifact, catalog);
  const entry = artifact.entries.find(
    (x) => x.identity === identity && x.permissions.humanInvocation,
  );
  const skill = catalog.find((x) => x.identity === identity);
  return entry && skill
    ? { identity, publicName: entry.publicName, description: skill.description }
    : undefined;
}
export function initialModelContext(
  artifact: RuntimeSkillArtifact,
): Array<{ identity: string; publicName: string; description?: string; triggers?: string }> {
  validateArtifact(artifact);
  return artifact.entries
    .filter((x) => x.permissions.modelInvocation)
    .map((x) => ({
      identity: x.identity,
      publicName: x.publicName,
      ...(x.exposure === 'full' && x.description ? { description: x.description } : {}),
      ...(x.exposure === 'full' && x.triggers ? { triggers: x.triggers } : {}),
    }));
}
