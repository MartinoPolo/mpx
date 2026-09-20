import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { optionalConfigurationArray, parseConfigurationJson, upgradeStatusLine } from '../migration/cutover-transforms.js';
import { applyPreparedCutover } from '../migration/cutover-transaction.js';
import { apply, isAllowedProtectedTarget, prepare } from '../migration/protected-file-change.js';

test('cutover parses JSONC without changing string contents and validates optional arrays', () => {
  assert.deepEqual(parseConfigurationJson('\uFEFF{ // comment\n "url": "https://host/,}", /* block */ "list": [1,], }'), { url: 'https://host/,}', list: [1] });
  assert.throws(() => parseConfigurationJson('{/* unterminated'), /Unterminated/);
  assert.deepEqual(optionalConfigurationArray(undefined, 'actions'), []);
  assert.throws(() => optionalConfigurationArray({}, 'actions'), /Invalid actions/);
});

test('cutover accepts both exact historical account registrations and preserves custom commands', () => {
  const expected = { type: 'command', command: 'owned command' };
  for (const directory of ['.claude', '.claude-work']) {
    for (const script of ['status-line.mts', 'subagent-status-line.mts']) {
      assert.equal(upgradeStatusLine({ command: `node "$HOME/${directory}/scripts/${script}"`, type: 'command' }, expected, script), expected);
    }
  }
  assert.equal(upgradeStatusLine(expected, expected, 'status-line.mts'), expected);
  assert.throws(() => upgradeStatusLine({ type: 'command', command: 'custom' }, expected, 'status-line.mts'), /ownership/);
});

test('project configuration changes require an explicitly selected physical project root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mpx-target-safety-'));
  try {
    const target = path.join(root, 'mpxconfig.json');
    await writeFile(target, 'before');
    assert.equal(isAllowedProtectedTarget(target), false);
    assert.equal(isAllowedProtectedTarget(target, { home: root, documents: root, projectRoot: root }), true);
    assert.equal(isAllowedProtectedTarget(path.join(root, 'archive', 'mpxconfig.json'), { home: root, documents: root, projectRoot: root }), false);
    await assert.rejects(prepare({ target, backupRoot: path.join(root, 'backup'), transform: () => 'after' }), /explicitly allowed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed cutover compensates, stops later operations, and exposes recovery failure', async () => {
  const operations: string[] = [];
  await assert.rejects(applyPreparedCutover([
    async () => { operations.push('applied'); },
    async () => { throw new Error('injected failure'); },
    async () => { operations.push('unexpected'); },
  ], async () => { operations.push('recovered'); }), /injected failure/);
  assert.deepEqual(operations, ['applied', 'recovered']);
  await assert.rejects(applyPreparedCutover([async () => { throw new Error('apply'); }], async () => { throw new Error('recovery'); }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    return true;
  });
});

test('standalone cutover recovery restores applied files and an interrupted link, and can be repeated', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mpx-cutover-recovery-'));
  try {
    const target = path.join(root, 'mpxconfig.json');
    await writeFile(target, 'before');
    const plan = await prepare({ target, projectRoot: root, backupRoot: path.join(root, 'file-backup'), transform: () => 'after', protect: async () => {} });
    await apply(plan);
    const previousTarget = path.join(root, 'original.md');
    await writeFile(previousTarget, 'original');
    const link = path.join(root, 'instructions.md');
    const retained = path.join(root, 'retained-link');
    await symlink(previousTarget, retained, 'file');
    for (const name of ['final-cutover-recovery.mjs', 'final-links-recovery.mjs']) await copyFile(path.resolve('migration', name), path.join(root, name));
    await writeFile(path.join(root, 'cutover-record.json'), JSON.stringify({ files: [{ planPath: plan.planPath }], links: [{ target: link, retained, previousTarget, replacement: path.join(root, 'replacement.md'), state: 'applying' }] }));
    for (const args of [[], ['--apply'], ['--apply']]) {
      const result = spawnSync(process.execPath, [path.join(root, 'final-cutover-recovery.mjs'), ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(target, 'utf8'), args.length ? 'before' : 'after');
    }
    assert.equal(await readlink(link), previousTarget);
    assert.equal((await lstat(link)).isSymbolicLink(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
