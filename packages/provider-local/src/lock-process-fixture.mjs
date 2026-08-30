import { LocalIssueStore } from '../dist/index.js';

const [mode, root] = process.argv.slice(2);
if (!mode || !root || !process.send) {
  process.exit(2);
}

let unblock, publishHeartbeat;
const blocked = new Promise((resolve) => {
  unblock = resolve;
});
const heartbeatGate = new Promise((resolve) => {
  publishHeartbeat = resolve;
});
const store = new LocalIssueStore(root, {
  staleLockMilliseconds: 2_000,
  lockHeartbeatMilliseconds: 10,
  beforeLockHeartbeatPublish: async () => {
    process.send?.({ type: 'heartbeat-ready' });
    await heartbeatGate;
  },
  afterLockHeartbeatPublish: async () => {
    process.send?.({ type: 'heartbeat-published' });
  },
  onChanged: async () => {
    process.send?.({ type: 'locked' });
    if (mode === 'crash') {
      process.exit(0);
    }
    await blocked;
  },
});
process.on('message', (message) => {
  if (message === 'release') {
    unblock?.();
  }
  if (message === 'publish-heartbeat') {
    publishHeartbeat?.();
  }
});
await store.create({ title: mode, body: '' });
process.send({ type: 'finished' });
