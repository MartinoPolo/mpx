import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createRuntimeSkillArtifact,
  doctor,
  humanSearchSkills,
  humanSkillDetail,
  initialModelContext,
  inventoryCanonical,
  inventoryProjectSkills,
  loadSkillBody,
  resolveManifest,
  SkillCatalogError,
  type Exposure,
} from '../../src/index.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);
async function catalog(exposure: Exposure = 'name-only') {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-skills-'));
  roots.push(root);
  await mkdir(path.join(root, 'review'));
  await writeFile(
    path.join(root, 'review', 'SKILL.md'),
    `---\nname: review\ndescription: Review source safely\ntriggers: code inspection\nmetadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [core]\n    defaultExposure: ${exposure}\n---\nSECRET BODY\n`,
  );
  return inventoryCanonical(root);
}
const base = {
  repositoryId: 'repo',
  identity: 'work',
  skillPolicy: 'developer',
  contentScope: 'work',
  enabledPacks: ['core'] as const,
};

describe('skill catalog and v4 resolution', () => {
  it.each(['full', 'name-only', 'explicit-only', 'off'] as const)(
    'resolves %s deterministically',
    async (exposure) => {
      const skills = await catalog();
      const options = {
        ...base,
        skillPolicyConfig: { skillExposure: { default: exposure } },
        projectExposure: { skills: { review: exposure } },
      };
      const manifest = resolveManifest(skills, options);
      expect(resolveManifest(skills, options)).toEqual(manifest);
      expect(JSON.stringify(manifest)).not.toContain('SECRET BODY');
      expect(manifest.decisions[0]).toMatchObject({ exposure, included: exposure !== 'off' });
      const artifact = createRuntimeSkillArtifact(manifest, skills, { runtime: 'pi' });
      expect(initialModelContext(artifact)).toHaveLength(
        exposure === 'full' || exposure === 'name-only' ? 1 : 0,
      );
    },
  );

  it('applies precedence and records pack exclusion', async () => {
    const skills = await catalog('full');
    const narrowed = resolveManifest(skills, {
      ...base,
      skillPolicyConfig: { skillExposure: { default: 'explicit-only' } },
      projectExposure: { default: 'full' },
    });
    expect(narrowed.decisions[0]).toMatchObject({
      exposure: 'explicit-only',
      included: true,
      permissions: { humanInvocation: true, modelInvocation: false },
    });
    const excluded = resolveManifest(skills, {
      ...base,
      enabledPacks: [],
      skillPolicyConfig: { skillExposure: { default: 'full' } },
    });
    expect(excluded.decisions[0]).toMatchObject({
      included: false,
      exclusionReasons: ['pack-excluded'],
    });
  });

  it('validates project skill exposure and namespace boundaries', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-project-'));
    roots.push(root);
    const skillRoot = path.join(root, '.agents', 'skills', 'deploy');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      path.join(skillRoot, 'SKILL.md'),
      '---\nname: deploy\ndescription: Deploy safely\ndisable-model-invocation: true\nmetadata:\n  mpx:\n    projectExposure: explicit-only\n---\n',
    );
    const inventory = await inventoryProjectSkills(root);
    expect(inventory.diagnostics).toEqual([]);
    expect(doctor([], inventory)).toEqual([]);
    await writeFile(
      path.join(skillRoot, 'SKILL.md'),
      '---\nname: deploy\ndescription: Deploy safely\nmetadata:\n  mpx:\n    projectExposure: explicit-only\n---\n',
    );
    const invalid = await inventoryProjectSkills(root);
    expect(invalid.diagnostics[0]?.code).toBe('PROJECT_SKILL_INVALID');
    const error = new SkillCatalogError(invalid.diagnostics);
    expect(error.message).toContain(path.join(skillRoot, 'SKILL.md'));
    expect(error.message).toContain("'explicit-only' requires disable-model-invocation: true");
    expect(error.message).toContain('Update the frontmatter');
  });

  it('keeps same-name canonical and managed project skills distinct end to end', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-coexist-'));
    roots.push(root);
    const canonicalRoot = path.join(root, 'canonical');
    const projectRoot = path.join(root, 'project');
    await mkdir(path.join(canonicalRoot, 'commit'), { recursive: true });
    await mkdir(path.join(projectRoot, '.agents', 'skills', 'commit'), { recursive: true });
    await writeFile(
      path.join(canonicalRoot, 'commit', 'SKILL.md'),
      '---\nname: commit\ndescription: Canonical commit\nmetadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [core]\n    defaultExposure: full\n---\nCANONICAL BODY\n',
    );
    await writeFile(
      path.join(projectRoot, '.agents', 'skills', 'commit', 'SKILL.md'),
      '---\nname: commit\ndescription: Project commit\ndisable-model-invocation: true\nmetadata:\n  mpx:\n    projectExposure: explicit-only\n---\nPROJECT BODY\n',
    );
    const canonical = await inventoryCanonical(canonicalRoot);
    const project = await inventoryProjectSkills(projectRoot, canonical);
    expect(project.diagnostics).toEqual([]);
    expect(project.skills[0]?.identity).toBe('commit');
    const combined = [...canonical, ...project.skills];
    const options = {
      ...base,
      skillPolicyConfig: {
        skillExposure: {
          default: 'full' as const,
          skills: { commit: 'full' as const, 'skill:commit': 'explicit-only' as const },
        },
      },
    };
    const manifest = resolveManifest(combined, options);
    expect(manifest.decisions.map((decision) => decision.identity)).toEqual([
      'commit',
      'skill:commit',
    ]);
    const artifact = createRuntimeSkillArtifact(manifest, combined, { runtime: 'pi' });
    expect(artifact.entries.map(({ identity, publicName }) => ({ identity, publicName }))).toEqual([
      { identity: 'commit', publicName: '/mpx:commit' },
      { identity: 'skill:commit', publicName: '/skill:commit' },
    ]);
    expect(humanSkillDetail(artifact, combined, 'commit')?.description).toBe('Canonical commit');
    expect(humanSkillDetail(artifact, combined, 'skill:commit')?.description).toBe(
      'Project commit',
    );
    expect(humanSearchSkills(artifact, combined, 'commit').map((item) => item.description)).toEqual(
      ['Canonical commit', 'Project commit'],
    );
    expect(
      (
        await loadSkillBody({
          canonicalRoot,
          manifest,
          artifact,
          runtime: 'pi',
          identity: 'commit',
          invocation: 'model',
        })
      ).body,
    ).toBe('CANONICAL BODY\n');
    expect(
      (
        await loadSkillBody({
          canonicalRoot,
          manifest,
          artifact,
          runtime: 'pi',
          identity: 'skill:commit',
          invocation: 'human-explicit',
        })
      ).body,
    ).toBe('PROJECT BODY\n');
    await expect(
      loadSkillBody({
        canonicalRoot,
        manifest,
        artifact,
        runtime: 'pi',
        identity: 'skill:commit',
        invocation: 'model',
      }),
    ).rejects.toThrow(/SKILL_INVOCATION_DENIED/u);

    const independentlyNarrowed = resolveManifest(combined, {
      ...base,
      skillPolicyConfig: {
        skillExposure: {
          default: 'full',
          skills: { commit: 'off', 'skill:commit': 'explicit-only' },
        },
      },
    });
    expect(independentlyNarrowed.decisions).toMatchObject([
      { identity: 'commit', included: false },
      { identity: 'skill:commit', included: true, exposure: 'explicit-only' },
    ]);
  });

  it('rejects malicious YAML aliases and canonical runtime overrides', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-skills-'));
    roots.push(root);
    await mkdir(path.join(root, 'bad'));
    await writeFile(
      path.join(root, 'bad', 'SKILL.md'),
      '---\nname: bad\ndescription: *secret\nmetadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [core]\n    defaultExposure: full\n---\n',
    );
    await expect(inventoryCanonical(root)).rejects.toThrow(SkillCatalogError);
    await writeFile(
      path.join(root, 'bad', 'SKILL.md'),
      '---\nname: bad\ndescription: Bad\ndisable-model-invocation: true\nmetadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [core]\n    defaultExposure: full\n---\n',
    );
    await expect(inventoryCanonical(root)).rejects.toThrow(/unknown frontmatter key/u);
  });
});
