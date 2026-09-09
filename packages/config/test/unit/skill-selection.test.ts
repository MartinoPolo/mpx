import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  classifyApplicableResource,
  parseUserConfig,
  resolveConfig,
  resolveSkillSelection,
  type ProjectConfig,
} from '../../src/index.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

function user(root: string) {
  return parseUserConfig(
    JSON.stringify({
      schemaVersion: 2,
      identities: {
        personal: {
          domain: 'personal',
          runtimeRoots: { claude: 'C:/native/claude', pi: 'C:/native/pi' },
          gitAuthorRoute: 'personal',
          allowedSkillPacks: ['development', 'personal'],
        },
      },
      domains: { personal: [root] },
      locations: {
        coding: { roots: [root], skillPacks: ['development'] },
        nested: { roots: [path.join(root, 'nested')], skillPacks: ['personal'] },
      },
      modes: {},
      presets: {},
      launchDefaults: { locations: {}, projects: {} },
      networkPolicies: {},
      executors: { host: {} },
    }),
  );
}

it.each([
  {
    name: 'committed project packs before user-project and location packs',
    skills: { packs: ['development', 'personal'] as const },
    packs: ['development', 'personal'],
    source: 'project',
  },
  {
    name: 'user-project packs before most-specific location packs when no packs are committed',
    skills: undefined,
    packs: ['development'],
    source: 'user-project',
  },
])('uses $name', async ({ skills, packs, source }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-selection-'));
  roots.push(root);
  const cwd = path.join(root, 'nested', 'repo');
  await mkdir(cwd, { recursive: true });
  const config = user(root);
  config.projects = { 'sample/app': { skillPacks: ['development'] } };
  const project: ProjectConfig = {
    schemaVersion: 1,
    project: { id: 'sample/app' },
    repository: { provider: 'github', remote: 'origin' },
    ...(skills ? { skills: { packs: [...skills.packs] } } : {}),
  };

  await expect(resolveConfig(project, config, cwd, 'personal')).resolves.toMatchObject({
    selection: {
      location: {
        name: 'nested',
        canonicalRoot: await import('node:fs/promises').then(({ realpath }) =>
          realpath(path.join(root, 'nested')),
        ),
      },
      packs,
      source,
    },
  });
});

it('rejects a selected pack outside the explicit identity allowance', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-selection-'));
  roots.push(root);
  const config = user(root);
  config.identities.personal!.allowedSkillPacks = ['development'];
  config.projects = { 'sample/app': { skillPacks: ['personal'] } };
  const project: ProjectConfig = {
    schemaVersion: 1,
    project: { id: 'sample/app' },
    repository: { provider: 'github', remote: 'origin' },
  };

  await expect(resolveConfig(project, config, root, 'personal')).rejects.toMatchObject({
    code: 'SKILL_PACK_NOT_ALLOWED',
  });
});

it('resolves a no-project launch from its most-specific configured location', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-selection-'));
  roots.push(root);
  const cwd = path.join(root, 'nested', 'shell');
  await mkdir(cwd, { recursive: true });
  const config = user(root);

  await expect(resolveSkillSelection(undefined, config, cwd, 'personal')).resolves.toMatchObject({
    location: { name: 'nested' },
    packs: ['personal'],
    source: 'user-location',
  });
});

it('classifies only explicitly configured concrete resource roots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-selection-'));
  roots.push(root);
  const clone = path.join(root, 'clones');
  await mkdir(path.join(clone, 'repo'), { recursive: true });
  const config = user(root);
  config.resourceRoots = { 'cloned-repositories': [clone] };

  await expect(classifyApplicableResource(path.join(clone, 'repo'), config)).resolves.toMatchObject(
    {
      status: 'known',
      resource: 'cloned-repositories',
    },
  );
  await expect(classifyApplicableResource(root, config)).resolves.toEqual({ status: 'unknown' });
});

it('rejects equal canonical location roots with different owners', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-selection-'));
  roots.push(root);
  const config = user(root);
  config.locations.alias = { roots: [root], skillPacks: ['personal'] };
  const project: ProjectConfig = {
    schemaVersion: 1,
    project: { id: 'sample/app' },
    repository: { provider: 'github', remote: 'origin' },
  };

  await expect(resolveConfig(project, config, root, 'personal')).rejects.toMatchObject({
    code: 'LOCATION_CLASSIFICATION_AMBIGUOUS',
  });
});
