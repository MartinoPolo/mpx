import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test, { after } from 'node:test';
import { apply, isAllowedProtectedTarget, prepare as prepareProtected, type PrepareProtectedFileChangeOptions } from '../migration/protected-file-change.js';
const prepare = (options: PrepareProtectedFileChangeOptions) => prepareProtected({ ...options, projectRoot: path.dirname(options.target) });
const exec = promisify(execFile);
const protect = async () => {};
const temporaryRoots: string[] = [];
after(async () => { for (const directory of temporaryRoots) await rm(directory, { recursive: true, force: true }); });
async function fixture(name = 'mpxconfig.json', content = 'old\r\n') { const root = await mkdtemp(path.join(os.tmpdir(), 'mpx-protected-')); temporaryRoots.push(root); const target = path.join(root, name); await writeFile(target, content); return { root, target, backup: path.join(root, 'backup') }; }

test('round trip preserves requested newline bytes and standalone recovery is preview-first', async () => {
  const f = await fixture(); const plan = await prepare({ target: f.target, backupRoot: f.backup, transform: () => 'new\r\n', protect }); await apply(plan);
  assert.equal(await readFile(f.target, 'utf8'), 'new\r\n');
  const preview = await exec(process.execPath, [plan.recoveryPath]); assert.match(preview.stdout, /preview/); assert.equal(await readFile(f.target, 'utf8'), 'new\r\n');
  const retainedAttempt = `${f.target}.mpx-recovery-${plan.id}`;
  await writeFile(retainedAttempt, 'retained failed attempt');
  await exec(process.execPath, [plan.recoveryPath, plan.planPath.replaceAll('\\', '/'), '--apply']); assert.equal(await readFile(f.target, 'utf8'), 'old\r\n');
  assert.equal(await readFile(retainedAttempt, 'utf8'), 'retained failed attempt');
  assert.match((await exec(process.execPath, [plan.recoveryPath])).stdout, /already restored/);
});

test('real Windows protection covers both directory and file candidates', { skip: process.platform !== 'win32' }, async () => {
  const fixtureState = await fixture();
  const plan = await prepare({ target: fixtureState.target, backupRoot: fixtureState.backup, transform: () => 'new\n' });
  await apply(plan);
  assert.equal(await readFile(fixtureState.target, 'utf8'), 'new\n');
  await exec(process.execPath, [plan.recoveryPath, '--apply']);
  assert.equal(await readFile(fixtureState.target, 'utf8'), 'old\r\n');
});

