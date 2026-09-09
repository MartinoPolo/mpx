import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
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

  test('keeps payload and Pi vendor/generated tests as explicit classifier exceptions', () => {
    const payload = 'content/skills/video-to-image/__tests__/compose.test.ts';
    expect(matchingTestCategories(payload)).toEqual(['payload']);
    expect(
      classifyTestPath('runtimes/pi/runtime-pi/vendor/subagents/upstream.test.ts'),
    ).toBeUndefined();
    expect(classifyTestPath('runtimes/pi/runtime-pi/generated/projected.test.ts')).toBeUndefined();
    expect(classifyTestPath('packages/core/dist/emitted.test.js')).toBeUndefined();
  });
});

describe('final workspace and root command contracts', () => {
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
});
