import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { activateRelease } from '../../src/immutable-core.js';
import { NodeInstalledRunnerAuthority } from '../../src/installed-runner-authority.js';
import { NodeCurrentReleaseBuilder } from '../../src/orchestration.js';
import { MemoryTransactionStore } from '../../src/transaction.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-installed-runner-'));
  const repositoryRoot = path.join(root, 'source'),
    appsRoot = path.join(root, 'apps'),
    localAppData = path.join(root, 'local');
  await mkdir(path.join(repositoryRoot, 'bin'), { recursive: true });
  await writeFile(path.join(repositoryRoot, 'bin', 'mpx.mjs'), 'export {};\n');
  const releases = new NodeCurrentReleaseBuilder({ repositoryRoot, appsRoot, assetPaths: ['bin'] });
  const manifest = await releases.build(),
    store = new MemoryTransactionStore();
  const authority = new NodeInstalledRunnerAuthority({ appsRoot, localAppData, store });
  return { appsRoot, localAppData, releases, manifest, store, authority };
}

it('reports structured uninstalled authority before the immutable release is active', async () => {
  const f = await fixture();
  await expect(f.authority.resolveInstalled()).rejects.toMatchObject({
    code: 'INSTALL_RUNNER_UNAVAILABLE',
    details: { status: 'uninstalled' },
  });
});

it('resolves only the active receipt-bound direct release runner and rejects tampering', async () => {
  const f = await fixture(),
    manifest = await f.releases.publish(f.manifest.releaseKey);
  await f.store.writeReceipt({
    schemaVersion: 2,
    kind: 'ownership-receipt',
    releaseKey: manifest.releaseKey,
    convergenceHash: manifest.convergenceHash,
    files: manifest.files,
    operations: [],
    operationLocators: [],
    installedAt: new Date(0).toISOString(),
  });
  await activateRelease(f.localAppData, null, manifest.releaseKey);
  const evidence = await f.authority.resolveInstalled();
  expect(evidence).toEqual({
    path: path.join(f.appsRoot, 'mpx', 'releases', manifest.releaseKey, 'bin', 'mpx.mjs'),
    sha256: manifest.files.find((file) => file.path === 'bin/mpx.mjs')!.sha256,
    version: manifest.releaseKey,
  });
  await expect(f.authority.verifyInstalled(evidence)).resolves.toEqual(evidence);
  await writeFile(evidence.path, `${await readFile(evidence.path, 'utf8')}tampered`);
  await expect(f.authority.verifyInstalled(evidence)).rejects.toMatchObject({
    code: 'INSTALL_RUNNER_STALE',
    message: expect.stringContaining('size'),
  });
});
