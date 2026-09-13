import assert from 'node:assert/strict';
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
        MPX_ACTIVE_CONTENT_ROOT: 'C:\\mpx2',
      },
      label: 'MPX2 · WORK · Pi', warnings: ['visible warning'], requiresConfirmation: false,
    },
    verification: {
      verified: true, method: 'pi-rpc-read-only-preflight',
      observed: { provider: 'provider', model: 'model', thinking: 'high', availableThinking: ['low', 'high'] },
    },
    ...overrides,
  };
}

test('adapter preserves the exact prepared MPX2 Pi launch without adopting mutable input', () => {
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
  assert.match(recipe.command, /^cd -- 'C:\/fixture\/project' \|\| exit 1; exec /);
  assert.ok(recipe.command.includes("'--skill' 'C:\\mpx packs\\work'"));
  assert.equal(recipe.argv.includes('worker-start'), false);
  assert.equal(recipe.argv.includes('run'), false);
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
