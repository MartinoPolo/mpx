import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ObsoleteAccountStateResetService } from '@mpx/application/node';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

it('converges disposable obsolete MPX-local account state without touching current session state', async () => {
  const local = await mkdtemp(path.join(os.tmpdir(), 'mpx-obsolete-reset-integration-'));
  roots.push(local);
  const state = path.join(local, 'mpx');
  const accounts = path.join(state, 'accounts', 'v1');
  const bindings = path.join(state, 'sessions', 'v1', 'private', 'native-bindings');
  const session = path.join(state, 'sessions', 'v1', 'identities', 'session.json');
  await mkdir(accounts, { recursive: true });
  await mkdir(bindings, { recursive: true });
  await mkdir(path.dirname(session), { recursive: true });
  const common = {
    schemaVersion: 1,
    ref: 'ref',
    identity: { domain: 'personal', name: 'main' },
    runtime: 'pi',
    recordedRootDigest: 'a'.repeat(64),
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
  await writeFile(
    path.join(accounts, 'registry.json'),
    JSON.stringify({ schemaVersion: 1, records: [] }),
  );
  await writeFile(
    path.join(bindings, 'old.json'),
    JSON.stringify({ ...common, accountBindingRef: 'old' }),
  );
  await writeFile(path.join(bindings, 'current.json'), JSON.stringify(common));
  await writeFile(session, 'session');
  await writeFile(path.join(state, 'sentinel.txt'), 'sentinel');

  await new ObsoleteAccountStateResetService(local).run();

  expect(await readdir(bindings)).toEqual(['current.json']);
  await expect(readFile(session, 'utf8')).resolves.toBe('session');
  await expect(readFile(path.join(state, 'sentinel.txt'), 'utf8')).resolves.toBe('sentinel');
});
