import { describe, expect, it, vi } from 'vitest';
import type { UserConfig } from '@mpx/config';
import { createSkillArtifactReference, sha256Canonical, type JsonValue } from '@mpx/core';
import type { CanonicalSkill } from '@mpx/skills';
import { resolveLaunchSkills } from '../../src/index.js';

const user: UserConfig = {
  identities: {
    work: {
      domain: 'work',
      runtimeRoots: { claude: 'C:/native/claude', pi: 'C:/native/pi' },
      gitAuthorRoute: 'git-work',
    },
  },
  domains: { work: ['C:/project'] },
  contentScopes: { work: { roots: ['C:/project'], skillPacks: ['core'] } },
  modes: {},
  skillPolicies: { clean: { skillExposure: { default: 'explicit-only' } } },
  presets: {},
  launchDefaults: { projects: {}, scopes: {} },
  networkPolicies: {},
  executors: { host: {} },
};

describe('launch skill resolution', () => {
  it('preserves an explicit repository binding when the discovered project id differs', async () => {
    const result = await resolveLaunchSkills(
      {
        userConfig: user,
        project: {
          root: 'C:/project',
          path: 'C:/project/mpxconfig.json',
          config: {
            schemaVersion: 1,
            project: { id: 'discovered/project' },
            repository: { provider: 'generic', remote: 'origin' },
          },
        },
        repositoryId: 'recorded/repository',
        canonicalRoot: 'C:/catalog',
        identity: 'work',
        skillPolicy: 'clean',
        contentScope: 'work',
        runtime: 'pi',
      },
      {
        inventoryCanonical: async () => [],
        inventoryProjectSkills: async () => ({ skills: [], diagnostics: [] }),
      },
    );

    expect(result.projectId).toBe('discovered/project');
    expect(result.repositoryId).toBe('recorded/repository');
    expect(result.options).toMatchObject({
      projectId: 'discovered/project',
      repositoryId: 'recorded/repository',
    });
    expect(result.manifest.binding).toEqual({
      projectId: 'discovered/project',
      repositoryId: 'recorded/repository',
      contentScope: 'work',
    });
    expect(result.artifact.manifestKey).toBe(result.manifest.manifestKey);
    expect(result.artifact.reference.manifestKey).toBe(result.manifest.manifestKey);
  });

  it('creates one immutable deterministic launch-bound resolution from canonical and project inventory', async () => {
    const canonical: CanonicalSkill[] = [
      {
        identity: 'z-skill',
        schemaVersion: 1,
        description: 'canonical',
        skillPacks: ['core'],
        defaultExposure: 'full' as const,
        contentHash: 'a'.repeat(64),
        sourcePath: 'C:/catalog/z-skill/SKILL.md',
        realPath: 'C:/catalog/z-skill/SKILL.md',
      },
    ];
    const inventoryProjectSkills = vi.fn(async () => ({ skills: [], diagnostics: [] }));
    const result = await resolveLaunchSkills(
      {
        userConfig: user,
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
        skillPolicy: 'clean',
        contentScope: 'work',
        runtime: 'pi',
      },
      {
        inventoryCanonical: async () => canonical,
        inventoryProjectSkills,
      },
    );

    expect(inventoryProjectSkills).toHaveBeenCalledWith('C:/project', canonical);
    expect(result.catalog.map((skill) => skill.identity)).toEqual(['z-skill']);
    expect(result.skillArtifact).toMatchObject({
      runtime: 'pi',
      identity: 'work',
      skillPolicy: 'clean',
      contentScope: 'work',
      projectId: 'sample/app',
      catalogHash: sha256Canonical([
        { identity: 'z-skill', contentHash: 'a'.repeat(64), origin: 'canonical' },
      ]),
    });
    expect(result.skillArtifact).toEqual(
      createSkillArtifactReference({
        runtime: 'pi',
        identity: 'work',
        skillPolicy: 'clean',
        contentScope: 'work',
        projectId: 'sample/app',
        catalogHash: sha256Canonical([
          { identity: 'z-skill', contentHash: 'a'.repeat(64), origin: 'canonical' },
        ]),
        enabledPacks: ['core'],
        skillPolicyConfig: user.skillPolicies.clean! as unknown as JsonValue,
        contentScopeExposure: {},
        projectExposure: null,
      }),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.catalog)).toBe(true);
    expect(Object.isFrozen(result.skillArtifact)).toBe(true);
  });
});
