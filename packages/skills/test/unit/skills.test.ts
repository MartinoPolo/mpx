import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createRuntimeSkillArtifact,
  doctor,
  initialModelContext,
  inventoryCanonical,
  inventoryProjectSkills,
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
    `---\nname: review\ndescription: Review source safely\ntriggers: code inspection\nmetadata:\n  mpx:\n    skillPacks: [core]\n    defaultExposure: ${exposure}\n---\nSECRET BODY\n`,
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
    expect((await inventoryProjectSkills(root)).diagnostics[0]?.code).toBe('PROJECT_SKILL_INVALID');
  });

  it('rejects malicious YAML aliases and canonical runtime overrides', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-skills-'));
    roots.push(root);
    await mkdir(path.join(root, 'bad'));
    await writeFile(
      path.join(root, 'bad', 'SKILL.md'),
      '---\nname: bad\ndescription: *secret\nmetadata:\n  mpx:\n    skillPacks: [core]\n    defaultExposure: full\n---\n',
    );
    await expect(inventoryCanonical(root)).rejects.toThrow(SkillCatalogError);
    await writeFile(
      path.join(root, 'bad', 'SKILL.md'),
      '---\nname: bad\ndescription: Bad\ndisable-model-invocation: true\nmetadata:\n  mpx:\n    skillPacks: [core]\n    defaultExposure: full\n---\n',
    );
    await expect(inventoryCanonical(root)).rejects.toThrow(/unknown frontmatter key/u);
  });
});
