import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

test('patched pi-subagents inherits concurrent selected packs in linked native child sessions', async () => {
  const { stdout, stderr } = await exec(process.execPath, ['migration/upstream-probe.mjs'], {
    cwd: packageRoot,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(stderr, '');
  const result = JSON.parse(stdout) as {
    version: string;
    linkedWorktree: boolean;
    concurrentSelections: { alpha: string[]; beta: string[]; empty: string[] };
    alpha: { discovery: Record<string, boolean>; named: Record<string, boolean> };
    beta: { discovery: Record<string, boolean>; named: Record<string, boolean> };
    empty: { discovery: Record<string, boolean>; named: Record<string, boolean> };
    providerRequests: number;
  };

  assert.equal(result.version, '0.19.0');
  assert.equal(result.linkedWorktree, true);
  assert.equal(result.concurrentSelections.alpha.length, 1);
  assert.equal(result.concurrentSelections.beta.length, 1);
  assert.notEqual(result.concurrentSelections.alpha[0], result.concurrentSelections.beta[0]);
  assert.deepEqual(result.concurrentSelections.empty, []);

  assert.equal(result.alpha.discovery.catalogAlpha, true);
  assert.equal(result.alpha.discovery.catalogBeta, false);
  assert.equal(result.beta.discovery.catalogAlpha, false);
  assert.equal(result.beta.discovery.catalogBeta, true);
  for (const discovery of [result.alpha.discovery, result.beta.discovery, result.empty.discovery]) {
    for (const nativeName of ['linkedProject', 'piProject', 'accountNative', 'sharedNative', 'packagedNative']) {
      assert.equal(discovery[nativeName], true, `native ${nativeName} missing from child discovery`);
    }
  }

  assert.equal(result.alpha.named.alphaBody, true);
  assert.equal(result.alpha.named.betaBody, false);
  assert.equal(result.beta.named.alphaBody, false);
  assert.equal(result.beta.named.betaBody, true);
  assert.equal(result.alpha.named.namedNotFound, false);
  assert.equal(result.beta.named.namedNotFound, false);
  assert.equal(result.empty.discovery.catalogAlpha, false);
  assert.equal(result.empty.discovery.catalogBeta, false);
  assert.equal(result.empty.named.alphaBody, false);
  assert.equal(result.empty.named.namedNotFound, true);
  assert.equal(result.providerRequests, 0);
});
