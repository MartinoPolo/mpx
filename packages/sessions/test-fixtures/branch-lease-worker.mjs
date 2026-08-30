import { BranchLeaseStore } from '../dist/branch.js';

const [root, workspace, owner, holdText] = process.argv.slice(2);
const store = new BranchLeaseStore(root, {
  controllerStartFingerprint: `worker-${process.pid}`,
});
try {
  const lease = await store.acquire(workspace, owner);
  process.stdout.write('ACQUIRED\n');
  await new Promise((resolve) => setTimeout(resolve, Number(holdText)));
  await lease.release();
  process.stdout.write('RELEASED\n');
} catch (error) {
  process.stdout.write(`ERROR:${error?.code ?? 'UNKNOWN'}\n`);
}
