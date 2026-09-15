import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeHookEntries, syncRuntime, syncRuntimeScope, validateRuntimeScope } from '../src/runtime-install.js';
import type { UserConfig } from '../src/contracts.js';

test('runtime scope rejects coercible values rather than widening or guessing selection', () => {
  for (const scope of [null, {}, { account: ['personal'], harness: 'pi' }, { account: 'personal', harness: ['pi'] }, { account: 'personal', harness: 'pi', extra: true }]) {
    assert.throws(() => validateRuntimeScope(scope), /runtime scope/);
  }
});

test('scoped personal Pi runtime installation never accesses other roots and preserves native values', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mpx-runtime-scope-'));
  const selected = join(scratch, 'pi');
  const config: UserConfig = { accounts: { personal: { pi: selected, claude: join(scratch, 'missing-personal-claude') }, work: { pi: join(scratch, 'missing-work-pi'), claude: join(scratch, 'missing-work-claude') } }, domains: { personal: [], work: [] } };
  try {
    await mkdir(selected);
    await writeFile(join(selected, 'settings.json'), JSON.stringify({ packages: ['keep-pinned'], providers: { local: { key: 'keep' } }, model: 'unchanged' }));
    const first = await syncRuntimeScope(resolve('.'), config, { account: 'personal', harness: 'pi' }, false);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.ok(first.entries.every(entry => entry.account === 'personal' && entry.harness === 'pi'));
    const settings = JSON.parse(await readFile(join(selected, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.packages, ['keep-pinned']);
    assert.deepEqual(settings.providers, { local: { key: 'keep' } });
    assert.equal(settings.model, 'unchanged');
    assert.equal(settings.treeFilterMode, 'no-tools');
    assert.ok((await syncRuntimeScope(resolve('.'), config, { account: 'personal', harness: 'pi' }, false)).entries.every(entry => entry.status === 'unchanged'));
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('scoped runtime preflights every selected destination before writing any of them', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mpx-runtime-preflight-'));
  const selected = join(scratch, 'pi');
  const config: UserConfig = { accounts: { personal: { pi: selected, claude: join(scratch, 'unused-1') }, work: { pi: join(scratch, 'unused-2'), claude: join(scratch, 'unused-3') } }, domains: { personal: [], work: [] } };
  try {
    await mkdir(selected);
    await writeFile(join(selected, 'settings.json'), '{"keep":true}\n');
    await writeFile(join(selected, 'keybindings.json'), '{ malformed');
    const result = await syncRuntimeScope(resolve('.'), config, { account: 'personal', harness: 'pi' }, false);
    assert.equal(result.ok, false);
    assert.equal(await readFile(join(selected, 'settings.json'), 'utf8'), '{"keep":true}\n');
    await assert.rejects(readFile(join(selected, 'subagents.json')));
    await assert.rejects(readFile(join(selected, 'extensions/mpx2.ts')));
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('Claude scopes enforce native Manual permissions while preserving unrelated permission settings', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mpx-runtime-claude-permissions-'));
  const selected = join(scratch, 'claude');
  const config: UserConfig = { accounts: { personal: { pi: join(scratch, 'unused-pi'), claude: selected }, work: { pi: join(scratch, 'unused-work-pi'), claude: join(scratch, 'unused-work-claude') } }, domains: { personal: [], work: [] } };
  try {
    await mkdir(selected);
    const before = JSON.stringify({ permissions: { defaultMode: 'auto', allow: ['Read'], deny: ['Bash(secret-command)'] }, unrelated: true });
    await writeFile(join(selected, 'settings.json'), before);
    assert.equal((await syncRuntimeScope(resolve('.'), config, { account: 'personal', harness: 'claude' }, true)).ok, true);
    assert.equal(await readFile(join(selected, 'settings.json'), 'utf8'), before);
    assert.equal((await syncRuntimeScope(resolve('.'), config, { account: 'personal', harness: 'claude' }, false)).ok, true);
    const after = JSON.parse(await readFile(join(selected, 'settings.json'), 'utf8'));
    assert.deepEqual(after.permissions, { defaultMode: 'default', allow: ['Read'], deny: ['Bash(secret-command)'] });
    assert.equal(after.unrelated, true);
    assert.equal(after.outputStyle, 'mpx-terse');
    await writeFile(join(selected, 'settings.json'), '{"permissions":"invalid"}');
    assert.equal((await syncRuntimeScope(resolve('.'), config, { account: 'personal', harness: 'claude' }, false)).ok, false);
    assert.equal(await readFile(join(selected, 'settings.json'), 'utf8'), '{"permissions":"invalid"}');
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('generated Claude hook commands load through native Node and fail closed before handler startup', () => {
  const root = resolve('.');
  const registrations = claudeHookEntries(root) as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  const command = registrations.PreToolUse![0]!.hooks[0]!.command;
  const loaderSpecifier = pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href;
  assert.ok(command.includes(loaderSpecifier));
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: root, tool_name: 'Bash', tool_input: { command: 'echo unsafe >NUL' } });
  const result = spawnSync('bash', ['--noprofile', '--norc', '-c', command], { input, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const unavailable = command.replace(loaderSpecifier, pathToFileURL(join(root, '.local/nonexistent-acceptance-loader.mjs')).href);
  const failure = spawnSync('bash', ['--noprofile', '--norc', '-c', unavailable], { input, encoding: 'utf8', timeout: 15000 });
  assert.equal(failure.status, 2, failure.stderr);
});

test('runtime upgrades exact old Windows loader registrations without retaining duplicate broken hooks', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mpx-runtime-hook-upgrade-'));
  const config: UserConfig = { accounts: { personal: { pi: join(scratch, 'unused-pi'), claude: scratch }, work: { pi: join(scratch, 'unused-work-pi'), claude: join(scratch, 'unused-work-claude') } }, domains: { personal: [], work: [] } };
  try {
    const root = resolve('.');
    const old = JSON.parse(JSON.stringify(claudeHookEntries(root)).replaceAll(pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href, join(root, 'node_modules/tsx/dist/loader.mjs').replaceAll('\\', '/')).replaceAll(' || exit 2', ''));
    const unrelated = { hooks: [{ type: 'command', command: 'preserve-native-owner' }] };
    old.SessionStart.push(unrelated);
    await writeFile(join(scratch, 'settings.json'), JSON.stringify({ hooks: old }));
    assert.equal((await syncRuntimeScope(root, config, { account: 'personal', harness: 'claude' }, false)).ok, true);
    const after = JSON.parse(await readFile(join(scratch, 'settings.json'), 'utf8'));
    assert.equal(after.hooks.PreToolUse.length, 1);
    assert.deepEqual(after.hooks.PreToolUse, claudeHookEntries(root).PreToolUse);
    assert.equal(after.hooks.SessionStart.length, 2);
    assert.deepEqual(after.hooks.SessionStart[1], unrelated);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('broad runtime installation preserves native settings/packages and converges only on owned entries', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mpx-runtime-'));
  const config: UserConfig = { accounts: { personal: { pi: join(scratch, 'pi'), claude: join(scratch, 'cc') }, work: { pi: join(scratch, 'piw'), claude: join(scratch, 'ccw') } }, domains: { personal: [], work: [] } };
  try {
    for (const account of Object.values(config.accounts)) for (const directory of Object.values(account)) {
      await mkdir(directory); await writeFile(join(directory, 'settings.json'), JSON.stringify({ packages: ['keep-pinned'], model: 'unchanged', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep' }] }] } }));
    }
    const before = await readFile(join(config.accounts.personal.pi, 'settings.json'));
    assert.equal((await syncRuntime(resolve('.'), config, true)).ok, true);
    assert.deepEqual(await readFile(join(config.accounts.personal.pi, 'settings.json')), before);
    const written = await syncRuntime(resolve('.'), config, false);
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.ok((await syncRuntime(resolve('.'), config, false)).entries.every(entry => entry.status === 'unchanged'));
    for (const account of Object.values(config.accounts)) {
      const pi = JSON.parse(await readFile(join(account.pi, 'settings.json'), 'utf8'));
      assert.deepEqual(pi.packages, ['keep-pinned']); assert.equal(pi.model, 'unchanged'); assert.equal(pi.treeFilterMode, 'no-tools');
      const claude = JSON.parse(await readFile(join(account.claude, 'settings.json'), 'utf8'));
      assert.equal(claude.hooks.Stop[0].hooks[0].command, 'keep'); assert.equal(claude.hooks.PreToolUse.length, 1);
    }
    await rm(join(config.accounts.work.pi, 'extensions/mpx2.ts')); await writeFile(join(config.accounts.work.pi, 'extensions/mpx2.ts'), 'unrelated');
    const conflict = await syncRuntime(resolve('.'), config, false);
    assert.equal(conflict.ok, false); assert.equal(await readFile(join(config.accounts.work.pi, 'extensions/mpx2.ts'), 'utf8'), 'unrelated');
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
