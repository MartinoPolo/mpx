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

async function projectFixture(
  options: { name?: string; sharedFile?: string; sharedSkill?: boolean } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-project-plan-'));
  roots.push(root);
  const skillsRoot = path.join(root, '.agents', 'skills');
  const name = options.name ?? 'commit';
  await mkdir(path.join(skillsRoot, name), { recursive: true });
  await writeFile(
    path.join(skillsRoot, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Project ${name}\nmetadata:\n  mpx:\n    projectExposure: full\n---\nProject body.\n`,
  );
  if (options.sharedFile || options.sharedSkill) {
    await mkdir(path.join(skillsRoot, 'shared'), { recursive: true });
  }
  if (options.sharedFile) {
    await writeFile(path.join(skillsRoot, 'shared', options.sharedFile), 'shared support');
  }
  if (options.sharedSkill) {
    await writeFile(
      path.join(skillsRoot, 'shared', 'SKILL.md'),
      '---\nname: shared\ndescription: Native shared\n---\nNative body.\n',
    );
  }
  const inventory = await inventoryProjectSkills(root);
  const catalog = inventory.skills;
  const manifest = resolveManifest(catalog, {
    repositoryId: 'repo',
    contentScope: 'work',
    identity: 'work',
    skillPolicy: 'developer',
    skillPolicyConfig: { skillExposure: { default: 'full' } },
    enabledPacks: [],
  });
  const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: 'pi' });
  return { root, skillsRoot, catalog, manifest, artifact };
}

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

  it('snapshots project shared support and covers it with plan tamper verification', async () => {
    const value = await projectFixture({ sharedFile: 'WRITING.md' });
    const plan = await createSkillProjectionPlan({
      canonicalRoot: path.join(value.root, 'unused'),
      manifest: value.manifest,
      artifact: value.artifact,
      catalog: value.catalog,
    });
    expect(plan.projectSharedFiles?.map((file) => file.relativePath)).toEqual(['WRITING.md']);
    plan.projectSharedFiles![0]!.bytes[0] = 0;
    expect(() => verifySkillProjectionPlan(plan)).toThrowError(/SKILL_PROJECTION_PLAN_CHANGED/u);
  });

  it('does not collect project support without an included project entry or a shared folder', async () => {
    const canonical = await fixture();
    const canonicalPlan = await createSkillProjectionPlan({
      canonicalRoot: canonical.root,
      manifest: canonical.manifest,
      artifact: canonical.artifact,
      catalog: canonical.catalog,
    });
    const project = await projectFixture();
    const projectPlan = await createSkillProjectionPlan({
      canonicalRoot: path.join(project.root, 'unused'),
      manifest: project.manifest,
      artifact: project.artifact,
      catalog: project.catalog,
    });
    expect(canonicalPlan.projectSharedFiles).toBeUndefined();
    expect(projectPlan.projectSharedFiles).toBeUndefined();
  });

  it('fails closed when included project skills claim different verified roots', async () => {
    const first = await projectFixture({ name: 'commit' });
    const second = await projectFixture({ name: 'review' });
    const catalog = [...first.catalog, ...second.catalog];
    const manifest = resolveManifest(catalog, {
      repositoryId: 'repo',
      contentScope: 'work',
      identity: 'work',
      skillPolicy: 'test',
      skillPolicyConfig: { skillExposure: { default: 'full' } },
      enabledPacks: [],
    });
    const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: 'pi' });
    await expect(
      createSkillProjectionPlan({
        canonicalRoot: path.join(first.root, 'unused'),
        manifest,
        artifact,
        catalog,
      }),
    ).rejects.toMatchObject({
      diagnostics: [
        {
          code: 'SKILL_PATH_INVALID',
          message: 'included project skills must share one verified project root',
        },
      ],
    });
  });

  it.each([
    ['exact', { sharedSkill: true }],
    ['case variant', { sharedFile: 'skill.MD' }],
  ])(
    'rejects a %s SKILL.md basename inside project shared support with a stable public diagnostic',
    async (_label, options) => {
      const value = await projectFixture(options);
      await expect(
        createSkillProjectionPlan({
          canonicalRoot: path.join(value.root, 'unused'),
          manifest: value.manifest,
          artifact: value.artifact,
          catalog: value.catalog,
        }),
      ).rejects.toMatchObject({
        diagnostics: [
          {
            code: 'SKILL_PATH_INVALID',
            message: 'project shared support cannot contain a SKILL.md entry',
          },
        ],
      });
    },
  );

  const supportsDirectoryLinks = process.platform === 'win32' || path.sep === '/';
  it.runIf(supportsDirectoryLinks)(
    'rejects a linked project shared root without exposing native paths',
    async () => {
      const value = await projectFixture({ sharedFile: 'WRITING.md' });
      const outside = await mkdtemp(path.join(tmpdir(), 'mpx-project-shared-outside-'));
      roots.push(outside);
      await rm(path.join(value.skillsRoot, 'shared'), { recursive: true });
      await symlink(
        outside,
        path.join(value.skillsRoot, 'shared'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await expect(
        createSkillProjectionPlan({
          canonicalRoot: path.join(value.root, 'unused'),
          manifest: value.manifest,
          artifact: value.artifact,
          catalog: value.catalog,
        }),
      ).rejects.toMatchObject({
        diagnostics: [
          { code: 'SKILL_PATH_INVALID', message: 'project shared support is not inventory-safe' },
        ],
      });
    },
  );

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
