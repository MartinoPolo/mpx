import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createRuntimeSkillArtifact,
  createSkillProjectionPlan,
  initialModelContext,
  inventoryProjectSkills,
  loadSkillBody,
  modelSearchSkillProjection,
  modelSearchSkills,
  resolveManifest,
} from '../../src/index.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

it('preserves managed project name-only disclosure and lazy model loading', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'mpx-project-name-only-'));
  roots.push(projectRoot);
  const directory = path.join(projectRoot, '.agents', 'skills', 'local-review');
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'SKILL.md'),
    '---\nname: local-review\ndescription: PRIVATE PROJECT DESCRIPTION\nmetadata:\n  mpx:\n    projectExposure: name-only\n---\nPROJECT BODY\n',
  );
  const inventory = await inventoryProjectSkills(projectRoot);
  expect(inventory.diagnostics).toEqual([]);
  const catalog = inventory.skills;
  const manifest = resolveManifest(catalog, {
    repositoryId: 'sample/app',
    projectId: 'sample/app',
    identity: 'personal',
    selection: {
      location: { name: 'coding', canonicalRoot: projectRoot },
      packs: ['development'],
      source: 'project',
    },
  });
  const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: 'pi' });
  const plan = await createSkillProjectionPlan({
    canonicalRoot: path.join(projectRoot, 'canonical-unused'),
    manifest,
    artifact,
    catalog,
  });

  expect(initialModelContext(artifact)).toEqual([
    { identity: 'skill:local-review', publicName: '/skill:local-review' },
  ]);
  expect(
    modelSearchSkills(artifact, catalog, 'local', {
      artifactKey: artifact.reference.artifactKey,
    })[0]?.description,
  ).toBe('');
  expect(
    modelSearchSkillProjection(plan, 'local', { artifactKey: artifact.reference.artifactKey })[0]
      ?.description,
  ).toBe('');
  expect(
    (
      await loadSkillBody({
        canonicalRoot: path.join(projectRoot, 'canonical-unused'),
        manifest,
        artifact,
        runtime: 'pi',
        identity: 'skill:local-review',
        invocation: 'model',
      })
    ).body,
  ).toBe('PROJECT BODY\n');
});
