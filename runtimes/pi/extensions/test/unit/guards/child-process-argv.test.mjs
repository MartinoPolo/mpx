import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test, vi } from 'vitest';

import { formatAndLintFile } from '../../../guards/format-lint-file.mjs';
import { readStagedFileDiff, readStagedFiles } from '../../../guards/pre-commit-gate.mjs';

const maliciousFile = `quote' and spaces $() ; & payload.ts`;

test('formatter and linter receive malicious filenames as exact argv without a shell', () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'pi-format-argv-'));
  writeFileSync(path.join(projectRoot, '.prettierrc'), '{}');
  writeFileSync(path.join(projectRoot, 'eslint.config.js'), 'export default [];');
  const execute = vi.fn();

  formatAndLintFile(maliciousFile, projectRoot, {
    detectToolchain: () => 'classic',
    resolveProjectPackageBinary: (_root, _packageName, binaryName) =>
      path.join(projectRoot, `${binaryName}.mjs`),
    execFileSync: execute,
  });

  assert.equal(execute.mock.calls.length, 2);
  assert.deepEqual(execute.mock.calls[0].slice(0, 2), [
    process.execPath,
    [path.join(projectRoot, 'prettier.mjs'), '--write', maliciousFile],
  ]);
  assert.deepEqual(execute.mock.calls[1].slice(0, 2), [
    process.execPath,
    [path.join(projectRoot, 'eslint.mjs'), '--fix', maliciousFile],
  ]);
  for (const call of execute.mock.calls) assert.equal(call[2].shell, false);
});

test('native Biome receives malicious filenames as exact argv without a shell', () => {
  const execute = vi.fn();
  const biomeBinary = path.resolve('trusted-biome');

  formatAndLintFile(maliciousFile, path.resolve('project'), {
    detectToolchain: () => 'biome',
    resolveBiomeBinary: () => biomeBinary,
    execFileSync: execute,
  });

  assert.deepEqual(
    execute.mock.calls.map((call) => call.slice(0, 2)),
    [
      [biomeBinary, ['format', '--write', maliciousFile]],
      [biomeBinary, ['lint', '--fix', maliciousFile]],
    ],
  );
  for (const call of execute.mock.calls) assert.equal(call[2].shell, false);
});

test('staged malicious filenames are passed after git pathspec separator as exact argv', () => {
  const secondFile = `semi; ampersand& command$(touch owned).js`;
  const execute = vi.fn((_executable, args) => {
    if (args.includes('--name-only')) return `${maliciousFile}\0${secondFile}\0`;
    return 'diff';
  });
  const projectRoot = path.resolve('project');

  const stagedFiles = readStagedFiles(projectRoot, execute);
  for (const file of stagedFiles) readStagedFileDiff(projectRoot, file, execute);

  assert.deepEqual(stagedFiles, [maliciousFile, secondFile]);
  assert.deepEqual(
    execute.mock.calls.map((call) => call.slice(0, 2)),
    [
      ['git', ['diff', '--cached', '--name-only', '-z']],
      ['git', ['diff', '--cached', '--', maliciousFile]],
      ['git', ['diff', '--cached', '--', secondFile]],
    ],
  );
  for (const call of execute.mock.calls) assert.equal(call[2].shell, false);
});
