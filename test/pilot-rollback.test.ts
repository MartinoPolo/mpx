import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-pilot-rollback-'));
  const backup = path.join(root, 'backup');
  const account = path.join(root, 'agent');
  const display = path.join(root, 'display');
  const sharedSkills = path.join(root, 'skills/mpx');
  const entries: Record<string, Array<{ path: string; type: string; sha256: string }>> = {};
  async function saved(group: string, relative: string, value: string) {
    const file = path.join(backup, group, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, value);
    (entries[group] ??= []).push({ path: relative, type: 'file', sha256: hash(value) });
    return file;
  }
  await mkdir(path.join(account, 'agents'), { recursive: true });
  const oldSettings = JSON.stringify({ packages: [display], skills: ['custom'], model: 'old' });
  const currentSettings = JSON.stringify({ packages: [{ source: display, extensions: [] }, 'new-package'], skills: ['custom', `!${sharedSkills.replaceAll('\\', '/')}/**`], model: 'new', treeFilterMode: 'no-tools' });
  await saved('personal-account', 'agent/settings.json', oldSettings);
  await writeFile(path.join(account, 'settings.json'), currentSettings);
  await writeFile(path.join(account, 'auth.json'), 'newer credentials');
  await writeFile(path.join(account, 'conversation.jsonl'), 'newer conversation');
  const legacy = path.join(root, 'legacy');
  await mkdir(path.join(legacy, 'agents'), { recursive: true });
  const oldSubagents = '{"other":true}';
  const target = path.join(legacy, 'subagents.json');
  await writeFile(target, oldSubagents);
  const backedSubagents = await saved('legacy-resources', 'mpx-pi/subagents.json', oldSubagents);
  await writeFile(path.join(account, 'subagents.json'), '{"other":true,"showModel":true}');
  const preserved = path.join(account, 'agents.mpx2-original-link');
  await symlink(path.join(legacy, 'agents'), preserved, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(account, 'agents/old.md'), 'retained');
  const generated = path.join(root, 'generated.md');
  await writeFile(generated, 'generated');
  const newLink = path.join(account, 'agents/mpx-executor.md');
  await symlink(generated, newLink, 'file');
  const shellFile = path.join(root, '.bashrc');
  const projectFile = path.join(root, 'mpxconfig.json');
  const configFile = path.join(root, 'config.json');
  await saved('routing', '.bashrc', 'old shell');
  await saved('routing', 'mpxconfig.json', '{"old":true}');
  for (const file of [shellFile, projectFile, configFile]) await writeFile(file, 'new');
  for (const [group, values] of Object.entries(entries)) await writeFile(path.join(backup, group, 'manifest.json'), JSON.stringify({ entries: values }));
  await writeFile(path.join(backup, 'pilot-apply.json'), JSON.stringify({ account, display, sharedSkills, shellFile, projectFile, configFile, files: [shellFile, projectFile, configFile].map(file => ({ path: file, afterHash: hash('new') })), createdLinks: [{ path: newLink, target: await readlink(newLink) }], originalLinks: [{ path: path.join(account, 'subagents.json'), target, backupFile: backedSubagents, sha256: hash(oldSubagents) }], originalDirectories: [{ path: path.join(account, 'agents'), preservedPath: preserved, target: await readlink(preserved) }] }));
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [fileURLToPath(new URL('../migration/rollback-personal-pilot.mjs', import.meta.url)), backup, ...args], { timeout: 10_000 });
  return { root, backup, account, shellFile, projectFile, configFile, display, currentSettings, run };
}

test('pilot rollback preserves newer credentials, conversations and unrelated settings, and restores legacy links', async () => {
  const f = await fixture();
  try {
    await f.run();
    assert.equal(await readFile(path.join(f.account, 'settings.json'), 'utf8'), f.currentSettings);
    await f.run('--apply');
    const settings = JSON.parse(await readFile(path.join(f.account, 'settings.json'), 'utf8'));
    assert.deepEqual(settings, { packages: [f.display, 'new-package'], skills: ['custom'], model: 'new' });
    assert.equal(await readFile(path.join(f.account, 'auth.json'), 'utf8'), 'newer credentials');
    assert.equal(await readFile(path.join(f.account, 'conversation.jsonl'), 'utf8'), 'newer conversation');
    assert.equal((await lstat(path.join(f.account, 'subagents.json'))).isSymbolicLink(), true);
    assert.equal((await lstat(path.join(f.account, 'agents'))).isSymbolicLink(), true);
    assert.equal(await readFile(path.join(f.account, 'agents.mpx2-pilot-retained/old.md'), 'utf8'), 'retained');
    assert.equal(await readFile(f.shellFile, 'utf8'), 'old shell');
    assert.equal(await readFile(f.projectFile, 'utf8'), '{"old":true}');
    await assert.rejects(lstat(f.configFile), { code: 'ENOENT' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('write-ahead recovery tolerates planned files not written and an interrupted directory switch', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.backup, 'pilot-apply.json');
    const record = JSON.parse(await readFile(file, 'utf8'));
    record.files.find((entry: { path: string }) => entry.path === f.shellFile).beforeHash = hash('old shell');
    record.files.find((entry: { path: string }) => entry.path === f.projectFile).beforeHash = hash('{"old":true}');
    await writeFile(file, JSON.stringify(record));
    await writeFile(f.shellFile, 'old shell');
    await writeFile(f.projectFile, '{"old":true}');
    await rm(f.configFile);
    await rm(path.join(f.account, 'agents'), { recursive: true });
    await f.run('--apply');
    assert.equal(await readFile(f.shellFile, 'utf8'), 'old shell');
    assert.equal((await lstat(path.join(f.account, 'agents'))).isSymbolicLink(), true);
    assert.equal(await readFile(path.join(f.account, 'auth.json'), 'utf8'), 'newer credentials');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('pilot rollback refuses a concurrent shell change before mutating any settings', async () => {
  const f = await fixture();
  try {
    await writeFile(f.shellFile, 'user changed this');
    await assert.rejects(f.run('--apply'), /refusing overwrite/);
    assert.equal(await readFile(path.join(f.account, 'settings.json'), 'utf8'), f.currentSettings);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
