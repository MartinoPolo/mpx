import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { syncRuntime } from '../src/runtime-install.js';
import type { UserConfig } from '../src/contracts.js';

test('runtime installation preserves native settings/packages and converges only on owned entries', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mpx-runtime-'));
  const config: UserConfig = { accounts: { personal: { pi: join(scratch, 'pi'), claude: join(scratch, 'cc') }, work: { pi: join(scratch, 'piw'), claude: join(scratch, 'ccw') } }, domains: { personal: [], work: [] } };
  try {
    for (const account of Object.values(config.accounts)) for (const directory of Object.values(account)) {
      await mkdir(directory); await writeFile(join(directory, 'settings.json'), JSON.stringify({ packages: ['keep-pinned'], model: 'unchanged', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep' }] }] } }));
    }
    const before = await readFile(join(config.accounts.personal.pi, 'settings.json'));
    assert.equal((await syncRuntime(resolve('.'), config, true)).ok, true);
    assert.deepEqual(await readFile(join(config.accounts.personal.pi, 'settings.json')), before);
    const written = await syncRuntime(resolve('.'), config, false);
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.ok((await syncRuntime(resolve('.'), config, false)).entries.every(entry => entry.status === 'unchanged'));
    for (const account of Object.values(config.accounts)) {
      const pi = JSON.parse(await readFile(join(account.pi, 'settings.json'), 'utf8'));
      assert.deepEqual(pi.packages, ['keep-pinned']); assert.equal(pi.model, 'unchanged'); assert.equal(pi.treeFilterMode, 'no-tools');
      const claude = JSON.parse(await readFile(join(account.claude, 'settings.json'), 'utf8'));
      assert.equal(claude.hooks.Stop[0].hooks[0].command, 'keep'); assert.equal(claude.hooks.PreToolUse.length, 1);
    }
    await rm(join(config.accounts.work.pi, 'extensions/mpx2.ts')); await writeFile(join(config.accounts.work.pi, 'extensions/mpx2.ts'), 'unrelated');
    const conflict = await syncRuntime(resolve('.'), config, false);
    assert.equal(conflict.ok, false); assert.equal(await readFile(join(config.accounts.work.pi, 'extensions/mpx2.ts'), 'utf8'), 'unrelated');
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
