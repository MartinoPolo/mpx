import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath as realpathTest, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import type { UserConfig } from '../src/contracts.js';
import { applyAccountRollout, prepareAccountRollout, rollbackAccountRollout } from '../migration/account-rollout.js';
const comparableTest = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

async function fixture(harness: 'pi' | 'claude' = 'pi') {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mpx-account-rollout-'));
  const root = path.join(temporary, 'checkout');
  const accountRoot = path.join(temporary, 'account');
  const legacy = path.join(temporary, 'legacy');
  const backupRoot = path.join(temporary, 'backup');
  await mkdir(path.join(root, 'extensions'), { recursive: true });
  await mkdir(path.join(root, 'dist/pi/agents'), { recursive: true });
  await mkdir(path.join(root, 'dist/claude/agents'), { recursive: true });
  await mkdir(path.join(root, 'dist/claude/rules/languages'), { recursive: true });
  await mkdir(path.join(root, 'dist/claude/output-styles'), { recursive: true });
  await mkdir(accountRoot, { recursive: true });
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(root, 'extensions/pi-runtime.ts'), 'export default {}');
  await writeFile(path.join(root, 'dist/pi/agents/mpx-worker.md'), 'pi generated');
  await writeFile(path.join(root, 'dist/claude/agents/mpx-worker.md'), 'claude generated');
  await writeFile(path.join(root, 'dist/claude/output-styles/mpx-terse.md'), 'new terse');
  await writeFile(path.join(root, 'dist/claude/rules/languages/typescript.md'), 'new ts');
  const config: UserConfig = { accounts: { personal: { pi: accountRoot, claude: accountRoot }, work: { pi: accountRoot, claude: accountRoot } }, domains: { personal: [], work: [] } };
  const protectCalls: string[] = [];
  const common = { account: 'personal' as const, harness, config, root, backupRoot, approvedLegacyRoots: [legacy], protectRoot: async (value: string) => { protectCalls.push(value); } };
  return { temporary, root, accountRoot, legacy, backupRoot, config, common, protectCalls };
}

test('prepare stages Pi transformations without writing account or linked legacy sources', async () => {
  const f = await fixture();
  try {
    const display = path.join(f.legacy, 'display');
    const skills = path.join(f.legacy, 'skills');
    await mkdir(display); await mkdir(skills);
    const legacySettings = path.join(f.legacy, 'settings.json');
    const original = { theme: 'custom', packages: ['native-package', { source: display, themes: ['legacy'], extensions: ['old'] }], skills: ['custom', path.join(skills, 'one')] };
    await writeFile(legacySettings, `${JSON.stringify(original)}\n`);
    await symlink(legacySettings, path.join(f.accountRoot, 'settings.json'), 'file');
    const plan = await prepareAccountRollout({ ...f.common, approvedDisplayPackage: display, approvedLegacySkillRoots: [skills], legacySkillExclusions: [skills, path.join(f.legacy, 'global-skills')] });
    assert.deepEqual(JSON.parse(await readFile(legacySettings, 'utf8')), original);
    assert.equal((await lstat(path.join(f.accountRoot, 'settings.json'))).isSymbolicLink(), true);
    const staged = JSON.parse(await readFile(path.join(plan.stagingRoot, 'settings.json'), 'utf8'));
    assert.equal(staged.theme, 'custom');
    assert.deepEqual(staged.packages, ['native-package', { source: display, themes: ['legacy'], extensions: [] }]);
    assert.deepEqual(staged.skills, ['custom', `!${skills.replaceAll('\\', '/')}/**`, `!${path.join(f.legacy, 'global-skills').replaceAll('\\', '/')}/**`]);
    assert.equal(f.protectCalls[0], f.backupRoot);
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});

test('prepare preserves Claude hooks and unknown files while replacing only approved legacy projections', async () => {
  const f = await fixture('claude');
  try {
    await writeFile(path.join(f.accountRoot, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'orca' }] }] }, theme: 'x' }));
    await mkdir(path.join(f.accountRoot, 'rules')); await writeFile(path.join(f.accountRoot, 'rules/custom.md'), 'keep'); await writeFile(path.join(f.accountRoot, 'rules/typescript.md'), 'old'); await writeFile(path.join(f.legacy, 'typescript.md'), 'old');
    await mkdir(path.join(f.accountRoot, 'output-styles')); const oldTerse = path.join(f.legacy, 'mp-terse.md'); await writeFile(oldTerse, 'old'); await symlink(oldTerse, path.join(f.accountRoot, 'output-styles/mp-terse.md'), 'file');
    const plan = await prepareAccountRollout({ ...f.common, legacyRuleMappings: [{ name: 'typescript.md', sourceRoot: f.legacy, destination: path.join(f.root, 'dist/claude/rules/languages/typescript.md') }], approvedLegacyTerseSource: oldTerse });
    const settings = JSON.parse(await readFile(path.join(plan.stagingRoot, 'settings.json'), 'utf8'));
    assert.equal(settings.theme, 'x'); assert.equal(settings.hooks.Stop[0].hooks[0].command, 'orca');
    assert.equal(await readFile(path.join(plan.stagingRoot, 'rules/custom.md'), 'utf8'), 'keep');
    await assert.rejects(lstat(path.join(plan.stagingRoot, 'rules/typescript.md')), { code: 'ENOENT' });
    assert.equal(path.resolve(path.dirname(path.join(plan.stagingRoot, 'output-styles/mpx-terse.md')), await readlink(path.join(plan.stagingRoot, 'output-styles/mpx-terse.md'))), path.resolve(f.root, 'dist/claude/output-styles/mpx-terse.md'));
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});

