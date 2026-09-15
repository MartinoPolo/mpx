import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mpx2-cli-'));
  await exec('git', ['init', '--quiet'], { cwd: root });
  const accounts = { personal: { pi: join(root, 'ppi'), claude: join(root, 'pcc') }, work: { pi: join(root, 'wpi'), claude: join(root, 'wcc') } };
  for (const roots of Object.values(accounts)) for (const directory of Object.values(roots)) await mkdir(directory);
  await mkdir(join(root, 'mpx2'));
  await writeFile(join(root, 'mpx2', 'config.json'), JSON.stringify({ accounts, domains: { personal: [root], work: [] }, defaultPacks: { personal: [], work: [] } }));
  const run = async (...args: string[]) => {
    try {
      return { ...await exec(process.execPath, ['--import', import.meta.resolve('tsx'), join(packageRoot, 'src', 'cli.ts'), ...args], { cwd: root, env: { ...process.env, APPDATA: root }, timeout: 20_000 }), code: 0 };
    } catch (error) {
      const e = error as { stdout: string; stderr: string; code: number };
      return { stdout: e.stdout, stderr: e.stderr, code: e.code };
    }
  };
  return { root, accounts, run };
}

test('command help exposes the same scoped sync syntax as validation errors', async () => {
  const f = await fixture();
  try {
    const help = await f.run();
    const invalid = await f.run('sync', '--account', 'personal');
    assert.equal(help.code, 0, help.stderr);
    assert.equal(invalid.code, 1);
    const usage = invalid.stderr.match(/Usage: (sync .*?)\. No live cutover/)?.[1];
    assert.ok(usage);
    assert.ok(help.stdout.includes(usage), 'help must expose the accepted account and harness scopes');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('status honors configured defaults and reports missing agent links without mutation', async () => {
  const f = await fixture();
  try {
    const result = await f.run('status');
    assert.equal(result.code, 1, 'configured missing installation must not look healthy');
    assert.match(result.stdout, /work\/pi: native skills only/);
    assert.match(result.stdout, /Agent links/);
    assert.match(result.stdout, /missing/);
    assert.deepEqual(await readdir(f.accounts.work.pi), []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('explicit partial sync previews without writes, then converges while preserving native files', async () => {
  const f = await fixture();
  try {
    const untouched = join(f.accounts.personal.pi, 'settings.json');
    await writeFile(untouched, '{"userOwned":true}\n');
    const preview = await f.run('sync', '--agents-only', '--preview');
    assert.equal(preview.code, 0, preview.stderr);
    assert.match(preview.stdout, /missing/);
    assert.deepEqual(await readdir(f.accounts.work.pi), []);
    const first = await f.run('sync', '--agents-only');
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /created/);
    const second = await f.run('sync', '--agents-only');
    assert.equal(second.code, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /created/);
    assert.match(second.stdout, /unchanged/);
    const status = await f.run('status');
    assert.equal(status.code, 1, 'agent-only sync must not claim that missing runtime/package registrations are ready');
    assert.match(status.stdout, /linked/);
    assert.match(status.stdout, /Runtime registrations\/settings/);
    assert.match(status.stdout, /missing/);
    assert.match(status.stdout, /NOT VERIFIED/);
    assert.equal(await readFile(untouched, 'utf8'), '{"userOwned":true}\n');
    assert.equal((await readdir(f.accounts.work.pi)).includes('skills'), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('standalone staged scan blocks redacted findings and visibly allows infrastructure warnings', async () => {
  const f = await fixture();
  try {
    const missingGit = await f.run('check-staged-secrets', join(f.root, 'missing-repository'));
    assert.equal(missingGit.code, 0);
    assert.match(missingGit.stdout + missingGit.stderr, /warn.*|incomplete/i);
    const fake = 'ghp_' + 'B'.repeat(36);
    await writeFile(join(f.root, 'credential.txt'), fake + '\n');
    await exec('git', ['add', '--', 'credential.txt'], { cwd: f.root });
    const blocked = await f.run('check-staged-secrets');
    assert.equal(blocked.code, 1);
    assert.match(blocked.stdout + blocked.stderr, /block/i);
    assert.equal((blocked.stdout + blocked.stderr).includes(fake), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('standalone package policy reports block/allow/uncertainty without executing its input', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11' }));
    const before = await readdir(f.root);
    const blocked = await f.run('check-package-manager', 'npm install');
    assert.equal(blocked.code, 1);
    assert.match(blocked.stdout + blocked.stderr, /uses pnpm/);
    const allowed = await f.run('check-package-manager', 'pnpm install');
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.match(allowed.stdout, /allow/);
    const uncertain = await f.run('check-package-manager', 'cd "$TARGET" && npm install');
    assert.equal(uncertain.code, 0, uncertain.stderr);
    assert.match(uncertain.stdout + uncertain.stderr, /warn|unresolved/);
    assert.deepEqual(await readdir(f.root), before);
    assert.notEqual((await f.run('check-package-manager')).code, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('native resume listing and preview recover state without launching or rewriting the transcript', async () => {
  const f = await fixture();
  try {
    const directory = join(f.accounts.work.pi, 'sessions', '--fixture--');
    await mkdir(directory, { recursive: true });
    const file = join(directory, 'session.jsonl');
    const timestamp = '2026-01-01T00:00:00.000Z';
    const bytes = [
      { type: 'session', version: 3, id: 'fixture-session', cwd: f.root, timestamp },
      { type: 'model_change', id: 'model', parentId: null, timestamp, provider: 'fixture', modelId: 'fixture-model' },
      { type: 'thinking_level_change', id: 'thinking', parentId: 'model', timestamp, thinkingLevel: 'low' },
    ].map(row => JSON.stringify(row)).join('\n');
    await writeFile(file, bytes);
    const list = await f.run('resume', '--list');
    assert.equal(list.code, 0, list.stderr);
    const listed = JSON.parse(list.stdout);
    assert.equal(listed.sessions[0].id, 'fixture-session');
    assert.equal(listed.sessions[0].account, 'work');
    assert.equal(listed.sessions[0].thinking, 'low');
    const preview = await f.run('resume', '--preview', file, '--account', 'work');
    assert.equal(preview.code, 0, preview.stderr);
    const planned = JSON.parse(preview.stdout);
    assert.deepEqual(planned.plan.args, ['--session', file]);
    assert.equal(planned.plan.fields.model.provenance, 'recovered');
    assert.equal(planned.launchVerified, false);
    assert.equal(await readFile(file, 'utf8'), bytes);
    const invalid = await f.run('resume', '--preview', file, '--account', 'work', '--thinking', 'invalid');
    assert.equal(invalid.code, 1);
    assert.equal(await readFile(file, 'utf8'), bytes);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('explicit Orca-only sync previews and converges without copying unrelated settings', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.accounts.personal.pi, 'extensions'));
    for (const name of ['orca-agent-status.ts', 'orca-prefill.ts', 'orca-titlebar-spinner.ts']) {
      await writeFile(join(f.accounts.personal.pi, 'extensions', name), '// @orca-managed-pi-extension\n');
    }
    await writeFile(join(f.accounts.personal.claude, 'settings.json'), JSON.stringify({ sourceOnly: 'do-not-copy', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'agent-hooks/claude-hook.cmd' }] }] } }));
    const target = join(f.accounts.work.claude, 'settings.json');
    await writeFile(target, '{"userOwned":true}\n');
    const preview = await f.run('sync', '--orca-hooks-only', '--preview');
    assert.equal(preview.code, 0, preview.stderr);
    assert.match(preview.stdout, /would-create/);
    assert.deepEqual(await readdir(f.accounts.work.pi), []);
    assert.equal(await readFile(target, 'utf8'), '{"userOwned":true}\n');
    const first = await f.run('sync', '--orca-hooks-only');
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /created/);
    const second = await f.run('sync', '--orca-hooks-only');
    assert.equal(second.code, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /created|updated/);
    assert.match(second.stdout, /unchanged/);
    const settings = JSON.parse(await readFile(target, 'utf8'));
    assert.equal(settings.userOwned, true);
    assert.equal(settings.sourceOnly, undefined);
    assert.equal(settings.hooks.Stop.length, 1);
    assert.notEqual((await f.run('sync', '--orca-hooks-only', '--agents-only')).code, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('scoped Orca Pi sync does not access or change Claude settings', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.accounts.personal.pi, 'extensions'));
    for (const name of ['orca-agent-status.ts', 'orca-prefill.ts', 'orca-titlebar-spinner.ts']) {
      await writeFile(join(f.accounts.personal.pi, 'extensions', name), '// @orca-managed-pi-extension\n');
    }
    await rm(f.accounts.personal.claude, { recursive: true });
    const target = join(f.accounts.work.claude, 'settings.json');
    await writeFile(target, '{"userOwned":true}\n');
    const preview = await f.run('sync', '--orca-hooks-only', '--harness', 'pi', '--preview');
    assert.equal(preview.code, 0, preview.stderr);
    assert.doesNotMatch(preview.stdout, /claude|settings\.json/i);
    assert.deepEqual(await readdir(f.accounts.work.pi), []);
    const applied = await f.run('sync', '--orca-hooks-only', '--harness', 'pi');
    assert.equal(applied.code, 0, applied.stderr);
    assert.deepEqual((await readdir(join(f.accounts.work.pi, 'extensions'))).sort(), [
      'orca-agent-status.ts', 'orca-prefill.ts', 'orca-titlebar-spinner.ts',
    ]);
    assert.equal(await readFile(target, 'utf8'), '{"userOwned":true}\n');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('scoped runtime-only sync applies personal Pi without accessing or changing unselected roots', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.accounts.personal.pi, 'settings.json'), JSON.stringify({ packages: ['keep'], providers: { fixture: true }, model: 'keep-model' }));
    await rm(f.accounts.personal.claude, { recursive: true });
    await rm(f.accounts.work.pi, { recursive: true });
    await rm(f.accounts.work.claude, { recursive: true });
    const preview = await f.run('sync', '--runtime-only', '--account', 'personal', '--harness', 'pi', '--preview');
    assert.equal(preview.code, 0, preview.stderr);
    assert.deepEqual(await readdir(f.accounts.personal.pi), ['settings.json']);
    const applied = await f.run('sync', '--runtime-only', '--account', 'personal', '--harness', 'pi');
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(applied.stdout, /personal\/pi/);
    const settings = JSON.parse(await readFile(join(f.accounts.personal.pi, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.packages, ['keep']);
    assert.deepEqual(settings.providers, { fixture: true });
    assert.equal(settings.model, 'keep-model');
    assert.equal(settings.treeFilterMode, 'no-tools');
    assert.ok((await readdir(f.accounts.personal.pi)).includes('extensions'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('runtime selectors reject partial, duplicate, malformed, and mixed scope before writes', async () => {
  const f = await fixture();
  try {
    const invalid = [
      ['sync', '--runtime-only', '--account', 'personal'],
      ['sync', '--runtime-only', '--account', 'personal', '--harness', 'native'],
      ['sync', '--runtime-only', '--account', 'personal', '--account', 'work', '--harness', 'pi'],
      ['sync', '--account', 'personal', '--harness', 'pi'],
      ['sync', '--runtime-only', '--agents-only', '--account', 'personal', '--harness', 'pi'],
    ];
    for (const invocation of invalid) assert.notEqual((await f.run(...invocation)).code, 0, invocation.join(' '));
    for (const roots of Object.values(f.accounts)) for (const directory of Object.values(roots)) assert.deepEqual(await readdir(directory), []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('full sync preview reports missing managed sources and unknown flags without account writes', async () => {
  const f = await fixture();
  try {
    assert.notEqual((await f.run('sync', '--preview')).code, 0);
    assert.notEqual((await f.run('sync', '--agents-only', '--force')).code, 0);
    for (const roots of Object.values(f.accounts)) for (const directory of Object.values(roots)) assert.deepEqual(await readdir(directory), []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
