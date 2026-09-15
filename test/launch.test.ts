import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createLaunchSpec, runLaunch, confirmLaunch } from '../src/launch.js';
import type { UserConfig } from '../src/contracts.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mpx2-launch-'));
  const roots = { personal: { pi: join(root, 'personal pi'), claude: join(root, 'personal cc') }, work: { pi: join(root, 'work pi'), claude: join(root, 'work cc') } };
  for (const account of Object.values(roots)) for (const p of Object.values(account)) await mkdir(p);
  const config: UserConfig = { accounts: roots, domains: { personal: [join(root, 'personal')], work: [join(root, 'work')] }, executables: { pi: process.execPath, claude: process.execPath } };
  return { root, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const registered = { config: { projectId: 'fixture', repository: { provider: 'github' as const, remote: 'origin' }, issues: { provider: 'kanbanflow' as const } }, warnings: [] };

test('additive arguments and selected native roots preserve all caller argument bytes', async () => {
  const f = await fixture();
  try {
    const args = ['--settings', '{"a":"b c"}', '--', 'line one\nline two', '$(touch nope)', '', 'C:\\a b\\'];
    const packs = { packs: ['development'], paths: [join(f.root, 'pack space')], warnings: [] };
    const spec = await createLaunchSpec({ root: f.root, cwd: join(f.root, 'personal'), harness: 'pi', account: 'work', config: f.config, project: registered, selection: packs, args, env: { MPX_PROJECTS: 'preserved', MPX_SESSION_ID: 'obsolete', MPX_OWNER: 'old', PI_MODEL: 'parent-only' } });
    assert.deepEqual(spec.args, ['--verbose', '--skill', packs.paths[0], ...args]);
    assert.equal(spec.env.PI_CODING_AGENT_DIR, f.config.accounts.work.pi);
    assert.equal(spec.env.MPX_ACCOUNT, 'work');
    assert.equal(spec.env.MPX_ACTIVE_CONTENT_ROOT, f.root);
    assert.equal(spec.env.MPX_PROJECTS, 'preserved');
    assert.equal(spec.env.MPX_SESSION_ID, undefined);
    assert.equal(spec.env.MPX_OWNER, undefined);
    assert.equal(spec.env.PI_MODEL, undefined);
    assert.equal(spec.requiresConfirmation, false);
    const cc = await createLaunchSpec({ root: f.root, cwd: f.root, harness: 'claude', account: 'personal', config: f.config, project: registered, selection: packs, args, env: { SHELL: '/usr/bin/bash', MSYSTEM: 'MINGW64' } });
    assert.deepEqual(cc.args, ['--add-dir', packs.paths[0], ...args]);
    assert.equal(cc.env.CLAUDE_CONFIG_DIR, f.config.accounts.personal.claude);
    assert.equal(cc.env.SHELL, '/usr/bin/bash');
    assert.equal(cc.env.MSYSTEM, 'MINGW64');
  } finally { await f.cleanup(); }
});

test('personal work-domain and either unregistered account wait; path boundaries are not prefixes', async () => {
  const f = await fixture();
  try {
    const base = { root: f.root, harness: 'pi' as const, config: f.config, selection: { packs: [], paths: [], warnings: [] }, args: [] };
    assert.equal((await createLaunchSpec({ ...base, cwd: join(f.root, 'work', 'repo'), account: 'personal', project: registered })).requiresConfirmation, true);
    assert.equal((await createLaunchSpec({ ...base, cwd: join(f.root, 'work-other'), account: 'personal', project: registered })).requiresConfirmation, false);
    assert.equal((await createLaunchSpec({ ...base, cwd: f.root, account: 'work', project: { warnings: [] } })).requiresConfirmation, true);
    assert.equal((await createLaunchSpec({ ...base, cwd: join(f.root, 'elsewhere'), account: 'personal', project: { ...registered, mainCheckout: join(f.root, 'work', 'main') } })).requiresConfirmation, true);
  } finally { await f.cleanup(); }
});

test('missing account/executable blocks only launch; xpi adds no packs or MPX runtime context', async () => {
  const f = await fixture();
  try {
    const base = { root: f.root, cwd: f.root, harness: 'pi' as const, account: 'personal' as const, config: f.config, project: registered, selection: { packs: ['development'], paths: ['/pack'], warnings: [] }, args: ['-e', '/explicit.ts'] };
    const native = await createLaunchSpec({ ...base, native: true, env: { MPX_ACCOUNT: 'work', MPX_ACTIVE_CONTENT_ROOT: '/old', MPX_WORK: '/kept' } });
    assert.deepEqual(native.args, ['--verbose', '--no-extensions', '-e', '/explicit.ts']);
    assert.equal(native.env.MPX_ACCOUNT, undefined);
    assert.equal(native.env.MPX_ACTIVE_CONTENT_ROOT, undefined);
    assert.equal(native.env.MPX_WORK, '/kept');
    assert.match(native.label, /discovery-disabled/);
    f.config.executables!.pi = join(f.root, 'missing');
    await assert.rejects(createLaunchSpec(base), /executable/i);
    f.config.executables!.pi = process.execPath;
    await rm(f.config.accounts.personal.pi, { recursive: true });
    await assert.rejects(createLaunchSpec(base), /account root/i);
  } finally { await f.cleanup(); }
});

test('real disposable process receives positional arguments intact and exit status propagates', async () => {
  const f = await fixture();
  try {
    const script = join(f.root, 'capture.mjs');
    await writeFile(script, 'process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),account:process.env.MPX_ACCOUNT}));process.exitCode=7;');
    const args = ['a b', '', '$HOME', 'a"b', 'first\nsecond', 'C:\\ends\\'];
    let output = '';
    const code = await runLaunch({ executable: process.execPath, args: [script, ...args], cwd: f.root, env: { ...process.env, MPX_ACCOUNT: 'work' }, label: 'fixture', warnings: [], requiresConfirmation: false }, chunk => { output += chunk; });
    assert.equal(code, 7);
    assert.deepEqual(JSON.parse(output), { args, cwd: f.root, account: 'work' });
  } finally { await f.cleanup(); }
});

test('all Git Bash wrapper entrypoints forward account and hostile-looking arguments to a shell shim', async () => {
  const f = await fixture();
  const exec = promisify(execFile);
  try {
    const appdata = join(f.root, 'appdata');
    await mkdir(join(appdata, 'mpx2'), { recursive: true });
    await exec('git', ['init', '--quiet'], { cwd: f.root });
    await writeFile(join(f.root, 'mpxconfig.json'), JSON.stringify({ ...registered.config, packs: [] }));
    const capture = join(f.root, 'capture.mjs');
    await writeFile(capture, 'console.log(JSON.stringify({args:process.argv.slice(2),pi:process.env.PI_CODING_AGENT_DIR,cc:process.env.CLAUDE_CONFIG_DIR,account:process.env.MPX_ACCOUNT,cwd:process.cwd()}));');
    const shim = join(f.root, 'native shim');
    await writeFile(shim, '#!/usr/bin/env bash\nexec node "$FIXTURE_CAPTURE" "$@"\n');
    f.config.executables = { pi: shim, claude: shim };
    await writeFile(join(appdata, 'mpx2', 'config.json'), JSON.stringify(f.config));
    const nativeArgs = ['--', 'a b', '', 'first\nsecond', '$(touch NEVER)', 'a"b', 'C:\\path\\'];
    for (const [wrapper, account, harness] of [['pi', 'personal', 'pi'], ['piw', 'work', 'pi'], ['cc', 'personal', 'claude'], ['ccw', 'work', 'claude'], ['xpi', 'personal', 'pi']] as const) {
      // Enter through a real shell command, not Node's unquoted LF -> MSYS boundary.
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const command = ['bash', fileURLToPath(new URL(`../bin/${wrapper}`, import.meta.url)), ...nativeArgs].map(quote).join(' ');
      const { stdout } = await exec('bash', ['--noprofile', '--norc', '-c', command], {
        cwd: f.root, env: { ...process.env, APPDATA: appdata, FIXTURE_CAPTURE: capture }, timeout: 20_000,
      });
      const actual = JSON.parse(stdout.trim());
      const prefix = wrapper === 'xpi' ? ['--verbose', '--no-extensions'] : harness === 'pi' ? ['--verbose'] : [];
      assert.deepEqual(actual.args, [...prefix, ...nativeArgs]);
      assert.equal(actual[harness === 'pi' ? 'pi' : 'cc'], f.config.accounts[account][harness]);
      assert.equal(actual.account, wrapper === 'xpi' ? undefined : account);
      assert.equal(actual.cwd, f.root);
    }
  } finally { await f.cleanup(); }
});

test('mixed-case Windows environment cannot restore stale model/session or account selectors', async () => {
  const f = await fixture();
  try {
    const spec = await createLaunchSpec({ root: f.root, cwd: f.root, harness: 'pi', account: 'work', config: f.config, project: registered, selection: { packs: [], paths: [], warnings: [] }, args: [],
      env: { ...process.env, pi_model: 'stale', Pi_Provider: 'stale', pi_reasoning_level: 'stale', pi_session_file: '/old', pi_coding_agent_dir: '/old-personal', mpx_account: 'personal', mpx_owner: 'legacy' },
    });
    assert.equal(Object.keys(spec.env).filter(key => key.toUpperCase() === 'PI_CODING_AGENT_DIR').length, 1);
    let output = '';
    await runLaunch({ ...spec, args: ['-e', 'console.log(JSON.stringify({model:process.env.PI_MODEL,provider:process.env.PI_PROVIDER,effort:process.env.PI_REASONING_LEVEL,session:process.env.PI_SESSION_FILE,account:process.env.MPX_ACCOUNT,root:process.env.PI_CODING_AGENT_DIR}))'] }, chunk => { output += chunk; });
    assert.deepEqual(JSON.parse(output), { account: 'work', root: f.config.accounts.work.pi });
  } finally { await f.cleanup(); }
});

test('confirmation does not silently proceed without terminal input', async () => {
  await assert.rejects(confirmLaunch({ requiresConfirmation: true } as never, { isTTY: false } as never), /interactive|terminal/i);
});