test('Claude legacy directory links become private while the generated output style is selected', async () => {
  const fixtureState = await fixture('claude');
  try {
    const originalStyles = path.join(fixtureState.legacy, 'output-styles');
    await mkdir(originalStyles);
    await writeFile(path.join(originalStyles, 'mp-terse.md'), 'preserved original style');
    await symlink(originalStyles, path.join(fixtureState.accountRoot, 'output-styles'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(path.join(fixtureState.accountRoot, 'settings.json'), '{"outputStyle":"mp-terse"}');
    const plan = await prepareAccountRollout(fixtureState.common);
    assert.equal(await readFile(path.join(plan.stagingRoot, 'output-styles/mp-terse.md'), 'utf8'), 'preserved original style');
    assert.equal(JSON.parse(await readFile(path.join(plan.stagingRoot, 'settings.json'), 'utf8')).outputStyle, 'mpx-terse');
    await applyAccountRollout(plan);
    assert.equal((await lstat(path.join(fixtureState.accountRoot, 'output-styles'))).isSymbolicLink(), false);
    assert.equal(await readFile(path.join(originalStyles, 'mp-terse.md'), 'utf8'), 'preserved original style');
    await rollbackAccountRollout(plan);
    assert.equal((await lstat(path.join(fixtureState.accountRoot, 'output-styles'))).isSymbolicLink(), true);
  } finally { await rm(fixtureState.temporary, { recursive: true, force: true }); }
});

test('repeat rollout leaves unchanged surfaces in place and compensation never quarantines untouched files', async () => {
  const fixtureState = await fixture();
  try {
    const first = await prepareAccountRollout(fixtureState.common);
    await applyAccountRollout(first);
    const unchanged = await prepareAccountRollout({ ...fixtureState.common, backupRoot: path.join(fixtureState.temporary, 'second-backup') });
    assert.ok(unchanged.entries.every(entry => JSON.stringify(entry.before) === JSON.stringify(entry.after)));
    await applyAccountRollout(unchanged);
    for (const entry of unchanged.entries) await assert.rejects(lstat(entry.retained), { code: 'ENOENT' });
    await rollbackAccountRollout(unchanged);
    const settingsFile = path.join(fixtureState.accountRoot, 'settings.json');
    const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
    settings.treeFilterMode = 'all';
    await writeFile(settingsFile, JSON.stringify(settings));
    const changed = await prepareAccountRollout({ ...fixtureState.common, backupRoot: path.join(fixtureState.temporary, 'third-backup') });
    await assert.rejects(applyAccountRollout(changed, { failAfterMutations: 1 }), /injected apply failure/);
    assert.equal(changed.state, 'rolled-back');
    assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).treeFilterMode, 'all');
    for (const entry of changed.entries.slice(1)) {
      const info = await lstat(entry.destination);
      assert.equal(info.isFile(), entry.before.type === 'file');
      assert.equal(info.isDirectory(), entry.before.type === 'directory');
      assert.equal(info.isSymbolicLink(), entry.before.type === 'link');
      await assert.rejects(lstat(entry.retainedAfter), { code: 'ENOENT' });
    }
  } finally { await rm(fixtureState.temporary, { recursive: true, force: true }); }
});

