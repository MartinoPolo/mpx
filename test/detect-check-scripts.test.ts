import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const detector = path.resolve('content/instructions/shared/detect-check-scripts.mjs');
const fixtureDirectories: string[] = [];
after(async () => {
  for (const directory of fixtureDirectories) await rm(directory, { recursive: true, force: true });
});

type Detection = {
  fast_checks: { command: string; cwd: string }[];
  full_checks: { command: string; cwd: string }[];
  unresolved: string[];
};

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-check-discovery-'));
  fixtureDirectories.push(root);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

function detect(root: string, packageManager?: string, configFile?: string): Detection {
  const arguments_ = [detector, root];
  if (packageManager !== undefined) arguments_.push(packageManager);
  if (configFile !== undefined) arguments_.push(configFile);
  return JSON.parse(execFileSync(process.execPath, arguments_, { encoding: 'utf8' })) as Detection;
}

test('classifies direct checks and defers combined Yarn lint, build, and E2E', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({
      packageManager: 'yarn@4.9.2',
      scripts: {
        lint: 'yarn lint:types && yarn lint:eslint',
        'lint:types': 'tsc --noEmit',
        'lint:eslint': 'eslint .',
        format: 'prettier --write .',
        'format:check': 'prettier --check .',
        test: 'vitest run',
        'test:e2e': 'playwright test',
        build: 'custom-builder',
        'check:fallow': 'fallow audit --base origin/main',
      },
    }),
    'yarn.lock': '',
  });
  assert.deepEqual(detect(root), {
    fast_checks: [
      { command: 'yarn run format', cwd: '.' },
      { command: 'yarn run lint:types', cwd: '.' },
      { command: 'yarn run format:check', cwd: '.' },
      { command: 'yarn run test', cwd: '.' },
      { command: 'yarn run check:fallow', cwd: '.' },
    ],
    full_checks: [
      { command: 'yarn run lint', cwd: '.' },
      { command: 'yarn run lint:eslint', cwd: '.' },
      { command: 'yarn run test:e2e', cwd: '.' },
      { command: 'yarn run build', cwd: '.' },
    ],
    unresolved: [],
  });
});

test('orders writable formatting before read-only checks without suppressing format checks', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({
      packageManager: 'npm@11',
      scripts: {
        'format:check': 'prettier --check .',
        test: 'node --test',
        format: 'prettier --write .',
      },
    }),
  });
  assert.deepEqual(detect(root).fast_checks, [
    { command: 'npm run format', cwd: '.' },
    { command: 'npm run format:check', cwd: '.' },
    { command: 'npm run test', cwd: '.' },
  ]);
});

test('defers an exact combined lint command instead of marking it unresolved', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({
      packageManager: 'yarn@4',
      scripts: { lint: 'yarn lint:types && yarn lint:eslint' },
    }),
    'yarn.lock': '',
  });
  assert.deepEqual(detect(root), {
    fast_checks: [],
    full_checks: [{ command: 'yarn run lint', cwd: '.' }],
    unresolved: [],
  });
});

test('pnpm settings without packages do not imply unresolved workspace discovery', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({ packageManager: 'pnpm@11', scripts: { typecheck: 'tsc --noEmit' } }),
    'pnpm-workspace.yaml': "patchedDependencies:\n  example: patches/example.patch\n",
  });
  assert.deepEqual(detect(root), {
    fast_checks: [{ command: 'pnpm run typecheck', cwd: '.' }],
    full_checks: [],
    unresolved: [],
  });
});

test('discovers pnpm workspace globs and exclusions with exact relative cwd', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({ packageManager: 'pnpm@10', scripts: { typecheck: 'tsc --noEmit' } }),
    'pnpm-lock.yaml': '',
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - '!packages/ignored'\n",
    'packages/alpha/package.json': JSON.stringify({ scripts: { unit: 'vitest run' } }),
    'packages/ignored/package.json': JSON.stringify({ scripts: { unit: 'vitest run' } }),
  });
  assert.deepEqual(detect(root).fast_checks, [
    { command: 'pnpm run typecheck', cwd: '.' },
    { command: 'pnpm run unit', cwd: 'packages/alpha' },
  ]);
});

test('continues pnpm workspace discovery after blank and comment lines', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({ packageManager: 'pnpm@10' }),
    'pnpm-lock.yaml': '',
    'pnpm-workspace.yaml': "packages:\n  - 'packages/alpha'\n\n  # another package follows\n  - 'packages/beta'\n",
    'packages/alpha/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    'packages/beta/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
  });
  assert.deepEqual(detect(root).fast_checks, [
    { command: 'pnpm run test', cwd: 'packages/alpha' },
    { command: 'pnpm run test', cwd: 'packages/beta' },
  ]);
});

