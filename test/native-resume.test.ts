import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('native Pi SDK transcript is read and planned read-only, then restores model, effort, and history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-native-resume-'));
  try {
    const account = path.join(root, 'account');
    const cwd = path.join(root, 'project');
    const sessionDir = path.join(account, 'sessions', '--native-fixture--');
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
    const fixture = path.resolve('test/fixtures/native-resume.ts');
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      '--import', 'tsx', fixture, JSON.stringify({ cwd, account, sessionDir }),
    ], { cwd: path.resolve('.'), timeout: 30_000, maxBuffer: 64 * 1024 });
    assert.equal(stderr, '');
    const lines = stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, `fixture emitted unexpected output: ${stdout}`);
    assert.deepEqual(JSON.parse(lines[0]!), {
      nativeSdk: true, sessionIdMatched: true,
      restored: { provider: 'native-fixture', model: 'model-b', thinking: 'medium' },
      historyMessages: 4, modelRequests: 0, bytesUnchanged: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