test('prepare never traverses or reads account siblings outside the selected surface allowlist', async () => {
  const f = await fixture();
  try {
    for (const name of ['auth.json', 'history.jsonl', 'unrelated-secret']) await writeFile(path.join(f.accountRoot, name), 'must not be observed');
    const observed: string[] = []; await prepareAccountRollout({ ...f.common, observeRead: (_operation, candidate) => observed.push(candidate) });
    for (const name of ['auth.json', 'history.jsonl', 'unrelated-secret']) assert.equal(observed.some(candidate => candidate === path.join(f.accountRoot, name) || candidate.startsWith(`${path.join(f.accountRoot, name)}${path.sep}`)), false);
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});

test('prepare rejects an oversized selected file before reading its bytes', async () => {
  const f = await fixture();
  try {
    const settings = path.join(f.accountRoot, 'settings.json'); await writeFile(settings, ''); await truncate(settings, 256 * 1024 * 1024 + 1);
    const reads: string[] = []; await assert.rejects(prepareAccountRollout({ ...f.common, observeRead: (operation, candidate) => { if (operation === 'read') reads.push(candidate); } }), /byte limit/);
    assert.equal(reads.includes(settings), false);
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});

test('Claude retired skill links are removed only from staging and restored by standalone recovery', async () => {
  const f = await fixture('claude');
  try {
    const exported = path.join(f.legacy, 'native-skill-export'); await mkdir(exported); await writeFile(path.join(exported, 'SKILL.md'), 'legacy');
    await mkdir(path.join(f.accountRoot, 'skills')); await symlink(exported, path.join(f.accountRoot, 'skills/explorer'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(path.join(f.accountRoot, 'skills/custom.md'), 'keep');
    const plan = await prepareAccountRollout({ ...f.common, retiredSkillLinks: [{ name: 'explorer', target: exported }] });
    await assert.rejects(lstat(path.join(plan.stagingRoot, 'skills/explorer')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(plan.stagingRoot, 'skills/custom.md'), 'utf8'), 'keep');
    assert.equal((await lstat(path.join(f.accountRoot, 'skills/explorer'))).isSymbolicLink(), true);
    await applyAccountRollout(plan);
    await promisify(execFile)(process.execPath, [plan.recoveryPath, plan.planPath]);
    assert.equal((await lstat(path.join(f.accountRoot, 'skills/explorer'))).isSymbolicLink(), true);
    assert.equal(await readFile(path.join(f.accountRoot, 'skills/custom.md'), 'utf8'), 'keep');
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});

test('prepare preserves an existing exact generated agent link', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.accountRoot, 'agents')); const existing = path.join(f.accountRoot, 'agents/mpx-worker.md'); const source = path.join(f.root, 'dist/pi/agents/mpx-worker.md'); await symlink(source, existing, 'file');
    const plan = await prepareAccountRollout(f.common); assert.equal((await lstat(existing)).isSymbolicLink(), true);
    assert.equal(comparableTest(await realpathTest(path.join(plan.stagingRoot, 'agents/mpx-worker.md'))), comparableTest(source));
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});

test('prepare refuses a custom definition at a generated agent name without discarding it', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.accountRoot, 'agents')); const custom = path.join(f.accountRoot, 'agents/mpx-worker.md'); await writeFile(custom, 'user definition');
    await assert.rejects(prepareAccountRollout(f.common), /conflicts with existing definition/);
    assert.equal(await readFile(custom, 'utf8'), 'user definition');
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});

test('standalone recovery restores an interrupted write-ahead quarantine without checkout dependencies', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.accountRoot, 'settings.json'), '{"old":true}');
    const plan = await prepareAccountRollout(f.common); const first = plan.entries[0]!;
    await rename(first.destination, first.retained); plan.state = 'applying'; await writeFile(plan.planPath, `${JSON.stringify(plan, null, 2)}\n`);
    await promisify(execFile)(process.execPath, [plan.recoveryPath, plan.planPath]);
    assert.equal(await readFile(path.join(f.accountRoot, 'settings.json'), 'utf8'), '{"old":true}');
    const durable = JSON.parse(await readFile(plan.planPath, 'utf8')); assert.equal(durable.state, 'rolled-back');
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});

test('standalone recovery tolerates and retains a partial recorded candidate without touching the original', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.accountRoot, 'settings.json'), '{"old":true}'); const plan = await prepareAccountRollout(f.common); const first = plan.entries[0]!;
    await writeFile(first.candidate, 'partial candidate bytes'); plan.state = 'applying'; await writeFile(plan.planPath, `${JSON.stringify(plan, null, 2)}\n`);
    await promisify(execFile)(process.execPath, [plan.recoveryPath, plan.planPath]);
    assert.equal(await readFile(path.join(f.accountRoot, 'settings.json'), 'utf8'), '{"old":true}'); assert.equal(await readFile(first.candidate, 'utf8'), 'partial candidate bytes');
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});

