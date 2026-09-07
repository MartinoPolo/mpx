import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfig } from 'vitest/config';

const TEST_TEMP_SETUP = fileURLToPath(new URL('./scripts/test-temp.mjs', import.meta.url));

export const TEST_CATEGORIES = ['unit', 'payload', 'contract', 'integration', 'e2e'] as const;
export type TestCategory = (typeof TEST_CATEGORIES)[number];

export const CATEGORY_CONFIGS: Readonly<Record<TestCategory, string>> = {
  unit: 'vitest.unit.config.ts',
  payload: 'vitest.payload.config.ts',
  contract: 'vitest.contract.config.ts',
  integration: 'vitest.integration.config.ts',
  e2e: 'vitest.e2e.config.ts',
};

const EXCLUDED_TEST_PATHS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/vendor/**',
  '**/generated/**',
] as const;

const CATEGORY_EXCLUDES: Readonly<Record<TestCategory, readonly string[]>> = {
  unit: ['**/*.integration.{test,spec}.*', '**/*.e2e.{test,spec}.*'],
  payload: [],
  contract: [],
  integration: [],
  e2e: [],
};

const CATEGORY_INCLUDES: Readonly<Record<TestCategory, readonly string[]>> = {
  unit: [
    'apps/*/test/unit/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
    'packages/*/test/unit/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
    'runtimes/*/*/test/unit/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
  ],
  payload: [
    'tests/payload/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
    'content/skills/**/{test,tests,__tests__}/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
  ],
  contract: ['tests/contract/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs,cts,cjs}'],
  integration: ['tests/integration/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs,cts,cjs}'],
  e2e: ['tests/e2e/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs,cts,cjs}'],
};

type CategoryIncludes = Readonly<Record<TestCategory, readonly string[]>>;

function matchesAny(candidate: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => path.matchesGlob(candidate, pattern));
}

/** Returns every Vitest category whose actual include/exclude definitions select a path. */
export function matchingTestCategories(
  candidate: string,
  includes: CategoryIncludes = CATEGORY_INCLUDES,
): TestCategory[] {
  const normalized = candidate.replaceAll('\\', '/').replace(/^\.\//, '');
  return TEST_CATEGORIES.filter(
    (category) =>
      matchesAny(normalized, includes[category]) &&
      !matchesAny(normalized, [...EXCLUDED_TEST_PATHS, ...CATEGORY_EXCLUDES[category]]),
  );
}

/** Classifies only paths selected by exactly one category, failing closed otherwise. */
export function classifyTestPath(
  candidate: string,
  includes: CategoryIncludes = CATEGORY_INCLUDES,
): TestCategory | undefined {
  const categories = matchingTestCategories(candidate, includes);
  return categories.length === 1 ? categories[0] : undefined;
}

function categoryConfig(category: TestCategory, maxWorkers?: number): UserConfig {
  return {
    test: {
      environment: 'node',
      globalSetup: TEST_TEMP_SETUP,
      testTimeout: 30_000,
      hookTimeout: 30_000,
      include: [...CATEGORY_INCLUDES[category]],
      exclude: [...EXCLUDED_TEST_PATHS, ...CATEGORY_EXCLUDES[category]],
      ...(maxWorkers === undefined ? {} : { maxWorkers }),
    },
  };
}

export function createCategoryConfig(category: TestCategory, maxWorkers?: number): UserConfig {
  return defineConfig(categoryConfig(category, maxWorkers));
}

export function createWorkspaceUnitConfig(
  _workspaceRoot: string,
  options: { testTimeout?: number; exclude?: readonly string[] } = {},
): UserConfig {
  return defineConfig({
    test: {
      environment: 'node',
      globalSetup: TEST_TEMP_SETUP,
      passWithNoTests: true,
      include: ['test/unit/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs,cts,cjs}'],
      exclude: [
        ...EXCLUDED_TEST_PATHS,
        '**/*.integration.{test,spec}.*',
        '**/*.e2e.{test,spec}.*',
        ...(options.exclude ?? []),
      ],
      ...(options.testTimeout === undefined ? {} : { testTimeout: options.testTimeout }),
    },
  });
}
