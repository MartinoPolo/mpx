import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { readPeakInputTokens } from '../src/pi-agent-usage.js';

async function withTranscript(lines: readonly string[], run: (url: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mpx-peak-'));
  const transcript = path.join(directory, 'child.jsonl');
  try {
    await writeFile(transcript, lines.join('\n'));
    await run(pathToFileURL(transcript).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('reads maximum per-request input including cache while excluding output and cumulative totals', async () => {
  const repeated = Array.from({ length: 30 }, () => JSON.stringify({
    type: 'message', message: { role: 'assistant', usage: { input: 100_000, output: 900_000, cacheRead: 20_000, cacheWrite: 5_300, totalTokens: 1_025_300 } },
  }));
  await withTranscript([
    ...repeated,
    JSON.stringify({ type: 'message', message: { role: 'assistant', usage: { input: 10_000, output: 8_000_000, cacheRead: 20_000, cacheWrite: 5_300 } } }),
    JSON.stringify({ type: 'message', message: { role: 'user', usage: { input: 999_999 } } }),
  ], async url => {
    assert.equal(await readPeakInputTokens(url), 125_300);
  });
});

test('skips malformed, partial, and invalid assistant usage and safely handles absent or non-file URLs', async () => {
  await withTranscript([
    JSON.stringify({ type: 'message', message: { role: 'assistant', usage: { input: 40, output: 1 } } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', usage: { input: 20, cacheRead: 5 } } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', usage: { cacheRead: 500 } } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', usage: { input: -1 } } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', usage: { input: 50, cacheWrite: null } } }),
    '{"type":"message","message":',
  ], async url => {
    assert.equal(await readPeakInputTokens(url), 40);
  });

  assert.equal(await readPeakInputTokens(pathToFileURL(path.join(os.tmpdir(), 'mpx-absent-transcript.jsonl')).href), undefined);
  assert.equal(await readPeakInputTokens('https://example.test/child.jsonl'), undefined);
  assert.equal(await readPeakInputTokens('relative-child.jsonl'), undefined);
});
