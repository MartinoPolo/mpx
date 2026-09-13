import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateFallow } from '../src/safeguards/fallow.js';
import { runBounded } from '../src/safeguards/process.js';

test('Fallow is opted-in, push-only, local, trusted and verdict-driven', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-fallow-'));
  try {
    await mkdir(join(root, '.git'));
    let runs = 0;
    const options = { isTrusted: () => true, run: async () => { runs++; return { code: 1, stdout: '{"verdict":"fail","token":"not displayed"}' }; } };
    assert.equal((await evaluateFallow('git push', root, options)).decision, 'allow');
    assert.equal(runs, 0);
    await writeFile(join(root, '.fallowrc.json'), '{}');
    assert.equal((await evaluateFallow('git commit -m test', root, options)).decision, 'allow');
    assert.equal((await evaluateFallow('git push', root, options)).decision, 'warn');
    assert.equal(runs, 0);
    await mkdir(join(root, 'node_modules/.bin'), { recursive: true });
    await writeFile(join(root, 'node_modules/.bin/fallow'), '#!/bin/sh\n');
    assert.equal((await evaluateFallow('git push', root, { ...options, isTrusted: () => false })).decision, 'warn');
    assert.equal(runs, 0);
    const blocked = await evaluateFallow('git status && git push', root, options);
    assert.equal(blocked.decision, 'block');
    assert.doesNotMatch(blocked.diagnostics.join(' '), /not displayed/);
    assert.equal(runs, 1);
    assert.equal((await evaluateFallow('git add . && git push', root, options)).decision, 'block');
    assert.equal(runs, 1);
    assert.equal((await evaluateFallow('cd "$WHERE" && git push', root, options)).decision, 'warn');
    for (const output of [{ code: 0, stdout: '{}' }, { code: 2, stdout: '{"verdict":"fail"}' }, { code: 0, stdout: 'bad' }, { code: null, stdout: '', incomplete: 'deadline exceeded' }]) {
      assert.equal((await evaluateFallow('git push', root, { ...options, run: async () => output })).decision, 'warn');
    }
    assert.equal((await evaluateFallow('git push', root, { ...options, run: async () => ({ code: 0, stdout: '{"verdict":"pass"}' }) })).decision, 'allow');
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { 'fallow:audit': 'npx fallow audit' } }));
    assert.equal((await evaluateFallow('git push', root, options)).decision, 'warn');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bounded child process output and deadline are visible, not success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-process-'));
  try {
    assert.equal((await runBounded(process.execPath, ['-e', 'console.log("ok")'], root, 2000)).stdout.trim(), 'ok');
    const start = Date.now();
    const timed = await runBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], root, 2000);
    assert.equal(timed.incomplete, 'deadline exceeded');
    assert.ok(Date.now() - start < 5000);
    assert.equal((await runBounded(process.execPath, ['-e', 'console.log("x".repeat(4096))'], root, 2000, 100)).incomplete, 'output limit exceeded');
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
