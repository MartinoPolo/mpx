import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { revalidateRuntimeArtifact } from '@mpx/runtime-contracts';
import { buildPiProjection } from '../../src/index.js';
import { fixture } from '../fixtures/fixture.js';

it('publishes only launch data and compiler-owned skills and agents', async () => {
  const input = await fixture();
  const artifactsRoot = await mkdtemp(path.join(tmpdir(), 'pi-native-projection-'));
  try {
    const projection = await buildPiProjection({ ...input, artifactsRoot });

    const runtimeOwnedFiles = ['projection.json', 'runtime-context.json', 'runtime-profile.json'];
    expect(projection.files).toEqual(
      [
        ...runtimeOwnedFiles,
        ...input.compiledContent.files.map((file) => file.relativePath),
      ].sort(),
    );
    for (const file of input.compiledContent.files) {
      await expect(readFile(path.join(projection.directory, file.relativePath))).resolves.toEqual(
        Buffer.from(file.bytes),
      );
    }
    expect(projection.files).not.toEqual(
      expect.arrayContaining([
        'extension.mjs',
        'settings.json',
        'keybindings.json',
        'themes/green.json',
        'status/status-snapshot.json',
        'vendor/subagents/VENDORED.md',
      ]),
    );
    expect(projection).not.toHaveProperty('extension');
    await expect(
      revalidateRuntimeArtifact(projection.directory, projection.reference),
    ).resolves.toMatchObject({ valid: true });
    const descriptor = JSON.parse(
      await readFile(path.join(projection.directory, 'projection.json'), 'utf8'),
    );
    expect(descriptor).toEqual({
      schemaVersion: 1,
      runtime: 'pi',
      manifestKey: input.skillPlan.manifestKey,
      runtimeArtifact: input.skillPlan.artifactReference,
      runtimeContext: 'runtime-context.json',
      profile: 'runtime-profile.json',
      skills: 'skills',
      agents: 'agents',
    });
  } finally {
    await rm(artifactsRoot, { recursive: true, force: true });
  }
});
