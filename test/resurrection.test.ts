import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { PreparedResumeLaunch } from '../src/resume-launch.js';
import {
  adaptPreparedPiResurrection,
  buildOrcaPiResurrectionRecipe,
  buildPreparedLaunchCommand,
} from '../src/resurrection.js';

function prepared(overrides: Partial<PreparedResumeLaunch> = {}): PreparedResumeLaunch {
  const accountRoot = 'C:\\fixture\\pi-work';
  const sessionFile = 'C:\\fixture\\pi-work\\sessions\\project\\session.jsonl';
  return {
    plan: {
      harness: 'pi', account: 'work', accountRoot, sessionId: 'session',
      args: ['--session', sessionFile], cwd: 'C:\\fixture\\project',
      fields: {
        provider: { value: 'provider', provenance: 'recovered' },
        model: { value: 'model', provenance: 'recovered' },
        thinking: { value: 'high', provenance: 'recovered' },
      },
      overrideLabels: [],
    },
    spec: {
      executable: 'C:\\native tools\\pi',
      args: ['--verbose', '--skill', 'C:\\mpx packs\\work', '--session', sessionFile],
      cwd: 'C:\\fixture\\project',
      env: {
        PATH: 'C:\\native tools',
        PI_CODING_AGENT_DIR: accountRoot,
        MPX_ACCOUNT: 'work',
        MPX_ACTIVE_CONTENT_ROOT: 'C:\\mpx',
      },
      label: 'MPX · WORK · Pi', warnings: [{ code: 'ownership-unknown', severity: 'yellow', message: 'visible warning' }], requiresConfirmation: true,
    },
    verification: {
      verified: true, method: 'pi-rpc-read-only-preflight',
      observed: { provider: 'provider', model: 'model', thinking: 'high', availableThinking: ['low', 'high'] },
    },
    ...overrides,
  };
}

test('adapter preserves the exact prepared MPX Pi launch without adopting mutable input', () => {
  const source = prepared();
  const launch = adaptPreparedPiResurrection(source);
  assert.deepEqual(launch.spec, source.spec);
  assert.notEqual(launch.spec, source.spec);
  assert.notEqual(launch.spec.args, source.spec.args);
  assert.notEqual(launch.spec.env, source.spec.env);
  assert.notEqual(launch.spec.warnings, source.spec.warnings);
  launch.spec.args.push('--changed-after-adaptation');
  launch.spec.env.PI_CODING_AGENT_DIR = 'C:\\other';
  assert.equal(source.spec.args.includes('--changed-after-adaptation'), false);
  assert.equal(source.spec.env.PI_CODING_AGENT_DIR, source.plan.accountRoot);
});

test('adapter fails closed on unverified, mismatched, non-Pi, and permission-bypass preparations', () => {
  const unverified = prepared({ verification: { verified: false, method: 'unsupported', reason: 'not verified' } });
  assert.throws(() => adaptPreparedPiResurrection(unverified), /unverified/);

  const wrongCwd = prepared();
  wrongCwd.spec.cwd = 'C:\\fixture\\other';
  assert.throws(() => adaptPreparedPiResurrection(wrongCwd), /cwd/);

  const wrongAccount = prepared();
  wrongAccount.spec.env.PI_CODING_AGENT_DIR = 'C:\\fixture\\pi-personal';
  assert.throws(() => adaptPreparedPiResurrection(wrongAccount), /account root/);

  const missingResume = prepared();
  missingResume.spec.args = ['--verbose'];
  assert.throws(() => adaptPreparedPiResurrection(missingResume), /exact resume arguments/);

  const bypass = prepared();
  bypass.spec.args.unshift('--dangerously-skip-permissions');
  assert.throws(() => adaptPreparedPiResurrection(bypass), /permission-bypass/);

  const claude = prepared();
  claude.plan.harness = 'claude';
  assert.throws(() => adaptPreparedPiResurrection(claude), /Pi resumes only/);
});

