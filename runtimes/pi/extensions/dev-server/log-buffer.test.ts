import assert from 'node:assert/strict';
import { test } from 'vitest';

import { RollingLogBuffer } from './log-buffer.js';

test('rolling logs decode split UTF-8, normalize CR progress, flush partials, and stay bounded', () => {
  const logs = new RollingLogBuffer({ maxCharacters: 18 });
  logs.beginRun(1);
  logs.write('stdout', Buffer.from([0xe2, 0x82]));
  logs.write('stdout', Buffer.concat([Buffer.from([0xac]), Buffer.from(' 1\r2\r\n')]));
  logs.write('stderr', Buffer.from('warning'));
  logs.flush();

  assert.deepEqual(logs.entries(), [
    { run: 1, stream: 'stdout', text: '2' },
    { run: 1, stream: 'stderr', text: 'warning' },
  ]);
});

test('log presentation strips terminal controls and applies a separate model-output bound', () => {
  const logs = new RollingLogBuffer({ maxCharacters: 100 });
  logs.beginRun(2);
  logs.write('stdout', Buffer.from('\u001b[31mred\u001b[0m\n0123456789\n'));

  const bounded = logs.present({ maxCharacters: 8 });
  assert.equal(bounded, '…3456789');
  assert.equal(bounded.length, 8);
  assert.equal(logs.present({ maxCharacters: 1 }), '…');
});

test('partial lines and sole oversized entries are capped at the rolling bound', () => {
  const logs = new RollingLogBuffer({ maxCharacters: 5 });
  logs.beginRun(1);
  logs.write('stdout', Buffer.from('0123456789'));
  logs.flush();

  assert.deepEqual(logs.entries(), [{ run: 1, stream: 'stdout', text: '56789' }]);
});

test('carriage-return progress retains only the latest frame and maxLines limits presentation', () => {
  const logs = new RollingLogBuffer({ maxCharacters: 100 });
  logs.beginRun(1);
  logs.write('stdout', Buffer.from('old frame\rnew frame\rfinal\nsecond\nthird\n'));

  assert.deepEqual(
    logs.entries().map((entry) => entry.text),
    ['final', 'second', 'third'],
  );
  assert.equal(logs.present({ maxLines: 2 }), 'second\nthird');
});
