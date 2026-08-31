import { RegistryStore } from '@mpx/ports';

const [mode, stateRoot, id] = process.argv.slice(2);
const send = (message) => process.send?.(message);
const waitFor = (type) =>
  new Promise((resolve) => {
    const listener = (message) => {
      if (message?.type === type) {
        process.off('message', listener);
        resolve(message);
      }
    };
    process.on('message', listener);
  });
const lease = (leaseId) => {
  const port =
    5100 + ([...leaseId].reduce((total, character) => total + character.charCodeAt(0), 0) % 1000);
  return {
    leaseId,
    projectId: `process-test-${leaseId}`,
    repositoryId: `repository-${leaseId}`,
    worktreeId: `worktree-${leaseId}`,
    worktreePath: `C:/${leaseId}`,
    role: 'main',
    slot: 0,
    configHash: 'a'.repeat(64),
    services: { app: port },
    claims: [{ port, exclusive: true }],
    updatedAt: 1,
  };
};

const store = new RegistryStore(stateRoot, {
  timeoutMs: 15_000,
  retryMs: 10,
  heartbeatMs: 50,
  emptyOwnerGraceMs: 200,
});
send({ type: 'ready', pid: process.pid });
await waitFor('go');

if (mode === 'crash') {
  await store.transaction(async () => {
    send({ type: 'entered', id, pid: process.pid });
    await waitFor('crash');
    process.exit(23);
  });
} else {
  await store.transaction(async (state) => {
    send({ type: 'entered', id, pid: process.pid, at: Date.now() });
    await waitFor('continue');
    await new Promise((resolve) => setTimeout(resolve, 40));
    state.leases.push(lease(id));
    send({ type: 'leaving', id, pid: process.pid, at: Date.now() });
    await waitFor('leave-ack');
  });
  send({ type: 'done', id, pid: process.pid });
  process.disconnect?.();
}
