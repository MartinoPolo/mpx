import { readFile as nodeReadFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateStructure } from '../../../scripts/validate-structure.mjs';

const roots = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function fixture(importSource, extraSource = {}, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-structure-'));
  roots.push(root);
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true }),
  );
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  await writeFile(
    path.join(root, 'vitest.shared.ts'),
    "export const includes = ['packages/*/test/unit/**/*.test.ts'];\n",
  );
  for (const name of ['a', 'b']) {
    await mkdir(path.join(root, 'packages', name, 'src'), { recursive: true });
    await writeFile(
      path.join(root, 'packages', name, 'package.json'),
      options.manifests?.[name] ??
        JSON.stringify({
          name: `@mpx/${name}`,
          version: '0.0.0',
          exports: { '.': './dist/index.js', './node': './dist/node.js' },
        }),
    );
    await writeFile(
      path.join(root, 'packages', name, 'tsconfig.json'),
      JSON.stringify({ exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts'] }),
    );
    await writeFile(
      path.join(root, 'packages', name, 'src', 'index.ts'),
      name === 'a' ? importSource : 'export {};\n',
    );
  }
  for (const [name, value] of Object.entries(extraSource)) {
    const file = path.join(root, 'packages', 'a', 'src', name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, value);
  }
  for (const [name, value] of Object.entries(options.rootFiles ?? {})) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, value);
  }
  return root;
}

const codes = (items) => items.map((item) => item.code);

describe('repository structure validation', () => {
  it('rejects relative cross-workspace and package src/dist deep imports', async () => {
    const deepPackage = ['@mpx/b', 'dist/index.js'].join('/');
    const root = await fixture(
      `export * ${'from'} '../../b/src/index.js';\nconst x = require('${deepPackage}');\n`,
    );
    expect(codes(await validateStructure(root))).toEqual(
      expect.arrayContaining(['CROSS_WORKSPACE_IMPORT', 'WORKSPACE_DEEP_IMPORT']),
    );
  });

  it('rejects root-owned deep-relative imports into a workspace', async () => {
    const deepRelative = ['..', '..', '..', 'packages', 'b', 'src', 'index.js'].join('/');
    const root = await fixture(
      'export {};\n',
      {},
      {
        rootFiles: {
          'tests/integration/cli/migration-bypass.test.ts': `import '${deepRelative}';\n`,
        },
      },
    );
    expect(codes(await validateStructure(root))).toContain('CROSS_WORKSPACE_IMPORT');
  });

  it('rejects undeclared package subpaths while permitting declared public exports', async () => {
    const declared = ['@mpx/b', 'node'].join('/');
    const privatePath = ['@mpx/b', 'private'].join('/');
    const root = await fixture(`import '${declared}';\nimport('${privatePath}');\n`);
    const diagnostics = await validateStructure(root);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'WORKSPACE_EXPORT_UNDECLARED',
        message: expect.stringContaining('@mpx/b/private'),
      }),
    ]);
  });

  it('uses syntax-aware traversal for import-equals and optional require calls', async () => {
    const root = await fixture(
      "import value = require('@mpx/b/private');\nrequire?.('@mpx/b/optional');\n",
    );
    expect(codes(await validateStructure(root))).toEqual([
      'WORKSPACE_EXPORT_UNDECLARED',
      'WORKSPACE_EXPORT_UNDECLARED',
    ]);
  });

  it('does not treat commented import-like text as a dependency', async () => {
    const root = await fixture(
      "// import '@mpx/b/private'\n/* require?.('@mpx/b/also-private') */\nexport {};\n",
    );
    expect(await validateStructure(root)).toEqual([]);
  });

  it('rejects tests and fixture assets under workspace src', async () => {
    const root = await fixture('export {};\n', {
      'bad.spec.ts': 'export {};\n',
      'fixtures/payload.ts': 'export {};\n',
    });
    expect(
      codes(await validateStructure(root)).filter((code) => code === 'WORKSPACE_SRC_TEST_ASSET'),
    ).toHaveLength(2);
  });

  it('fails closed for a malformed workspace export manifest', async () => {
    const root = await fixture('export {};\n', {}, { manifests: { b: '{' } });
    expect(
      codes(
        await validateStructure(root, {
          workspaceDirectories: ['a', 'b'].map((name) => path.join(root, 'packages', name)),
        }),
      ),
    ).toContain('WORKSPACE_EXPORTS_INVALID');
  });

  it('fails closed for an unreadable workspace export manifest', async () => {
    const root = await fixture('export {};\n');
    const blocked = path.join(root, 'packages', 'b', 'package.json');
    const diagnostics = await validateStructure(root, {
      readFile: async (file, encoding) => {
        if (path.resolve(file) === path.resolve(blocked)) {
          const failure = new Error('isolated access denied');
          failure.code = 'EACCES';
          throw failure;
        }
        return nodeReadFile(file, encoding);
      },
    });
    expect(codes(diagnostics)).toContain('WORKSPACE_EXPORTS_INVALID');
  });

  it('requires production workspace tsconfigs to exclude test and spec sources', async () => {
    const root = await fixture('export {};\n');
    await writeFile(
      path.join(root, 'packages', 'a', 'tsconfig.json'),
      JSON.stringify({ exclude: ['src/**/*.test.ts'] }),
    );
    expect(codes(await validateStructure(root))).toContain('WORKSPACE_TSCONFIG_TEST_EXCLUDES');
  });

  it('rejects transitional root tests/unit discovery in shared Vitest configuration', async () => {
    const root = await fixture('export {};\n');
    await writeFile(
      path.join(root, 'vitest.shared.ts'),
      "export const includes = ['tests/unit/**/*.test.ts'];\n",
    );
    expect(codes(await validateStructure(root))).toContain('ROOT_UNIT_DISCOVERY_TRANSITIONAL');
  });
});
