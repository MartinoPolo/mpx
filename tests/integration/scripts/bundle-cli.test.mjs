import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBundleBytes, checkBundles } from '../../../scripts/bundle-cli.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const sha = (value) => createHash('sha256').update(value).digest('hex');

describe('generated CLI bundle validation', () => {
  it('builds deterministic bytes without mutating tracked bundles or evidence', async () => {
    const tracked = ['bin/mpx.mjs', 'bin/claude-gateway.js', 'evidence/executor-evidence.ts'];
    const before = await Promise.all(tracked.map((name) => readFile(path.join(root, name))));
    const first = await buildBundleBytes();
    const second = await buildBundleBytes();
    expect([...first.keys()]).toEqual([...second.keys()]);
    for (const [name, bytes] of first) {
      expect(bytes.equals(second.get(name))).toBe(true);
    }
    const cli = first.get('bin/mpx.mjs').toString('utf8');
    expect(cli).not.toContain('The package "esbuild" cannot be bundled');
    expect(cli).not.toContain('var ESBUILD_VERSION');
    const after = await Promise.all(tracked.map((name) => readFile(path.join(root, name))));
    expect(after.map(sha)).toEqual(before.map(sha));
  }, 30_000);

  it('reports canonical source-driven drift without rewriting tracked bytes', async () => {
    const sourceName = 'apps/cli/src/main.ts';
    const bundleName = 'bin/mpx.mjs';
    const originalSource = await readFile(path.join(root, sourceName));
    const originalBundle = await readFile(path.join(root, bundleName));
    const tracked = new Map([[bundleName, originalBundle]]);

    expect(
      await checkBundles({
        sourceOverrides: new Map([
          [sourceName, Buffer.concat([originalSource, Buffer.from('\n// isolated gate change\n')])],
        ]),
        readTrackedBundle: async (name) =>
          tracked.get(name) ?? (await readFile(path.join(root, name))),
      }),
    ).toContain('BUNDLE_DRIFT: bin/mpx.mjs: tracked bundle differs from canonical source build');
    expect(tracked.get(bundleName).equals(originalBundle)).toBe(true);
  }, 30_000);

  it('distinguishes a missing tracked bundle without touching the checkout', async () => {
    const missing = 'bin/claude-gateway.js';
    const diagnostics = await checkBundles({
      readTrackedBundle: async (name) => {
        if (name === missing) {
          const failure = new Error('isolated missing artifact');
          failure.code = 'ENOENT';
          throw failure;
        }
        return readFile(path.join(root, name));
      },
    });

    expect(diagnostics).toContain(
      'BUNDLE_MISSING: bin/claude-gateway.js: tracked bundle is missing',
    );
    await expect(readFile(path.join(root, missing))).resolves.toBeInstanceOf(Buffer);
  }, 30_000);
});
