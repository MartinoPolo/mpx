import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

for (const profile of ['personal', 'work'] as const) {
  test(`native composed runtime loads and enforces policy for the ${profile} account`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), `mpx2-native-runtime-${profile}-`));
    try {
      const home = path.join(root, 'home');
      const appdata = path.join(root, 'appdata');
      const accounts = path.join(root, 'accounts');
      const account = path.join(accounts, profile);
      const project = path.join(root, 'project');
      await Promise.all([home, appdata, account, project].map(directory => mkdir(directory, { recursive: true })));
      await execFileAsync('git', ['init', '--quiet'], { cwd: project, timeout: 10_000 });
      await writeFile(path.join(project, 'clean-marker.txt'), 'preserved');
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: appdata,
        PI_CODING_AGENT_DIR: account,
        PI_OFFLINE: '1',
        PI_TELEMETRY: '0',
        MPX_ACCOUNT: profile,
        MPX_ACTIVE_CONTENT_ROOT: packageRoot,
        MPX_PROJECTS: profile === 'personal' ? project : '',
        MPX_WORK: profile === 'work' ? project : '',
      };
      for (const key of Object.keys(env)) {
        if (key.startsWith('ANTHROPIC_') || key.endsWith('_API_KEY') || key.endsWith('_AUTH_TOKEN')) delete env[key as keyof typeof env];
      }
      const fixture = path.join(packageRoot, 'test', 'fixtures', 'native-runtime.ts');
      const extension = path.join(packageRoot, 'extensions', 'pi-runtime.ts');
      const { stdout, stderr } = await execFileAsync(process.execPath, [
        '--import', import.meta.resolve('tsx'), fixture, JSON.stringify({ cwd: project, account, extension, profile }),
      ], { cwd: project, env, timeout: 30_000, maxBuffer: 128 * 1024 });
      assert.equal(stderr, '');
      assert.deepEqual(JSON.parse(stdout.trim()), {
        profile, nativeLoader: true, nativeToolCalls: 4, modelRequests: 0,
        tools: ['Agent', 'get_subagent_result', 'steer_subagent'], markerPreserved: true, safeBytes: 'after',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
