import path from 'node:path';
import { defineConfig, type UserConfig } from 'vitest/config';

export const TEST_CATEGORIES = ['unit', 'payload', 'contract', 'integration', 'e2e'] as const;
export type TestCategory = (typeof TEST_CATEGORIES)[number];

export const CATEGORY_CONFIGS: Readonly<Record<TestCategory, string>> = {
  unit: 'vitest.unit.config.ts',
  payload: 'vitest.payload.config.ts',
  contract: 'vitest.contract.config.ts',
  integration: 'vitest.integration.config.ts',
  e2e: 'vitest.e2e.config.ts',
};

export const EXCLUDED_TEST_PATHS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/vendor/**',
  '**/generated/**',
] as const;

export const ROOT_CONTRACT_LEGACY_INCLUDES = [
  'packages/runtime-contracts/test/**/*.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
  'packages/providers/src/{contracts,conformance}.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
  'packages/provider-github/src/issue.conformance.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
] as const;

export const CATEGORY_EXCLUDES: Readonly<Record<TestCategory, readonly string[]>> = {
  unit: ['**/*.integration.test.*', '**/*.e2e.test.*', ...ROOT_CONTRACT_LEGACY_INCLUDES],
  payload: [],
  contract: [],
  integration: [],
  e2e: [],
};

export const CATEGORY_INCLUDES: Readonly<Record<TestCategory, readonly string[]>> = {
  unit: [
    'tests/unit/**/*.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
    'apps/*/{src,test}/**/*.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
    'packages/*/{src,test}/**/*.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
    'runtimes/*/*/{src,test}/**/*.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
  ],
  payload: [
    'tests/payload/**/*.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
    'content/skills/**/{test,tests,__tests__}/**/*.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
  ],
  contract: [
    'tests/contract/**/*.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
    ...ROOT_CONTRACT_LEGACY_INCLUDES,
  ],
  integration: [
    'tests/integration/**/*.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
    'apps/*/{src,test}/**/*.integration.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
    'packages/*/{src,test}/**/*.integration.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
    'runtimes/*/*/{src,test}/**/*.integration.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
    'scripts/*.test.mjs',
  ],
  e2e: [
    'tests/e2e/**/*.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
    'apps/*/{src,test}/**/*.e2e.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
    'packages/*/{src,test}/**/*.e2e.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
    'runtimes/*/*/{src,test}/**/*.e2e.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
  ],
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

function rootOwnedContractExcludes(workspaceRoot: string): string[] {
  const relativeRoot = path.relative(import.meta.dirname, workspaceRoot).replaceAll('\\', '/');
  const prefix = `${relativeRoot}/`;
  return ROOT_CONTRACT_LEGACY_INCLUDES.filter((pattern) => pattern.startsWith(prefix)).map(
    (pattern) => pattern.slice(prefix.length),
  );
}

export function createWorkspaceUnitConfig(
  workspaceRoot: string,
  options: { testTimeout?: number; exclude?: readonly string[] } = {},
): UserConfig {
  return defineConfig({
    test: {
      environment: 'node',
      passWithNoTests: true,
      include: [
        'src/**/*.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
        'test/**/*.test.{ts,tsx,js,jsx,mts,mjs,cts,cjs}',
      ],
      exclude: [
        ...EXCLUDED_TEST_PATHS,
        '**/*.integration.test.*',
        '**/*.e2e.test.*',
        ...rootOwnedContractExcludes(workspaceRoot),
        ...(options.exclude ?? []),
      ],
      ...(options.testTimeout === undefined ? {} : { testTimeout: options.testTimeout }),
    },
  });
}
