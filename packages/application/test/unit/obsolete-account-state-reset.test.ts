import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ObsoleteAccountStateResetService } from '../../src/node/obsolete-account-state-reset.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);
const digest = 'a'.repeat(64);
const timestamp = '2025-01-01T00:00:00.000Z';
const binding = (legacy: boolean) => ({
  schemaVersion: 1,
  ref: 'binding',
  identity: { domain: 'personal', name: 'main' },
  runtime: 'pi',
  recordedRootDigest: digest,
  ...(legacy ? { accountBindingRef: 'account' } : {}),
  createdAt: timestamp,
  updatedAt: timestamp,
});

async function fixture() {
  const local = await mkdtemp(path.join(os.tmpdir(), 'mpx-reset-'));
  roots.push(local);
  const state = path.join(local, 'mpx');
  const bindings = path.join(state, 'sessions', 'v1', 'private', 'native-bindings');
  await mkdir(bindings, { recursive: true });
  return { local, state, bindings };
}

it('removes only exact obsolete account state and preserves current bindings, sessions, and sentinels', async () => {
  const f = await fixture();
  const accounts = path.join(f.state, 'accounts', 'v1');
  const sessions = path.join(f.state, 'sessions', 'v1', 'identities', 'sentinel');
  await mkdir(accounts, { recursive: true });
  await mkdir(sessions, { recursive: true });
  await writeFile(
    path.join(accounts, 'registry.json'),
    JSON.stringify({ schemaVersion: 1, records: [] }),
  );
  await writeFile(path.join(f.bindings, 'legacy.json'), JSON.stringify(binding(true)));
  await writeFile(path.join(f.bindings, 'current.json'), JSON.stringify(binding(false)));
  await writeFile(path.join(sessions, 'registry.json'), 'session sentinel');
  await writeFile(path.join(f.state, 'sentinel.txt'), 'keep');

  const reset = new ObsoleteAccountStateResetService(f.local);
  await reset.run();
  await reset.run();

  await expect(readFile(path.join(accounts, 'registry.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readdir(f.bindings)).toEqual(['current.json']);
  await expect(readFile(path.join(sessions, 'registry.json'), 'utf8')).resolves.toBe(
    'session sentinel',
  );
  await expect(readFile(path.join(f.state, 'sentinel.txt'), 'utf8')).resolves.toBe('keep');
});

it('fails closed on linked objects without removing their target', async () => {
  const f = await fixture();
  const outside = path.join(f.local, 'outside.json');
  await writeFile(outside, JSON.stringify(binding(true)));
  await symlink(outside, path.join(f.bindings, 'legacy.json'), 'file');
  await expect(new ObsoleteAccountStateResetService(f.local).run()).rejects.toMatchObject({
    code: 'SETUP_OBSOLETE_STATE_INVALID',
  });
  await expect(readFile(outside, 'utf8')).resolves.toContain('accountBindingRef');
});