test('allows only exact native settings and profile paths', () => {
  const root = path.resolve(os.tmpdir(), 'mpx-policy-root');
  const roots = { home: path.join(root, 'home'), documents: path.join(root, 'documents'), appData: path.join(root, 'appdata'), localAppData: path.join(root, 'localappdata') };
  const allowed = [
    path.join(roots.home, '.bashrc'),
    path.join(roots.home, '.pi', 'agent', 'settings.json'),
    path.join(roots.home, '.pi', 'agent-work', 'settings.json'),
    path.join(roots.home, '.claude', 'settings.json'),
    path.join(roots.home, '.claude-work', 'settings.json'),
    path.join(roots.home, '.claude', 'settings.local.json'),
    path.join(roots.home, '.claude-work', 'settings.local.json'),
    path.join(roots.documents, 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
    path.join(roots.appData, 'mpx', 'config.json'),
    path.join(roots.localAppData, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
  ];
  for (const target of allowed) assert.equal(isAllowedProtectedTarget(target, roots), true, target);
  assert.equal(isAllowedProtectedTarget(path.join(root, 'arbitrary', 'settings.json'), roots), false);
  assert.equal(isAllowedProtectedTarget(path.join(roots.localAppData, 'Packages', 'OtherTerminal', 'LocalState', 'settings.json'), roots), false);
});

test('supports selected repository mpxconfig.json conversion without interpreting it', async () => {
  const f = await fixture('mpxconfig.json', '{"old":true}\n'); const plan = await prepare({ target: f.target, backupRoot: f.backup, transform: () => '{"new":true}\n', protect }); await apply(plan); assert.equal(await readFile(f.target, 'utf8'), '{"new":true}\n');
});

test('rejects a precomputed postimage based on a stale preimage', async () => {
  const f = await fixture(); const oldHash = createHash('sha256').update('old\r\n').digest('hex'); await writeFile(f.target, 'newer\n');
  await assert.rejects(prepare({ target: f.target, backupRoot: f.backup, after: 'computed-from-old\n', expectedPreHash: oldHash, protect }), /stale precomputed postimage/);
});

test('refuses stale source and an existing adjacent candidate', async () => {
  const stale = await fixture(); const p1 = await prepare({ target: stale.target, backupRoot: stale.backup, transform: before => `${before}new\n`, protect }); await writeFile(stale.target, 'later\n'); await assert.rejects(apply(p1), /source drift/);
  const conflict = await fixture(); const p2 = await prepare({ target: conflict.target, backupRoot: conflict.backup, transform: () => 'new\n', protect }); await writeFile(p2.candidate, 'occupied'); await assert.rejects(apply(p2), /candidate already exists/);
});

test('refuses a target beneath a linked parent', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mpx-linked-')); temporaryRoots.push(root); const real = path.join(root, 'real'); await mkdir(real); await writeFile(path.join(real, 'mpxconfig.json'), 'old\n'); const linked = path.join(root, 'linked');
  try { await symlink(real, linked, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { t.skip(`symlink unavailable: ${String(error)}`); return; }
  await assert.rejects(prepare({ target: path.join(linked, 'mpxconfig.json'), backupRoot: path.join(root, 'backup'), transform: () => 'new\n', protect }), /symlink/);
});

test('post-write checkpoint failure compensates while owned', async () => {
  const f = await fixture(); const plan = await prepare({ target: f.target, backupRoot: f.backup, transform: () => 'new\n', protect, failureHook: checkpoint => { if (checkpoint === 'after-write') throw new Error('checkpoint'); } }); await assert.rejects(apply(plan), /checkpoint/); assert.equal(await readFile(f.target, 'utf8'), 'old\r\n'); assert.equal(plan.state, 'rolled-back');
});

test('post-write failure never overwrites a concurrent newer edit', async () => {
  const f = await fixture(); const plan = await prepare({ target: f.target, backupRoot: f.backup, transform: () => 'new\n', protect, failureHook: async () => { await writeFile(f.target, 'newer\n'); throw new Error('checkpoint'); } }); await assert.rejects(apply(plan), /compensation incomplete/); assert.equal(await readFile(f.target, 'utf8'), 'newer\n'); assert.equal(plan.state, 'recovery-incomplete');
});

test('after-rename failures compensate and corrupted backup bytes are never restored', async () => {
  for (const corrupt of [false, true]) {
    const fixtureState = await fixture();
    const plan = await prepare({ target: fixtureState.target, backupRoot: fixtureState.backup, transform: () => 'new\n', protect,
      failureHook: async checkpoint => {
        if (checkpoint !== 'after-rename') return;
        if (corrupt) await writeFile(path.join(fixtureState.backup, 'before'), 'corrupted');
        throw new Error('after rename');
      } });
    await assert.rejects(apply(plan), corrupt ? /compensation incomplete/ : /after rename/);
    assert.equal(await readFile(fixtureState.target, 'utf8'), corrupt ? 'new\n' : 'old\r\n');
    assert.equal(plan.state, corrupt ? 'recovery-incomplete' : 'rolled-back');
  }
});

test('standalone recovery rejects tampered plan identity and backup without changing the target', async () => {
  const fixtureState = await fixture();
  const plan = await prepare({ target: fixtureState.target, backupRoot: fixtureState.backup, transform: () => 'new\n', protect });
  await apply(plan);
  await writeFile(plan.planPath, JSON.stringify({ ...plan, id: '../invalid' }));
  await assert.rejects(exec(process.execPath, [plan.recoveryPath, '--apply']), /invalid recovery plan/);
  await writeFile(plan.planPath, JSON.stringify(plan));
  await writeFile(plan.backup, 'corrupted');
  await assert.rejects(exec(process.execPath, [plan.recoveryPath, '--apply']), /backup mismatch/);
  assert.equal(await readFile(fixtureState.target, 'utf8'), 'new\n');
});

test('oversized files and a target changed to a link are refused', async () => {
  const fixtureState = await fixture();
  const plan = await prepare({ target: fixtureState.target, backupRoot: fixtureState.backup, transform: () => 'new\n', protect });
  await truncate(plan.staged, 1024 * 1024 + 1);
  await assert.rejects(apply(plan), /exceeds bound/);
  await writeFile(plan.staged, 'new\n');
  const unrelated = path.join(fixtureState.root, 'unrelated');
  await writeFile(unrelated, 'preserve'); await rm(fixtureState.target);
  await symlink(unrelated, fixtureState.target, 'file');
  await assert.rejects(apply(plan), /symlink/);
  assert.equal(await readFile(unrelated, 'utf8'), 'preserve');
});
