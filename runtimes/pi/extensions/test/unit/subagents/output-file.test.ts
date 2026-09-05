import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, test, vi } from 'vitest';

import { createOutputFilePath, encodeCwd } from '../../../subagents/output-file.js';
import { ensureSafeDirectory } from '../../../subagents/safe-directory.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  chmodSync: vi.fn(),
}));
vi.mock('../../../subagents/safe-directory.js', () => ({
  ensureSafeDirectory: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(chmodSync).mockClear();
  vi.mocked(ensureSafeDirectory).mockReset();
});

test('verifies the predictable output root and nested transcript directory', () => {
  const cwd = join('project', 'workspace');
  const path = createOutputFilePath(cwd, 'agent-id', 'session-id');
  const root = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`);
  const transcriptDirectory = join(root, encodeCwd(cwd), 'session-id', 'tasks');

  assert.deepEqual(vi.mocked(ensureSafeDirectory).mock.calls, [[root], [transcriptDirectory]]);
  assert.equal(path, join(transcriptDirectory, 'agent-id.output'));
});

test('rejects an unsafe output root before transcript setup', () => {
  vi.mocked(ensureSafeDirectory).mockImplementationOnce(() => {
    throw new Error('linked directory component');
  });

  assert.throws(
    () => createOutputFilePath('project', 'agent-id', 'session-id'),
    /linked directory component/,
  );
  assert.equal(vi.mocked(chmodSync).mock.calls.length, 0);
});
