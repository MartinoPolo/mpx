import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import { discoverWorkspaceRoots, filesBelow } from './fixtures/test-harness-support.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workspaceRoots = await discoverWorkspaceRoots(root);

async function json(relative) {
  return JSON.parse(await readFile(path.join(root, relative), 'utf8'));
}

describe('test taxonomy', () => {
  test('classifies synthetic legacy and target paths by ownership and suffix', () => {
    expect(classifyTestPath('packages/core/src/value.test.ts')).toBe('unit');
    expect(classifyTestPath('packages/core/test/value.test.ts')).toBe('unit');
    expect(classifyTestPath('packages/core/test/unit/value.test.ts')).toBe('unit');
    expect(classifyTestPath('packages/core/src/value.integration.test.ts')).toBeUndefined();
    expect(classifyTestPath('apps/cli/test/unit/value.e2e.test.ts')).toBeUndefined();
    expect(classifyTestPath('tests/e2e/cli/value.e2e.test.ts')).toBe('e2e');
    expect(classifyTestPath('tests/contract/public-api.test.ts')).toBe('contract');
    expect(classifyTestPath('tests/integration/scripts/example.test.mjs')).toBe('integration');
    expect(classifyTestPath('scripts/example.test.mjs')).toBeUndefined();
  });

  test('does not infer a category from incidental directory or stem words', () => {
    expect(classifyTestPath('packages/core/src/integration/value.test.ts')).toBe('unit');
    expect(classifyTestPath('packages/core/src/contracts.test.ts')).toBe('unit');
    expect(classifyTestPath('packages/core/src/production.test.ts')).toBe('unit');
  });

  test('fails closed when include definitions overlap', () => {
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
  });

  test('selects future root test categories from their configured patterns', () => {
    expect(classifyTestPath('tests/unit/future.test.ts')).toBe('unit');
    expect(classifyTestPath('tests/payload/future.test.ts')).toBe('payload');
    expect(classifyTestPath('tests/contract/future.test.ts')).toBe('contract');
    expect(classifyTestPath('tests/integration/future.test.ts')).toBe('integration');
    expect(classifyTestPath('tests/e2e/future.test.ts')).toBe('e2e');
  });

  test('keeps the script governance cohort exclusively in root integration tests', async () => {
    const files = new Set(await filesBelow(root));
    const basenames = [
      'build-preparation.test.mjs',
      'capture-migration-baseline.test.mjs',
      'convergence-manifest.test.mjs',
      'native-capability-inventory.test.mjs',
      'required-convergence.test.mjs',
      'run-f2-live-proof.test.mjs',
      'test-harness.test.mjs',
      'validate-generated.test.mjs',
    ];
    for (const basename of basenames) {
      const formerPath = `scripts/${basename}`;
      const integrationPath = `tests/integration/scripts/${basename}`;
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(integrationPath), integrationPath).toBe(true);
      expect(matchingTestCategories(integrationPath), integrationPath).toEqual(['integration']);
    }
    expect(files.has('scripts/test-harness-support.mjs')).toBe(false);
    expect(files.has('tests/integration/scripts/fixtures/test-harness-support.mjs')).toBe(true);
  });

  test('preserves the fixed six-suite contract migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const migrationInventory = [
      [
        'packages/runtime-contracts/test/capabilities.test.ts',
        'tests/contract/runtime-contracts/capabilities.test.ts',
      ],
      [
        'packages/runtime-contracts/test/f2-contracts.test.ts',
        'tests/contract/runtime-contracts/f2-contracts.test.ts',
      ],
      [
        'packages/runtime-contracts/test/runtime-contracts.test.ts',
        'tests/contract/runtime-contracts/runtime-contracts.test.ts',
      ],
      ['packages/providers/src/contracts.test.ts', 'tests/contract/providers/contracts.test.ts'],
      [
        'packages/providers/src/conformance.test.ts',
        'tests/contract/providers/conformance.test.ts',
      ],
      [
        'packages/provider-github/src/issue.conformance.test.ts',
        'tests/contract/provider-github/issue.conformance.test.ts',
      ],
    ];
    expect(migrationInventory).toHaveLength(6);
    for (const [formerPath, contractPath] of migrationInventory) {
      expect(files.has(contractPath), contractPath).toBe(true);
      expect(classifyTestPath(contractPath), contractPath).toBe('contract');
      expect(files.has(formerPath), formerPath).toBe(false);
    }
  });

  test('preserves the fixed five-suite core unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const migrationInventory = [
      ['packages/core/src/envelope.test.ts', 'packages/core/test/unit/envelope.test.ts'],
      ['packages/core/src/errors.test.ts', 'packages/core/test/unit/errors.test.ts'],
      ['packages/core/src/json.test.ts', 'packages/core/test/unit/json.test.ts'],
      ['packages/core/src/paths.test.ts', 'packages/core/test/unit/paths.test.ts'],
      [
        'packages/core/src/skill-artifact.test.ts',
        'packages/core/test/unit/skill-artifact.test.ts',
      ],
    ];
    expect(migrationInventory).toHaveLength(5);
    for (const [formerPath, unitPath] of migrationInventory) {
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(classifyTestPath(unitPath), unitPath).toBe('unit');
    }

    const coreFiles = await filesBelow(root, 'packages/core');
    expect(
      coreFiles.filter(
        (file) =>
          file.startsWith('packages/core/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
  });

  test('preserves the fixed four-suite config unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const migrationInventory = [
      ['packages/config/src/config.test.ts', 'packages/config/test/unit/config.test.ts'],
      [
        'packages/config/src/launch-contracts.test.ts',
        'packages/config/test/unit/launch-contracts.test.ts',
      ],
      ['packages/config/src/preparation.test.ts', 'packages/config/test/unit/preparation.test.ts'],
      ['packages/config/src/resolve.test.ts', 'packages/config/test/unit/resolve.test.ts'],
    ];
    expect(migrationInventory).toHaveLength(4);
    for (const [formerPath, unitPath] of migrationInventory) {
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(classifyTestPath(unitPath), unitPath).toBe('unit');
    }

    const configFiles = await filesBelow(root, 'packages/config');
    expect(
      configFiles.filter(
        (file) =>
          file.startsWith('packages/config/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
  });

  test('keeps the fixed CLI E2E cohort exclusively under root ownership', async () => {
    const files = new Set(await filesBelow(root));
    const migrationInventory = [
      ['apps/cli/src/fake-pi-bridge.e2e.test.ts', 'tests/e2e/cli/fake-pi-bridge.e2e.test.ts'],
      [
        'apps/cli/src/preparation-worker.e2e.test.ts',
        'tests/e2e/cli/preparation-worker.e2e.test.ts',
      ],
    ];
    expect(migrationInventory).toHaveLength(2);
    for (const [formerPath, e2ePath] of migrationInventory) {
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(e2ePath), e2ePath).toBe(true);
      expect(matchingTestCategories(e2ePath), e2ePath).toEqual(['e2e']);
    }
  });

  test('keeps every E2E-classified test under the root E2E directory', async () => {
    const files = (await filesBelow(root)).filter((file) => /\.test\.(?:[cm]?[jt]sx?)$/.test(file));
    const e2eTests = files.filter((file) => classifyTestPath(file) === 'e2e');
    for (const file of e2eTests) {
      expect(file, file).toMatch(/^tests\/e2e\//u);
    }
  });

  test('keeps the fixed CLI integration cohort exclusively under root ownership', async () => {
    const files = new Set(await filesBelow(root));
    const migrationInventory = [
      [
        'apps/cli/src/migration.integration.test.ts',
        'tests/integration/cli/migration.integration.test.ts',
      ],
      [
        'apps/cli/src/phase-g-subprocess.integration.test.ts',
        'tests/integration/cli/phase-g-subprocess.integration.test.ts',
      ],
    ];
    expect(migrationInventory).toHaveLength(2);
    for (const [formerPath, integrationPath] of migrationInventory) {
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(integrationPath), integrationPath).toBe(true);
      expect(matchingTestCategories(integrationPath), integrationPath).toEqual(['integration']);
    }
  });

  test('keeps the fixed Windows and worktrees system integration cohort under root ownership', async () => {
    const files = new Set(await filesBelow(root));
    const migrationInventory = [
      [
        'packages/windows/src/adapter.integration.test.ts',
        'tests/integration/windows/adapter.integration.test.ts',
      ],
      [
        'packages/windows/src/native-resource-contract.integration.test.ts',
        'tests/integration/windows/native-resource-contract.integration.test.ts',
      ],
      [
        'packages/worktrees/src/lifecycle.integration.test.ts',
        'tests/integration/worktrees/lifecycle.integration.test.ts',
      ],
      [
        'packages/worktrees/src/preparation-persistence.integration.test.ts',
        'tests/integration/worktrees/preparation-persistence.integration.test.ts',
      ],
      [
        'packages/worktrees/src/worktree-include.integration.test.ts',
        'tests/integration/worktrees/worktree-include.integration.test.ts',
      ],
    ];
    expect(migrationInventory).toHaveLength(5);
    for (const [formerPath, integrationPath] of migrationInventory) {
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(integrationPath), integrationPath).toBe(true);
      expect(matchingTestCategories(integrationPath), integrationPath).toEqual(['integration']);
    }
    const fixtureInventory = [
      [
        'packages/windows/test/fixtures/owned-process-tree.mjs',
        'tests/integration/windows/fixtures/owned-process-tree.mjs',
      ],
      [
        'packages/worktrees/test-fixtures/lifecycle-worker.mjs',
        'tests/integration/worktrees/fixtures/lifecycle-worker.mjs',
      ],
      [
        'packages/worktrees/test-fixtures/preparation-persisted-worker.mjs',
        'tests/integration/worktrees/fixtures/preparation-persisted-worker.mjs',
      ],
    ];
    expect(fixtureInventory).toHaveLength(3);
    for (const [formerPath, fixturePath] of fixtureInventory) {
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(fixturePath), fixturePath).toBe(true);
    }
  });

  test('keeps root tests and fixtures on public package boundaries', async () => {
    const sourceFiles = (await filesBelow(root, 'tests')).filter((file) =>
      /\.(?:[cm]?[jt]sx?)$/u.test(file),
    );
    const privatePackageImport =
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"][^'"]*packages\/[^'"]+\/(?:dist|src)(?:\/[^'"]*)?['"]/u;
    const violations = [];
    for (const file of sourceFiles) {
      const source = await readFile(path.join(root, file), 'utf8');
      if (privatePackageImport.test(source)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  test('keeps every integration-classified test under the root integration directory', async () => {
    const files = (await filesBelow(root)).filter((file) => /\.test\.(?:[cm]?[jt]sx?)$/.test(file));
    const integrationTests = files.filter((file) => classifyTestPath(file) === 'integration');
    for (const file of integrationTests) {
      expect(file, file).toMatch(/^tests\/integration\//u);
    }
  });

  test('keeps every contract-classified test under the root contract directory', async () => {
    const files = (await filesBelow(root)).filter((file) => /\.test\.(?:[cm]?[jt]sx?)$/.test(file));
    const contractTests = files.filter((file) => classifyTestPath(file) === 'contract');
    for (const file of contractTests) {
      expect(file, file).toMatch(/^tests\/contract\//u);
    }
  });

  test('selects every current owned test exactly once using configured patterns', async () => {
    const files = (await filesBelow(root)).filter((file) => /\.test\.(?:[cm]?[jt]sx?)$/.test(file));
    for (const file of files) {
      expect(matchingTestCategories(file), file).toHaveLength(1);
    }
  });

  test('prunes dependency, output, generated, projection, and vendor trees before recursion', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'mpx-harness-'));
    try {
      await writeFile(path.join(fixture, 'visible.test.ts'), '');
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
      expect(await filesBelow(fixture)).toEqual(['visible.test.ts']);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test('excludes vendor and generated output tests', () => {
    expect(classifyTestPath('runtimes/pi/runtime-pi/vendor/tool/upstream.test.ts')).toBeUndefined();
    expect(classifyTestPath('packages/core/dist/value.test.js')).toBeUndefined();
    expect(classifyTestPath('node_modules/tool/index.test.js')).toBeUndefined();
    expect(classifyTestPath('packages/core/generated/value.test.ts')).toBeUndefined();
  });

  test('selects payload tests only as payload', () => {
    const payload = 'content/skills/video-to-image/__tests__/compose.test.ts';
    expect(classifyTestPath(payload)).toBe('payload');
    expect(TEST_CATEGORIES.filter((category) => classifyTestPath(payload) === category)).toEqual([
      'payload',
    ]);
  });
});

describe('configuration structure', () => {
  test('derives workspace roots from workspace patterns and package manifests', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'mpx-workspaces-'));
    try {
      await writeFile(path.join(fixture, 'pnpm-workspace.yaml'), 'packages:\n  - modules/*\n');
      await mkdir(path.join(fixture, 'modules', 'future'), { recursive: true });
      await writeFile(path.join(fixture, 'modules', 'future', 'package.json'), '{"name":"future"}');
      await mkdir(path.join(fixture, 'modules', 'not-a-workspace'), { recursive: true });
      expect(await discoverWorkspaceRoots(fixture)).toEqual(['modules/future']);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test('does not define partial source aliases in root or workspace configs', async () => {
    const configs = [
      ...Object.values(CATEGORY_CONFIGS),
      ...workspaceRoots.map((workspace) => `${workspace}/vitest.config.ts`),
    ];
    for (const config of configs) {
      expect(await readFile(path.join(root, config), 'utf8'), config).not.toMatch(/\balias\s*:/u);
    }
  });

  test('keeps root contract suites outside package unit config discovery', async () => {
    for (const workspace of workspaceRoots) {
      const config = await import(path.join(root, workspace, 'vitest.config.ts'));
      expect(config.default.test.include, workspace).toEqual([
        'src/**/*.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
        'test/**/*.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
      ]);
      expect(
        path.relative(path.join(root, workspace), path.join(root, 'tests', 'contract')),
      ).toMatch(/^\.\.[\\/]/u);
    }
  });

  test('bounds workers only for the aggregate root unit category', async () => {
    for (const category of TEST_CATEGORIES) {
      const config = await import(path.join(root, CATEGORY_CONFIGS[category]));
      expect(config.default.test.maxWorkers, category).toBe(category === 'unit' ? 4 : undefined);
    }
  });

  test('provides one thin root config for each category', async () => {
    expect(Object.keys(CATEGORY_CONFIGS).sort()).toEqual([...TEST_CATEGORIES].sort());
    for (const config of Object.values(CATEGORY_CONFIGS)) {
      expect(await readFile(path.join(root, config), 'utf8')).toContain('vitest.shared');
    }
  });

  test('gives every workspace unit config and production/test tsconfigs', async () => {
    for (const workspace of workspaceRoots) {
      const vitest = await readFile(path.join(root, workspace, 'vitest.config.ts'), 'utf8');
      expect(vitest, workspace).toContain('createWorkspaceUnitConfig');
      const production = await json(`${workspace}/tsconfig.json`);
      expect(production.include, workspace).toEqual(['src/**/*.ts']);
      expect(production.exclude, workspace).toContain('src/**/*.test.ts');
      const tests = await json(`${workspace}/tsconfig.test.json`);
      expect(tests.compilerOptions.noEmit, workspace).toBe(true);
      expect(tests.include, workspace).toEqual(['src/**/*.ts', 'test/**/*.ts']);
      expect(tests.exclude, workspace).toEqual([]);
    }
  });

  test('normalizes workspace scripts without recursive test duplication', async () => {
    for (const workspace of workspaceRoots) {
      const manifest = await json(`${workspace}/package.json`);
      expect(manifest.scripts['test:unit'], workspace).toBe(
        `pnpm --filter ${manifest.name}... build && vitest run`,
      );
      expect(manifest.scripts.test, workspace).toContain('test:unit');
      expect(manifest.scripts.typecheck, workspace).toContain('tsconfig.test.json');
      expect(manifest.scripts.check, workspace).not.toContain('vitest run');
    }
  });

  test('standalone workspace tests build the selected dependency closure before Vitest', async () => {
    for (const workspace of workspaceRoots) {
      const manifest = await json(`${workspace}/package.json`);
      expect(manifest.scripts['test:unit'], workspace).toMatch(
        new RegExp(
          `^pnpm --filter ${manifest.name.replaceAll('/', '\\/')}\\.\\.\\. build && vitest run$`,
        ),
      );
    }
  });

  test('keeps payload execution separate from root strict typechecking', async () => {
    const rootManifest = await json('package.json');
    expect(rootManifest.scripts['test:payload']).toBe(
      'vitest run --config vitest.payload.config.ts',
    );
    expect(rootManifest.scripts.typecheck).not.toContain('content/skills');
  });

  test('builds the public contract dependency closure before invoking contract Vitest', async () => {
    const rootManifest = await json('package.json');
    expect(rootManifest.scripts['test:contract']).toMatch(
      /^pnpm --filter @mpx\/provider-github\.\.\. --filter @mpx\/runtime-contracts\.\.\. build && vitest run --config vitest\.contract\.config\.ts$/u,
    );
  });

  test('builds the CLI dependency closure before invoking integration Vitest', async () => {
    const rootManifest = await json('package.json');
    expect(rootManifest.scripts['test:integration']).toBe(
      'pnpm --filter mpx... build && vitest run --config vitest.integration.config.ts',
    );
  });

  test('builds the bounded CLI dependency closure before invoking E2E Vitest', async () => {
    const rootManifest = await json('package.json');
    expect(rootManifest.scripts['test:e2e']).toBe(
      'pnpm --filter mpx... build && vitest run --config vitest.e2e.config.ts',
    );
  });

  test('root aggregate invokes every category exactly once', async () => {
    const manifest = await json('package.json');
    const invocations = manifest.scripts.test.split('&&').map((command) => command.trim());
    for (const category of TEST_CATEGORIES) {
      expect(manifest.scripts[`test:${category}`]).toBeDefined();
      expect(invocations.filter((command) => command === `pnpm run test:${category}`)).toHaveLength(
        1,
      );
    }
    expect(manifest.scripts.test).not.toContain('pnpm -r test');
  });
});
