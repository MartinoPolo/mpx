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
  test('lists files in deterministic path order', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'mpx-files-below-'));
    try {
      await mkdir(path.join(fixture, 'middle'));
      await Promise.all([
        writeFile(path.join(fixture, 'z-last.ts'), ''),
        writeFile(path.join(fixture, 'a-first.ts'), ''),
        writeFile(path.join(fixture, 'middle', 'z-nested.ts'), ''),
        writeFile(path.join(fixture, 'middle', 'a-nested.ts'), ''),
      ]);

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

  test('preserves the fixed fifteen-suite skills unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const basenames = [
      'artifact-integrity.test.ts',
      'batch-c3-content.test.ts',
      'canonical-content.test.ts',
      'content-batch-c4.test.ts',
      'content-batch-c5.test.ts',
      'content-batch-c6.test.ts',
      'directory-inventory.test.ts',
      'four-state-v4.test.ts',
      'instruction-content.test.ts',
      'launch-contracts.test.ts',
      'project-inventory-errors.test.ts',
      'project-inventory-limits.test.ts',
      'project-policy-binding.test.ts',
      'runtime-manifest-v4.test.ts',
      'skills.test.ts',
    ];
    expect(basenames).toHaveLength(15);
    for (const basename of basenames) {
      const formerPath = `packages/skills/test/${basename}`;
      const unitPath = `packages/skills/test/unit/${basename}`;
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(classifyTestPath(unitPath), unitPath).toBe('unit');
    }

    const skillsFiles = await filesBelow(root, 'packages/skills');
    expect(
      skillsFiles.filter(
        (file) =>
          file.startsWith('packages/skills/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
    expect(skillsFiles.filter((file) => file.includes('/fixtures/'))).toEqual([
      'packages/skills/test/fixtures/batch-c3-semantic.json',
      'packages/skills/test/fixtures/catalog/review/SKILL.md',
      'packages/skills/test/fixtures/content-batch-c4/harvest-cases.json',
      'packages/skills/test/fixtures/content-batch-c4/recovery-cases.json',
      'packages/skills/test/fixtures/content-batch-c5/provider-cases.json',
    ]);
  });

  test('preserves the fixed one-suite launch unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const migrationInventory = [
      ['packages/launch/src/launch.test.ts', 'packages/launch/test/unit/launch.test.ts'],
    ];
    expect(migrationInventory).toHaveLength(1);
    for (const [formerPath, unitPath] of migrationInventory) {
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(classifyTestPath(unitPath), unitPath).toBe('unit');
    }

    const launchFiles = await filesBelow(root, 'packages/launch');
    expect(
      launchFiles.filter(
        (file) =>
          file.startsWith('packages/launch/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
  });

  test('preserves the fixed three-suite providers unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const migrationInventory = [
      ['packages/providers/src/index.test.ts', 'packages/providers/test/unit/index.test.ts'],
      ['packages/providers/src/process.test.ts', 'packages/providers/test/unit/process.test.ts'],
      ['packages/providers/src/service.test.ts', 'packages/providers/test/unit/service.test.ts'],
    ];
    expect(migrationInventory).toHaveLength(3);
    for (const [formerPath, unitPath] of migrationInventory) {
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(matchingTestCategories(unitPath), unitPath).toEqual(['unit']);
    }

    const providersFiles = await filesBelow(root, 'packages/providers');
    expect(
      providersFiles.filter(
        (file) =>
          file.startsWith('packages/providers/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
  });

  test('preserves the fixed six-suite and three-fixture ports unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const suiteBasenames = [
      'adapters.test.ts',
      'arithmetic.test.ts',
      'lifecycle.test.ts',
      'registry.test.ts',
      'service-concurrency.test.ts',
      'service.test.ts',
    ];
    const fixtureBasenames = ['ensure-worker.mjs', 'registry-worker.mjs', 'release-worker.mjs'];

    expect(suiteBasenames).toHaveLength(6);
    for (const basename of suiteBasenames) {
      const formerPath = `packages/ports/src/${basename}`;
      const unitPath = `packages/ports/test/unit/${basename}`;
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(matchingTestCategories(unitPath), unitPath).toEqual(['unit']);
    }

    expect(fixtureBasenames).toHaveLength(3);
    for (const basename of fixtureBasenames) {
      const formerPath = `packages/ports/test-fixtures/${basename}`;
      const fixturePath = `packages/ports/test/fixtures/${basename}`;
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(fixturePath), fixturePath).toBe(true);
    }

    const portsFiles = await filesBelow(root, 'packages/ports');
    expect(
      portsFiles.filter(
        (file) =>
          file.startsWith('packages/ports/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
    expect(portsFiles.filter((file) => file.includes('/fixtures/'))).toEqual(
      fixtureBasenames.map((basename) => `packages/ports/test/fixtures/${basename}`),
    );
  });

  test('preserves the fixed three-suite and one-fixture sessions unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const suiteBasenames = ['account-attestation.test.ts', 'branch.test.ts', 'sessions.test.ts'];
    const fixtureBasenames = ['branch-lease-worker.mjs'];

    expect(suiteBasenames).toHaveLength(3);
    for (const basename of suiteBasenames) {
      const formerPath = `packages/sessions/src/${basename}`;
      const unitPath = `packages/sessions/test/unit/${basename}`;
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(matchingTestCategories(unitPath), unitPath).toEqual(['unit']);
    }

    expect(fixtureBasenames).toHaveLength(1);
    for (const basename of fixtureBasenames) {
      const formerPath = `packages/sessions/test-fixtures/${basename}`;
      const fixturePath = `packages/sessions/test/fixtures/${basename}`;
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(fixturePath), fixturePath).toBe(true);
    }

    const sessionsFiles = await filesBelow(root, 'packages/sessions');
    expect(
      sessionsFiles.filter(
        (file) =>
          file.startsWith('packages/sessions/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
    expect(sessionsFiles.filter((file) => file.includes('/fixtures/'))).toEqual(
      fixtureBasenames.map((basename) => `packages/sessions/test/fixtures/${basename}`),
    );
  });

  test('preserves the fixed seven-suite and four-fixture worktrees unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const suiteBasenames = [
      'index.test.ts',
      'lifecycle.test.ts',
      'node-lifecycle-adapters.test.ts',
      'node-preparation-adapters.test.ts',
      'preparation-engine.test.ts',
      'trusted-executable.test.ts',
      'worktree-include.test.ts',
    ];
    const fixtureBasenames = [
      'activating-inert-worker.mjs',
      'delayed-inert-worker.mjs',
      'lock-crash-worker.mjs',
      'preparation-cas-worker.mjs',
    ];

    expect(suiteBasenames).toHaveLength(7);
    for (const basename of suiteBasenames) {
      const formerPath = `packages/worktrees/src/${basename}`;
      const unitPath = `packages/worktrees/test/unit/${basename}`;
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(matchingTestCategories(unitPath), unitPath).toEqual(['unit']);
    }

    expect(fixtureBasenames).toHaveLength(4);
    for (const basename of fixtureBasenames) {
      const formerPath = `packages/worktrees/test-fixtures/${basename}`;
      const fixturePath = `packages/worktrees/test/fixtures/${basename}`;
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(fixturePath), fixturePath).toBe(true);
    }

    const worktreesFiles = await filesBelow(root, 'packages/worktrees');
    expect(
      worktreesFiles.filter(
        (file) =>
          file.startsWith('packages/worktrees/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
    expect(worktreesFiles.filter((file) => file.includes('/fixtures/'))).toEqual(
      fixtureBasenames.map((basename) => `packages/worktrees/test/fixtures/${basename}`),
    );
  });

  test('preserves the fixed two-suite dev-services unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const migrationInventory = [
      [
        'packages/dev-services/src/dev-services.test.ts',
        'packages/dev-services/test/unit/dev-services.test.ts',
      ],
      [
        'packages/dev-services/src/docker-runtime.test.ts',
        'packages/dev-services/test/unit/docker-runtime.test.ts',
      ],
    ];

    expect(migrationInventory).toHaveLength(2);
    for (const [formerPath, unitPath] of migrationInventory) {
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(matchingTestCategories(unitPath), unitPath).toEqual(['unit']);
    }

    const devServicesFiles = await filesBelow(root, 'packages/dev-services');
    expect(
      devServicesFiles.filter(
        (file) =>
          file.startsWith('packages/dev-services/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
  });

  test('preserves the fixed fourteen-suite installer unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const basenames = [
      'composition.test.ts',
      'external-integrations.test.ts',
      'immutable-core.test.ts',
      'install-intent-builder.test.ts',
      'installed-runner-authority.test.ts',
      'orchestration.test.ts',
      'production-operation.test.ts',
      'production-simulation.test.ts',
      'runtime-registration.test.ts',
      'selector-operation.test.ts',
      'service.test.ts',
      'transaction-lock.test.ts',
      'transaction.test.ts',
      'windows-integration.test.ts',
    ];

    expect(basenames).toHaveLength(14);
    for (const basename of basenames) {
      const formerPath = `packages/installer/src/${basename}`;
      const unitPath = `packages/installer/test/unit/${basename}`;
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(matchingTestCategories(unitPath), unitPath).toEqual(['unit']);
    }

    const installerFiles = await filesBelow(root, 'packages/installer');
    expect(
      installerFiles.filter(
        (file) =>
          file.startsWith('packages/installer/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
  });

  test('preserves the fixed four-suite Windows unit migration inventory and fixture', async () => {
    const files = new Set(await filesBelow(root));
    const suiteBasenames = [
      'adapter.test.ts',
      'production-resource.test.ts',
      'scheduled-task.test.ts',
      'system-integration.test.ts',
    ];

    expect(suiteBasenames).toHaveLength(4);
    for (const basename of suiteBasenames) {
      const formerPath = `packages/windows/src/${basename}`;
      const unitPath = `packages/windows/test/unit/${basename}`;
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(matchingTestCategories(unitPath), unitPath).toEqual(['unit']);
    }

    const windowsFiles = await filesBelow(root, 'packages/windows');
    expect(
      windowsFiles.filter(
        (file) =>
          file.startsWith('packages/windows/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
    expect(windowsFiles.filter((file) => file.includes('/fixtures/'))).toEqual([
      'packages/windows/test/fixtures/powershell-scheduled-task.json',
    ]);
  });

  test('preserves the fixed two-suite provider-github unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const migrationInventory = [
      [
        'packages/provider-github/src/index.test.ts',
        'packages/provider-github/test/unit/index.test.ts',
      ],
      [
        'packages/provider-github/src/repository.test.ts',
        'packages/provider-github/test/unit/repository.test.ts',
      ],
    ];
    expect(migrationInventory).toHaveLength(2);
    for (const [formerPath, unitPath] of migrationInventory) {
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(matchingTestCategories(unitPath), unitPath).toEqual(['unit']);
    }

    const providerGitHubFiles = await filesBelow(root, 'packages/provider-github');
    expect(
      providerGitHubFiles.filter(
        (file) =>
          file.startsWith('packages/provider-github/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
  });

  test('preserves the fixed one-suite provider-gitlab unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const migrationInventory = [
      [
        'packages/provider-gitlab/src/index.test.ts',
        'packages/provider-gitlab/test/unit/index.test.ts',
      ],
    ];
    expect(migrationInventory).toHaveLength(1);
    for (const [formerPath, unitPath] of migrationInventory) {
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(matchingTestCategories(unitPath), unitPath).toEqual(['unit']);
    }

    const providerGitLabFiles = await filesBelow(root, 'packages/provider-gitlab');
    expect(
      providerGitLabFiles.filter(
        (file) =>
          file.startsWith('packages/provider-gitlab/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
  });

  test('preserves the fixed one-suite provider-kanbanflow unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const migrationInventory = [
      [
        'packages/provider-kanbanflow/src/index.test.ts',
        'packages/provider-kanbanflow/test/unit/index.test.ts',
      ],
    ];
    expect(migrationInventory).toHaveLength(1);
    for (const [formerPath, unitPath] of migrationInventory) {
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(matchingTestCategories(unitPath), unitPath).toEqual(['unit']);
    }

    const providerKanbanFlowFiles = await filesBelow(root, 'packages/provider-kanbanflow');
    expect(
      providerKanbanFlowFiles.filter(
        (file) =>
          file.startsWith('packages/provider-kanbanflow/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
  });

  test('preserves the fixed provider-local test and fixture migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const migrationInventory = [
      [
        'packages/provider-local/src/index.test.ts',
        'packages/provider-local/test/unit/index.test.ts',
      ],
      [
        'packages/provider-local/src/lock-process-fixture.mjs',
        'packages/provider-local/test/fixtures/lock-process-fixture.mjs',
      ],
    ];
    expect(migrationInventory).toHaveLength(2);
    for (const [formerPath, targetPath] of migrationInventory) {
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(targetPath), targetPath).toBe(true);
    }
    expect(matchingTestCategories(migrationInventory[0][1]), migrationInventory[0][1]).toEqual([
      'unit',
    ]);

    const providerLocalFiles = await filesBelow(root, 'packages/provider-local');
    expect(
      providerLocalFiles.filter(
        (file) =>
          file.startsWith('packages/provider-local/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
    expect(providerLocalFiles.filter((file) => file.includes('/fixtures/'))).toEqual([
      'packages/provider-local/test/fixtures/lock-process-fixture.mjs',
    ]);
  });

  test('preserves the fixed one-suite runtime-hooks unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const migrationInventory = [
      [
        'packages/runtime-hooks/src/index.test.ts',
        'packages/runtime-hooks/test/unit/index.test.ts',
      ],
    ];
    expect(migrationInventory).toHaveLength(1);
    for (const [formerPath, unitPath] of migrationInventory) {
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(matchingTestCategories(unitPath), unitPath).toEqual(['unit']);
    }

    const runtimeHooksFiles = await filesBelow(root, 'packages/runtime-hooks');
    expect(
      runtimeHooksFiles.filter(
        (file) =>
          file.startsWith('packages/runtime-hooks/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
  });

  test('preserves the fixed two-suite runtime-tools unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const migrationInventory = [
      [
        'packages/runtime-tools/test/runtime-tools.test.ts',
        'packages/runtime-tools/test/unit/runtime-tools.test.ts',
      ],
      [
        'packages/runtime-tools/test/runtime-tool-inventory.test.ts',
        'packages/runtime-tools/test/unit/runtime-tool-inventory.test.ts',
      ],
    ];
    expect(migrationInventory).toHaveLength(2);
    for (const [formerPath, unitPath] of migrationInventory) {
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(matchingTestCategories(unitPath), unitPath).toEqual(['unit']);
    }

    const runtimeToolsFiles = await filesBelow(root, 'packages/runtime-tools');
    expect(
      runtimeToolsFiles.filter(
        (file) =>
          file.startsWith('packages/runtime-tools/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
    expect(runtimeToolsFiles.filter((file) => file.includes('/fixtures/'))).toEqual([]);
  });

  test('preserves the fixed status test and fixture migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const testBasenames = [
      'render.test.ts',
      'runtime.test.ts',
      'segment.test.ts',
      'snapshot.test.ts',
      'status.test.ts',
    ];
    const fixtureBasenames = [
      'external-conflict.json',
      'external-conflict.txt',
      'fixed-shared.json',
      'fixed-shared.txt',
      'invalid.json',
      'invalid.txt',
      'missing.json',
      'missing.txt',
      'runtime-claude-personal.json',
      'runtime-claude-work.json',
      'runtime-pi-personal.json',
      'runtime-pi-work.json',
      'stale.json',
      'stale.txt',
      'unknown-listener.json',
      'unknown-listener.txt',
      'valid.json',
      'valid.txt',
    ];
    expect(testBasenames).toHaveLength(5);
    expect(fixtureBasenames).toHaveLength(18);
    for (const basename of testBasenames) {
      const formerPath = `packages/status/src/${basename}`;
      const unitPath = `packages/status/test/unit/${basename}`;
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(matchingTestCategories(unitPath), unitPath).toEqual(['unit']);
    }
    for (const basename of fixtureBasenames) {
      const formerPath = `packages/status/fixtures/${basename}`;
      const fixturePath = `packages/status/test/fixtures/${basename}`;
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(fixturePath), fixturePath).toBe(true);
    }

    const statusFiles = await filesBelow(root, 'packages/status');
    expect(
      statusFiles.filter(
        (file) =>
          file.startsWith('packages/status/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
    expect(statusFiles.filter((file) => file.includes('/fixtures/'))).toEqual(
      fixtureBasenames.map((basename) => `packages/status/test/fixtures/${basename}`),
    );
  });

  test('preserves the fixed four-suite subagents unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const basenames = [
      'authority.test.ts',
      'isolation.test.ts',
      'lifecycle.test.ts',
      'state.test.ts',
    ];
    expect(basenames).toHaveLength(4);
    for (const basename of basenames) {
      const formerPath = `packages/subagents/src/${basename}`;
      const unitPath = `packages/subagents/test/unit/${basename}`;
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(matchingTestCategories(unitPath), unitPath).toEqual(['unit']);
    }

    const subagentsFiles = await filesBelow(root, 'packages/subagents');
    expect(
      subagentsFiles.filter(
        (file) =>
          file.startsWith('packages/subagents/src/') &&
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

  test('preserves the fixed seven-suite executors unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const basenames = [
      'execution.test.ts',
      'f2.test.ts',
      'launch-private-bridge.test.ts',
      'production-remote.test.ts',
      'sandbox-resume.test.ts',
      'sbx-client.test.ts',
      'standalone-sbx-executor.test.ts',
    ];
    expect(basenames).toHaveLength(7);
    for (const basename of basenames) {
      const formerPath = `packages/executors/src/${basename}`;
      const unitPath = `packages/executors/test/unit/${basename}`;
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(matchingTestCategories(unitPath), unitPath).toEqual(['unit']);
    }

    const executorFiles = await filesBelow(root, 'packages/executors');
    expect(
      executorFiles.filter(
        (file) =>
          file.startsWith('packages/executors/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
  });

  test('preserves the fixed three-suite Claude runtime unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const basenames = ['activation.test.ts', 'index.test.ts', 'runtime-tools.test.ts'];
    expect(basenames).toHaveLength(3);
    for (const basename of basenames) {
      const formerPath = `runtimes/claude/runtime-claude/src/${basename}`;
      const unitPath = `runtimes/claude/runtime-claude/test/unit/${basename}`;
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(matchingTestCategories(unitPath), unitPath).toEqual(['unit']);
    }

    const claudeRuntimeFiles = await filesBelow(root, 'runtimes/claude/runtime-claude');
    expect(
      claudeRuntimeFiles.filter(
        (file) =>
          file.startsWith('runtimes/claude/runtime-claude/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
  });

  test('preserves the fixed twenty-one-suite and fixture Pi runtime unit migration inventory', async () => {
    const files = new Set(await filesBelow(root));
    const basenames = [
      'adapter.test.ts',
      'dev-services.test.ts',
      'event-coordination.test.ts',
      'footer.test.ts',
      'generator.test.ts',
      'hooks-wiring.test.ts',
      'invocation.test.ts',
      'keybindings-profile.test.ts',
      'launch-private-client.test.ts',
      'production-projection.test.ts',
      'production-runtime.test.ts',
      'profile.test.ts',
      'projection-bundles.test.ts',
      'projection.test.ts',
      'runtime-capabilities.test.ts',
      'runtime-status.test.ts',
      'runtime-tools.test.ts',
      'sandbox-executor.test.ts',
      'sandbox-subagents.test.ts',
      'subagent-bridge.test.ts',
      'subagents-vendor.test.ts',
    ];
    expect(basenames).toHaveLength(21);
    for (const basename of basenames) {
      const formerPath = `runtimes/pi/runtime-pi/test/${basename}`;
      const unitPath = `runtimes/pi/runtime-pi/test/unit/${basename}`;
      expect(files.has(formerPath), formerPath).toBe(false);
      expect(files.has(unitPath), unitPath).toBe(true);
      expect(matchingTestCategories(unitPath), unitPath).toEqual(['unit']);
    }

    expect(files.has('runtimes/pi/runtime-pi/test/fixture.ts')).toBe(false);
    expect(files.has('runtimes/pi/runtime-pi/test/fixtures/fixture.ts')).toBe(true);

    const piRuntimeFiles = await filesBelow(root, 'runtimes/pi/runtime-pi');
    expect(
      piRuntimeFiles.filter(
        (file) =>
          file.startsWith('runtimes/pi/runtime-pi/src/') &&
          (file
            .split('/')
            .some((segment) =>
              ['fixture', 'fixtures', '__fixtures__', 'test-fixtures'].includes(segment),
            ) ||
            /\.test\.[cm]?[jt]sx?$/u.test(file)),
      ),
    ).toEqual([]);
    expect(
      piRuntimeFiles.filter((file) =>
        /^runtimes\/pi\/runtime-pi\/test\/[^/]+\.test\.[cm]?[jt]sx?$/u.test(file),
      ),
    ).toEqual([]);

    const vendorTests = [
      'runtimes/pi/runtime-pi/vendor/subagents/group-join.test.ts',
      'runtimes/pi/runtime-pi/vendor/subagents/invocation-config.test.ts',
      'runtimes/pi/runtime-pi/vendor/subagents/notification-gate.test.ts',
    ];
    for (const vendorTest of vendorTests) {
      expect(await readFile(path.join(root, vendorTest), 'utf8'), vendorTest).toBeTruthy();
      expect(matchingTestCategories(vendorTest), vendorTest).toEqual([]);
    }
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
