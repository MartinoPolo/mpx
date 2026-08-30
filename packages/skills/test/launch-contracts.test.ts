import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MAX_SKILL_BODY_BYTES,
  SkillCatalogError,
  createRuntimeSkillArtifact,
  inventoryCanonical,
  loadSkillBody,
  resolveManifest,
} from '../src/index.js';
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-load-v4-'));
  roots.push(root);
  await mkdir(path.join(root, 'review'));
  await writeFile(
    path.join(root, 'review', 'SKILL.md'),
    '---\nname: review\ndescription: Review safely\nmetadata:\n  mpx:\n    skillPacks: [core]\n    defaultExposure: name-only\n---\nBODY\n',
  );
  const catalog = await inventoryCanonical(root);
  const manifest = resolveManifest(catalog, {
    repositoryId: 'repo',
    contentScope: 'work',
    identity: 'work',
    skillPolicy: 'developer',
    skillPolicyConfig: { skillExposure: { default: 'name-only' } },
    enabledPacks: ['core'],
  });
  return {
    root,
    catalog,
    manifest,
    artifact: createRuntimeSkillArtifact(manifest, catalog, { runtime: 'pi' }),
  };
}
function code(error: unknown) {
  return error instanceof SkillCatalogError ? error.diagnostics[0]?.code : undefined;
}
describe('v4 lazy body validation', () => {
  it('rejects path escapes', async () => {
    const value = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'mpx-outside-'));
    roots.push(outside);
    await writeFile(path.join(outside, 'SKILL.md'), 'outside');
    const link = path.join(value.root, 'link');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const entry = value.artifact.entries[0];
    if (!entry) {
      throw new Error('fixture did not produce a runtime entry');
    }
    entry.source.path = path.join(link, 'SKILL.md');
    await expect(
      loadSkillBody({
        canonicalRoot: value.root,
        manifest: value.manifest,
        artifact: value.artifact,
        runtime: 'pi',
        identity: 'review',
        invocation: 'model',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => code(error) === 'STALE_ARTIFACT' || code(error) === 'SKILL_PATH_INVALID',
    );
  });
  it('rejects oversized and stale canonical files', async () => {
    const oversized = await fixture();
    await writeFile(
      path.join(oversized.root, 'review', 'SKILL.md'),
      'x'.repeat(MAX_SKILL_BODY_BYTES + 1),
    );
    await expect(
      loadSkillBody({
        canonicalRoot: oversized.root,
        manifest: oversized.manifest,
        artifact: oversized.artifact,
        runtime: 'pi',
        identity: 'review',
        invocation: 'model',
      }),
    ).rejects.toSatisfy((error: unknown) => code(error) === 'SKILL_BODY_TOO_LARGE');
    const stale = await fixture();
    const file = path.join(stale.root, 'review', 'SKILL.md');
    await writeFile(file, (await readFile(file, 'utf8')).replace('BODY', 'CHANGED'));
    await expect(
      loadSkillBody({
        canonicalRoot: stale.root,
        manifest: stale.manifest,
        artifact: stale.artifact,
        runtime: 'pi',
        identity: 'review',
        invocation: 'model',
      }),
    ).rejects.toSatisfy((error: unknown) => code(error) === 'SKILL_CONTENT_STALE');
  });
});
