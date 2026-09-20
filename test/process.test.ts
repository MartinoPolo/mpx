import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runBounded } from '../src/safeguards/process.js';

test('bounded children receive isolated environment without mutating parent routing', async () => {
  const before = process.env.MPX_CHILD_ENV_FIXTURE;
  const [first, second] = await Promise.all(['personal-fixture', 'work-fixture'].map(value =>
    runBounded(process.execPath, ['-e', 'console.log(process.env.MPX_CHILD_ENV_FIXTURE)'], process.cwd(), 3000, undefined, undefined, { ...process.env, MPX_CHILD_ENV_FIXTURE: value }),
  ));
  assert.equal(first?.stdout.trim(), 'personal-fixture');
  assert.equal(second?.stdout.trim(), 'work-fixture');
  assert.equal(first?.incomplete, undefined);
  assert.equal(second?.incomplete, undefined);
  assert.equal(process.env.MPX_CHILD_ENV_FIXTURE, before);
});

test('deadline stops a real process tree before its delayed write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-process-'));
  try {
    const marker = join(root, 'late-write');
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected'), 4000);`;
    const script = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);`;
    const started = Date.now();
    const result = await runBounded(process.execPath, ['-e', script], root, 3500);
    assert.match(result.incomplete ?? '', /deadline exceeded/);
    assert.doesNotMatch(result.incomplete ?? '', /FAILED/);
    assert.match(result.stdout.trim(), /^\d+$/);
    assert.ok(Date.now() - started < 5000, 'bounded process startup/termination');
    await delay(4100);
    await assert.rejects(access(marker), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

if (process.platform === 'win32') test('dual Windows tree-kill failure is explicit and cannot wait forever on inherited pipes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-failed-killers-'));
  let pid: number | undefined;
  try {
    const system = join(root, 'System32');
    const powershell = join(system, 'WindowsPowerShell/v1.0');
    await mkdir(powershell, { recursive: true });
    // Node rejects both killers' arguments: present executables, deterministic infrastructure failure.
    await symlink(process.execPath, join(system, 'taskkill.exe'), 'file');
    await symlink(process.execPath, join(powershell, 'powershell.exe'), 'file');
    const script = `const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{stdio:'inherit'}); console.log(child.pid); setInterval(()=>{},1000);`;
    const start = Date.now();
    const result = await runBounded(process.execPath, ['-e', script], root, 2000, undefined, root);
    pid = Number(result.stdout.trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 0, JSON.stringify(result));
    assert.match(result.incomplete ?? '', /termination FAILED; stop the project tool manually/);
    assert.ok(Date.now() - start < 4000, 'surviving descendant pipes must not extend the deadline');
  } finally {
    if (pid && Number.isSafeInteger(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

if (process.platform === 'win32') test('missing Windows tree-kill capability prevents tool startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-no-killer-'));
  const previous = process.env.SystemRoot;
  try {
    process.env.SystemRoot = root;
    const result = await runBounded(process.execPath, ['-e', 'console.log("started")'], root, 1000);
    assert.equal(result.stdout, '');
    assert.match(result.incomplete ?? '', /termination unavailable; command not started/);
  } finally {
    if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous;
    await rm(root, { recursive: true, force: true });
  }
});
