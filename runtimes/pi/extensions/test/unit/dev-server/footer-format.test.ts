import assert from 'node:assert/strict';
import { test } from 'vitest';

import { formatManagedDevServer, subscribeManagedDevServerEvents } from '../../../dev-server/footer-format.js';

test('managed dev-server subscription validates, normalizes, forwards, and unsubscribes', () => {
  let channel = '';
  let handler: (payload: unknown) => void = () => {};
  let unsubscribed = false;
  const received: unknown[] = [];
  const cleanup = subscribeManagedDevServerEvents(
    {
      on(name, listener) {
        channel = name;
        handler = listener;
        return () => {
          unsubscribed = true;
        };
      },
    },
    (snapshot) => received.push(snapshot),
  );

  assert.equal(channel, 'dev-servers:changed');
  handler(null);
  handler({ id: 1, state: 'ready' });
  handler({ id: 'web', state: 'invalid' });
  handler({ id: 'web', state: 'crashed', exitCode: '7' });
  assert.deepEqual(received, [{ id: 'web', state: 'crashed', exitCode: null }]);
  cleanup();
  assert.equal(unsubscribed, true);
});

for (const [snapshot, expected] of [
  [
    { id: 'web', state: 'starting', exitCode: null },
    { text: 'web starting', tone: 'warning' },
  ],
  [
    { id: 'web', state: 'ready', exitCode: null },
    { text: 'web ready', tone: 'success' },
  ],
  [
    { id: 'web', state: 'crashed', exitCode: 7 },
    { text: 'web crashed exit 7', tone: 'error' },
  ],
  [
    { id: 'web', state: 'stopped', exitCode: null },
    { text: 'web stopped', tone: 'dim' },
  ],
] as const) {
  test(`formats managed footer state ${snapshot.state}`, () => {
    assert.deepEqual(formatManagedDevServer(snapshot), expected);
  });
}
