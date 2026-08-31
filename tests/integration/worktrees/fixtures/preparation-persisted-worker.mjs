import { NodePreparationStore } from '@mpx/worktrees';

const [stateRoot, key] = process.argv.slice(2);
const store = new NodePreparationStore(stateRoot);
let captured;

const reply = (message) => process.send?.(message);
process.on('message', async (message) => {
  if (message?.type === 'capture') {
    captured = await store.load(key);
    reply({ type: 'captured', revision: captured?.revision });
    return;
  }
  if (message?.type === 'complete' && captured) {
    const status = message.status;
    const next = {
      ...captured,
      revision: captured.revision + 1,
      status,
      updatedAt: Date.now(),
      finishedAt: Date.now(),
      steps: captured.steps.map((step) => ({
        ...step,
        status,
        finishedAt: Date.now(),
        process: undefined,
      })),
    };
    const swapped = await store.compareAndSwap(key, captured.revision, next);
    reply({ type: 'completion', status, swapped });
    return;
  }
  if (message?.type === 'stop') {
    process.exit(0);
  }
});

reply({ type: 'online', pid: process.pid });
