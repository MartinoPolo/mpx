import { expect, it } from 'vitest';
import { FakeBinaryFileSystem, FakeJsonResourceStore } from '@mpx/windows';
import type { InstallIntent, ReleaseManifest } from '../../src/immutable-core.js';
import { ProductionInstallerOperationAdapter } from '../../src/production-operation.js';

it('excludes the active-release selector from the reversible operation set', async () => {
  const releaseKey = 'a'.repeat(64),
    files = new FakeBinaryFileSystem();
  const adapter = new ProductionInstallerOperationAdapter(
    {
      MPX_APPS: 'C:\\Apps',
      APPDATA: 'C:\\Roaming',
      LOCALAPPDATA: 'C:\\Local',
      USERPROFILE: 'C:\\Users\\me',
      MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
    },
    'me',
    { files, resources: new FakeJsonResourceStore() },
  );
  const intent: InstallIntent = {
    schemaVersion: 1,
    kind: 'install-intent',
    releaseKey,
    convergenceHash: releaseKey,
    components: ['cli'],
  };
  const manifest = {
    schemaVersion: 1,
    kind: 'release-manifest',
    releaseKey,
    convergenceHash: releaseKey,
    files: [{ path: 'bin/mpx.mjs', bytes: 3, sha256: 'b'.repeat(64) }],
  } as ReleaseManifest;
  const operations = await adapter.operations(intent, manifest);
  expect(operations.automatic.map((item) => item.id)).not.toContain('06-active-release');
  expect(await files.read('C:\\Local\\mpx\\active-release')).toBeUndefined();
});
