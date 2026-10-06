import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createLaunchSpec, runLaunch, confirmLaunch, formatLaunchWarning } from '../src/launch.js';
import { LAUNCH_WARNING_CODE, WARNING_SEVERITY, type UserConfig } from '../src/contracts.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mpx-launch-'));
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
    const spec = await createLaunchSpec({ root: f.root, cwd: join(f.root, 'personal'), harness: 'pi', account: 'personal', config: f.config, project: registered, selection: packs, args, env: { MPX_PROJECTS: 'preserved', MPX_AI_GENERATED: 'saved', MPX_AI_DUMP: 'inspectable', MPX_TEMP: 'disposable', MPX_SESSION_ID: 'obsolete', MPX_OWNER: 'old', PI_MODEL: 'parent-only' } });
    assert.deepEqual(spec.args, ['--skill', packs.paths[0], ...args]);
    const verbose = await createLaunchSpec({ root: f.root, cwd: join(f.root, 'personal'), harness: 'pi', account: 'personal', config: f.config, project: registered, selection: packs, args: ['--verbose'] });
    assert.deepEqual(verbose.args, ['--skill', packs.paths[0], '--verbose']);
    assert.equal(spec.env.PI_CODING_AGENT_DIR, f.config.accounts.personal.pi);
    assert.equal(spec.env.MPX_ACCOUNT, 'personal');
    assert.equal(spec.env.MPX_ACTIVE_CONTENT_ROOT, f.root);
    assert.equal(spec.env.MPX_PROJECTS, 'preserved');
    assert.equal(spec.env.MPX_AI_GENERATED, 'saved');
    assert.equal(spec.env.MPX_AI_DUMP, 'inspectable');
    assert.equal(spec.env.MPX_TEMP, 'disposable');
    assert.equal(spec.env.MPX_SESSION_ID, undefined);
    assert.equal(spec.env.MPX_OWNER, undefined);
    assert.equal(spec.env.PI_MODEL, undefined);
    assert.equal(spec.requiresConfirmation, false);
    assert.equal(spec.label, 'MPX · PERSONAL · Pi');
    const cc = await createLaunchSpec({ root: f.root, cwd: f.root, harness: 'claude', account: 'personal', config: f.config, project: registered, selection: packs, args, env: { SHELL: '/usr/bin/bash', MSYSTEM: 'MINGW64' } });
    assert.deepEqual(cc.args, ['--add-dir', packs.paths[0], ...args]);
    assert.equal(cc.env.CLAUDE_CONFIG_DIR, f.config.accounts.personal.claude);
    assert.equal(cc.label, 'MPX · PERSONAL · Claude');
    assert.equal(cc.env.SHELL, '/usr/bin/bash');
    assert.equal(cc.env.MSYSTEM, 'MINGW64');
  } finally { await f.cleanup(); }
});

