import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const AGENT_RESURRECT = 'C:/_MP_projects/agent-resurrect';
const INSTALLED_EXTENSION = 'C:/Users/snapy/.pi/agent/extensions/agent-resurrect.ts';
const PI_EXECUTABLE = process.env.MPX_PI_EXECUTABLE;
const BASH_EXECUTABLE = process.env.MPX_GIT_BASH ?? 'C:/_MP_apps/Git/bin/bash.exe';
const TIMEOUT_MS = 30_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function quote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

async function waitFor(check, description, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

function start(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = '';
  let stderr = '';
  const records = [];
  child.stdout.on('data', chunk => {
    pending += chunk.toString('utf8');
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { /* Native startup diagnostics remain captured in stderr. */ }
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-64 * 1024); });
  return { child, records, stderr: () => stderr };
}

async function rpc(runtime, id = `state-${Date.now()}`) {
  runtime.child.stdin.write(`${JSON.stringify({ id, type: 'get_state' })}\n`);
  const response = await waitFor(
    () => runtime.records.find(record => record?.type === 'response' && record.id === id),
    `Pi RPC ${id}`,
  );
  assert(response.success === true, `Pi RPC failed: ${JSON.stringify(response)}`);
  return response.data;
}

async function stop(runtime) {
  if (!runtime?.child?.pid || runtime.child.exitCode !== null) return;
  runtime.child.stdin.end();
  const closed = await Promise.race([
    new Promise(resolve => runtime.child.once('close', () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), 1_000)),
  ]);
  if (!closed && runtime.child.exitCode === null) {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/pid', String(runtime.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(resolve, 3_000);
      killer.once('close', () => { clearTimeout(timer); resolve(); });
      killer.once('error', () => { clearTimeout(timer); resolve(); });
    });
    await Promise.race([
      new Promise(resolve => runtime.child.once('close', resolve)),
      new Promise(resolve => setTimeout(resolve, 1_000)),
    ]);
  }
}

async function removeDisposableRoot(root) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { await rm(root, { recursive: true, force: true }); return; }
    catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw lastError;
}

async function registryEntry(registryDir) {
  const names = await readdir(registryDir).catch(() => []);
  for (const name of names.filter(name => name.endsWith('.json'))) {
    const entry = JSON.parse(await readFile(path.join(registryDir, name), 'utf8'));
    if (entry.sessionId === 'resurrection-probe-session') return entry;
  }
  return undefined;
}