test('reports malformed package workspaces while retaining valid patterns', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({
      packageManager: 'npm@11',
      workspaces: [42, 'packages/valid'],
    }),
    'packages/valid/package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
  });
  const output = detect(root);
  assert.deepEqual(output.fast_checks, [{ command: 'npm run test', cwd: 'packages/valid' }]);
  assert.match(output.unresolved.join('\n'), /package\.json workspaces\[0\].*string/i);
});

test('reports malformed package workspace shapes', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({ packageManager: 'npm@11', workspaces: { packages: 'packages/*' } }),
  });
  assert.match(detect(root).unresolved.join('\n'), /package\.json workspaces.*array of strings/i);
});

test('rejects Windows drive-relative workspace patterns portably', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({ packageManager: 'npm@11', workspaces: ['D:packages'] }),
  });
  assert.match(detect(root).unresolved.join('\n'), /Unsafe workspace pattern: D:packages/);
});

test('retains package workspace patterns when pnpm workspace metadata is unreadable', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({ packageManager: 'npm@11', workspaces: ['packages/valid'] }),
    'packages/valid/package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
  });
  await mkdir(path.join(root, 'pnpm-workspace.yaml'));
  const output = detect(root);
  assert.deepEqual(output.fast_checks, [{ command: 'npm run test', cwd: 'packages/valid' }]);
  assert.match(output.unresolved.join('\n'), /pnpm-workspace\.yaml/i);
});

test('reports malformed JSON instead of treating it as absent', async () => {
  const root = await fixture({ 'package.json': '{broken', 'package-lock.json': '{}' });
  const output = detect(root);
  assert.deepEqual(output.fast_checks, []);
  assert.deepEqual(output.full_checks, []);
  assert.match(output.unresolved.join('\n'), /package\.json/i);
});

test('does not classify tool substrings, nested scripts, or development commands', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({
      packageManager: 'npm@11',
      scripts: {
        deploy: 'echo eslint',
        check: 'npm run dev',
        dev: 'vitest --watch',
        test: 'tsx --test test/*.ts',
        lint: 'eslint . --fix',
      },
    }),
  });
  assert.deepEqual(detect(root), {
    fast_checks: [{ command: 'npm run test', cwd: '.' }],
    full_checks: [],
    unresolved: [
      'Unsafe or unknown check script .:check',
      'Unsafe or unknown check script .:lint',
    ],
  });
});

test('recognizes explicit fast names and defers opaque known checks', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({
      packageManager: 'pnpm@10',
      scripts: {
        oxlint: 'oxlint .',
        fallow: 'fallow audit',
        'lint:oxlint': 'oxlint .',
        'test-unit': 'vitest run',
        'unit-test': 'node --test',
        'unit:test': 'tsx --test test/*.ts',
        prettier: 'prettier --write .',
        fmt: 'dprint fmt',
        'check:ci': 'pnpm run verify',
        typecheck: 'custom-type-wrapper',
        build: 'build-tool',
      },
    }),
    'pnpm-lock.yaml': '',
  });
  assert.deepEqual(detect(root), {
    fast_checks: [
      { command: 'pnpm run prettier', cwd: '.' },
      { command: 'pnpm run fmt', cwd: '.' },
      { command: 'pnpm run oxlint', cwd: '.' },
      { command: 'pnpm run fallow', cwd: '.' },
      { command: 'pnpm run lint:oxlint', cwd: '.' },
      { command: 'pnpm run test-unit', cwd: '.' },
      { command: 'pnpm run unit-test', cwd: '.' },
      { command: 'pnpm run unit:test', cwd: '.' },
    ],
    full_checks: [
      { command: 'pnpm run check:ci', cwd: '.' },
      { command: 'pnpm run typecheck', cwd: '.' },
      { command: 'pnpm run build', cwd: '.' },
    ],
    unresolved: [],
  });
});

test('loads authoritative checks before requiring package.json', async () => {
  const root = await fixture({});
  const configFile = path.join(root, 'local-checks.json');
  await writeFile(configFile, JSON.stringify({
    fast_checks: [{ command: 'cargo check', cwd: '.' }],
    full_checks: [],
  }));
  assert.deepEqual(detect(root, 'not-a-manager', configFile), {
    fast_checks: [{ command: 'cargo check', cwd: '.' }],
    full_checks: [],
    unresolved: [],
  });
});

