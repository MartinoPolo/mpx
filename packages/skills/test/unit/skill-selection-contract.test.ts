import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  inventoryCanonical,
  resolveEffectiveSkillPacks,
  resolveManifest,
} from '../../src/index.js';
import { parseCanonical } from '../../src/frontmatter.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

it('rejects empty, obsolete, and identity-unallowed selected packs instead of filtering or defaulting', () => {
  expect(() => resolveEffectiveSkillPacks([], ['development'])).toThrow(/at least one/u);
  expect(() => resolveEffectiveSkillPacks(['core' as never], ['core' as never])).toThrow(
    /unsupported/u,
  );
  expect(() => resolveEffectiveSkillPacks(['personal'], ['development'])).toThrow(/not allowed/u);
});

it('rejects explicit null canonical exposure instead of defaulting it to full', () => {
  expect(() =>
    parseCanonical(
      {
        name: 'invalid',
        description: 'Invalid exposure',
        metadata: {
          mpx: {
            schemaVersion: 1,
            skillPacks: ['development'],
            defaultExposure: null,
          },
        },
      },
      'invalid',
    ),
  ).toThrow(/defaultExposure is invalid/u);
});

it('defaults omitted canonical exposure to full while preserving explicit exposure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-exposure-'));
  roots.push(root);
  for (const [name, declaration] of [
    ['missing', ''],
    ['explicit', '    defaultExposure: explicit-only\n'],
  ] as const) {
    await mkdir(path.join(root, name));
    await writeFile(
      path.join(root, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: description\nmetadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [development]\n${declaration}---\nbody\n`,
    );
  }
  const catalog = await inventoryCanonical(root);
  const manifest = resolveManifest(catalog, {
    repositoryId: 'sample/app',
    projectId: 'sample/app',
    identity: 'personal',
    selection: {
      location: { name: 'coding', canonicalRoot: root },
      packs: ['development'],
      source: 'project',
    },
  });

  expect(manifest.decisions.map(({ identity, exposure }) => [identity, exposure])).toEqual([
    ['explicit', 'explicit-only'],
    ['missing', 'full'],
  ]);
});
