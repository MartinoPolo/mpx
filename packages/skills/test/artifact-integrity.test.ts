import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeSkillArtifactReferenceV4 } from '@mpx/runtime-contracts';
import {
  createRuntimeSkillArtifact,
  inventoryCanonical,
  resolveManifest,
  verifyRuntimeSkillArtifact,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);
function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-integrity-'));
  roots.push(root);
  for (const [name, exposure] of [
    ['shown', 'name-only'],
    ['hidden', 'off'],
  ] as const) {
    await mkdir(path.join(root, name));
    await writeFile(
      path.join(root, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} description\nmetadata:\n  mpx:\n    skillPacks: [core]\n    defaultExposure: ${exposure}\n---\n${name}\n`,
    );
  }
  const catalog = await inventoryCanonical(root);
  const manifest = resolveManifest(catalog, {
    repositoryId: 'repo',
    contentScope: 'work',
    enabledPacks: ['core'],
    identity: 'work',
    skillPolicy: 'policy',
    skillPolicyConfig: {
      skillExposure: { default: 'full', skills: { shown: 'name-only', hidden: 'off' } },
    },
  });
  return {
    catalog,
    manifest,
    artifact: createRuntimeSkillArtifact(manifest, catalog, { runtime: 'pi' }),
  };
}

function selfConsistent(
  artifact: Awaited<ReturnType<typeof fixture>>['artifact'],
  entries: typeof artifact.entries,
) {
  const fileMap = entries
    .map((entry) => ({
      identity: entry.identity,
      publicName: entry.publicName,
      metadataHash: entry.metadataHash,
      contentHash: entry.source.contentHash,
    }))
    .sort((a, b) => a.identity.localeCompare(b.identity));
  const fileMapHash = digest(fileMap);
  const artifactKey = digest({
    schemaVersion: 4,
    runtime: artifact.runtime,
    manifestKey: artifact.manifestKey,
    fileMapHash,
  });
  return {
    ...artifact,
    entries,
    reference: createRuntimeSkillArtifactReferenceV4({
      runtime: artifact.runtime,
      manifestKey: artifact.manifestKey,
      fileMapHash,
      artifactKey,
    }),
  };
}

describe('bound runtime artifact integrity', () => {
  it('rejects self-consistent exposure, permission, identity, inclusion, omission, duplicate, source, and metadata mutations', async () => {
    const { catalog, manifest, artifact } = await fixture();
    const shown = artifact.entries[0];
    const mutations = [
      [{ ...shown, exposure: 'full' as const, description: 'forged' }],
      [{ ...shown, permissions: { humanInvocation: true, modelInvocation: false } }],
      [{ ...shown, publicName: '/mpx:forged' }],
      [{ ...shown, packs: ['work' as const] }],
      [{ ...shown, metadataHash: 'forged' }],
      [{ ...shown, source: { ...shown.source, contentHash: 'forged' } }],
      [shown, shown],
      [],
      [shown, { ...shown, identity: 'hidden', publicName: '/mpx:hidden' }],
    ];
    for (const entries of mutations) {
      expect(() =>
        verifyRuntimeSkillArtifact(selfConsistent(artifact, entries), manifest, catalog, {
          runtime: 'pi',
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'RUNTIME_ARTIFACT_TAMPERED',
          details: expect.objectContaining({ restartRequired: true }),
        }),
      );
    }
    expect(verifyRuntimeSkillArtifact(artifact, manifest, catalog, { runtime: 'pi' })).toBe(
      artifact,
    );
  });
});
