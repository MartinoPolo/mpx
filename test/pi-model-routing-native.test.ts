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

test('native provider request aborts unsupported Luna before transport dispatch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-model-routing-cancellation-'));
  try {
    const project = path.join(root, 'project');
    const account = path.join(root, 'account');
    await mkdir(project, { recursive: true });
    await mkdir(account, { recursive: true });
    const fixture = path.join(packageRoot, 'test', 'fixtures', 'pi-model-routing-native.ts');
    const extension = path.join(packageRoot, 'extensions', 'pi-runtime.ts');
    const probe = path.join(packageRoot, 'test', 'fixtures', 'pi-model-routing-probe.ts');
    const env = {
      ...process.env, HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'appdata'),
      PI_CODING_AGENT_DIR: account, PI_OFFLINE: '1', MPX_ACCOUNT: 'personal',
      MPX_ACTIVE_CONTENT_ROOT: packageRoot, MPX_PROJECTS: project,
    };
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      '--import', import.meta.resolve('tsx'), fixture,
      JSON.stringify({ cwd: project, account, extension, probe, cancellation: true }),
    ], { cwd: project, env, timeout: 30_000, maxBuffer: 64 * 1024 });
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout.trim()), { aborted: true, dispatched: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native loader uses subagents fuzzy resolution before Agent executes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-model-routing-'));
  try {
    const project = path.join(root, 'project');
    const account = path.join(root, 'account');
    await mkdir(path.join(project, '.pi', 'agents'), { recursive: true });
    await mkdir(path.join(account, 'agents'), { recursive: true });
    await writeFile(path.join(account, 'agents', 'worker.md'), [
      '---', 'name: project-worker', 'model: reviewer', 'thinking: medium', '---', 'Global agent.',
    ].join('\n'));
    await writeFile(path.join(project, '.pi', 'agents', 'worker.md'), [
      '---', 'name: project-worker', 'model: mechanical', 'thinking: low', '---', 'Project override.',
    ].join('\n'));
    const fixture = path.join(packageRoot, 'test', 'fixtures', 'pi-model-routing-native.ts');
    const extension = path.join(packageRoot, 'extensions', 'pi-runtime.ts');
    const probe = path.join(packageRoot, 'test', 'fixtures', 'pi-model-routing-probe.ts');
    const env = {
      ...process.env, HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'appdata'),
      PI_CODING_AGENT_DIR: account, PI_OFFLINE: '1', MPX_ACCOUNT: 'personal',
      MPX_ACTIVE_CONTENT_ROOT: packageRoot, MPX_PROJECTS: project,
    };
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      '--import', import.meta.resolve('tsx'), fixture, JSON.stringify({ cwd: project, account, extension, probe }),
    ], { cwd: project, env, timeout: 30_000, maxBuffer: 64 * 1024 });
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout.trim()), {
      subagent_type: 'project-worker', description: 'routing probe', prompt: 'probe',
      model: 'openai-codex/gpt-6-luna', thinking: 'high',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
