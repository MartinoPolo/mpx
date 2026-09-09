import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkActiveContentProjection,
  classifyCompiledSkillSource,
  loadActiveContentProjection,
  readActiveContentEntry,
  readActiveSkill,
} from '../../src/index.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-active-content-'));
  const skill = Buffer.from('skill bytes\r\n', 'utf8');
  const agent = Buffer.from('agent bytes\n', 'utf8');
  await mkdir(path.join(root, 'skills', 'alpha'), { recursive: true });
  await mkdir(path.join(root, 'agents'), { recursive: true });
  await writeFile(path.join(root, 'skills', 'alpha', 'SKILL.md'), skill);
  await writeFile(path.join(root, 'agents', 'Explore.md'), agent);
  const manifest = {
    schemaVersion: 2,
    compilerVersion: '2.0.0',
    runtime: 'claude',
    profileSchemaVersion: 1,
    binding: {
      projectId: null,
      repositoryId: 'repo',
      identity: 'test',
      selection: {
        location: { name: 'test', canonicalRoot: root },
        packs: ['development'] as const,
        source: 'user-location' as const,
      },
    },
    manifestKey: 'manifest-key',
    manifestEnvelope: { path: 'active-content.json', includedInFileMap: false },
    skills: [
      {
        identity: 'alpha',
        exposure: 'full',
        canonicalDescription: 'Alpha.',
        effectiveDescription: 'Alpha.',
        sourcePath: 'content/skills/alpha/SKILL.md',
        generatedPath: 'skills/alpha/SKILL.md',
        generatedSha256: sha256(skill),
        bodyByteOffset: 0,
        omittedOptionalFeatures: [],
      },
    ],
    agents: [
      {
        canonicalIdentity: 'mpx-explorer',
        projectedIdentity: 'Explore',
        semanticModel: 'standard',
        concreteModel: 'sonnet',
        thinking: 'medium',
        capabilities: ['read'],
        tools: ['Read'],
        nesting: { canonical: [], projected: [], requiredTools: [] },
        outputSchema: 'text',
        sourcePath: 'mpx-explorer.md',
        sourceSha256: 'a'.repeat(64),
        sourceByteCount: 10,
        generatedPath: 'agents/Explore.md',
        generatedSha256: sha256(agent),
        generatedByteCount: agent.byteLength,
      },
    ],
    files: [
      { relativePath: 'agents/Explore.md', sha256: sha256(agent), byteCount: agent.byteLength },
      {
        relativePath: 'skills/alpha/SKILL.md',
        sha256: sha256(skill),
        byteCount: skill.byteLength,
      },
    ],
  };
  const manifestPath = path.join(root, 'active-content.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifestPath, skill, agent, manifest };
}