async function main() {
  assert(PI_EXECUTABLE && path.isAbsolute(PI_EXECUTABLE), 'MPX_PI_EXECUTABLE must select an absolute native Pi executable');
  await Promise.all([access(PI_EXECUTABLE), access(BASH_EXECUTABLE), access(INSTALLED_EXTENSION)]);

  const root = await mkdtemp(path.join(tmpdir(), 'mpx2-agent-resurrect-'));
  const accountRoot = path.join(root, 'pi-account');
  const registryDir = path.join(accountRoot, 'agent-resurrect', 'active-sessions');
  const sessionsDir = path.join(accountRoot, 'sessions', '--resurrection-probe--');
  const savesDir = path.join(root, 'saves');
  const cwd = path.join(root, 'workspace');
  const sessionFile = path.join(sessionsDir, 'resurrection-probe-session.jsonl');
  const shim = path.join(root, 'native-pi-probe.sh');
  const argvLog = path.join(root, 'restore-argv.txt');
  const cwdLog = path.join(root, 'restore-cwd.txt');
  const accountLog = path.join(root, 'restore-account.txt');
  const launchScript = path.join(root, 'restore-launch.sh');
  let initial;
  let restored;

  try {
    await Promise.all([
      mkdir(registryDir, { recursive: true }),
      mkdir(sessionsDir, { recursive: true }),
      mkdir(savesDir, { recursive: true }),
      mkdir(cwd, { recursive: true }),
    ]);
    const provider = 'mpx-resurrection-probe';
    const model = 'exact-native-model';
    const thinking = 'high';
    await writeFile(path.join(accountRoot, 'models.json'), `${JSON.stringify({ providers: {
      [provider]: {
        baseUrl: 'http://127.0.0.1:1', api: 'openai-completions', apiKey: 'disposable-probe-only',
        models: [{ id: model, reasoning: true, thinkingLevelMap: { high: 'high' } }],
      },
    } }, null, 2)}\n`);
    const iso = seconds => new Date(Date.UTC(2026, 8, 14, 0, 0, seconds)).toISOString();
    await writeFile(sessionFile, [
      { type: 'session', version: 3, id: 'resurrection-probe-session', timestamp: iso(0), cwd },
      { type: 'message', id: 'u1', parentId: null, timestamp: iso(1), message: { role: 'user', content: 'DISPOSABLE_AGENT_RESURRECT_MARKER' } },
      { type: 'model_change', id: 'm2', parentId: 'u1', timestamp: iso(2), provider, modelId: model },
      { type: 'thinking_level_change', id: 't3', parentId: 'm2', timestamp: iso(3), thinkingLevel: thinking },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');

    const isolationArgs = [
      '--mode', 'rpc', '--no-skills', '--no-prompt-templates', '--no-themes',
      '--no-context-files', '--no-tools', '--offline',
    ];
    await writeFile(shim, [
      '#!/usr/bin/env bash',
      `pwd > ${quote(cwdLog)}`,
      `printf '%s\\n' "$PI_CODING_AGENT_DIR" > ${quote(accountLog)}`,
      `printf '%s\\n' "$@" > ${quote(argvLog)}`,
      `exec ${quote(PI_EXECUTABLE)} "$@" ${isolationArgs.map(quote).join(' ')}`,
      '',
    ].join('\n'));
    await chmod(shim, 0o755);

    const config = {
      bashPath: BASH_EXECUTABLE,
      accounts: {},
      wtSettingsPath: path.join(root, 'absent-wt-settings.json'),
      savesDir,
      mpxEnabled: false,
      piAccounts: {
        probe: { command: shim, agentDir: accountRoot, registryDir },
      },
      nativeLaunchers: {
        pi: { probe: { args: ['--no-extensions', '-e', INSTALLED_EXTENSION] } },
      },
    };

    const commonArgs = [
      '--session', sessionFile, '--mode', 'rpc', '--no-extensions', '-e', INSTALLED_EXTENSION,
      '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-tools', '--offline',
    ];
    const initialEnv = { ...process.env, PI_CODING_AGENT_DIR: accountRoot, PI_OFFLINE: '1' };
    for (const name of ['PI_MODEL', 'PI_PROVIDER', 'PI_REASONING_LEVEL', 'PI_SESSION_ID', 'PI_SESSION_FILE']) delete initialEnv[name];
    initial = start(BASH_EXECUTABLE, [PI_EXECUTABLE, ...commonArgs], cwd, initialEnv);
    const initialState = await rpc(initial, 'initial-state');
    const initialRegistration = await waitFor(() => registryEntry(registryDir), 'installed Agent Resurrect registration');
    assert(initialRegistration.ownership === 'native', `Expected native registration, got ${initialRegistration.ownership}`);

    const [{ runHeadlessSave }, { readSave }, { resurrectSessions, buildSessionLaunch }] = await Promise.all([
      import(pathToFileURL(path.join(AGENT_RESURRECT, 'src', 'cli', 'save.js')).href),
      import(pathToFileURL(path.join(AGENT_RESURRECT, 'src', 'saves-store.js')).href),
      import(pathToFileURL(path.join(AGENT_RESURRECT, 'src', 'resurrect.js')).href),
    ]);
    const saveStdout = [];
    const saveStderr = [];
    const saveExitCodes = [];
    await runHeadlessSave(config, 'native-pi-probe', {
      toast: () => ({ ok: false }),
      stdout: line => saveStdout.push(line),
      stderr: line => saveStderr.push(line),
      setExitCode: code => saveExitCodes.push(code),
    });
    assert(saveExitCodes.length === 0, `Current save failed: ${saveStderr.join('; ')}`);
    const saved = readSave(savesDir, 'native-pi-probe');
    assert(saved?.sessions?.length === 1, `Expected one saved session, got ${saved?.sessions?.length ?? 0}`);
    assert(saved.sessions[0].sessionFile === sessionFile.replaceAll('\\', '/'), 'Saved session file changed');

    await stop(initial);
    initial = undefined;
    await waitFor(async () => !(await registryEntry(registryDir)), 'initial registration cleanup/filtering').catch(() => true);

    let dispatched;
    const plan = await resurrectSessions(saved.sessions, {
      config,
      inspectSelected: async () => ({ liveKeys: new Set(), unavailable: [] }),
      launch: sessions => {
        assert(sessions.length === 1, `Expected one restore dispatch, got ${sessions.length}`);
        const recipe = buildSessionLaunch(sessions[0], config, launchScript);
        writeFile(launchScript, recipe.content).then(() => chmod(launchScript, 0o755)).then(() => {
          restored = start(BASH_EXECUTABLE, recipe.bashArgs, cwd, process.env);
        }).catch(error => { dispatched = { error }; });
        dispatched = { recipe, session: sessions[0] };
        return [];
      },
      verifyLaunch: false,
    });
    assert(plan.toOpen.length === 1, `Current restore did not request one launch: ${JSON.stringify(plan)}`);
    await waitFor(() => restored || dispatched?.error, 'restore process creation');
    if (dispatched.error) throw dispatched.error;
    const restoredState = await rpc(restored, 'restored-state');
    const restoredRegistration = await waitFor(() => registryEntry(registryDir), 'restored Agent Resurrect registration');
    const restoreArgv = (await readFile(argvLog, 'utf8')).trim().split(/\r?\n/);
    const restoredCwd = (await readFile(cwdLog, 'utf8')).trim();
    const restoredAccountRoot = (await readFile(accountLog, 'utf8')).trim();

    const result = {
      result: 'pass',
      disposableRootRemovedAfterRun: true,
      source: {
        agentResurrect: AGENT_RESURRECT,
        installedRegistration: INSTALLED_EXTENSION,
      },
      save: {
        completeness: saved.completeness,
        sourceStatuses: saved.sources,
        warnings: saveStderr,
        stdout: saveStdout,
        session: saved.sessions[0],
      },
      initial: {
        cwd,
        accountRoot,
        sessionFile,
        launchArgs: commonArgs,
        observed: {
          sessionId: initialState.sessionId,
          sessionFile: initialState.sessionFile,
          provider: initialState.model?.provider,
          model: initialState.model?.id,
          effort: initialState.thinkingLevel,
          ownership: initialRegistration.ownership,
        },
      },
      restore: {
        cwd: restoredRegistration.cwd,
        shellCwd: restoredCwd,
        accountRoot: restoredAccountRoot,
        sessionFile,
        launchArgs: restoreArgv,
        modelFlags: restoreArgv.filter((value, index) => value === '--model' || restoreArgv[index - 1] === '--model'),
        effortFlags: restoreArgv.filter((value, index) => value === '--thinking' || restoreArgv[index - 1] === '--thinking'),
        observed: {
          sessionId: restoredState.sessionId,
          sessionFile: restoredState.sessionFile,
          provider: restoredState.model?.provider,
          model: restoredState.model?.id,
          effort: restoredState.thinkingLevel,
          ownership: restoredRegistration.ownership,
        },
        plan: {
          requested: plan.toOpen.length,
          alreadyOpen: plan.alreadyOpen.length,
          missingDirectory: plan.missingDirectory.length,
          missingSessionFile: plan.missingSessionFile.length,
          launchUnavailable: plan.launchUnavailable.length,
        },
      },
      limitations: [
        'The current launch script and native Pi process were exercised, but Windows Terminal dispatch and a human-visible TUI were not.',
        'No real account, transcript, credential, save group, installed registration, or Agent Resurrect source was modified.',
      ],
    };
    assert(restoredRegistration.cwd.replaceAll('\\', '/').toLowerCase() === cwd.replaceAll('\\', '/').toLowerCase(), 'Restore cwd mismatch');
    assert(restoredAccountRoot.replaceAll('\\', '/') === accountRoot.replaceAll('\\', '/'), 'Restore account mismatch');
    assert(restoredState.sessionId === 'resurrection-probe-session', 'Restore session ID mismatch');
    assert(restoredState.model?.provider === provider && restoredState.model?.id === model, 'Restore model mismatch');
    assert(restoredState.thinkingLevel === thinking, 'Restore effort mismatch');
    assert(!restoreArgv.includes('--dangerously-skip-permissions'), 'Restore replayed a skip-permissions flag');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await stop(initial);
    await stop(restored);
    await removeDisposableRoot(root);
  }
}

main().catch(error => {
  console.error(`[agent-resurrect-probe] ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
