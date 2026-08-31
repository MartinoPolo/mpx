import { writeFileSync } from 'node:fs';
import path from 'node:path';

const exitMarker = process.env.MPX_TEST_EXIT_MARKER;
const finish = () => process.exit(0);
process.on('exit', () => {
  if (exitMarker) {
    writeFileSync(exitMarker, 'exited');
  }
});
process.on('SIGTERM', finish);
process.on('disconnect', finish);
process.on('message', (message) => {
  if (message?.type === 'mpx-preparation-abort') {
    finish();
  }
});
if (typeof process.send === 'function') {
  process.send({
    type: 'mpx-preparation-ready',
    workerToken: process.env.MPX_PREPARATION_WORKER_TOKEN,
    requestId: path.basename(process.argv.at(-1)),
  });
}
setTimeout(finish, 10_000).unref();
setInterval(() => {}, 1_000);
