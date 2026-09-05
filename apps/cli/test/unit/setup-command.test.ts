import { expect, it, vi } from 'vitest';
import { run } from '../../src/main.js';
import { captureIo } from '../../src/io.js';

const releaseKey = 'a'.repeat(64);
const result = {
  schemaVersion: 1,
  kind: 'setup-result',
  releaseKey,
  verification: { healthy: true, issues: [] },
} as const;

it('runs injectable setup and emits the normal JSON envelope', async () => {
  const execute = vi.fn(async () => result);
  const io = captureIo();
  expect(await run(['--json', 'setup'], io, { env: {}, setupService: { execute } } as never)).toBe(
    0,
  );
  expect(execute).toHaveBeenCalledOnce();
  expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: true, data: result });
});

it('prints concise human success and rejects setup arguments', async () => {
  const context = { env: {}, setupService: { execute: async () => result } } as never;
  const success = captureIo();
  expect(await run(['setup'], success, context)).toBe(0);
  expect(success.out).toEqual([`Setup complete (${releaseKey}).\n`]);
  const invalid = captureIo();
  expect(await run(['--json', 'setup', 'extra'], invalid, context)).toBe(2);
  expect(JSON.parse(invalid.out[0]!)).toMatchObject({ ok: false, error: { code: 'USAGE_ERROR' } });
});
