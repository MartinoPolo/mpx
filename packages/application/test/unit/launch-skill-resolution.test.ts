import { describe, expect, it, vi } from 'vitest';
import { createSkillArtifactReference, sha256Canonical } from '@mpx/core';
import type { CanonicalSkill, ResolvedSkillSelection } from '@mpx/skills/contracts';
import { resolveLaunchSkills } from '../../src/index.js';

const selection: ResolvedSkillSelection = {
  location: { name: 'coding', canonicalRoot: 'C:/project' },
  packs: ['development'],
  source: 'project',
};

describe('launch skill resolution', () => {
  it('forwards one authoritative selection into the manifest and launch artifact bindings', async () => {
    const result = await resolveLaunchSkills(
      {
        project: {
          root: 'C:/project',
          path: 'C:/project/mpxconfig.json',
          config: {
            schemaVersion: 1,
            project: { id: 'discovered/project' },
            repository: { provider: 'generic', remote: 'origin' },
            skills: { packs: ['development'] },
          },
        },
        repositoryId: 'recorded/repository',
        canonicalRoot: 'C:/catalog',
        identity: 'work',
        selection,
        runtime: 'pi',
      },
      {
        inventoryCanonical: async () => [],
        inventoryProjectSkills: async () => ({ skills: [], diagnostics: [] }),
      },
    );

    expect(result.options.selection).toEqual(selection);
    expect(result.manifest.binding).toEqual({
      projectId: 'discovered/project',
      repositoryId: 'recorded/repository',
      identity: 'work',
      selection,
    });
    expect(result.skillArtifact).toMatchObject({
      projectId: 'discovered/project',
      repositoryId: 'recorded/repository',
      identity: 'work',
      location: selection.location,
      packs: selection.packs,
      selectionSource: selection.source,
    });
  });

  it('creates one immutable deterministic launch-bound resolution from canonical and project inventory', async () => {
    const canonical: CanonicalSkill[] = [
      {
        identity: 'z-skill',
        schemaVersion: 1,
        description: 'canonical',
        skillPacks: ['development'],
        defaultExposure: 'full',
        contentHash: 'a'.repeat(64),
        sourcePath: 'C:/catalog/z-skill/SKILL.md',
        realPath: 'C:/catalog/z-skill/SKILL.md',
      },
    ];
    const inventoryProjectSkills = vi.fn(async () => ({ skills: [], diagnostics: [] }));
    const result = await resolveLaunchSkills(
      {
        project: {
          root: 'C:/project',
          path: 'C:/project/mpxconfig.json',
          config: {
            schemaVersion: 1,
            project: { id: 'sample/app' },
            repository: { provider: 'generic', remote: 'origin' },
          },
        },
        canonicalRoot: 'C:/catalog',
        identity: 'work',
        selection,
        runtime: 'pi',
      },
      {
        inventoryCanonical: async () => canonical,
        inventoryProjectSkills,
      },
    );

    expect(inventoryProjectSkills).toHaveBeenCalledWith('C:/project', canonical);
    expect(result.catalog.map((skill) => skill.identity)).toEqual(['z-skill']);
    expect(result.skillArtifact).toEqual(
      createSkillArtifactReference({
        runtime: 'pi',
        identity: 'work',
        projectId: 'sample/app',
        repositoryId: 'sample/app',
        catalogHash: sha256Canonical([
          { identity: 'z-skill', contentHash: 'a'.repeat(64), origin: 'canonical' },
        ]),
        selection,
      }),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.catalog)).toBe(true);
    expect(Object.isFrozen(result.skillArtifact)).toBe(true);
  });
});
