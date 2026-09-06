import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

import { resolveCompactInstructionsFile } from '../../../compact-instructions.js';
import { devServerPortsFor, resolvePortsConfigPath } from '../../../footer.js';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(packageRoot, relativePath), 'utf8')) as Record<
    string,
    unknown
  >;
}

test('package manifest exposes only the static composition entry point', () => {
  const manifest = readJson('package.json');
  const pi = manifest.pi as { extensions?: unknown };
  const dependencies = manifest.dependencies as Record<string, string>;

  assert.equal(manifest.name, '@mpx/pi-extensions');
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.deepEqual(pi.extensions, ['./index.ts']);
  assert.deepEqual(dependencies, {
    '@mpx/content-compiler': 'workspace:*',
    '@mpx/runtime-contracts': 'workspace:*',
    croner: '10.0.1',
    nanoid: '5.1.16',
  });
});

const REQUIRED_THEME_COLORS = [
  'accent',
  'border',
  'borderAccent',
  'borderMuted',
  'success',
  'error',
  'warning',
  'muted',
  'dim',
  'text',
  'thinkingText',
  'scrollbarTrack',
  'scrollbarThumb',
  'selectedBg',
  'userMessageBg',
  'userMessageText',
  'customMessageBg',
  'customMessageText',
  'customMessageLabel',
  'toolPendingBg',
  'toolSuccessBg',
  'toolErrorBg',
  'toolTitle',
  'toolOutput',
  'mdHeading',
  'mdLink',
  'mdLinkUrl',
  'mdCode',
  'mdCodeBlock',
  'mdCodeBlockBorder',
  'mdQuote',
  'mdQuoteBorder',
  'mdHr',
  'mdListBullet',
  'toolDiffAdded',
  'toolDiffRemoved',
  'toolDiffContext',
  'syntaxComment',
  'syntaxKeyword',
  'syntaxFunction',
  'syntaxVariable',
  'syntaxString',
  'syntaxNumber',
  'syntaxType',
  'syntaxOperator',
  'syntaxPunctuation',
  'thinkingOff',
  'thinkingMinimal',
  'thinkingLow',
  'thinkingMedium',
  'thinkingHigh',
  'thinkingXhigh',
  'bashMode',
] as const;

test('package settings retain only portable runtime choices', () => {
  const settings = readJson('config/settings.json');
  const forbiddenKeys = [
    'defaultProvider',
    'defaultModel',
    'defaultThinkingLevel',
    'npmCommand',
    'extensions',
    'skills',
    'enabledModels',
    'lastChangelogVersion',
  ];

  for (const key of forbiddenKeys) {
    assert.equal(key in settings, false, key);
  }
  assert.equal(typeof settings.compaction, 'object');
  assert.equal(typeof settings.terminal, 'object');
  assert.equal(settings.enableSkillCommands, true);
  assert.equal(settings.defaultProjectTrust, 'ask');
  assert.ok(Array.isArray(settings.packages));
  assert.ok(
    (settings.packages as unknown[]).every(
      (entry) => typeof entry === 'string' && entry.startsWith('npm:'),
    ),
  );
});

test('portable paths resolve from validated environment values or package defaults', async () => {
  const cwd = resolve('workspace');
  const configuredCompactFile = resolve('runtime', 'COMPACT.md');
  const configuredPortsFile = resolve('runtime', 'ports.json');

  assert.equal(resolveCompactInstructionsFile(configuredCompactFile), configuredCompactFile);
  assert.equal(
    resolveCompactInstructionsFile('relative.md'),
    join(packageRoot, 'config', 'COMPACT.md'),
  );
  assert.equal(resolvePortsConfigPath(cwd, configuredPortsFile), configuredPortsFile);
  assert.equal(resolvePortsConfigPath(cwd, 'relative.json'), join(cwd, '.worktree-ports.json'));

  const directory = await mkdtemp(join(tmpdir(), 'pi-ports-'));
  const portsFile = join(directory, '.worktree-ports.json');
  try {
    await writeFile(
      portsFile,
      JSON.stringify({ services: { web: 5100, api: 5200, duplicate: 5100, invalid: 0 } }),
    );
    assert.deepEqual(devServerPortsFor(portsFile), [5100, 5200]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('NUL-containing absolute environment paths use safe package defaults', () => {
  const cwd = resolve('workspace');
  const unsafeCompactFile = `${resolve('environment', 'COMPACT.md')}\0ignored`;
  const unsafePortsFile = `${resolve('environment', 'ports.json')}\0ignored`;

  assert.equal(
    resolveCompactInstructionsFile(unsafeCompactFile),
    join(packageRoot, 'config', 'COMPACT.md'),
  );
  assert.equal(resolvePortsConfigPath(cwd, unsafePortsFile), join(cwd, '.worktree-ports.json'));
});

test('environment path overrides are used by default resolver arguments', () => {
  const previousCompactFile = process.env.MPX_COMPACT_INSTRUCTIONS_FILE;
  const previousPortsFile = process.env.MPX_WORKTREE_PORTS_FILE;
  const compactFile = resolve('environment', 'COMPACT.md');
  const portsFile = resolve('environment', 'ports.json');

  try {
    process.env.MPX_COMPACT_INSTRUCTIONS_FILE = compactFile;
    process.env.MPX_WORKTREE_PORTS_FILE = portsFile;

    assert.equal(resolveCompactInstructionsFile(), compactFile);
    assert.equal(resolvePortsConfigPath(resolve('workspace')), portsFile);
  } finally {
    if (previousCompactFile === undefined) {
      delete process.env.MPX_COMPACT_INSTRUCTIONS_FILE;
    } else {
      process.env.MPX_COMPACT_INSTRUCTIONS_FILE = previousCompactFile;
    }
    if (previousPortsFile === undefined) {
      delete process.env.MPX_WORKTREE_PORTS_FILE;
    } else {
      process.env.MPX_WORKTREE_PORTS_FILE = previousPortsFile;
    }
  }
});

test('keybindings and subagent settings are valid objects', () => {
  const keybindings = readJson('config/keybindings.json');
  const subagents = readJson('config/subagents.json');

  assert.ok(Object.keys(keybindings).length > 0);
  for (const value of Object.values(keybindings)) {
    assert.ok(
      typeof value === 'string' ||
        (Array.isArray(value) && value.every((key) => typeof key === 'string')),
    );
  }
  assert.equal(typeof subagents.fleetView, 'boolean');
});

test('amber and green themes define valid portable palettes', () => {
  for (const name of ['amber', 'green']) {
    const theme = readJson(`themes/${name}.json`);
    const variables = theme.vars as Record<string, unknown>;
    const colors = theme.colors as Record<string, unknown>;

    assert.equal(theme.name, name);
    assert.equal(typeof theme.$schema, 'string');
    for (const token of REQUIRED_THEME_COLORS) {
      assert.ok(token in colors, `${name}.${token}`);
    }
    for (const value of Object.values(colors)) {
      assert.ok(
        value === '' ||
          (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255) ||
          (typeof value === 'string' && (/^#[0-9a-f]{6}$/i.test(value) || value in variables)),
        `${name} has invalid color ${String(value)}`,
      );
    }
  }
});
