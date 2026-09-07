import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  CATEGORY_CONFIGS,
  classifyTestPath,
  matchingTestCategories,
  TEST_CATEGORIES,
} from '../../../vitest.shared.ts';
import {
  discoverWorkspaceRoots,
  filesBelow,
  requireReadableWorkspaceManifests,
  runPnpm,
  selectedCategoryTestFile,
  testLikeFile,
  workspaceRootsFromPnpmList,
  workspaceTestLayoutViolations,
} from './fixtures/test-harness-support.mjs';

import {
  createRepositorySnapshot,
  repositoryOutputDigests,
} from '../fixtures/repository-snapshot.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workspaceRoots = await discoverWorkspaceRoots(root);
expect(workspaceRoots, 'pnpm workspace discovery must return non-root workspaces').not.toHaveLength(
  0,
);
const fixtureDirectory = /(?:^|\/)(?:fixture|fixtures|__fixtures__|test-fixtures)(?:\/|$)/u;

async function json(relative) {
  return JSON.parse(await readFile(path.join(root, relative), 'utf8'));
}

async function outputFiles(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map((entry) =>
          entry.isDirectory()
            ? outputFiles(path.join(directory, entry.name))
            : [path.join(directory, entry.name)],
        ),
      )
    ).flat();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

describe('repository-derived test taxonomy', () => {
  test('rejects spec suites in workspace source and emitted output', () => {
    expect(
      workspaceTestLayoutViolations('packages/example', [
        'packages/example/src/foo.spec.ts',
        'packages/example/test/unit/foo.spec.ts',
        'packages/example/dist/foo.spec.js',
      ]),
    ).toEqual(['packages/example/dist/foo.spec.js', 'packages/example/src/foo.spec.ts']);
  });

  test('lists files deterministically and prunes non-owned trees before recursion', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'mpx-files-below-'));
    try {
      await mkdir(path.join(fixture, 'middle'));
      await Promise.all([
        writeFile(path.join(fixture, 'z-last.ts'), ''),
        writeFile(path.join(fixture, 'a-first.ts'), ''),
        writeFile(path.join(fixture, 'middle', 'z-nested.ts'), ''),
        writeFile(path.join(fixture, 'middle', 'a-nested.ts'), ''),
      ]);
      for (const directory of [
        '.git',
        '.fallow',
        'node_modules',
        'dist',
        'coverage',
        'generated',
        'projection',
        'projections',
        'vendor',
      ]) {
        await mkdir(path.join(fixture, directory), { recursive: true });
        await writeFile(path.join(fixture, directory, 'hidden.test.ts'), '');
      }
      expect(await filesBelow(fixture)).toEqual([
        'a-first.ts',
        'middle/a-nested.ts',
        'middle/z-nested.ts',
        'z-last.ts',
      ]);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test('fails closed when pnpm returns malformed workspace JSON', () => {
    expect(() => workspaceRootsFromPnpmList(root, '{not json')).toThrow(SyntaxError);
  });

  test.each([
    ['an empty list', '[]'],
    ['only the repository root', JSON.stringify([{ path: root }])],
  ])('fails closed when pnpm returns %s', (_description, source) => {
    expect(() => workspaceRootsFromPnpmList(root, source)).toThrow(
      'pnpm workspace list must include at least one non-root workspace',
    );
  });

  test('does not swallow workspace manifest read errors', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'mpx-unreadable-workspace-'));
    try {
      await expect(requireReadableWorkspaceManifests(fixture, ['missing'])).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test('derives workspace roots through pnpm workspace discovery', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'mpx-workspaces-'));
    try {
      await writeFile(path.join(fixture, 'package.json'), '{"name":"fixture","private":true}');
      await writeFile(path.join(fixture, 'pnpm-workspace.yaml'), 'packages:\n  - modules/**\n');
      await mkdir(path.join(fixture, 'modules', 'group', 'future'), { recursive: true });
      await writeFile(
        path.join(fixture, 'modules', 'group', 'future', 'package.json'),
        '{"name":"future"}',
      );
      await mkdir(path.join(fixture, 'modules', 'not-a-workspace'), { recursive: true });
      expect(await discoverWorkspaceRoots(fixture)).toEqual(['modules/group/future']);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test('digests published output while ignoring only the Pi package verification scratch tree', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'mpx-output-digests-'));
    const workspace = 'runtimes/pi/extensions';
    const scratch = `${workspace}/dist/.package-verify`;
    const trackedFiles = [
      'bin/mpx.mjs',
      `${workspace}/dist/package/index.js`,
      `${workspace}/dist/package/package.json`,
      `${workspace}/dist/.package-staging/index.js`,
      `${workspace}/dist/.package-backup/index.js`,
      `${workspace}/dist/package/.package-verify/index.js`,
      'packages/example/dist/.package-verify/index.js',
    ];
    try {
      await writeFile(path.join(fixture, 'package.json'), '{"name":"fixture","private":true}');
      await writeFile(
        path.join(fixture, 'pnpm-workspace.yaml'),
        'packages:\n  - runtimes/pi/*\n  - packages/*\n',
      );
      for (const directory of [workspace, 'packages/example']) {
        await mkdir(path.join(fixture, directory), { recursive: true });
        await writeFile(
          path.join(fixture, directory, 'package.json'),
          JSON.stringify({ name: path.basename(directory) }),
        );
      }
      for (const file of [...trackedFiles, `${scratch}/nested/index.js`]) {
        await mkdir(path.dirname(path.join(fixture, file)), { recursive: true });
        await writeFile(path.join(fixture, file), 'original');
      }
      const before = await repositoryOutputDigests(fixture);
      expect(Object.keys(before).sort()).toEqual([...trackedFiles].sort());
      await writeFile(path.join(fixture, scratch, 'nested/index.js'), 'changed');
      await writeFile(path.join(fixture, scratch, 'package.json'), '{}');
      expect(await repositoryOutputDigests(fixture)).toEqual(before);
      await rm(path.join(fixture, scratch), { recursive: true });
      expect(await repositoryOutputDigests(fixture)).toEqual(before);
      for (const file of trackedFiles) {
        await writeFile(path.join(fixture, file), 'changed');
        const after = await repositoryOutputDigests(fixture);
        expect(after[file], file).not.toBe(before[file]);
        expect(after).toEqual({ ...before, [file]: after[file] });
        await writeFile(path.join(fixture, file), 'original');
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test('fails closed for overlapping definitions and incidental category words', () => {
    const overlapping = {
      unit: ['tests/**/*.test.ts'],
      payload: [],
      contract: ['tests/contract/**/*.test.ts'],
      integration: [],
      e2e: [],
    };
    expect(matchingTestCategories('tests/contract/public-api.test.ts', overlapping)).toEqual([
      'unit',
      'contract',
    ]);
    expect(classifyTestPath('tests/contract/public-api.test.ts', overlapping)).toBeUndefined();
    expect(classifyTestPath('packages/core/test/unit/integration/value.test.ts')).toBe('unit');
    expect(classifyTestPath('packages/core/test/unit/contracts.test.ts')).toBe('unit');
  });

  test('keeps actual category configs disjoint and aligned with the classifier', async () => {
    const configs = Object.fromEntries(
      await Promise.all(
        TEST_CATEGORIES.map(async (category) => {
          const imported = await import(path.join(root, CATEGORY_CONFIGS[category]));
          return [category, imported.default.test];
        }),
      ),
    );
    const files = (await filesBelow(root)).filter(selectedCategoryTestFile);
    for (const file of files) {
      const configured = TEST_CATEGORIES.filter((category) => {
        const config = configs[category];
        return (
          config.include.some((pattern) => path.matchesGlob(file, pattern)) &&
          !config.exclude.some((pattern) => path.matchesGlob(file, pattern))
        );
      });
      expect(configured, file).toEqual(matchingTestCategories(file));
      expect(configured, file).toHaveLength(1);
      expect(classifyTestPath(file), file).toBe(configured[0]);
    }
  });

  test('keeps workspace suites and fixtures only in their final owned directories', async () => {
    const files = await filesBelow(root);
    for (const workspace of workspaceRoots) {
      const emitted = (await outputFiles(path.join(root, workspace, 'dist'))).map((file) =>
        path.relative(root, file).replaceAll('\\', '/'),
      );
      const owned = files.filter((file) => file.startsWith(`${workspace}/`));
      expect(workspaceTestLayoutViolations(workspace, [...owned, ...emitted]), workspace).toEqual(
        [],
      );
      expect(
        owned.filter(
          (file) => fixtureDirectory.test(file) && !file.startsWith(`${workspace}/test/fixtures/`),
        ),
        workspace,
      ).toEqual([]);
      expect(
        owned.filter(
          (file) =>
            file.startsWith(`${workspace}/src/`) &&
            /(?:^|\/)(?:test|tests|fixture|fixtures|__fixtures__|test-fixtures)(?:\/|$)/u.test(
              file,
            ),
        ),
        workspace,
      ).toEqual([]);
    }
  });

  test('keeps root-owned categories in their final root directories', async () => {
    const files = (await filesBelow(root)).filter(
      (file) =>
        selectedCategoryTestFile(file) &&
        !workspaceRoots.some((workspace) => file.startsWith(`${workspace}/`)) &&
        !file.startsWith('content/'),
    );
    for (const category of ['unit', 'contract', 'integration', 'e2e']) {
      for (const file of files.filter((candidate) => classifyTestPath(candidate) === category)) {
        expect(file, file).toMatch(new RegExp(`^tests/${category}/`, 'u'));
      }
    }
  });

  test('keeps payload and Pi vendor/generated tests as explicit classifier exceptions', () => {
    const payload = 'content/skills/video-to-image/__tests__/compose.test.ts';
    expect(matchingTestCategories(payload)).toEqual(['payload']);
    expect(
      classifyTestPath('runtimes/pi/runtime-pi/vendor/subagents/upstream.test.ts'),
    ).toBeUndefined();
    expect(classifyTestPath('runtimes/pi/runtime-pi/generated/projected.test.ts')).toBeUndefined();
    expect(classifyTestPath('packages/core/dist/emitted.test.js')).toBeUndefined();
  });

  test('keeps executable scripts free of test suites', async () => {
    expect((await filesBelow(root, 'scripts')).filter(testLikeFile)).toEqual([]);
  });

  test('keeps root tests on public package boundaries', async () => {
    const files = (await filesBelow(root, 'tests')).filter((file) =>
      /\.(?:[cm]?[jt]sx?)$/u.test(file),
    );
    const privatePackageImport =
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"][^'"]*packages\/[^'"]+\/(?:dist|src)(?:\/[^'"]*)?['"]/u;
    const violations = [];
    for (const file of files) {
      if (privatePackageImport.test(await readFile(path.join(root, file), 'utf8'))) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('final workspace and root command contracts', () => {
  test('gives every workspace its final Vitest, tsconfig, and package-script contract', async () => {
    for (const workspace of workspaceRoots) {
      const production = await json(`${workspace}/tsconfig.json`);
      const tests = await json(`${workspace}/tsconfig.test.json`);
      const manifest = await json(`${workspace}/package.json`);
      if (workspace === 'runtimes/pi/extensions') {
        expect(production.include, workspace).toEqual(['**/*.ts']);
        expect(production.exclude, workspace).toEqual(['**/*.test.ts', 'dist/**', 'test/**']);
        expect(tests.compilerOptions.noEmit, workspace).toBe(true);
        expect(tests.include, workspace).toEqual(['**/*.ts']);
        expect(tests.exclude, workspace).toEqual(['dist/**']);
        expect(manifest.scripts.build, workspace).toBe('node scripts/run.mjs build');
        expect(manifest.scripts['test:unit'], workspace).toBe('node scripts/run.mjs test');
        expect(manifest.scripts.typecheck, workspace).toBe('node scripts/run.mjs typecheck');
        expect(manifest.scripts.check, workspace).not.toContain('vitest run');
        continue;
      }
      const vitest = await import(path.join(root, workspace, 'vitest.config.ts'));
      expect(vitest.default.test.include, workspace).toEqual([
        'test/unit/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
      ]);
      expect(production.include, workspace).toEqual(['src/**/*.ts']);
      expect(production.exclude, workspace).toEqual(
        expect.arrayContaining(['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/fixtures/**']),
      );
      expect(tests.compilerOptions.noEmit, workspace).toBe(true);
      expect(tests.include, workspace).toEqual(['src/**/*.ts', 'test/**/*.ts']);
      expect(tests.exclude, workspace).toEqual([]);
      expect(manifest.scripts.build, workspace).toBe('tsc -p tsconfig.json');
      expect(manifest.scripts['test:unit'], workspace).toBe(
        `pnpm --filter ${manifest.name}... build && vitest run`,
      );
      expect(manifest.scripts.test, workspace).toContain('test:unit');
      expect(manifest.scripts.typecheck, workspace).toContain('tsconfig.test.json');
      expect(manifest.scripts.check, workspace).not.toContain('vitest run');
    }
  });

  test('keeps tests outside production compilation and emitted build output', async () => {
    const canonicalBefore = await repositoryOutputDigests(root);
    const snapshotRoot = await createRepositorySnapshot(root, 'mpx-build-integration-');
    try {
      for (const workspace of workspaceRoots) {
        await rm(path.join(snapshotRoot, workspace, 'dist'), { recursive: true, force: true });
      }
      await runPnpm(snapshotRoot, ['run', 'build']);
      for (const workspace of workspaceRoots) {
        const emitted = await outputFiles(path.join(snapshotRoot, workspace, 'dist'));
        expect(emitted, workspace).not.toHaveLength(0);
        expect(emitted.map((file) => path.basename(file)).filter(testLikeFile), workspace).toEqual(
          [],
        );
      }
      expect(await repositoryOutputDigests(root)).toEqual(canonicalBefore);
    } finally {
      await rm(snapshotRoot, { recursive: true, force: true });
      await expect(stat(snapshotRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }, 120_000);

  test('keeps one thin root config per category and bounds only aggregate unit workers', async () => {
    expect(Object.keys(CATEGORY_CONFIGS).sort()).toEqual([...TEST_CATEGORIES].sort());
    for (const category of TEST_CATEGORIES) {
      const configPath = CATEGORY_CONFIGS[category];
      expect(await readFile(path.join(root, configPath), 'utf8'), category).toContain(
        'vitest.shared',
      );
      const config = await import(path.join(root, configPath));
      expect(config.default.test.maxWorkers, category).toBe(category === 'unit' ? 4 : undefined);
    }
  });

  test('makes every public category command independently executable with its exact config', async () => {
    const manifest = await json('package.json');
    expect(
      Object.fromEntries(
        TEST_CATEGORIES.map((category) => [category, manifest.scripts[`test:${category}`]]),
      ),
    ).toEqual({
      unit: 'pnpm run build && vitest run --config vitest.unit.config.ts',
      payload: 'vitest run --config vitest.payload.config.ts',
      contract:
        'pnpm --filter @mpx/runtime-contracts... build && vitest run --config vitest.contract.config.ts',
      integration: 'pnpm --filter mpx... build && vitest run --config vitest.integration.config.ts',
      e2e: 'pnpm --filter mpx... build && vitest run --config vitest.e2e.config.ts',
    });
  });

  test('invokes each self-contained category exactly once in safe order', async () => {
    const manifest = await json('package.json');
    const invocations = manifest.scripts.test.split('&&').map((command) => command.trim());
    expect(invocations).toEqual(TEST_CATEGORIES.map((category) => `pnpm run test:${category}`));
    for (const category of TEST_CATEGORIES) {
      expect(invocations.filter((command) => command === `pnpm run test:${category}`)).toHaveLength(
        1,
      );
    }
    expect(invocations).not.toContain('pnpm run test:convergence');
    expect(invocations).not.toContain('pnpm run build');
    expect(manifest.scripts.test).not.toContain('pnpm -r test');
  });

  test('does not retain obsolete convergence migration commands', async () => {
    const manifest = await json('package.json');
    expect(Object.keys(manifest.scripts).filter((name) => name.includes('convergence'))).toEqual(
      [],
    );
    expect(manifest.scripts.test).not.toContain('convergence');
  });

  test('retains only the final test exception in Fallow duplicate analysis', async () => {
    const config = await json('.fallowrc.json');
    expect(config.duplicates.ignore).toEqual(['**/*.test.ts', '**/*.spec.ts']);
  });
});