test('command confirms typed warnings before the unchanged native exec', () => {
  const source = prepared();
  source.spec.warnings = [
    { code: 'work-in-personal', severity: 'orange', message: "don't launch silently" },
    { code: 'ownership-unknown', severity: 'yellow', message: 'visible warning' },
  ];
  const command = buildPreparedLaunchCommand(adaptPreparedPiResurrection(source), source.spec.env);
  const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
  const confirmationCli = fileURLToPath(new URL('../src/confirm-launch-cli.ts', import.meta.url));
  const expectedWarnings = JSON.stringify(source.spec.warnings);
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const confirmation = [process.execPath, tsxCli, confirmationCli, expectedWarnings].map(quote).join(' ');
  const native = `exec ${[source.spec.executable, ...source.spec.args].map(quote).join(' ')}`;
  assert.ok(command.includes(`${confirmation} || exit $?; ${native}`), command);
  assert.ok(command.indexOf(confirmation) < command.indexOf(native));
});

test('warnings cannot bypass acknowledgement when a stale caller clears the confirmation flag', () => {
  const source = prepared();
  source.spec.requiresConfirmation = false;
  const command = buildPreparedLaunchCommand(adaptPreparedPiResurrection(source), source.spec.env);
  assert.match(command, /confirm-launch-cli\.ts/);
});

