import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { LaunchSpec, UserConfig } from '../src/contracts.js';
import { updatePiExtensions } from '../src/pi-extension-update.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mpx-update-pi-'));
  const personal = join(root, 'personal account');
  const work = join(root, 'work account');
  await mkdir(personal);
  await mkdir(work);
  const executable = join(root, 'native pi');
  await writeFile(executable, '');
  const config: UserConfig = {
    accounts: { personal: { pi: personal, claude: join(root, 'personal-claude') }, work: { pi: work, claude: join(root, 'work-claude') } },
    domains: { personal: [], work: [] }, executables: { pi: executable },
  };
  return { root, personal, work, executable, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('native updater runs both accounts in order, isolated from project cwd and inherited session state', async () => {
  const fixtureData = await fixture();
  try {
    const seen: LaunchSpec[] = [];
    const code = await updatePiExtensions(fixtureData.config, {
      MPX_PI_EXECUTABLE: join(fixtureData.root, 'ignored'), MPX_ACCOUNT: 'old', MPX_ACTIVE_CONTENT_ROOT: 'old',
      pi_coding_agent_dir: 'old', PI_SESSION_FILE: 'old', PI_SESSION_ID: 'old', PI_CODING_AGENT_SESSION_DIR: 'old',
      PI_MODEL: 'old', PI_PROVIDER: 'old', PI_REASONING_LEVEL: 'old', SAFE_VARIABLE: 'retained',
    }, async spec => { seen.push(spec); return 0; });
    assert.equal(code, 0);
    assert.deepEqual(seen.map(spec => ({ executable: spec.executable, args: spec.args, cwd: spec.cwd, root: spec.env.PI_CODING_AGENT_DIR })), [
      { executable: fixtureData.executable, args: ['update', '--extensions'], cwd: fixtureData.personal, root: fixtureData.personal },
      { executable: fixtureData.executable, args: ['update', '--extensions'], cwd: fixtureData.work, root: fixtureData.work },
    ]);
    for (const spec of seen) {
      assert.equal(spec.env.SAFE_VARIABLE, 'retained');
      for (const key of ['MPX_ACCOUNT', 'MPX_ACTIVE_CONTENT_ROOT', 'PI_SESSION_FILE', 'PI_SESSION_ID', 'PI_CODING_AGENT_SESSION_DIR', 'PI_MODEL', 'PI_PROVIDER', 'PI_REASONING_LEVEL']) assert.equal(spec.env[key], undefined);
      assert.deepEqual(Object.keys(spec.env).filter(key => key.toUpperCase() === 'PI_CODING_AGENT_DIR'), ['PI_CODING_AGENT_DIR']);
      assert.equal(spec.requiresConfirmation, false);
    }
  } finally { await fixtureData.cleanup(); }
});

test('update failure stops before second account and propagates nonzero status', async () => {
  const fixtureData = await fixture();
  try {
    const attempted: string[] = [];
    const code = await updatePiExtensions(fixtureData.config, {}, async spec => { attempted.push(spec.cwd); return 23; });
    assert.equal(code, 23);
    assert.deepEqual(attempted, [fixtureData.personal]);
  } finally { await fixtureData.cleanup(); }
});

test('invalid native executable or account root fails before any updater runs', async () => {
  const fixtureData = await fixture();
  try {
    const invoked: string[] = [];
    const run = async (spec: LaunchSpec) => { invoked.push(spec.cwd); return 0; };
    await rm(fixtureData.work, { recursive: true });
    await assert.rejects(updatePiExtensions(fixtureData.config, {}, run), /work.*account root/i);
    await mkdir(fixtureData.work);
    fixtureData.config.executables!.pi = join(fixtureData.root, 'missing');
    await assert.rejects(updatePiExtensions(fixtureData.config, {}, run), /executable/i);
    assert.deepEqual(invoked, []);
  } finally { await fixtureData.cleanup(); }
});
