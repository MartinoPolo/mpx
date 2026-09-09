import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { revalidateRuntimeArtifact } from '@mpx/runtime-contracts';
import { buildPiProjection, planPiInvocation } from '../../src/index.js';
import { fixture } from '../fixtures/fixture.js';

it('publishes managed instructions and project context in broad-to-specific order', async () => {
  const input = await fixture();
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'pi-native-projection-'));
  const artifactsRoot = path.join(fixtureRoot, 'artifacts');
  const globalInstructions = path.join(
    fixtureRoot,
    'canonical',
    'instructions',
    'global',
    'AGENTS.md',
  );
  const piAppendInstructions = path.join(
    fixtureRoot,
    'canonical',
    'instructions',
    'runtime',
    'pi',
    'APPEND_SYSTEM.md',
  );
  const projectRoot = path.join(fixtureRoot, 'project');
  const cwd = path.join(projectRoot, 'nested');
  try {
    await mkdir(path.dirname(globalInstructions), { recursive: true });
    await mkdir(path.dirname(piAppendInstructions), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(artifactsRoot);
    await writeFile(globalInstructions, 'CANONICAL GLOBAL\n');
    await writeFile(piAppendInstructions, 'PI APPEND\n');
    await writeFile(path.join(projectRoot, 'AGENTS.md'), 'BROAD PROJECT\n');
    await writeFile(path.join(projectRoot, 'CLAUDE.md'), 'DO NOT READ\n');
    await writeFile(path.join(cwd, 'AGENTS.override.md'), 'SPECIFIC PROJECT\n');
    await writeFile(path.join(cwd, 'AGENTS.md'), 'DO NOT READ\n');
    await writeFile(path.join(artifactsRoot, 'AGENTS.md'), 'ACCOUNT GLOBAL MUST NOT LOAD\n');
    await writeFile(path.join(artifactsRoot, 'APPEND_SYSTEM.md'), 'ACCOUNT APPEND MUST NOT LOAD\n');
    const projection = await buildPiProjection({
      ...input,
      artifactsRoot,
      globalInstructions,
      piAppendInstructions,
      cwd,
    });

    const runtimeOwnedFiles = [
      'projection.json',
      'runtime-context.json',
      'runtime-profile.json',
      'instructions/global/AGENTS.md',
      'instructions/runtime/pi/APPEND_SYSTEM.md',
      'instructions/pi/MANAGED_PROMPT.md',
    ];
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
    await expect(
      readFile(path.join(projection.directory, 'instructions/global/AGENTS.md')),
    ).resolves.toEqual(await readFile(globalInstructions));
    await expect(
      readFile(path.join(projection.directory, 'instructions/runtime/pi/APPEND_SYSTEM.md')),
    ).resolves.toEqual(await readFile(piAppendInstructions));
    const managed = await readFile(
      path.join(projection.directory, 'instructions/pi/MANAGED_PROMPT.md'),
      'utf8',
    );
    expect(managed.indexOf('CANONICAL GLOBAL')).toBeLessThan(managed.indexOf('PI APPEND'));
    expect(managed.indexOf('PI APPEND')).toBeLessThan(managed.indexOf('BROAD PROJECT'));
    expect(managed.indexOf('BROAD PROJECT')).toBeLessThan(managed.indexOf('SPECIFIC PROJECT'));
    expect(managed).not.toContain('DO NOT READ');
    expect(managed).not.toContain('ACCOUNT GLOBAL MUST NOT LOAD');
    expect(managed).not.toContain('ACCOUNT APPEND MUST NOT LOAD');
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
    await expect(
      planPiInvocation({
        executable: path.join(artifactsRoot, 'pi.cmd'),
        executor: 'host',
        accountRoot: artifactsRoot,
        cwd,
        runtimeContext: input.context,
        projection,
      }),
    ).resolves.toMatchObject({
      args: expect.arrayContaining([
        '--no-context-files',
        '--append-system-prompt',
        path.join(projection.directory, 'instructions/pi/MANAGED_PROMPT.md').replaceAll('\\', '/'),
      ]),
      env: {
        MPX_ACTIVE_CONTENT_MANIFEST_INTEGRITY: expect.any(String),
      },
    });
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
    await rm(path.join(projection.directory, 'instructions/pi/MANAGED_PROMPT.md'));
    await expect(
      planPiInvocation({
        executable: path.join(artifactsRoot, 'pi.cmd'),
        executor: 'host',
        accountRoot: artifactsRoot,
        cwd,
        runtimeContext: input.context,
        projection,
      }),
    ).rejects.toThrow();
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
