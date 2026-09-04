import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SkillCatalogError,
  createRuntimeSkillArtifact,
  createSkillProjectionPlan,
  inventoryCanonical,
  inventoryProjectSkills,
  humanSearchSkills,
  loadSkillProjectionBody,
  modelSearchSkillProjection,
  modelSearchSkills,
  resolveManifest,
  verifySkillProjectionPlan,
} from '../../src/index.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((x) => rm(x, { recursive: true, force: true }))),
);
const code = (error: unknown) =>
  error instanceof SkillCatalogError ? error.diagnostics[0]?.code : undefined;
const thrownCode = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    return code(error);
  }
  return undefined;
};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-plan-'));
  roots.push(root);
  for (const [name, exposure] of [
    ['full', 'full'],
    ['named', 'name-only'],
    ['explicit', 'explicit-only'],
    ['off', 'off'],
  ] as const) {
    const directory = path.join(root, name);
    await mkdir(path.join(directory, 'nested'), { recursive: true });
    await writeFile(
      path.join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} café description\ntriggers: ${name} trigger\nmetadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [core]\n    defaultExposure: ${exposure}\n---\n${name} BODY\n`,
    );
    if (name === 'full') {
      await writeFile(path.join(directory, 'nested', 'binary.dat'), Buffer.from([0, 255, 1]));
      await writeFile(path.join(directory, 'z.txt'), 'support');
    }
  }
  const catalog = await inventoryCanonical(root);
  const manifest = resolveManifest(catalog, {
    repositoryId: 'repo',
    contentScope: 'work',
    identity: 'work',
    skillPolicy: 'developer',
    skillPolicyConfig: {
      skillExposure: {
        default: 'name-only',
        skills: { full: 'full', named: 'name-only', explicit: 'explicit-only', off: 'off' },
      },
    },
    enabledPacks: ['core'],
  });
  const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: 'pi' });
  return { root, catalog, manifest, artifact };
}

describe('process-local skill projection plans', () => {
  it('snapshots neutral sorted projection material and preserves current disclosure and loading semantics', async () => {
    const value = await fixture();
    const plan = await createSkillProjectionPlan({
      canonicalRoot: value.root,
      manifest: value.manifest,
      artifact: value.artifact,
      catalog: value.catalog,
    });
    expect(plan.entries.map((x) => x.identity)).toEqual(['explicit', 'full', 'named']);
    expect(
      plan.entries.find((x) => x.identity === 'full')?.files.map((x) => x.relativePath),
    ).toEqual(['nested/binary.dat', 'z.txt']);
    const binary = plan.entries.find((x) => x.identity === 'full')!.files[0]!;
    expect([...binary.bytes]).toEqual([0, 255, 1]);
    expect(binary.sha256).toBe(createHash('sha256').update(binary.bytes).digest('hex'));
    expect(plan.initialModelContext).toEqual([
      {
        identity: 'full',
        publicName: '/mpx:full',
        description: 'full café description',
        triggers: 'full trigger',
      },
      { identity: 'named', publicName: '/mpx:named' },
    ]);
    expect(
      (await loadSkillProjectionBody(plan, { identity: 'explicit', invocation: 'human-explicit' }))
        .body,
    ).toBe('explicit BODY\n');
    await expect(
      loadSkillProjectionBody(plan, { identity: 'explicit', invocation: 'model' }),
    ).rejects.toSatisfy((e) => code(e) === 'SKILL_INVOCATION_DENIED');
    expect(
      modelSearchSkillProjection(plan, 'café', {
        artifactKey: value.artifact.reference.artifactKey,
      }).map((x) => x.identity),
    ).toEqual(['full', 'named']);
    const enumerable = JSON.stringify({ ...plan });
    expect(enumerable).not.toContain(value.root);
    expect(enumerable).not.toMatch(/canonicalRoot|projectRoot|realPath|credential|route/iu);
    expect(() => JSON.stringify(plan)).toThrow();
    (value.artifact.reference as { artifactKey: string }).artifactKey = 'caller mutation';
    value.catalog[0]!.description = 'caller mutation';
    expect(() => verifySkillProjectionPlan(plan)).not.toThrow();
  });

  it('rejects unregistered copies and changed registered plans with stable diagnostics', async () => {
    const value = await fixture();
    const plan = await createSkillProjectionPlan({
      canonicalRoot: value.root,
      manifest: value.manifest,
      artifact: value.artifact,
      catalog: value.catalog,
    });
    expect(() => verifySkillProjectionPlan({ ...plan })).toThrowError(
      /SKILL_PROJECTION_PLAN_UNVERIFIED/u,
    );
    expect(() => verifySkillProjectionPlan(structuredClone(plan))).toThrowError(
      /SKILL_PROJECTION_PLAN_UNVERIFIED/u,
    );
    (plan.entries[0] as { publicName: string }).publicName = '/changed';
    expect(() => verifySkillProjectionPlan(plan)).toThrowError(/SKILL_PROJECTION_PLAN_CHANGED/u);
  });

  it('load rejects changed registered plans and all unregistered copies by exact diagnostic code', async () => {
    const value = await fixture();
    const plan = await createSkillProjectionPlan({
      canonicalRoot: value.root,
      manifest: value.manifest,
      artifact: value.artifact,
      catalog: value.catalog,
    });
    const request = { identity: 'full', invocation: 'model' } as const;
    await expect(loadSkillProjectionBody({ ...plan }, request)).rejects.toSatisfy(
      (error) => code(error) === 'SKILL_PROJECTION_PLAN_UNVERIFIED',
    );
    await expect(loadSkillProjectionBody(structuredClone(plan), request)).rejects.toSatisfy(
      (error) => code(error) === 'SKILL_PROJECTION_PLAN_UNVERIFIED',
    );
    (plan.entries[0] as { publicName: string }).publicName = '/changed';
    await expect(loadSkillProjectionBody(plan, request)).rejects.toSatisfy(
      (error) => code(error) === 'SKILL_PROJECTION_PLAN_CHANGED',
    );
  });

  it('model search rejects changed registered plans and all unregistered copies by exact diagnostic code', async () => {
    const value = await fixture();
    const plan = await createSkillProjectionPlan({
      canonicalRoot: value.root,
      manifest: value.manifest,
      artifact: value.artifact,
      catalog: value.catalog,
    });
    const options = { artifactKey: value.artifact.reference.artifactKey };
    expect(thrownCode(() => modelSearchSkillProjection({ ...plan }, 'full', options))).toBe(
      'SKILL_PROJECTION_PLAN_UNVERIFIED',
    );
    expect(
      thrownCode(() => modelSearchSkillProjection(structuredClone(plan), 'full', options)),
    ).toBe('SKILL_PROJECTION_PLAN_UNVERIFIED');
    (plan.entries[0] as { publicName: string }).publicName = '/changed';
    expect(thrownCode(() => modelSearchSkillProjection(plan, 'full', options))).toBe(
      'SKILL_PROJECTION_PLAN_CHANGED',
    );
  });

  it('model search rejects the wrong artifact key by exact diagnostic code', async () => {
    const value = await fixture();
    const plan = await createSkillProjectionPlan({
      canonicalRoot: value.root,
      manifest: value.manifest,
      artifact: value.artifact,
      catalog: value.catalog,
    });
    expect(
      thrownCode(() =>
        modelSearchSkillProjection(plan, 'full', { artifactKey: 'wrong-artifact-key' }),
      ),
    ).toBe('STALE_ARTIFACT');
  });

  it('keeps artifact and projection model search ranking identical', async () => {
    const value = await fixture();
    const plan = await createSkillProjectionPlan({
      canonicalRoot: value.root,
      manifest: value.manifest,
      artifact: value.artifact,
      catalog: value.catalog,
    });
    const artifactKey = value.artifact.reference.artifactKey;
    for (const [query, limit] of [
      ['', undefined],
      ['named full', undefined],
      ['description trigger', 1],
      ['missing', 20],
      ['full', 0],
    ] as const) {
      const options = limit === undefined ? { artifactKey } : { artifactKey, limit };
      expect(modelSearchSkillProjection(plan, query, options)).toEqual(
        modelSearchSkills(value.artifact, value.catalog, query, options),
      );
    }
  });

  it('keeps human-only entries out of model ranking without hiding them from human search', async () => {
    const value = await fixture();
    const artifactKey = value.artifact.reference.artifactKey;
    expect(modelSearchSkills(value.artifact, value.catalog, 'explicit', { artifactKey })).toEqual(
      [],
    );
    expect(humanSearchSkills(value.artifact, value.catalog, 'explicit')).toEqual([
      {
        identity: 'explicit',
        publicName: '/mpx:explicit',
        description: 'explicit café description',
        score: 3,
      },
    ]);
  });

  it('preserves model search validation order for a wrong key and oversized query', async () => {
    const value = await fixture();
    const plan = await createSkillProjectionPlan({
      canonicalRoot: value.root,
      manifest: value.manifest,
      artifact: value.artifact,
      catalog: value.catalog,
    });
    const oversized = 'x'.repeat(201);
    expect(
      thrownCode(() =>
        modelSearchSkillProjection(plan, oversized, { artifactKey: 'wrong-artifact-key' }),
      ),
    ).toBe('STALE_ARTIFACT');
    expect(
      thrownCode(() =>
        modelSearchSkills(value.artifact, value.catalog, oversized, {
          artifactKey: 'wrong-artifact-key',
        }),
      ),
    ).toBe('QUERY_TOO_LONG');
  });

  it('snapshots project-relative provenance and rejects stale project support digests', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'mpx-plan-project-'));
    roots.push(projectRoot);
    const directory = path.join(projectRoot, '.agents', 'skills', 'local');
    await mkdir(path.join(directory, 'docs'), { recursive: true });
    await writeFile(
      path.join(directory, 'SKILL.md'),
      '---\nname: local\ndescription: Local project skill\nmetadata:\n  mpx:\n    projectExposure: full\n---\nLOCAL BODY\n',
    );
    await writeFile(path.join(directory, 'docs', 'guide.md'), 'GUIDE\n');
    const catalog = (await inventoryProjectSkills(projectRoot)).skills;
    const manifest = resolveManifest(catalog, {
      repositoryId: 'repo',
      projectId: 'project',
      contentScope: 'work',
      identity: 'work',
      skillPolicy: 'developer',
      skillPolicyConfig: { skillExposure: { default: 'full' } },
      enabledPacks: [],
    });
    const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: 'claude' });
    const plan = await createSkillProjectionPlan({
      canonicalRoot: path.join(projectRoot, 'unused'),
      manifest,
      artifact,
      catalog,
    });
    expect(plan.entries[0]?.source).toMatchObject({
      kind: 'project',
      provenancePath: '.agents/skills/local/SKILL.md',
    });
    expect(plan.entries[0]?.files.map((x) => x.relativePath)).toEqual(['docs/guide.md']);
    await writeFile(path.join(directory, 'docs', 'guide.md'), 'DRIFT\n');
    await expect(
      createSkillProjectionPlan({
        canonicalRoot: path.join(projectRoot, 'unused'),
        manifest,
        artifact,
        catalog,
      }),
    ).rejects.toSatisfy((e) => code(e) === 'SKILL_DIRECTORY_STALE');
  });

  it('rejects stale source bytes during creation', async () => {
    const stale = await fixture();
    await writeFile(path.join(stale.root, 'full', 'SKILL.md'), 'changed');
    await expect(
      createSkillProjectionPlan({
        canonicalRoot: stale.root,
        manifest: stale.manifest,
        artifact: stale.artifact,
        catalog: stale.catalog,
      }),
    ).rejects.toSatisfy((e) => code(e) === 'SKILL_CONTENT_STALE');
  });

  const supportsDirectoryLinks = process.platform === 'win32' || path.sep === '/';
  it.runIf(supportsDirectoryLinks)(
    'rejects unsafe linked support directories by exact diagnostic code',
    async () => {
      const unsafe = await fixture();
      const outside = path.join(unsafe.root, 'outside');
      await mkdir(outside);
      await writeFile(path.join(outside, 'secret'), 'outside');
      await symlink(
        outside,
        path.join(unsafe.root, 'full', 'link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await expect(
        createSkillProjectionPlan({
          canonicalRoot: unsafe.root,
          manifest: unsafe.manifest,
          artifact: unsafe.artifact,
          catalog: unsafe.catalog,
        }),
      ).rejects.toSatisfy((error) => code(error) === 'SKILL_PATH_INVALID');
    },
  );
});
