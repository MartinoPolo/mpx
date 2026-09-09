import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeSkillArtifactReference } from '@mpx/runtime-contracts';
import {
  createRuntimeSkillArtifact,
  inventoryCanonical,
  resolveManifest,
  verifyRuntimeSkillArtifact,
} from '../../src/index.js';

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
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const digest = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-integrity-'));
  roots.push(root);
  for (const [name, exposure] of [
    ['shown', 'name-only'],
    ['manual', 'explicit-only'],
  ] as const) {
    await mkdir(path.join(root, name));
    await writeFile(
      path.join(root, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} description\nmetadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [development]\n    defaultExposure: ${exposure}\n---\n${name}\n`,
    );
  }
  const catalog = await inventoryCanonical(root);
  const manifest = resolveManifest(catalog, {
    repositoryId: 'repo',
    identity: 'personal',
    selection: {
      location: { name: 'coding', canonicalRoot: root },
      packs: ['development'],
      source: 'project',
    },
  });
  const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: 'pi' });
  return { catalog, manifest, artifact };
}

type Artifact = Awaited<ReturnType<typeof fixture>>['artifact'];

function fileMap(entries: Artifact['entries']) {
  return entries
    .map((entry) => ({
      identity: entry.identity,
      publicName: entry.publicName,
      packs: [...entry.packs].sort(),
      exposure: entry.exposure,
      metadataHash: entry.metadataHash,
      description: entry.description ?? null,
      triggers: entry.triggers ?? null,
      source:
        entry.source.kind === 'project'
          ? {
              kind: entry.source.kind,
              path: entry.source.path,
              realPath: entry.source.realPath,
              contentHash: entry.source.contentHash,
              directoryHash: entry.source.directoryHash,
              projectRoot: entry.source.projectRoot,
              realProjectRoot: entry.source.realProjectRoot,
            }
          : {
              kind: entry.source.kind,
              path: entry.source.path,
              realPath: entry.source.realPath,
              contentHash: entry.source.contentHash,
            },
      permissions: { ...entry.permissions },
    }))
    .sort((a, b) => a.identity.localeCompare(b.identity));
}

function selfConsistent(artifact: Artifact, entries: Artifact['entries']): Artifact {
  const fileMapHash = digest(fileMap(entries));
  const artifactKey = digest({
    schemaVersion: 5,
    runtime: artifact.runtime,
    manifestKey: artifact.manifestKey,
    fileMapHash,
  });
  return {
    ...artifact,
    entries,
    reference: createRuntimeSkillArtifactReference({
      runtime: artifact.runtime,
      manifestKey: artifact.manifestKey,
      fileMapHash,
      artifactKey,
    }),
  };
}

it('rejects self-consistent forged v5 artifacts beyond superficial reference hashes', async () => {
  const { catalog, manifest, artifact } = await fixture();
  const shown = artifact.entries.find((entry) => entry.identity === 'shown')!;
  const mutations: Artifact['entries'][] = [
    artifact.entries.map((entry) =>
      entry === shown ? { ...entry, exposure: 'full', description: 'forged' } : entry,
    ),
    artifact.entries.map((entry) =>
      entry === shown
        ? { ...entry, permissions: { ...entry.permissions, modelInvocation: false } }
        : entry,
    ),
    artifact.entries.map((entry) => (entry === shown ? { ...entry, identity: 'forged' } : entry)),
    artifact.entries.filter((entry) => entry !== shown),
    [...artifact.entries, shown],
    artifact.entries.map((entry) =>
      entry === shown ? { ...entry, source: { ...entry.source, contentHash: 'forged' } } : entry,
    ),
    artifact.entries.map((entry) =>
      entry === shown ? { ...entry, metadataHash: 'forged' } : entry,
    ),
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
  expect(verifyRuntimeSkillArtifact(artifact, manifest, catalog, { runtime: 'pi' })).toBe(artifact);
});
