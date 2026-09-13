import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
// Migration scripts are intentionally outside the runtime TypeScript compilation.
// @ts-expect-error JavaScript migration helper has no declaration file.
import { withSourceIntegrity } from '../migration/source-integrity.mjs';

test('source integrity checks failure paths and preserves execution plus integrity errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-source-integrity-'));
  const file = join(root, 'source.txt');
  try {
    await writeFile(file, 'before');
    await assert.rejects(withSourceIntegrity({ files: [file] }, async () => {
      await writeFile(file, 'after');
      throw new Error('fixture execution failure');
    }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(error.message, /fixture execution failure/);
      assert.match(error.message, /source integrity changed/);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('source integrity observes Git-visible untracked bytes, not just dirty-entry counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-source-integrity-'));
  const file = join(root, 'source.txt');
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    await writeFile(file, 'before');
    assert.equal(await withSourceIntegrity({ repositories: [root] }, async () => 'unchanged'), 'unchanged');
    await assert.rejects(withSourceIntegrity({ repositories: [root] }, async () => {
      await writeFile(file, 'after');
    }), /source integrity changed/);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
