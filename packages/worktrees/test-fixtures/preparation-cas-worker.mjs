import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { NodePreparationStore, PreparationStateLock } from '../dist/node-preparation-adapters.js';

const [mode, root, key] = process.argv.slice(2);
const lockPath = path.join(
  root,
  'state-locks',
  `${createHash('sha256').update(key).digest('hex')}.lock`,
);
const inspector = {
  inspect: async (pid) => {
    if (pid === process.pid) {
      return { status: 'present', pid, startFingerprint: `process-${pid}` };
    }
    try {
      process.kill(pid, 0);
      return { status: 'unknown', pid };
    } catch (error) {
      return error?.code === 'ESRCH' ? { status: 'absent', pid } : { status: 'unknown', pid };
    }
  },
};
const lock = new PreparationStateLock({
  lockTimeoutMs: 10_000,
  lockRetryMs: 5,
  ownerlessGraceMs: 200,
  now: Date.now,
  token: () => crypto.randomUUID(),
  processIdentityInspector: inspector,
});
if (mode === 'ownerless') {
  await mkdir(lockPath, { recursive: true });
  process.send?.({ type: 'ownerless' });
  process.exit(24);
}
const waitFor = (type) =>
  new Promise((resolve) => {
    const listener = (message) => {
      if (message?.type === type) {
        process.off('message', listener);
        resolve();
      }
    };
    process.on('message', listener);
  });
if (mode === 'cas') {
  await waitFor('go');
  const state = {
    schemaVersion: 2,
    owner: 'mpx',
    key,
    runId: '11111111-1111-4111-8111-111111111111',
    revision: 1,
    status: 'ready',
    execution: 'foreground',
    createdAt: 1,
    updatedAt: 1,
    steps: [],
    finishedAt: 1,
  };
  const swapped = await new NodePreparationStore(root, {
    processIdentityInspector: inspector,
    lockTimeoutMs: 10_000,
    lockRetryMs: 5,
  }).compareAndSwap(key, undefined, state);
  process.send?.({ type: 'result', swapped });
  process.disconnect?.();
  await new Promise((resolve) => setTimeout(resolve, 10));
  process.exit(0);
}
if (mode === 'serialize') {
  await waitFor('go');
}
const release = await lock.acquire(lockPath);
process.send?.({ type: 'locked', pid: process.pid });
if (mode === 'crash') {
  await new Promise(() => undefined);
}
await waitFor('release');
await release();
process.send?.({ type: 'done' });
process.disconnect?.();
