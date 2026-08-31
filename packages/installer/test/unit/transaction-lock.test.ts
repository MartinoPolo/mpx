import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { NodeTransactionStore } from '../../src/transaction.js';

it('publishes complete lock owner metadata before entering', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-lock-owner-'));
  await expect(
    new NodeTransactionStore(root).exclusive(async () => {
      const owner = JSON.parse(
        await readFile(path.join(root, 'transaction.lock'), 'utf8'),
      ) as Record<string, unknown>;
      expect(owner).toMatchObject({ schemaVersion: 1, pid: process.pid });
      expect(typeof owner.nonce).toBe('string');
    }),
  ).resolves.toBeUndefined();
});

it('cleans an abandoned cross-process lock owned by a nonexistent process', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-lock-'));
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, 'transaction.lock'),
    JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647, nonce: 'abandoned' }) + '\n',
  );
  const store = new NodeTransactionStore(root);
  await expect(store.exclusive(async () => 'entered')).resolves.toBe('entered');
  await expect(readFile(path.join(root, 'transaction.lock'), 'utf8')).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('releases the local queue and aggregates action and process-lock release failures', async () => {
  const store = new NodeTransactionStore(await mkdtemp(path.join(tmpdir(), 'mpx-lock-release-')));
  let acquisitions = 0;
  (
    store as unknown as { acquireProcessLock: () => Promise<() => Promise<void>> }
  ).acquireProcessLock = async () => {
    acquisitions += 1;
    return acquisitions === 1
      ? async () => {
          throw new Error('release failed');
        }
      : async () => {};
  };
  const failure = await store
    .exclusive(async () => {
      throw new Error('action failed');
    })
    .catch((error) => error as AggregateError);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors.map((error) => (error as Error).message)).toEqual([
    'action failed',
    'release failed',
  ]);
  await expect(store.exclusive(async () => 'later-entered')).resolves.toBe('later-entered');
});
