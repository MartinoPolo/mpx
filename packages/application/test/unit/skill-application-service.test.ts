import { describe, expect, it } from 'vitest';
import type { UserConfig } from '@mpx/config';
import type { CanonicalSkill } from '@mpx/skills';
import { createSkillApplicationService, type ProjectSkillInventory } from '../../src/index.js';

const skill: CanonicalSkill = {
  identity: 'mp-test',
  schemaVersion: 1,
  description: 'Synthetic skill',
  triggers: 'test',
  skillPacks: ['core'],
  defaultExposure: 'full',
  sourcePath: 'C:/catalog/mp-test/SKILL.md',
  realPath: 'C:/catalog/mp-test/SKILL.md',
  contentHash: 'a'.repeat(64),
};
const user: UserConfig = {
  identities: {
    work: { domain: 'work', runtimeRoots: { claude: 'C:/c', pi: 'C:/p' }, gitAuthorRoute: 'git' },
  },
  domains: { work: ['C:/work'] },
  contentScopes: { work: { roots: ['C:/work'], skillPacks: ['core'] } },
  modes: {},
  skillPolicies: { normal: { skillExposure: { default: 'full' } } },
  presets: {},
  launchDefaults: { projects: {}, scopes: {} },
  networkPolicies: {},
  executors: { host: {} },
};
const project = {
  path: 'C:/work/repo/mpxconfig.json',
  root: 'C:/work/repo',
  config: {
    schemaVersion: 1 as const,
    project: { id: 'repo' },
    repository: { provider: 'generic', remote: 'origin' },
  },
};

function service(projectInventory: ProjectSkillInventory = { skills: [], diagnostics: [] }) {
  return createSkillApplicationService({
    inventoryCanonical: async () => [skill],
    inventoryProjectSkills: async () => projectInventory,
    discoverProjectConfig: async () => project,
    classifyCwd: async () => ({ domain: 'work', contentScope: 'work' }),
  });
}
const binding = {
  cwd: 'C:/work/repo',
  catalogRoot: 'C:/catalog',
  user,
  identity: 'work',
  runtime: 'claude' as const,
  skillPolicy: 'normal',
};

describe('SkillApplicationService', () => {
  it('preserves canonical inventory, project discovery, project inventory, and classification order', async () => {
    const events: string[] = [];
    const app = createSkillApplicationService({
      inventoryCanonical: async () => {
        events.push('canonical');
        return [skill];
      },
      discoverProjectConfig: async () => {
        events.push('discovery');
        return project;
      },
      inventoryProjectSkills: async () => {
        events.push('project');
        return { skills: [], diagnostics: [] };
      },
      classifyCwd: async () => {
        events.push('classification');
        return { domain: 'work', contentScope: 'work' };
      },
    });

    await app.execute({ ...binding, action: 'explain', value: 'mp-test' });

    expect(events).toEqual(['canonical', 'discovery', 'project', 'classification']);
  });

  it('composes canonical and project inventory into a launch-bound list result', async () => {
    const result = await service().execute({ ...binding, action: 'list' });
    expect(result.data).toMatchObject({
      artifact: {
        identity: 'work',
        skillPolicy: 'normal',
        contentScope: 'work',
        projectId: 'repo',
      },
      manifest: {
        schemaVersion: 4,
        binding: { contentScope: 'work', projectId: 'repo', repositoryId: 'repo' },
      },
      skills: [{ identity: 'mp-test', exposure: 'full' }],
    });
  });

  it('rejects project inventory diagnostics before manifest construction', async () => {
    await expect(
      service({ skills: [], diagnostics: [{ code: 'BAD_SKILL', message: 'bad' }] }).execute({
        ...binding,
        action: 'list',
      }),
    ).rejects.toMatchObject({ diagnostics: [{ code: 'BAD_SKILL' }] });
  });

  it('constructs complete, show, explain, and search results against one resolved artifact', async () => {
    const app = service();
    await expect(app.execute({ ...binding, action: 'complete', value: '' })).resolves.toMatchObject(
      { data: { completions: ['/mpx:mp-test'] } },
    );
    await expect(
      app.execute({ ...binding, action: 'show', value: 'mp-test' }),
    ).resolves.toMatchObject({ data: { skill: { identity: 'mp-test', exposure: 'full' } } });
    await expect(
      app.execute({ ...binding, action: 'explain', value: 'mp-test' }),
    ).resolves.toMatchObject({ data: { skill: { identity: 'mp-test' } } });
    await expect(
      app.execute({ ...binding, action: 'search', value: 'Synthetic', limit: 5 }),
    ).resolves.toMatchObject({ data: { results: [{ identity: 'mp-test' }] } });
  });
});
