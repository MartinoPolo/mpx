import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createRuntimeSkillArtifact,
  createSkillProjectionPlan,
  inventoryCanonical,
  resolveManifest,
} from '../../src/index.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe('portable canonical metadata', () => {
  it.each([
    ['missing schema version', '', /schemaVersion must be 1/u],
    ['invalid schema version', '    schemaVersion: 2\n', /schemaVersion must be 1/u],
    ['empty argument hint', "argument-hint: ''\n", /argument-hint must be a non-empty string/u],
    [
      'non-string argument hint',
      'argument-hint: true\n',
      /argument-hint must be a non-empty string/u,
    ],
    [
      'empty capabilities',
      '    capabilities: []\n',
      /capabilities contains an unknown capability/u,
    ],
    [
      'unknown capability',
      '    capabilities: [network]\n',
      /capabilities contains an unknown capability/u,
    ],
  ])('rejects %s', async (_label, addition, message) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-portable-invalid-'));
    roots.push(root);
    await mkdir(path.join(root, 'invalid'));
    const top = addition.startsWith('argument-') ? addition : '';
    const nested = addition.includes('capabilities') ? addition : '';
    const schema =
      _label === 'missing schema version'
        ? ''
        : _label === 'invalid schema version'
          ? addition
          : '    schemaVersion: 1\n';
    await writeFile(
      path.join(root, 'invalid', 'SKILL.md'),
      `---\nname: invalid\ndescription: Invalid.\n${top}metadata:\n  mpx:\n${schema}${nested}    skillPacks: [core]\n    defaultExposure: full\n---\nBody.\n`,
    );
    await expect(inventoryCanonical(root)).rejects.toThrow(message);
  });

  it('preserves argument hints and semantic capabilities into a verified projection plan', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-portable-metadata-'));
    roots.push(root);
    await mkdir(path.join(root, 'create-thing'));
    await writeFile(
      path.join(root, 'create-thing', 'SKILL.md'),
      `---\nname: create-thing\ndescription: Create a thing exactly.\nargument-hint: <title>\nmetadata:\n  mpx:\n    schemaVersion: 1\n    contentVersion: 1\n    skillPacks: [core]\n    defaultExposure: full\n    capabilities: [read, search, shell, write, delegate]\n---\nBody.\n`,
    );
    const catalog = await inventoryCanonical(root);
    expect(catalog[0]).toMatchObject({
      schemaVersion: 1,
      contentVersion: 1,
      argumentHint: '<title>',
      capabilities: ['delegate', 'read', 'search', 'shell', 'write'],
    });
    const manifest = resolveManifest(catalog, {
      repositoryId: 'repo',
      contentScope: 'test',
      identity: 'test',
      skillPolicy: 'test',
      skillPolicyConfig: { skillExposure: { default: 'full' } },
      enabledPacks: ['core'],
    });
    const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: 'claude' });
    const plan = await createSkillProjectionPlan({
      canonicalRoot: root,
      manifest,
      artifact,
      catalog,
    });
    expect(plan.entries[0]).toMatchObject({
      argumentHint: '<title>',
      capabilities: ['delegate', 'read', 'search', 'shell', 'write'],
    });
  });
});
