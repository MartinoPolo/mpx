import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createRuntimeSkillArtifact,
  humanListSkills,
  initialModelContext,
  inventoryProjectSkills,
  loadSkillBody,
  resolveManifest,
  type Exposure,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function fixture() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'mpx-project-policy-'));
  roots.push(projectRoot);
  const directory = path.join(projectRoot, '.agents', 'skills', 'local-review');
  await mkdir(path.join(directory, 'reference'), { recursive: true });
  await writeFile(
    path.join(directory, 'SKILL.md'),
    '---\nname: local-review\ndescription: Local review guidance\nmetadata:\n  mpx:\n    projectExposure: full\n---\nPROJECT BODY\n',
  );
  await writeFile(path.join(directory, 'reference', 'guide.md'), 'SUPPORT A\n');
  const inventory = await inventoryProjectSkills(projectRoot);
  expect(inventory.diagnostics).toEqual([]);
  return { projectRoot, directory, catalog: inventory.skills };
}

function resolved(catalog: Awaited<ReturnType<typeof fixture>>['catalog'], exposure: Exposure) {
  const manifest = resolveManifest(catalog, {
    repositoryId: 'sample/app',
    projectId: 'sample/app',
    contentScope: 'work',
    identity: 'work',
    skillPolicy: 'policy',
    skillPolicyConfig: { skillExposure: { default: exposure } },
    enabledPacks: [],
  });
  return { manifest, artifact: createRuntimeSkillArtifact(manifest, catalog, { runtime: 'pi' }) };
}

describe('project skills in the combined policy artifact', () => {
  it.each([
    ['full', true, true, true],
    ['name-only', true, true, false],
    ['explicit-only', true, false, false],
    ['off', false, false, false],
  ] as const)(
    'narrows a self-declared full project skill to %s',
    async (exposure, human, model, description) => {
      const { catalog } = await fixture();
      const { manifest, artifact } = resolved(catalog, exposure);
      expect(manifest.decisions).toHaveLength(1);
      expect(artifact.entries).toHaveLength(exposure === 'off' ? 0 : 1);
      expect(humanListSkills(artifact).some((skill) => skill.identity === 'local-review')).toBe(
        human,
      );
      expect(initialModelContext(artifact).some((skill) => skill.identity === 'local-review')).toBe(
        model,
      );
      expect(initialModelContext(artifact)[0]?.description !== undefined).toBe(description);
    },
  );

  it('binds exact body and support-file changes into the manifest and artifact', async () => {
    const first = await fixture();
    const firstResolved = resolved(first.catalog, 'full');
    await writeFile(path.join(first.directory, 'reference', 'guide.md'), 'SUPPORT B\n');
    const supportCatalog = (await inventoryProjectSkills(first.projectRoot)).skills;
    const supportResolved = resolved(supportCatalog, 'full');
    expect(supportResolved.manifest.manifestKey).not.toBe(firstResolved.manifest.manifestKey);
    expect(supportResolved.artifact.reference.artifactKey).not.toBe(
      firstResolved.artifact.reference.artifactKey,
    );
    await writeFile(
      path.join(first.directory, 'SKILL.md'),
      '---\nname: local-review\ndescription: Local review guidance\nmetadata:\n  mpx:\n    projectExposure: full\n---\nCHANGED BODY\n',
    );
    const bodyCatalog = (await inventoryProjectSkills(first.projectRoot)).skills;
    expect(resolved(bodyCatalog, 'full').manifest.manifestKey).not.toBe(
      supportResolved.manifest.manifestKey,
    );
  });

  it('loads the exact inventory-bound project body and rejects directory drift', async () => {
    const value = await fixture();
    const { manifest, artifact } = resolved(value.catalog, 'full');
    expect(
      (
        await loadSkillBody({
          canonicalRoot: path.join(value.projectRoot, 'not-canonical'),
          manifest,
          artifact,
          runtime: 'pi',
          identity: 'local-review',
          invocation: 'model',
        })
      ).body,
    ).toBe('PROJECT BODY\n');
    await writeFile(path.join(value.directory, 'reference', 'guide.md'), 'DRIFT\n');
    await expect(
      loadSkillBody({
        canonicalRoot: path.join(value.projectRoot, 'not-canonical'),
        manifest,
        artifact,
        runtime: 'pi',
        identity: 'local-review',
        invocation: 'model',
      }),
    ).rejects.toThrow(/SKILL_DIRECTORY_STALE/u);
  });
});