describe('persisted active content', () => {
  it('rejects a structurally valid stale schema 1/compiler 1.1.0 projection', async () => {
    const value = await fixture();
    Object.assign(value.manifest, { schemaVersion: 1, compilerVersion: '1.1.0' });
    const staleBytes = Buffer.from(JSON.stringify(value.manifest));
    await writeFile(value.manifestPath, staleBytes);

    await expect(
      loadActiveContentProjection({
        root: value.root,
        manifestPath: value.manifestPath,
        expected: {
          runtime: 'claude',
          manifestKey: value.manifest.manifestKey,
          binding: value.manifest.binding,
          manifestFile: { sha256: sha256(staleBytes), byteCount: staleBytes.byteLength },
        },
      }),
    ).rejects.toMatchObject({ code: 'ACTIVE_CONTENT_MANIFEST_INVALID' });
  });

  it('loads only an exact root-to-manifest binding and rejects unknown manifest fields', async () => {
    const value = await fixture();
    await expect(
      loadActiveContentProjection({ root: value.root, manifestPath: value.manifestPath }),
    ).resolves.toMatchObject({ root: value.root, manifestPath: value.manifestPath });

    await writeFile(value.manifestPath, JSON.stringify({ ...value.manifest, unexpected: true }));
    await expect(
      loadActiveContentProjection({ root: value.root, manifestPath: value.manifestPath }),
    ).rejects.toMatchObject({ code: 'ACTIVE_CONTENT_MANIFEST_INVALID' });
  });

  it('normalizes equivalent pack ordering in persisted projection bindings', async () => {
    const value = await fixture();
    (
      value.manifest.binding.selection as {
        packs: readonly ('development' | 'personal')[];
      }
    ).packs = ['personal', 'development'];
    await writeFile(value.manifestPath, JSON.stringify(value.manifest));

    await expect(
      loadActiveContentProjection({ root: value.root, manifestPath: value.manifestPath }),
    ).resolves.toMatchObject({
      manifest: { binding: { selection: { packs: ['development', 'personal'] } } },
    });
  });

  it('rejects unknown fields in persisted projection selections', async () => {
    const value = await fixture();
    Object.assign(value.manifest.binding.selection.location, { unexpected: true });
    await writeFile(value.manifestPath, JSON.stringify(value.manifest));

    await expect(
      loadActiveContentProjection({ root: value.root, manifestPath: value.manifestPath }),
    ).rejects.toMatchObject({ code: 'ACTIVE_CONTENT_MANIFEST_INVALID' });
  });

  it('rejects a relative selected root through the persisted manifest parser', async () => {
    const value = await fixture();
    value.manifest.binding.selection.location.canonicalRoot = 'skills/canonical';
    await writeFile(value.manifestPath, JSON.stringify(value.manifest));

    await expect(
      loadActiveContentProjection({ root: value.root, manifestPath: value.manifestPath }),
    ).rejects.toMatchObject({ code: 'ACTIVE_CONTENT_MANIFEST_INVALID' });
  });

  it('classifies only exact canonical and project skill provenance', async () => {
    const value = await fixture();
    const canonical = value.manifest.skills[0]! as Parameters<
      typeof classifyCompiledSkillSource
    >[0];
    expect(classifyCompiledSkillSource(canonical)).toBe('canonical');
    expect(
      classifyCompiledSkillSource({
        ...canonical,
        identity: 'skill:alpha',
        sourcePath: '.agents/skills/alpha/SKILL.md',
        generatedPath: 'project-skills/skills/alpha/SKILL.md',
      }),
    ).toBe('project');
    expect(() =>
      classifyCompiledSkillSource({ ...canonical, sourcePath: 'vendor/alpha/SKILL.md' }),
    ).toThrowError(expect.objectContaining({ code: 'ACTIVE_CONTENT_MANIFEST_INVALID' }));
    expect(() =>
      classifyCompiledSkillSource({ ...canonical, generatedPath: 'skills/spoof/SKILL.md' }),
    ).toThrowError(expect.objectContaining({ code: 'ACTIVE_CONTENT_MANIFEST_INVALID' }));
    for (const identity of ['../alpha', 'alpha/beta', 'mpx:alpha']) {
      expect(() =>
        classifyCompiledSkillSource({
          ...canonical,
          identity,
          sourcePath: `content/skills/${identity}/SKILL.md`,
          generatedPath: `skills/${identity}/SKILL.md`,
        }),
      ).toThrowError(expect.objectContaining({ code: 'ACTIVE_CONTENT_MANIFEST_INVALID' }));
    }
  });

  it.each([
    { identity: 'skill:alpha', sourcePath: '.agents/skills/alpha/SKILL.md' },
    { identity: 'alpha', sourcePath: '.agents/skills/alpha/SKILL.md' },
    { identity: 'skill:alpha', sourcePath: 'content/skills/alpha/SKILL.md' },
  ])('rejects mismatched skill provenance before loading verified bytes: %j', async (changes) => {
    const value = await fixture();
    Object.assign(value.manifest.skills[0]!, changes);
    await writeFile(value.manifestPath, JSON.stringify(value.manifest));
    await expect(
      loadActiveContentProjection({ root: value.root, manifestPath: value.manifestPath }),
    ).rejects.toMatchObject({ code: 'ACTIVE_CONTENT_MANIFEST_INVALID' });
  });

  it('verifies exact manifest bytes and expected launch binding', async () => {
    const value = await fixture();
    const bytes = await readFile(value.manifestPath);
    const expected = {
      runtime: 'claude' as const,
      manifestKey: 'manifest-key',
      binding: value.manifest.binding,
      manifestFile: { sha256: sha256(bytes), byteCount: bytes.byteLength },
    };
    await expect(
      loadActiveContentProjection({
        root: value.root,
        manifestPath: value.manifestPath,
        expected: {
          ...expected,
          binding: {
            identity: value.manifest.binding.identity,
            repositoryId: value.manifest.binding.repositoryId,
            projectId: value.manifest.binding.projectId,
            selection: value.manifest.binding.selection,
          },
        },
      }),
    ).resolves.toMatchObject({ manifest: { manifestKey: 'manifest-key' } });
    await expect(
      loadActiveContentProjection({
        root: value.root,
        manifestPath: value.manifestPath,
        expected: { ...expected, manifestKey: 'other' },
      }),
    ).rejects.toMatchObject({ code: 'ACTIVE_CONTENT_BINDING_INVALID' });
    await expect(
      loadActiveContentProjection({
        root: value.root,
        manifestPath: value.manifestPath,
        expected: {
          ...expected,
          manifestFile: { ...expected.manifestFile, sha256: '0'.repeat(64) },
        },
      }),
    ).rejects.toMatchObject({ code: 'ACTIVE_CONTENT_TAMPERED' });
  });

  it('returns the exact verified generated bytes for skill and either agent identity', async () => {
    const value = await fixture();
    const active = await loadActiveContentProjection({
      root: value.root,
      manifestPath: value.manifestPath,
    });

    await expect(readActiveContentEntry(active, 'skill', 'alpha')).resolves.toEqual(value.skill);
    await expect(readActiveContentEntry(active, 'agent', 'mpx-explorer')).resolves.toEqual(
      value.agent,
    );
    await expect(readActiveContentEntry(active, 'agent', 'Explore')).resolves.toEqual(value.agent);
  });

  it('reads a skill body lazily from its byte offset and reports its paths', async () => {
    const value = await fixture();
    const generated = Buffer.from('front matter\nbody text\r\n', 'utf8');
    value.manifest.skills[0]!.bodyByteOffset = Buffer.byteLength('front matter\n');
    value.manifest.skills[0]!.generatedSha256 = sha256(generated);
    value.manifest.files[1]!.sha256 = sha256(generated);
    value.manifest.files[1]!.byteCount = generated.byteLength;
    await writeFile(path.join(value.root, 'skills', 'alpha', 'SKILL.md'), generated);
    await writeFile(value.manifestPath, `${JSON.stringify(value.manifest, null, 2)}\n`);
    const active = await loadActiveContentProjection({
      root: value.root,
      manifestPath: value.manifestPath,
    });

    await expect(readActiveSkill(active, 'alpha')).resolves.toEqual({
      entry: active.manifest.skills[0],
      body: 'body text\r\n',
      filePath: path.join(value.root, 'skills', 'alpha', 'SKILL.md'),
      baseDirectory: path.join(value.root, 'skills', 'alpha'),
    });
    await writeFile(path.join(value.root, 'skills', 'alpha', 'SKILL.md'), generated.subarray(1));
    await expect(readActiveSkill(active, 'alpha')).rejects.toMatchObject({
      code: 'ACTIVE_CONTENT_TAMPERED',
    });
  });

  it('selects same-name canonical and project skills only with a verified source qualifier', async () => {
    const value = await fixture();
    const projectBytes = Buffer.from('project skill bytes\n', 'utf8');
    const projectPath = 'project-skills/skills/alpha/SKILL.md';
    await mkdir(path.join(value.root, 'project-skills', 'skills', 'alpha'), { recursive: true });
    await writeFile(path.join(value.root, ...projectPath.split('/')), projectBytes);
    value.manifest.skills.push({
      ...value.manifest.skills[0]!,
      identity: 'skill:alpha',
      sourcePath: '.agents/skills/alpha/SKILL.md',
      generatedPath: projectPath,
      generatedSha256: sha256(projectBytes),
    });
    value.manifest.files.push({
      relativePath: projectPath,
      sha256: sha256(projectBytes),
      byteCount: projectBytes.byteLength,
    });
    await writeFile(value.manifestPath, `${JSON.stringify(value.manifest, null, 2)}\n`);
    const active = await loadActiveContentProjection({
      root: value.root,
      manifestPath: value.manifestPath,
    });

    await expect(readActiveSkill(active, 'alpha')).rejects.toMatchObject({
      code: 'ACTIVE_CONTENT_AMBIGUOUS',
    });
    await expect(readActiveSkill(active, 'alpha', 'canonical')).resolves.toMatchObject({
      body: value.skill.toString('utf8'),
      entry: { identity: 'alpha' },
    });
    await expect(readActiveSkill(active, 'alpha', 'project')).resolves.toMatchObject({
      body: projectBytes.toString('utf8'),
      entry: { identity: 'skill:alpha' },
    });

    await writeFile(path.join(value.root, ...projectPath.split('/')), 'tampered');
    await expect(readActiveSkill(active, 'alpha', 'project')).rejects.toMatchObject({
      code: 'ACTIVE_CONTENT_TAMPERED',
    });
  });

  it('rejects mutation before returning generated bytes', async () => {
    const value = await fixture();
    const active = await loadActiveContentProjection({
      root: value.root,
      manifestPath: value.manifestPath,
    });
    await writeFile(path.join(value.root, 'skills', 'alpha', 'SKILL.md'), 'mutated');

    await expect(readActiveContentEntry(active, 'skill', 'alpha')).rejects.toMatchObject({
      code: 'ACTIVE_CONTENT_TAMPERED',
    });
  });

  it('checks every represented compiler file while excluding the manifest self-hash', async () => {
    const value = await fixture();
    const active = await loadActiveContentProjection({
      root: value.root,
      manifestPath: value.manifestPath,
    });
    await expect(checkActiveContentProjection(active)).resolves.toEqual({
      checkedFiles: 2,
      clean: true,
    });

    await writeFile(path.join(value.root, 'agents', 'Explore.md'), 'changed');
    await expect(checkActiveContentProjection(active)).rejects.toMatchObject({
      code: 'ACTIVE_CONTENT_TAMPERED',
    });
    await expect(readFile(value.manifestPath, 'utf8')).resolves.toContain(
      '"includedInFileMap": false',
    );
  });
});
