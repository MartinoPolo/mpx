import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

test('native Pi loader/session delivers roots and style without repeated prompt injection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx2-native-context-'));
  try {
    const account = join(root, 'account');
    const cwd = join(root, 'project');
    await mkdir(account);
    await mkdir(cwd);
    await exec('git', ['init', '--quiet'], { cwd });
    const env = { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: account, PI_OFFLINE: '1', PI_TELEMETRY: '0' };
    for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('MPX_')) delete env[key as keyof typeof env];
    Object.assign(env, { MPX_PROJECTS: 'C:/fixture-A', MPX_NOT_A_ROOT: 'never-inject-this' });
    const { stdout } = await exec(process.execPath, ['--import', import.meta.resolve('tsx'), join(packageRoot, 'test', 'fixtures', 'native-context.ts'), JSON.stringify({ cwd, account, extension: join(packageRoot, 'extensions', 'pi-context.ts') })], { cwd: root, env, timeout: 30_000 });
    assert.deepEqual(JSON.parse(stdout.trim()), { prompts: 7, rootMessages: 5, nativeLoader: true, modelRequests: 0, syntheticCompactionBoundary: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
