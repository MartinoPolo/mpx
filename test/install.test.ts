import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UserConfig } from '../src/contracts.js';
import { inspectAgentLinks, planAgentLinks, syncAgentLinks } from '../src/install.js';

async function fixture(): Promise<{ root: string; config: UserConfig }> {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx2-install-'));
  for (const harness of ['pi', 'claude'] as const) {
    const source = path.join(root, 'dist', harness, 'agents');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'mpx-checker.md'), `${harness} checker`);
    await writeFile(path.join(source, 'mpx-reviewer.md'), `${harness} reviewer`);
    await writeFile(path.join(source, 'not-mpx.md'), 'ignored');
  }
  const accounts = {
    personal: { pi: path.join(root, 'personal-pi'), claude: path.join(root, 'personal-claude') },
    work: { pi: path.join(root, 'work-pi'), claude: path.join(root, 'work-claude') },
  };
  for (const roots of Object.values(accounts)) for (const accountRoot of Object.values(roots)) await mkdir(accountRoot);
  return { root, config: { accounts, domains: { personal: [], work: [] } } };
}

async function dispose(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

test('plans and converges named specialist file links across all four account/harness roots', async () => {
  const { root, config } = await fixture();
  try {
    const plan = await planAgentLinks(root, config);
    assert.equal(plan.errors.length, 0);
    assert.equal(plan.links.length, 8);
    assert.deepEqual(new Set(plan.links.map(item => `${item.account}/${item.harness}`)), new Set(['personal/pi', 'personal/claude', 'work/pi', 'work/claude']));
    assert.ok(plan.links.every(item => path.basename(item.source).startsWith('mpx-') && path.dirname(item.destination).endsWith(`${path.sep}agents`)));

    const first = await syncAgentLinks(plan);
    assert.equal(first.ok, true);
    assert.ok(first.results.every(result => result.action === 'created'));
    const second = await syncAgentLinks(plan);
    assert.equal(second.ok, true);
    assert.ok(second.results.every(result => result.action === 'unchanged'));
    assert.ok((await inspectAgentLinks(plan)).results.every(result => result.status === 'linked'));
    for (const item of plan.links) {
      assert.equal((await lstat(item.destination)).isSymbolicLink(), true);
      assert.equal(await readFile(item.destination, 'utf8'), await readFile(item.source, 'utf8'));
    }
  } finally { await dispose(root); }
});

test('reports a missing generated source without disturbing other entries', async () => {
  const { root, config } = await fixture();
  try {
    const plan = await planAgentLinks(root, config);
    await unlink(plan.links[0]!.source);
    const result = await syncAgentLinks(plan);
    assert.equal(result.ok, false);
    const affected = result.results.filter(entry => entry.source === plan.links[0]!.source);
    assert.ok(affected.every(entry => entry.action === 'failed' && entry.status === 'source-missing'));
    assert.ok(affected.every(entry => entry.error?.includes(entry.source!)));
    assert.ok(result.results.filter(entry => entry.source !== plan.links[0]!.source).every(entry => entry.action === 'created'));
  } finally { await dispose(root); }
});

test('missing account roots are errors and are never created', async () => {
  const { root, config } = await fixture();
  try {
    const missingRoot = config.accounts.work.pi;
    await rm(missingRoot, { recursive: true });
    const plan = await planAgentLinks(root, config);
    const affected = (await inspectAgentLinks(plan)).results.filter(item => item.account === 'work' && item.harness === 'pi');
    assert.ok(affected.every(item => item.status === 'account-root-missing'));
    const result = await syncAgentLinks(plan);
    assert.equal(result.ok, false);
    await assert.rejects(lstat(missingRoot), { code: 'ENOENT' });
    assert.ok(result.results.filter(item => item.account === 'personal').every(item => item.action === 'created'));
  } finally { await dispose(root); }
});

test('preserves ordinary files, wrong links, linked agents directories, and unrelated entries', async () => {
  const { root, config } = await fixture();
  try {
    const plan = await planAgentLinks(root, config);
    const ordinary = plan.links.find(item => item.account === 'personal' && item.harness === 'pi' && path.basename(item.destination) === 'mpx-checker.md')!;
    await mkdir(path.dirname(ordinary.destination));
    await writeFile(ordinary.destination, 'user file');
    await writeFile(path.join(path.dirname(ordinary.destination), 'native-agent.md'), 'native');

    const wrong = plan.links.find(item => item.account === 'work' && item.harness === 'claude' && path.basename(item.destination) === 'mpx-checker.md')!;
    await mkdir(path.dirname(wrong.destination));
    const wrongTarget = path.join(root, 'wrong.md');
    await writeFile(wrongTarget, 'wrong');
    await symlink(wrongTarget, wrong.destination, 'file');

    const linkedDirectoryRoot = config.accounts.work.pi;
    const legacy = path.join(root, 'legacy-agents');
    await mkdir(legacy);
    await writeFile(path.join(legacy, 'legacy.md'), 'legacy');
    await symlink(legacy, path.join(linkedDirectoryRoot, 'agents'), 'dir');

    const result = await syncAgentLinks(plan);
    assert.equal(result.ok, false);
    assert.equal(await readFile(ordinary.destination, 'utf8'), 'user file');
    assert.equal(await readFile(path.join(path.dirname(ordinary.destination), 'native-agent.md'), 'utf8'), 'native');
    assert.equal(await readFile(wrong.destination, 'utf8'), 'wrong');
    assert.deepEqual(await readdir(legacy), ['legacy.md']);
    assert.ok(result.results.filter(item => item.account === 'personal' && item.harness === 'claude').every(item => item.action === 'created'));
    assert.ok(result.results.filter(item => item.account === 'work' && item.harness === 'pi').every(item => item.status === 'agents-directory-conflict'));
  } finally { await dispose(root); }
});

test('rejects an intermediate account-root symlink without touching its target and continues healthy accounts', async () => {
  const { root, config } = await fixture();
  try {
    const redirected = path.join(root, 'redirected');
    const redirectedAccount = path.join(redirected, 'work-pi');
    await mkdir(redirectedAccount, { recursive: true });
    const marker = path.join(redirectedAccount, 'marker.txt');
    await writeFile(marker, 'redirected bytes');
    const intermediary = path.join(root, 'configured-parent');
    await symlink(redirected, intermediary, 'dir');
    config.accounts.work.pi = path.join(intermediary, 'work-pi');

    const plan = await planAgentLinks(root, config);
    const result = await syncAgentLinks(plan);
    assert.equal(result.ok, false);
    assert.ok(result.results.filter(item => item.account === 'work' && item.harness === 'pi').every(item => item.status === 'account-root-conflict'));
    assert.ok(result.results.filter(item => item.account === 'personal').every(item => item.action === 'created'));
    assert.equal(await readFile(marker, 'utf8'), 'redirected bytes');
    await assert.rejects(lstat(path.join(redirectedAccount, 'agents')), { code: 'ENOENT' });
  } finally { await dispose(root); }
});

test('planning errors do not suppress healthy harness links and make inspect and sync fail overall', async () => {
  const { root, config } = await fixture();
  try {
    await rm(path.join(root, 'dist', 'claude', 'agents'), { recursive: true });
    const plan = await planAgentLinks(root, config);
    assert.equal(plan.errors.length, 1);
    assert.equal(plan.errors[0]!.harness, 'claude');
    assert.equal(plan.links.length, 4);
    assert.ok(plan.links.every(item => item.harness === 'pi'));
    const inspection = await inspectAgentLinks(plan);
    assert.equal(inspection.ok, false);
    assert.deepEqual(inspection.errors, plan.errors);
    const synced = await syncAgentLinks(plan);
    assert.equal(synced.ok, false);
    assert.deepEqual(synced.errors, plan.errors);
    assert.ok(synced.results.every(item => item.action === 'created'));
  } finally { await dispose(root); }
});

test('reports and preserves stale, unexpected, and externally targeted leftover mpx entries', async () => {
  const { root, config } = await fixture();
  try {
    const plan = await planAgentLinks(root, config);
    const agents = path.join(config.accounts.personal.pi, 'agents');
    await mkdir(agents);
    const staleSource = path.join(root, 'dist', 'pi', 'agents', 'mpx-retired.md');
    await writeFile(staleSource, 'retired bytes');
    await symlink(staleSource, path.join(agents, 'mpx-retired.md'), 'file');
    const external = path.join(root, 'external-missing.md');
    await symlink(external, path.join(agents, 'mpx-external.md'), 'file');
    await writeFile(path.join(agents, 'mpx-local.md'), 'local bytes');

    const inspected = await inspectAgentLinks(plan);
    const leftovers = inspected.results.filter(item => ['stale', 'unexpected', 'conflict'].includes(item.status));
    assert.equal(leftovers.find(item => path.basename(item.destination) === 'mpx-retired.md')?.status, 'stale');
    assert.equal(leftovers.find(item => path.basename(item.destination) === 'mpx-external.md')?.status, 'conflict');
    assert.equal(leftovers.find(item => path.basename(item.destination) === 'mpx-local.md')?.status, 'unexpected');
    assert.ok(leftovers.find(item => path.basename(item.destination) === 'mpx-external.md')?.target);

    const synced = await syncAgentLinks(plan);
    assert.equal(synced.ok, false);
    assert.equal(await readFile(path.join(agents, 'mpx-retired.md'), 'utf8'), 'retired bytes');
    assert.equal(await readFile(path.join(agents, 'mpx-local.md'), 'utf8'), 'local bytes');
    assert.equal((await lstat(path.join(agents, 'mpx-external.md'))).isSymbolicLink(), true);
  } finally { await dispose(root); }
});

test('status still reports stale links after the last source agent is removed', async () => {
  const { root, config } = await fixture();
  try {
    const initial = await planAgentLinks(root, config);
    assert.equal((await syncAgentLinks(initial)).ok, true);
    const sourceDirectory = path.join(root, 'dist', 'pi', 'agents');
    await rm(sourceDirectory, { recursive: true });
    await mkdir(sourceDirectory);
    const plan = await planAgentLinks(root, config);
    const inspection = await inspectAgentLinks(plan);
    assert.equal(inspection.ok, false);
    assert.ok(inspection.results.some(entry => entry.harness === 'pi' && entry.status === 'stale'));
    assert.equal((await lstat(initial.links.find(entry => entry.harness === 'pi')!.destination)).isSymbolicLink(), true);
  } finally { await dispose(root); }
});

test('relative correct links are owned, while a directory at a destination is preserved as conflict', async () => {
  const { root, config } = await fixture();
  try {
    const plan = await planAgentLinks(root, config);
    const relative = plan.links[0]!;
    await mkdir(path.dirname(relative.destination));
    await symlink(path.relative(path.dirname(relative.destination), relative.source), relative.destination, 'file');
    const obstruction = plan.links[1]!;
    await mkdir(obstruction.destination);
    const partial = { ...plan, links: plan.links.slice(0, 2), errors: [] };
    const inspected = await inspectAgentLinks(partial);
    assert.equal(inspected.results[0]!.status, 'linked');
    assert.equal(inspected.results[1]!.status, 'conflict');
    const result = await syncAgentLinks(partial);
    assert.equal(result.ok, false);
    assert.equal(result.results[0]!.action, 'unchanged');
    assert.equal((await lstat(obstruction.destination)).isDirectory(), true);
  } finally { await dispose(root); }
});
