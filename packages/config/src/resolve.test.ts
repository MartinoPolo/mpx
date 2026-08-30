import { expect, it, vi } from 'vitest';
import { resolveEffectiveSkillPacks } from './skill-packs.js';
import { classifyContentScope, resolveConfig } from './resolve.js';
import type { ProjectConfig, UserConfig } from './types.js';

vi.mock('node:fs/promises', () => ({
  realpath: async (value: string) => {
    if (value === 'C:/stale') {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
    if (value === 'C:/locked') {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }
    return value;
  },
}));

const project: ProjectConfig = {
  schemaVersion: 1,
  project: { id: 'acme/app' },
  repository: { provider: 'github', remote: 'origin' },
};
const launchContracts = (contentScopes: UserConfig['contentScopes']): UserConfig => ({
  identities: {},
  domains: { work: ['C:/_MP_work'] },
  contentScopes,
  modes: {},
  skillPolicies: {},
  presets: {},
  launchDefaults: { scopes: {}, projects: {} },
  networkPolicies: {},
  executors: { host: {} },
});

it('uses the longest canonical content root and deterministic catalog overrides', async () => {
  const user = launchContracts({
    work: { roots: ['C:/_MP_work'], skillPacks: ['core'] },
    nested: {
      roots: ['C:/_MP_work/team'],
      skillPacks: ['work'],
      skillExposure: { skills: { review: 'full' } },
    },
  });
  user.projects = {
    'acme/app': { skillPacks: ['personal'], skillExposure: { default: 'name-only' } },
  };
  const first = await resolveConfig(project, user, 'C:/_MP_work/team/repo');
  const second = await resolveConfig(project, user, 'C:/_MP_work/team/repo');
  expect(first.contentScope.name).toBe('nested');
  expect(first.contentScope.skillPacks).toEqual(['personal']);
  expect(first.contentScope.skillExposure).toEqual({ skills: { review: 'full' } });
  expect(first.contentScope.projectSkillExposure).toEqual({ default: 'name-only' });
  expect(first).toEqual(second);
  expect(first.project.issues).toEqual({ provider: 'none' });
  expect(first.provenance.map(({ pointer }) => pointer)).toEqual(
    first.provenance.map(({ pointer }) => pointer).sort(),
  );
});

it('does not classify against unresolvable lexical content roots', async () => {
  const user = launchContracts({ stale: { roots: ['C:/stale'] } });
  await expect(classifyContentScope('C:/stale/repo', user)).resolves.toEqual({ status: 'unknown' });
});

it('rethrows inaccessible configured roots instead of misclassifying them as unknown', async () => {
  const user = launchContracts({ locked: { roots: ['C:/locked'] } });
  await expect(classifyContentScope('C:/locked/repo', user)).rejects.toMatchObject({
    code: 'EACCES',
  });
});

it('derives deterministic effective skill packs from content, project, and skill-policy inputs', () => {
  expect(resolveEffectiveSkillPacks({})).toEqual(['core']);
  expect(resolveEffectiveSkillPacks({ contentScopeSkillPacks: ['work', 'core', 'work'] })).toEqual([
    'core',
    'work',
  ]);
  expect(
    resolveEffectiveSkillPacks({
      contentScopeSkillPacks: ['core', 'personal'],
      projectSkillPacks: ['work', 'core'],
      skillPolicySkillPacks: ['core', 'personal'],
    }),
  ).toEqual(['core']);
});