test('an explicit confirmation request with no diagnostics still invokes acknowledgement', () => {
  const source = prepared();
  source.spec.warnings = [];
  const command = buildPreparedLaunchCommand(adaptPreparedPiResurrection(source), source.spec.env);
  assert.match(command, /confirm-launch-cli\.ts' '\[\]'/);
});

test('command applies only the exact environment delta and keeps argv as quoted data', () => {
  const source = prepared();
  source.spec.args.splice(-2, 0, "apostrophe's-value", 'two words');
  const launch = adaptPreparedPiResurrection(source);
  const ambient = {
    PATH: 'C:\\native tools',
    PI_CODING_AGENT_DIR: 'C:\\stale-account',
    PI_MODEL: 'stale-default',
    MPX_RUNTIME: 'legacy-owner',
  };
  const command = buildPreparedLaunchCommand(launch, ambient);
  assert.match(command, /unset -v .*'MPX_RUNTIME'.*'PI_MODEL'/);
  assert.match(command, /export PI_CODING_AGENT_DIR='C:\\fixture\\pi-work'/);
  assert.match(command, /export MPX_ACCOUNT='work'/);
  assert.doesNotMatch(command, /export PATH=/);
  assert.match(command, /'apostrophe'"'"'s-value'/);
  assert.match(command, /'--session' 'C:\\fixture\\pi-work\\sessions\\project\\session\.jsonl'/);
  assert.doesNotMatch(command, /--dangerously-skip-permissions/);
});

test('Orca recipe uses pinned terminal create interface, explicit workspace, and WORK · Pi label', () => {
  const source = prepared();
  const recipe = buildOrcaPiResurrectionRecipe(source, { ambientEnv: source.spec.env });
  assert.equal(recipe.executable, 'orca');
  assert.equal(recipe.workspace, 'path:C:/fixture/project');
  assert.equal(recipe.title, 'WORK · Pi');
  assert.deepEqual(recipe.argv.slice(0, 6), [
    'terminal', 'create', '--worktree', 'path:C:/fixture/project', '--title', 'WORK · Pi',
  ]);
  assert.deepEqual(recipe.argv.slice(-3), ['--command', recipe.command, '--json']);
  assert.match(recipe.command, /^cd -- 'C:\/fixture\/project' \|\| exit 1; /);
  assert.match(recipe.command, /confirm-launch-cli\.ts.* \|\| exit \$\?; exec /);
  assert.ok(recipe.command.includes("'--skill' 'C:\\mpx packs\\work'"));
  assert.equal(recipe.argv.includes('worker-start'), false);
  assert.equal(recipe.argv.includes('run'), false);
});

test('non-TTY warning acknowledgement fails without spawning the native process', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mpx-resurrection-warning-'));
  try {
    const capture = join(directory, 'native-capture.json');
    const script = join(directory, 'capture.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'spawned');`);
    const source = prepared();
    source.plan.cwd = directory;
    source.spec.cwd = directory;
    source.plan.args = [script, capture];
    source.spec.executable = process.execPath;
    source.spec.args = [script, capture];
    source.spec.env = { ...process.env, PI_CODING_AGENT_DIR: source.plan.accountRoot };
    const command = buildPreparedLaunchCommand(adaptPreparedPiResurrection(source), source.spec.env);
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', command], {
      cwd: directory, env: source.spec.env, encoding: 'utf8', timeout: 20_000,
    });
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /\x1b\[33m\[ownership-unknown\]: visible warning\x1b\[0m/);
    assert.match(result.stderr, /interactive terminal|launch cancelled/i);
    assert.equal(existsSync(capture), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('work-in-personal warning is displayed and launches native without acknowledgement', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mpx-resurrection-informational-'));
  try {
    const capture = join(directory, 'native-capture.json');
    const script = join(directory, 'capture.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'spawned');`);
    const source = prepared();
    source.plan.cwd = directory;
    source.spec.cwd = directory;
    source.plan.args = [script, capture];
    source.spec.executable = process.execPath;
    source.spec.args = [script, capture];
    source.spec.warnings = [{ code: 'work-in-personal', severity: 'orange', message: 'visible warning' }];
    source.spec.requiresConfirmation = false;
    source.spec.env = { ...process.env, PI_CODING_AGENT_DIR: source.plan.accountRoot };
    const command = buildPreparedLaunchCommand(adaptPreparedPiResurrection(source), source.spec.env);
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', command], {
      cwd: directory, env: source.spec.env, encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /\[work-in-personal\]: visible warning/);
    assert.equal(readFileSync(capture, 'utf8'), 'spawned');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('warning-free recipe executes native directly with exact arguments and environment', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mpx-resurrection-native-'));
  try {
    const capture = join(directory, 'native-capture.json');
    const script = join(directory, 'capture.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], JSON.stringify({ args: process.argv.slice(3), account: process.env.MPX_ACCOUNT }));`);
    const source = prepared();
    source.plan.cwd = directory;
    source.spec.cwd = directory;
    source.plan.args = [script, capture, "apostrophe's-value", 'two words'];
    source.spec.executable = process.execPath;
    source.spec.args = [...source.plan.args];
    source.spec.warnings = [];
    source.spec.requiresConfirmation = false;
    source.spec.env = { ...process.env, PI_CODING_AGENT_DIR: source.plan.accountRoot, MPX_ACCOUNT: 'work' };
    const command = buildPreparedLaunchCommand(adaptPreparedPiResurrection(source), process.env);
    assert.doesNotMatch(command, /confirm-launch-cli/);
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', command], {
      cwd: directory, env: process.env, encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {
      args: ["apostrophe's-value", 'two words'], account: 'work',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('confirmation helper safely rejects malformed warning input', () => {
  const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
  const confirmationCli = fileURLToPath(new URL('../src/confirm-launch-cli.ts', import.meta.url));
  for (const malformed of ['not-json', '{}', '[{"code":"unknown","severity":"yellow","message":"bad"}]']) {
    const result = spawnSync(process.execPath, [tsxCli, confirmationCli, malformed], {
      encoding: 'utf8', timeout: 20_000,
    });
    assert.notEqual(result.status, 0, malformed);
    assert.match(result.stderr, /valid JSON|required typed warning format/);
  }
});

test('native Windows environment names are preserved and credential changes are never serialized', () => {
  const source = prepared();
  source.spec.env['ProgramFiles(x86)'] = 'C:\\Program Files (x86)';
  source.spec.env.SECRET_KEY = 'fixture-private-value';
  const launch = adaptPreparedPiResurrection(source);
  const command = buildPreparedLaunchCommand(launch, source.spec.env);
  assert.doesNotMatch(command, /ProgramFiles|SECRET_KEY|fixture-private-value/);
  assert.throws(() => buildPreparedLaunchCommand(launch, { ...source.spec.env, SECRET_KEY: 'changed' }), /unrelated environment/);
});

test('recovered Pi state adds no model/effort flags while explicit overrides remain exact', () => {
  const recoveredSource = prepared();
  const recovered = buildOrcaPiResurrectionRecipe(recoveredSource, { ambientEnv: recoveredSource.spec.env });
  assert.equal(recovered.launch.spec.args.includes('--model'), false);
  assert.equal(recovered.launch.spec.args.includes('--thinking'), false);

  const overridden = prepared();
  overridden.plan.args.push('--model', 'override-model', '--thinking', 'low');
  overridden.plan.fields.model = { value: 'override-model', provenance: 'override' };
  overridden.plan.fields.thinking = { value: 'low', provenance: 'override' };
  overridden.spec.args.push('--model', 'override-model', '--thinking', 'low');
  const recipe = buildOrcaPiResurrectionRecipe(overridden, { ambientEnv: overridden.spec.env });
  assert.deepEqual(recipe.launch.spec.args.slice(-4), ['--model', 'override-model', '--thinking', 'low']);
});