test('ownership and configuration warnings are typed, prioritized, deduplicated, and require confirmation unless work reaches personal', async () => {
  const f = await fixture();
  try {
    const base = { root: f.root, harness: 'pi' as const, config: f.config, selection: { packs: [], paths: [], warnings: [] }, args: [] };
    const red = await createLaunchSpec({ ...base, cwd: join(f.root, 'work', 'repo'), account: 'personal', project: { warnings: [] } });
    assert.deepEqual(red.warnings.map(warning => [warning.code, warning.severity]), [
      ['personal-in-work', 'red'], ['project-config-missing', 'yellow'],
    ]);
    assert.equal(red.requiresConfirmation, true);
    const orange = await createLaunchSpec({ ...base, cwd: join(f.root, 'personal', 'repo'), account: 'work', project: registered });
    assert.deepEqual(orange.warnings.map(warning => warning.code), ['work-in-personal']);
    assert.equal(orange.requiresConfirmation, false);
    const orangeWithoutConfig = await createLaunchSpec({ ...base, cwd: join(f.root, 'personal', 'repo'), account: 'work', project: { warnings: [] } });
    assert.equal(orangeWithoutConfig.requiresConfirmation, true);
    const unknown = await createLaunchSpec({ ...base, cwd: join(f.root, 'elsewhere'), account: 'personal', project: registered });
    assert.equal(unknown.warnings[0]?.code, 'ownership-unknown');
    assert.equal(unknown.requiresConfirmation, true);
    assert.match(formatLaunchWarning(red.warnings[0]!), /^\x1b\[31m\[personal-in-work\]: /);
  } finally { await f.cleanup(); }
});

test('warning formatting retains severity colors without spelling out color names', () => {
  const colors = {
    [WARNING_SEVERITY.red]: '\x1b[31m',
    [WARNING_SEVERITY.orange]: '\x1b[38;5;208m',
    [WARNING_SEVERITY.yellow]: '\x1b[33m',
  };
  for (const severity of Object.values(WARNING_SEVERITY)) {
    assert.equal(
      formatLaunchWarning({ code: LAUNCH_WARNING_CODE.projectConfigMissing, severity, message: 'Configuration missing.' }),
      `${colors[severity]}[project-config-missing]: Configuration missing.\x1b[0m`,
    );
  }
});

test('project diagnostics survive pack selection and do not falsely claim missing configuration', async () => {
  const f = await fixture();
  try {
    for (const code of [LAUNCH_WARNING_CODE.projectConfigInvalid, LAUNCH_WARNING_CODE.projectOverrideInvalid, LAUNCH_WARNING_CODE.projectDiscoveryFailed]) {
      const spec = await createLaunchSpec({
        root: f.root, cwd: join(f.root, 'personal'), harness: 'pi', account: 'personal', config: f.config,
        project: { warnings: [{ code, severity: WARNING_SEVERITY.orange, message: 'Cannot resolve project metadata.' }] },
        selection: { packs: [], paths: [], warnings: [] }, args: [],
      });
      assert.deepEqual(spec.warnings.map(warning => warning.code), [code]);
      assert.equal(spec.requiresConfirmation, true);
    }
  } finally { await f.cleanup(); }
});

test('shared domains suppress ownership warnings for both accounts and harnesses, but not project warnings', async () => {
  const f = await fixture();
  try {
    const shared = join(f.root, 'shared');
    const child = join(shared, 'nested');
    await mkdir(child, { recursive: true });
    f.config.domains.shared = [shared];
    for (const harness of ['pi', 'claude'] as const) {
      for (const account of ['personal', 'work'] as const) {
        const base = { root: f.root, cwd: child, harness, account, config: f.config,
          selection: { packs: [], paths: [], warnings: [] }, args: [] };
        const configured = await createLaunchSpec({ ...base, project: registered });
        assert.deepEqual(configured.warnings, []);
        assert.equal(configured.requiresConfirmation, false);
        const missing = await createLaunchSpec({ ...base, project: { warnings: [] } });
        assert.deepEqual(missing.warnings.map(warning => warning.code), [LAUNCH_WARNING_CODE.projectConfigMissing]);
        const invalid = await createLaunchSpec({ ...base, project: {
          warnings: [{ code: LAUNCH_WARNING_CODE.projectConfigInvalid, severity: WARNING_SEVERITY.orange, message: 'Invalid manifest.' }],
        } });
        assert.deepEqual(invalid.warnings.map(warning => warning.code), [LAUNCH_WARNING_CODE.projectConfigInvalid]);
        const omitted = await createLaunchSpec({ ...base, project: { warnings: [], configOmitted: true } });
        assert.deepEqual(omitted.warnings, []);
        const sibling = await createLaunchSpec({ ...base, cwd: join(f.root, 'shared-sibling'), project: registered });
        assert.deepEqual(sibling.warnings.map(warning => warning.code), [LAUNCH_WARNING_CODE.ownershipUnknown]);
      }
    }
  } finally { await f.cleanup(); }
});

test('explicit ownership wins over shared domains in cwd and main checkout', async () => {
  const f = await fixture();
  try {
    f.config.domains.shared = [join(f.root, 'shared'), join(f.root, 'personal', 'nested-shared')];
    f.config.domains.work.push(join(f.root, 'shared', 'work-owned'));
    const base = { root: f.root, harness: 'pi' as const, config: f.config, project: registered,
      selection: { packs: [], paths: [], warnings: [] }, args: [] };
    const personal = await createLaunchSpec({ ...base, cwd: join(f.root, 'personal', 'nested-shared', 'child'), account: 'work' });
    assert.deepEqual(personal.warnings.map(warning => warning.code), [LAUNCH_WARNING_CODE.workInPersonal]);
    const work = await createLaunchSpec({ ...base, cwd: join(f.root, 'shared', 'work-owned', 'child'), account: 'personal' });
    assert.deepEqual(work.warnings.map(warning => warning.code), [LAUNCH_WARNING_CODE.personalInWork]);
    const mainWork = await createLaunchSpec({ ...base, cwd: join(f.root, 'shared'), account: 'personal',
      project: { ...registered, mainCheckout: join(f.root, 'work', 'main') } });
    assert.deepEqual(mainWork.warnings.map(warning => warning.code), [LAUNCH_WARNING_CODE.personalInWork]);
    const mainPersonal = await createLaunchSpec({ ...base, cwd: join(f.root, 'shared'), account: 'work',
      project: { ...registered, mainCheckout: join(f.root, 'personal', 'main') } });
    assert.deepEqual(mainPersonal.warnings.map(warning => warning.code), [LAUNCH_WARNING_CODE.workInPersonal]);
    const workOverPersonal = await createLaunchSpec({ ...base, cwd: join(f.root, 'personal'), account: 'personal',
      project: { ...registered, mainCheckout: join(f.root, 'shared', 'work-owned') } });
    assert.deepEqual(workOverPersonal.warnings.map(warning => warning.code), [LAUNCH_WARNING_CODE.personalInWork]);
    const sharedMain = await createLaunchSpec({ ...base, cwd: join(f.root, 'elsewhere'), account: 'work',
      project: { ...registered, mainCheckout: join(f.root, 'shared') } });
    assert.deepEqual(sharedMain.warnings, []);
  } finally { await f.cleanup(); }
});

test('work ownership wins across canonical cwd and main checkout locations', async () => {
  const f = await fixture();
  try {
    const spec = await createLaunchSpec({
      root: f.root, cwd: join(f.root, 'personal', 'linked'), harness: 'pi', account: 'personal', config: f.config,
      project: { ...registered, mainCheckout: join(f.root, 'work', 'main') }, selection: { packs: [], paths: [], warnings: [] }, args: [],
    });
    assert.equal(spec.warnings[0]?.code, 'personal-in-work');
    assert.match(spec.warnings[0]?.message ?? '', /personal[\\/]linked/);
    assert.match(spec.warnings[0]?.message ?? '', /work[\\/]main/);
  } finally { await f.cleanup(); }
});

test('missing account/executable blocks only launch; xpi adds no packs or MPX runtime context', async () => {
  const f = await fixture();
  try {
    const base = { root: f.root, cwd: f.root, harness: 'pi' as const, account: 'personal' as const, config: f.config, project: registered, selection: { packs: ['development'], paths: ['/pack'], warnings: [{ code: 'native-only' as const, severity: 'orange' as const, message: 'packs unavailable' }] }, args: ['-e', '/explicit.ts'] };
    const native = await createLaunchSpec({ ...base, native: true, env: { MPX_ACCOUNT: 'work', MPX_ACTIVE_CONTENT_ROOT: '/old', MPX_WORK: '/kept' } });
    assert.deepEqual(native.args, ['--no-extensions', '-e', '/explicit.ts']);
    assert.equal(native.env.MPX_ACCOUNT, undefined);
    assert.equal(native.env.MPX_ACTIVE_CONTENT_ROOT, undefined);
    assert.equal(native.env.MPX_WORK, '/kept');
    assert.match(native.label, /discovery-disabled/);
    assert.equal(native.warnings.some(warning => warning.code === 'native-only'), false);
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
    await mkdir(join(appdata, 'mpx'), { recursive: true });
    const launchDirectories = { personal: join(f.root, 'personal'), work: join(f.root, 'work') };
    for (const directory of Object.values(launchDirectories)) {
      await mkdir(directory, { recursive: true });
      await exec('git', ['init', '--quiet'], { cwd: directory });
      await writeFile(join(directory, 'mpxconfig.json'), JSON.stringify({ ...registered.config, packs: [] }));
    }
    const capture = join(f.root, 'capture.mjs');
    await writeFile(capture, 'console.log(JSON.stringify({args:process.argv.slice(2),pi:process.env.PI_CODING_AGENT_DIR,cc:process.env.CLAUDE_CONFIG_DIR,account:process.env.MPX_ACCOUNT,cwd:process.cwd()}));');
    const shim = join(f.root, 'native shim');
    await writeFile(shim, '#!/usr/bin/env bash\nexec node "$FIXTURE_CAPTURE" "$@"\n');
    f.config.executables = { pi: shim, claude: shim };
    await writeFile(join(appdata, 'mpx', 'config.json'), JSON.stringify(f.config));
    const nativeArgs = ['--', 'a b', '', 'first\nsecond', '$(touch NEVER)', 'a"b', 'C:\\path\\'];
    for (const [wrapper, account, harness] of [['pi', 'personal', 'pi'], ['piw', 'work', 'pi'], ['cc', 'personal', 'claude'], ['ccw', 'work', 'claude'], ['xpi', 'personal', 'pi']] as const) {
      // Enter through a real shell command, not Node's unquoted LF -> MSYS boundary.
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const command = ['bash', fileURLToPath(new URL(`../bin/${wrapper}`, import.meta.url)), ...nativeArgs].map(quote).join(' ');
      const { stdout } = await exec('bash', ['--noprofile', '--norc', '-c', command], {
        cwd: launchDirectories[account], env: { ...process.env, APPDATA: appdata, FIXTURE_CAPTURE: capture }, timeout: 20_000,
      });
      const actual = JSON.parse(stdout.trim());
      const prefix = wrapper === 'xpi' ? ['--no-extensions'] : [];
      assert.deepEqual(actual.args, [...prefix, ...nativeArgs]);
      assert.equal(actual[harness === 'pi' ? 'pi' : 'cc'], f.config.accounts[account][harness]);
      assert.equal(actual.account, wrapper === 'xpi' ? undefined : account);
      assert.equal(actual.cwd, launchDirectories[account]);
    }
  } finally { await f.cleanup(); }
});

test('Claude launches root their scratchpad at MPX_TEMP unless CLAUDE_CODE_TMPDIR is already set', async () => {
  const f = await fixture();
  try {
    const launch = (harness: 'pi' | 'claude', env: NodeJS.ProcessEnv) => createLaunchSpec({ root: f.root, cwd: f.root, harness, account: 'personal', config: f.config, project: registered, selection: { packs: [], paths: [], warnings: [] }, args: [], env });
    assert.equal((await launch('claude', { MPX_TEMP: 'C:\\temp' })).env.CLAUDE_CODE_TMPDIR, 'C:\\temp');
    assert.equal((await launch('claude', { MPX_TEMP: 'C:\\temp', CLAUDE_CODE_TMPDIR: 'D:\\own' })).env.CLAUDE_CODE_TMPDIR, 'D:\\own');
    assert.equal((await launch('claude', {})).env.CLAUDE_CODE_TMPDIR, undefined);
    assert.equal((await launch('pi', { MPX_TEMP: 'C:\\temp' })).env.CLAUDE_CODE_TMPDIR, undefined);
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

test('readline confirmation handles fragmented arrows and restores null, paused, flowing, and raw input state', async () => {
  const { PassThrough } = await import('node:stream');
  class TerminalInput extends PassThrough {
    isTTY = true; isRaw = false; rawChanges: boolean[] = [];
    setRawMode(value: boolean) { this.isRaw = value; this.rawChanges.push(value); return this; }
  }
  const spec = { requiresConfirmation: true } as never;

  const initiallyNull = new TerminalInput();
  assert.equal(initiallyNull.readableFlowing, null);
  const accepted = confirmLaunch(spec, initiallyNull as never);
  initiallyNull.write(Buffer.from('\x1b')); initiallyNull.write(Buffer.from('[A\r'));
  await accepted;
  assert.equal(initiallyNull.isPaused(), true);
  assert.equal(initiallyNull.listenerCount('keypress'), 0);

  const paused = new TerminalInput(); paused.pause();
  const pausedResult = confirmLaunch(spec, paused as never); paused.write('\r'); await pausedResult;
  assert.equal(paused.isPaused(), true);

  const flowing = new TerminalInput(); const observer = () => undefined; flowing.on('data', observer);
  const flowingResult = confirmLaunch(spec, flowing as never); flowing.write('\r'); await flowingResult;
  assert.equal(flowing.readableFlowing, true); flowing.off('data', observer);

  const raw = new TerminalInput(); raw.isRaw = true;
  const alreadyRaw = confirmLaunch(spec, raw as never); raw.write('\n'); await alreadyRaw;
  assert.equal(raw.isRaw, true);
});

test('confirmation cleans up when terminal raw-mode setup fails', async () => {
  const { PassThrough } = await import('node:stream');
  class BrokenTerminalInput extends PassThrough {
    isTTY = true; isRaw = false;
    setRawMode() { throw new Error('raw mode unavailable'); }
  }
  const input = new BrokenTerminalInput();
  await assert.rejects(confirmLaunch({ requiresConfirmation: true } as never, input as never), /raw mode unavailable/);
  assert.equal(input.listenerCount('keypress'), 0);
  assert.equal(input.listenerCount('error'), 0);
  assert.equal(input.isPaused(), true);
});

test('confirmation releases listeners and flow when raw-mode restoration fails', async () => {
  const { PassThrough } = await import('node:stream');
  class BrokenRestoreInput extends PassThrough {
    isTTY = true; isRaw = false;
    setRawMode(value: boolean) {
      if (!value) throw new Error('raw restore unavailable');
      this.isRaw = true;
      return this;
    }
  }
  const input = new BrokenRestoreInput();
  const result = confirmLaunch({ requiresConfirmation: true } as never, input as never);
  input.write('\r');
  await assert.rejects(result, /raw restore unavailable/);
  assert.equal(input.listenerCount('keypress'), 0);
  assert.equal(input.listenerCount('error'), 0);
  assert.equal(input.isPaused(), true);
});

test('readline confirmation rejects Ctrl+C, Escape, EOF, and input errors with cleanup', async () => {
  const { PassThrough } = await import('node:stream');
  class TerminalInput extends PassThrough {
    isTTY = true; isRaw = false;
    setRawMode(value: boolean) { this.isRaw = value; return this; }
  }
  const spec = { requiresConfirmation: true } as never;
  for (const [action, message] of [
    [(input: TerminalInput) => input.write(Buffer.from([3])), /Ctrl\+C/],
    [(input: TerminalInput) => input.write(Buffer.from([27])), /Escape/],
    [(input: TerminalInput) => input.end(), /input closed/],
    [(input: TerminalInput) => input.emit('error', new Error('fixture input failure')), /fixture input failure/],
  ] as const) {
    const input = new TerminalInput();
    const result = confirmLaunch(spec, input as never); action(input);
    await assert.rejects(result, message);
    assert.equal(input.isPaused(), true);
    assert.equal(input.listenerCount('keypress'), 0);
    assert.equal(input.listenerCount('error'), 0);
  }
});
