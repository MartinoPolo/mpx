import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeContentCommand } from '../../src/content-command.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const temporaryRoots: string[] = [];

afterEach(async () => {
  const results = await Promise.allSettled(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Temporary fixture cleanup failed.');
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-content-cli-'));
  temporaryRoots.push(root);
  const alpha = Buffer.from('exact alpha skill bytes\r\n');
  const zeta = Buffer.from('exact zeta skill bytes\n');
  const explore = Buffer.from('exact explore agent bytes\n');
  const writer = Buffer.from('exact writer agent bytes\n');
  await mkdir(path.join(root, 'skills', 'alpha'), { recursive: true });
  await mkdir(path.join(root, 'skills', 'zeta'), { recursive: true });
  await mkdir(path.join(root, 'agents'));
  await writeFile(path.join(root, 'skills', 'alpha', 'SKILL.md'), alpha);
  await writeFile(path.join(root, 'skills', 'zeta', 'SKILL.md'), zeta);
  await writeFile(path.join(root, 'agents', 'Explore.md'), explore);
  await writeFile(path.join(root, 'agents', 'Writer.md'), writer);
  const files = [
    { relativePath: 'agents/Explore.md', sha256: hash(explore), byteCount: explore.byteLength },
    { relativePath: 'agents/Writer.md', sha256: hash(writer), byteCount: writer.byteLength },
    { relativePath: 'skills/alpha/SKILL.md', sha256: hash(alpha), byteCount: alpha.byteLength },
    { relativePath: 'skills/zeta/SKILL.md', sha256: hash(zeta), byteCount: zeta.byteLength },
  ];
  const skill = (identity: string, description: string, fileIndex: number) => ({
    identity,
    exposure: 'name-only',
    canonicalDescription: description,
    effectiveDescription: description,
    sourcePath: `content/skills/${identity}/SKILL.md`,
    generatedPath: files[fileIndex]!.relativePath,
    generatedSha256: files[fileIndex]!.sha256,
    bodyByteOffset: 0,
    omittedOptionalFeatures: [],
  });
  const agent = (
    canonicalIdentity: string,
    projectedIdentity: string,
    model: string,
    fileIndex: number,
  ) => ({
    canonicalIdentity,
    projectedIdentity,
    semanticModel: 'standard',
    concreteModel: model,
    thinking: 'medium',
    capabilities: ['read'],
    tools: ['Read'],
    nesting: { canonical: [], projected: [], requiredTools: [] },
    outputSchema: 'text',
    sourcePath: `${canonicalIdentity}.md`,
    sourceSha256: 'a'.repeat(64),
    sourceByteCount: 1,
    generatedPath: files[fileIndex]!.relativePath,
    generatedSha256: files[fileIndex]!.sha256,
    generatedByteCount: files[fileIndex]!.byteCount,
  });
  const manifest = {
    schemaVersion: 1,
    compilerVersion: '1.1.0',
    runtime: 'claude',
    profileSchemaVersion: 1,
    binding: { projectId: null, repositoryId: 'repo', contentScope: 'test' },
    manifestKey: 'key',
    manifestEnvelope: { path: 'active-content.json', includedInFileMap: false },
    skills: [skill('zeta', 'Zeta skill.', 3), skill('alpha', 'Alpha skill.', 2)],
    agents: [
      agent('mpx-writer', 'Writer', 'opus', 1),
      agent('mpx-explorer', 'Explore', 'sonnet', 0),
    ],
    files,
  };
  const manifestPath = path.join(root, 'active-content.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  return {
    root,
    manifestPath,
    alpha,
    explore,
    files,
    env: { MPX_ACTIVE_CONTENT_ROOT: root, MPX_ACTIVE_CONTENT_MANIFEST: manifestPath },
  };
}

describe('content command', () => {
  it('inspects active paths with deterministically sorted skill and agent summaries', async () => {
    const value = await fixture();
    const result = await executeContentCommand({ action: 'inspect', args: [], env: value.env });

    expect(result.data).toEqual({
      root: value.root,
      manifest: value.manifestPath,
      skills: [
        {
          identity: 'alpha',
          path: 'skills/alpha/SKILL.md',
          exposure: 'name-only',
          description: 'Alpha skill.',
        },
        {
          identity: 'zeta',
          path: 'skills/zeta/SKILL.md',
          exposure: 'name-only',
          description: 'Zeta skill.',
        },
      ],
      agents: [
        {
          identity: 'mpx-explorer',
          projectedIdentity: 'Explore',
          path: 'agents/Explore.md',
          model: 'sonnet',
        },
        {
          identity: 'mpx-writer',
          projectedIdentity: 'Writer',
          path: 'agents/Writer.md',
          model: 'opus',
        },
      ],
    });
    expect(result.rawOutput).toContain(`Active content: ${value.root}`);
    expect(result.rawOutput).toContain(`Manifest: ${value.manifestPath}`);
    expect(result.rawOutput).toContain('alpha — Alpha skill.');
    expect(result.rawOutput).not.toContain('sourceSha256');
    expect(result.rawOutput).not.toContain('manifestKey');
  });

  it('returns exact compiled skill bytes with safe structured metadata', async () => {
    const value = await fixture();
    const result = await executeContentCommand({
      action: 'inspect',
      args: ['skill', 'alpha'],
      env: value.env,
    });

    expect(Buffer.from(result.rawOutput!)).toEqual(value.alpha);
    expect(result.data).toEqual({
      kind: 'skill',
      identity: 'alpha',
      path: 'skills/alpha/SKILL.md',
      byteCount: value.alpha.byteLength,
      sha256: value.files[2]!.sha256,
    });
  });

  it('returns exact compiled agent bytes with canonical and projected identities', async () => {
    const value = await fixture();
    const result = await executeContentCommand({
      action: 'inspect',
      args: ['agent', 'Explore'],
      env: value.env,
    });

    expect(Buffer.from(result.rawOutput!)).toEqual(value.explore);
    expect(result.data).toEqual({
      kind: 'agent',
      identity: 'mpx-explorer',
      projectedIdentity: 'Explore',
      path: 'agents/Explore.md',
      byteCount: value.explore.byteLength,
      sha256: value.files[0]!.sha256,
    });
  });

  it('retains active projection integrity checking', async () => {
    const value = await fixture();
    const result = await executeContentCommand({ action: 'check', args: [], env: value.env });

    expect(result.data).toEqual({ clean: true, checkedFiles: 4 });
    expect(result.rawOutput).toBe('Active content clean (4 files).\n');
  });

  it.each([
    ['current', []],
    ['list', []],
    ['show', ['skill', 'alpha']],
    ['inspect', ['skill']],
    ['inspect', ['unknown', 'alpha']],
    ['inspect', ['agent', 'Explore', 'extra']],
    ['check', ['extra']],
  ] as const)(
    'rejects removed routes and invalid arity before loading active state: %s',
    async (action, args) => {
      await expect(executeContentCommand({ action, args, env: {} })).rejects.toMatchObject({
        code: 'USAGE_ERROR',
      });
    },
  );
});
