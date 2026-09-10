import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { revalidateRuntimeArtifact } from '@mpx/runtime-contracts';
import { buildPiProjection, planPiInvocation } from '../../src/index.js';
import { fixture } from '../fixtures/fixture.js';

it('publishes compiler output without duplicating native Pi instructions', async () => {
  const input = await fixture();
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'pi-native-projection-'));
  const artifactsRoot = path.join(fixtureRoot, 'artifacts');
  const projectRoot = path.join(fixtureRoot, 'project');
  const cwd = path.join(projectRoot, 'nested');
  const nativeInstructions = path.join(fixtureRoot, 'native-AGENTS.md');
  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(artifactsRoot);
    await writeFile(nativeInstructions, 'NATIVE PROJECT CONTEXT\n');
    await symlink(nativeInstructions, path.join(cwd, 'AGENTS.override.md'), 'file');

    const projection = await buildPiProjection({ ...input, artifactsRoot });

    const runtimeOwnedFiles = ['projection.json', 'runtime-context.json', 'runtime-profile.json'];
    expect(projection.files).toEqual(
      [
        ...runtimeOwnedFiles,
        ...input.compiledContent.files.map((file) => file.relativePath),
      ].sort(),
    );
    expect(projection.files).not.toEqual(
      expect.arrayContaining([
        'instructions/global/AGENTS.md',
        'instructions/runtime/pi/APPEND_SYSTEM.md',
        'instructions/pi/MANAGED_PROMPT.md',
      ]),
    );
    for (const file of input.compiledContent.files) {
      await expect(readFile(path.join(projection.directory, file.relativePath))).resolves.toEqual(
        Buffer.from(file.bytes),
      );
    }
    await expect(
      revalidateRuntimeArtifact(projection.directory, projection.reference),
    ).resolves.toMatchObject({ valid: true });

    const plan = await planPiInvocation({
      executable: path.join(artifactsRoot, 'pi.cmd'),
      executor: 'host',
      accountRoot: artifactsRoot,
      cwd,
      runtimeContext: input.context,
      projection,
    });
    expect(plan.args).not.toContain('--no-context-files');
    expect(plan.args).not.toContain('--append-system-prompt');
    expect(plan.args).not.toContain(nativeInstructions.replaceAll('\\', '/'));
    expect(plan.env.MPX_ACTIVE_CONTENT_MANIFEST_INTEGRITY).toEqual(expect.any(String));

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
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
