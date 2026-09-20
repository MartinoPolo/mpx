import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
test('native filters isolate automatic MPX resources while explicit legacy loading survives', async () => {
  const scratch = fileURLToPath(new URL('../.local/', import.meta.url));
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'mpx-pilot-filters-'));
  try {
    const home = path.join(root, 'home');
    const account = path.join(home, '.pi/agent');
    await mkdir(account, { recursive: true });
    const { stdout } = await execute(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./fixtures/native-pilot-filters.ts', import.meta.url)), root], {
      cwd: root, timeout: 20_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), PI_CODING_AGENT_DIR: account, PI_OFFLINE: '1', PI_TELEMETRY: '0', MPX_ACCOUNT: '', MPX_ACTIVE_CONTENT_ROOT: '' },
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { autoDisplayDisabled: true, independentExtensionsRetained: true, sharedProjectSkillsRetained: true, explicitLegacyDisplayAndSkillsRestored: true, installedRuntimeRegistrationLoads: true });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
