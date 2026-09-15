import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isMpx2RuntimeSelected } from '../src/runtime-selection.js';

test('runtime activates only for its exact existing content root and a managed account', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-runtime-selection-'));
  try {
    const other = path.join(root, 'other');
    await mkdir(other);
    assert.equal(await isMpx2RuntimeSelected(root, {}), false);
    assert.equal(await isMpx2RuntimeSelected(root, { MPX_ACCOUNT: 'personal' }), false);
    assert.equal(await isMpx2RuntimeSelected(root, { MPX_ACCOUNT: 'legacy', MPX_ACTIVE_CONTENT_ROOT: root }), false);
    assert.equal(await isMpx2RuntimeSelected(root, { MPX_ACCOUNT: 'personal', MPX_ACTIVE_CONTENT_ROOT: other }), false);
    assert.equal(await isMpx2RuntimeSelected(root, { MPX_ACCOUNT: 'personal', MPX_ACTIVE_CONTENT_ROOT: '.' }), false);
    for (const account of ['personal', 'work']) {
      assert.equal(await isMpx2RuntimeSelected(root, { MPX_ACCOUNT: account, MPX_ACTIVE_CONTENT_ROOT: root }), true);
    }
    assert.equal(await isMpx2RuntimeSelected(other, { MPX_ACCOUNT: 'personal', MPX_ACTIVE_CONTENT_ROOT: path.join(root, 'missing') }), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('automatically discovered MPX2 runtime registers nothing outside its launcher', async () => {
  const previousAccount = process.env.MPX_ACCOUNT;
  const previousRoot = process.env.MPX_ACTIVE_CONTENT_ROOT;
  delete process.env.MPX_ACCOUNT;
  delete process.env.MPX_ACTIVE_CONTENT_ROOT;
  try {
    const { default: runtime } = await import('../extensions/pi-runtime.js');
    const forbidden = new Proxy({}, { get() { throw new Error('Unselected runtime must not use ExtensionAPI'); } });
    await runtime(forbidden as Parameters<typeof runtime>[0]);
  } finally {
    if (previousAccount === undefined) delete process.env.MPX_ACCOUNT; else process.env.MPX_ACCOUNT = previousAccount;
    if (previousRoot === undefined) delete process.env.MPX_ACTIVE_CONTENT_ROOT; else process.env.MPX_ACTIVE_CONTENT_ROOT = previousRoot;
  }
});