test('authoritative arrays bypass package parsing and package-manager diagnostics', async () => {
  const root = await fixture({
    'package.json': '{broken',
    'pnpm-lock.yaml': '',
    'yarn.lock': '',
  });
  const configFile = path.join(root, 'local-checks.json');
  await writeFile(configFile, JSON.stringify({
    fast_checks: [{ command: 'cargo check', cwd: '.' }],
    full_checks: [{ command: 'cargo test', cwd: '.' }],
  }));
  assert.deepEqual(detect(root, 'not-a-manager', configFile), {
    fast_checks: [{ command: 'cargo check', cwd: '.' }],
    full_checks: [{ command: 'cargo test', cwd: '.' }],
    unresolved: [],
  });
});

test('reports a missing explicit configuration file', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({ packageManager: 'npm@11', scripts: { test: 'node --test' } }),
  });
  const output = detect(root, 'npm', path.join(root, 'missing.json'));
  assert.deepEqual(output.fast_checks, [{ command: 'npm run test', cwd: '.' }]);
  assert.match(output.unresolved.join('\n'), /No config JSON file found/);
});

test('uses configured package manager and validates CLI package manager', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    'mpxconfig.json': JSON.stringify({ packageManager: 'bun@1' }),
  });
  assert.deepEqual(detect(root).fast_checks, [{ command: 'bun run test', cwd: '.' }]);
  assert.match(detect(root, 'invalid').unresolved.join('\n'), /Unsupported CLI packageManager/);
});

test('reports contradictory package manager declarations without lockfiles', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({ packageManager: 'npm@11', scripts: { test: 'node --test' } }),
    'mpxconfig.json': JSON.stringify({ packageManager: 'yarn' }),
  });
  const configured = detect(root);
  assert.deepEqual(configured.fast_checks, [{ command: 'yarn run test', cwd: '.' }]);
  assert.match(configured.unresolved.join('\n'), /packageManager declarations.*config yarn.*package\.json npm/i);

  const commanded = detect(root, 'pnpm');
  assert.deepEqual(commanded.fast_checks, [{ command: 'pnpm run test', cwd: '.' }]);
  assert.match(commanded.unresolved.join('\n'), /packageManager declarations.*CLI pnpm.*config yarn.*package\.json npm/i);
});

test('rejects Windows drive-relative configured working directories portably', async () => {
  const root = await fixture({
    'mpxconfig.json': JSON.stringify({
      fast_checks: [{ command: 'pnpm test', cwd: 'D:checks' }],
      full_checks: [],
    }),
  });
  const output = detect(root);
  assert.deepEqual(output.fast_checks, []);
  assert.match(output.unresolved.join('\n'), /fast_checks\[0\] is invalid/);
});

test('reports unsafe workspace patterns after comment lines', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({ packageManager: 'pnpm@10' }),
    'pnpm-workspace.yaml': "packages:\n  # generated list\n  - '../outside'\n",
  });
  assert.match(detect(root).unresolved.join('\n'), /Unsafe workspace pattern: \.\.\/outside/);
});

test('suppresses direct self-alias cycles while preserving separate valid checks', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({
      packageManager: 'pnpm@11',
      scripts: { test: 'pnpm run test', typecheck: 'tsc --noEmit' },
    }),
  });
  assert.deepEqual(detect(root), {
    fast_checks: [{ command: 'pnpm run typecheck', cwd: '.' }],
    full_checks: [],
    unresolved: ['Cyclic check script .:test'],
  });
});

test('suppresses direct mutual alias cycles and aliases reaching them', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({
      packageManager: 'pnpm@11',
      scripts: {
        check: 'pnpm run lint',
        lint: 'pnpm run test',
        test: 'pnpm run lint',
        typecheck: 'tsc --noEmit',
      },
    }),
  });
  assert.deepEqual(detect(root), {
    fast_checks: [{ command: 'pnpm run typecheck', cwd: '.' }],
    full_checks: [],
    unresolved: [
      'Cyclic check script .:check',
      'Cyclic check script .:lint',
      'Cyclic check script .:test',
    ],
  });
});

test('explicit arrays override their category independently, including empty arrays', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({ packageManager: 'npm@11', scripts: { typecheck: 'tsc', build: 'custom-builder' } }),
    'mpxconfig.json': JSON.stringify({
      projectId: 'fixture',
      fast_checks: [],
      full_checks: [{ command: ' npm run release  ', cwd: 'tools' }],
    }),
  });
  assert.deepEqual(detect(root), {
    fast_checks: [],
    full_checks: [{ command: ' npm run release  ', cwd: 'tools' }],
    unresolved: [],
  });
});