test('apply drift preflight makes zero account mutations', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.accountRoot, 'settings.json'), '{}');
    const plan = await prepareAccountRollout(f.common);
    await writeFile(path.join(f.accountRoot, 'settings.json'), '{"newer":true}');
    await assert.rejects(applyAccountRollout(plan), /changed|drift/i);
    assert.equal(await readFile(path.join(f.accountRoot, 'settings.json'), 'utf8'), '{"newer":true}');
    assert.deepEqual((await (await import('node:fs/promises')).readdir(f.accountRoot)).filter(value => value.includes('retained')), []);
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});

test('an injected partial apply compensates this attempt and preserves original link topology', async () => {
  const f = await fixture();
  try {
    const source = path.join(f.legacy, 'settings.json'); await writeFile(source, '{}'); await symlink(source, path.join(f.accountRoot, 'settings.json'), 'file');
    await writeFile(path.join(f.accountRoot, 'subagents.json'), '{}');
    const plan = await prepareAccountRollout(f.common);
    await assert.rejects(applyAccountRollout(plan, { failAfterMutations: 2 }), /injected/i);
    assert.equal((await lstat(path.join(f.accountRoot, 'settings.json'))).isSymbolicLink(), true);
    assert.equal(path.resolve(f.accountRoot, await readlink(path.join(f.accountRoot, 'settings.json'))), source);
    assert.equal(await readFile(path.join(f.accountRoot, 'subagents.json'), 'utf8'), '{}');
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});

test('failed compensation remains durably recoverable and never claims prepared state', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.accountRoot, 'settings.json'), '{"old":true}'); const plan = await prepareAccountRollout(f.common);
    await assert.rejects(applyAccountRollout(plan, { failAfterMutations: 1, failCompensationAfterOperations: 1 }), /compensation incomplete/i);
    assert.equal(JSON.parse(await readFile(plan.planPath, 'utf8')).state, 'applying');
    await promisify(execFile)(process.execPath, [plan.recoveryPath, plan.planPath]); assert.equal(await readFile(path.join(f.accountRoot, 'settings.json'), 'utf8'), '{"old":true}');
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});

test('rollback restores original link topology while retaining newer auth and history', async () => {
  const f = await fixture();
  try {
    const source = path.join(f.legacy, 'settings.json'); await writeFile(source, '{"old":true}'); await symlink(source, path.join(f.accountRoot, 'settings.json'), 'file');
    const plan = await prepareAccountRollout(f.common); await applyAccountRollout(plan);
    await writeFile(path.join(f.accountRoot, 'auth.json'), 'new auth'); await writeFile(path.join(f.accountRoot, 'history.jsonl'), 'new history');
    await rollbackAccountRollout(plan);
    assert.equal((await lstat(path.join(f.accountRoot, 'settings.json'))).isSymbolicLink(), true);
    assert.equal((await lstat(plan.entries[0]!.retainedAfter)).isFile(), true);
    assert.equal(await readFile(path.join(f.accountRoot, 'auth.json'), 'utf8'), 'new auth'); assert.equal(await readFile(path.join(f.accountRoot, 'history.jsonl'), 'utf8'), 'new history');
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});

test('rollback refuses changed owned settings before any mutation', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.accountRoot, 'settings.json'), '{"old":true}');
    await writeFile(path.join(f.accountRoot, 'auth.json'), 'secret');
    const plan = await prepareAccountRollout(f.common); await applyAccountRollout(plan);
    await writeFile(path.join(f.accountRoot, 'history.jsonl'), 'new history');
    await writeFile(path.join(f.accountRoot, 'settings.json'), '{"concurrent":true}');
    await assert.rejects(rollbackAccountRollout(plan), /changed|refus/i);
    assert.equal(await readFile(path.join(f.accountRoot, 'settings.json'), 'utf8'), '{"concurrent":true}');
    assert.equal(await readFile(path.join(f.accountRoot, 'auth.json'), 'utf8'), 'secret');
    assert.equal(await readFile(path.join(f.accountRoot, 'history.jsonl'), 'utf8'), 'new history');
  } finally { await rm(f.temporary, { recursive: true, force: true }); }
});
