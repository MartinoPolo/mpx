import { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FakeBinaryFileSystem, FakeJsonResourceStore } from '@mpx/windows';
import {
  canonicalJson,
  installerDigest,
  type InstallIntentV1,
  type ReleaseManifestV1,
} from './immutable-core.js';
import {
  NodeBinaryFileSystem,
  ProductionInstallerOperationAdapter,
} from './production-operation.js';
import { ImmutableInstallerService, MemoryTransactionStore } from './transaction.js';

const userConfigContent = (extra: Record<string, unknown> = {}) =>
  canonicalJson({
    identities: {},
    domains: {},
    contentScopes: {},
    modes: {},
    skillPolicies: {},
    presets: {},
    launchDefaults: { scopes: {}, projects: {} },
    networkPolicies: {},
    executors: { host: {} },
    ...extra,
  });
const withUserConfig = (releaseKey: string, content = userConfigContent()): InstallIntentV1 => ({
  schemaVersion: 1,
  kind: 'install-intent',
  releaseKey,
  convergenceHash: releaseKey,
  components: ['cli'],
  userConfigArtifact: {
    target: '%APPDATA%/mpx/config.json',
    content,
    sha256: installerDigest(JSON.parse(content)),
  },
});
const releaseManifest = (releaseKey: string): ReleaseManifestV1 => ({
  schemaVersion: 1,
  kind: 'release-manifest',
  releaseKey,
  convergenceHash: releaseKey,
  files: [{ path: 'bin/mpx.mjs', bytes: 3, sha256: 'b'.repeat(64) }],
});

it('atomically creates a production binary file without clobbering an existing target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-create-only-')),
    target = path.join(root, 'config.json'),
    files = new NodeBinaryFileSystem();
  try {
    await expect(files.create(target, Buffer.from('first'))).resolves.toBe(true);
    await expect(files.create(target, Buffer.from('second'))).resolves.toBe(false);
    expect(await readFile(target, 'utf8')).toBe('first');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('cleans temporary state without publishing when a create-only write fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-create-write-failure-')),
    target = path.join(root, 'config.json');
  const files = new NodeBinaryFileSystem({
    open: async (...args) => {
      const handle = await open(...args);
      return {
        writeFile: async () => {
          throw new Error('injected write failure');
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
  });
  try {
    await expect(files.create(target, Buffer.from('complete'))).rejects.toThrow(
      'injected write failure',
    );
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('leaves no target or temporary bytes after create-only sync failure and can recover', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-create-recovery-')),
    target = path.join(root, 'config.json');
  let failSync = true;
  const files = new NodeBinaryFileSystem({
    open: async (...args) => {
      const handle = await open(...args);
      return {
        writeFile: (value) => handle.writeFile(value),
        sync: async () => {
          if (failSync) {
            failSync = false;
            throw new Error('injected sync failure');
          }
          await handle.sync();
        },
        close: () => handle.close(),
      };
    },
  });
  try {
    await expect(files.create(target, Buffer.from('complete'))).rejects.toThrow(
      'injected sync failure',
    );
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).toEqual([]);
    await expect(files.create(target, Buffer.from('complete'))).resolves.toBe(true);
    expect(await readFile(target, 'utf8')).toBe('complete');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects secret-bearing user config through the public config parser', async () => {
  const releaseKey = 'a'.repeat(64),
    files = new FakeBinaryFileSystem();
  const adapter = new ProductionInstallerOperationAdapter(
    {
      MPX_APPS: 'C:\\Apps',
      APPDATA: 'C:\\Roaming',
      LOCALAPPDATA: 'C:\\Local',
      USERPROFILE: 'C:\\Users\\me',
    },
    'me',
    { files, resources: new FakeJsonResourceStore() },
  );
  await expect(
    adapter.operations(
      withUserConfig(releaseKey, userConfigContent({ token: 'secret' })),
      releaseManifest(releaseKey),
    ),
  ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
});

it('creates absent user config exactly and accepts exact existing bytes', async () => {
  const releaseKey = 'a'.repeat(64),
    target = 'C:\\Roaming\\mpx\\config.json',
    files = new FakeBinaryFileSystem();
  const adapter = new ProductionInstallerOperationAdapter(
    {
      MPX_APPS: 'C:\\Apps',
      APPDATA: 'C:\\Roaming',
      LOCALAPPDATA: 'C:\\Local',
      USERPROFILE: 'C:\\Users\\me',
    },
    'me',
    { files, resources: new FakeJsonResourceStore() },
  );
  const operations = await adapter.operations(
      withUserConfig(releaseKey),
      releaseManifest(releaseKey),
    ),
    config = operations.automatic[0];
  expect(config).toMatchObject({ id: '01-user-config', target });
  await adapter.apply(config);
  expect((await files.read(target))?.toString('utf8')).toBe(userConfigContent());
  await expect(
    adapter.operations(withUserConfig(releaseKey), releaseManifest(releaseKey)),
  ).resolves.toBeDefined();
});

it('refuses different existing user-config bytes during planning and after observation', async () => {
  const releaseKey = 'a'.repeat(64),
    target = 'C:\\Roaming\\mpx\\config.json',
    files = new FakeBinaryFileSystem();
  const adapter = new ProductionInstallerOperationAdapter(
    {
      MPX_APPS: 'C:\\Apps',
      APPDATA: 'C:\\Roaming',
      LOCALAPPDATA: 'C:\\Local',
      USERPROFILE: 'C:\\Users\\me',
    },
    'me',
    { files, resources: new FakeJsonResourceStore() },
  );
  const config = (await adapter.operations(withUserConfig(releaseKey), releaseManifest(releaseKey)))
    .automatic[0];
  await files.write(target, Buffer.from('foreign'));
  await expect(adapter.apply(config)).rejects.toMatchObject({ code: 'INSTALL_FOREIGN_OR_DRIFTED' });
  await expect(
    adapter.operations(withUserConfig(releaseKey), releaseManifest(releaseKey)),
  ).rejects.toMatchObject({ code: 'INSTALL_FOREIGN_OR_DRIFTED' });
  expect((await files.read(target))?.toString()).toBe('foreign');
});

it('preserves a different user config created concurrently during apply', async () => {
  const releaseKey = 'a'.repeat(64),
    target = 'C:\\Roaming\\mpx\\config.json',
    concurrent = Buffer.from('concurrent-foreign');
  class RacingFiles extends FakeBinaryFileSystem {
    override async create(path: string, body: Buffer): Promise<boolean> {
      await this.write(path, concurrent);
      return super.create(path, body);
    }
  }
  const files = new RacingFiles();
  const adapter = new ProductionInstallerOperationAdapter(
    {
      MPX_APPS: 'C:\\Apps',
      APPDATA: 'C:\\Roaming',
      LOCALAPPDATA: 'C:\\Local',
      USERPROFILE: 'C:\\Users\\me',
    },
    'me',
    { files, resources: new FakeJsonResourceStore() },
  );
  const config = (await adapter.operations(withUserConfig(releaseKey), releaseManifest(releaseKey)))
    .automatic[0];
  await expect(adapter.apply(config)).rejects.toMatchObject({ code: 'INSTALL_FOREIGN_OR_DRIFTED' });
  expect(await files.read(target)).toEqual(concurrent);
});

it('hash-verifies user-config drift and rolls back its creation when a later operation fails', async () => {
  const releaseKey = 'a'.repeat(64),
    target = 'C:\\Roaming\\mpx\\config.json',
    files = new FakeBinaryFileSystem();
  const adapter = new ProductionInstallerOperationAdapter(
    {
      MPX_APPS: 'C:\\Apps',
      APPDATA: 'C:\\Roaming',
      LOCALAPPDATA: 'C:\\Local',
      USERPROFILE: 'C:\\Users\\me',
    },
    'me',
    { files, resources: new FakeJsonResourceStore() },
  );
  const operations = await adapter.operations(
    withUserConfig(releaseKey),
    releaseManifest(releaseKey),
  );
  const store = new MemoryTransactionStore(),
    service = new ImmutableInstallerService({
      adapters: [adapter],
      store,
      manifest: releaseManifest(releaseKey),
      failureInjection: (id) => {
        if (id === '05-cli-selector') {
          throw new Error('injected');
        }
      },
    });
  const plan = await service.plan(withUserConfig(releaseKey), operations.automatic.slice(0, 2));
  await expect(service.apply(plan, plan.confirmationDigest)).rejects.toThrow('injected');
  expect(await files.read(target)).toBeUndefined();
  const stable = new ImmutableInstallerService({
    adapters: [adapter],
    store,
    manifest: releaseManifest(releaseKey),
  });
  const secondPlan = await stable.plan(withUserConfig(releaseKey), [operations.automatic[0]]);
  await stable.apply(secondPlan, secondPlan.confirmationDigest);
  await files.write(target, Buffer.from('drift'));
  await expect(stable.verify()).resolves.toMatchObject({
    healthy: false,
    issues: ['operation-drift:01-user-config'],
  });
});

it('fails closed without overwriting a concurrent post-apply user-config change during rollback', async () => {
  const releaseKey = 'a'.repeat(64),
    target = 'C:\\Roaming\\mpx\\config.json',
    files = new FakeBinaryFileSystem(),
    concurrent = Buffer.from('user-changed-after-apply');
  const adapter = new ProductionInstallerOperationAdapter(
    {
      MPX_APPS: 'C:\\Apps',
      APPDATA: 'C:\\Roaming',
      LOCALAPPDATA: 'C:\\Local',
      USERPROFILE: 'C:\\Users\\me',
    },
    'me',
    { files, resources: new FakeJsonResourceStore() },
  );
  const config = (await adapter.operations(withUserConfig(releaseKey), releaseManifest(releaseKey)))
      .automatic[0],
    snapshot = await adapter.capture(config);
  await adapter.apply(config);
  await files.write(target, concurrent);
  await expect(adapter.restore(config, snapshot)).rejects.toMatchObject({
    code: 'INSTALL_FOREIGN_OR_DRIFTED',
  });
  expect(await files.read(target)).toEqual(concurrent);
});

it('rejects forged user-config retention through the production adapter', async () => {
  const adapter = new ProductionInstallerOperationAdapter(
    {
      MPX_APPS: 'C:\\Apps',
      APPDATA: 'C:\\Roaming',
      LOCALAPPDATA: 'C:\\Local',
      USERPROFILE: 'C:\\Users\\me',
    },
    'me',
    { files: new FakeBinaryFileSystem(), resources: new FakeJsonResourceStore() },
  );
  const attempts = [
    {
      operation: {
        id: '01-user-config',
        adapter: adapter.name,
        action: 'ensure' as const,
        target: 'C:\\Roaming\\arbitrary.json',
        desiredDigest: 'b'.repeat(64),
      },
      spec: { kind: 'user-config', retention: 'user-owned' },
    },
    {
      operation: {
        id: '01-user-config',
        adapter: adapter.name,
        action: 'ensure' as const,
        target: 'C:\\Roaming\\mpx\\config.json',
        desiredDigest: 'b'.repeat(64),
      },
      spec: { kind: 'user-config', retention: 'altered' },
    },
  ];
  for (const { operation, spec } of attempts) {
    const store = new MemoryTransactionStore();
    await store.writeReceipt({
      schemaVersion: 2,
      kind: 'ownership-receipt',
      releaseKey: 'a'.repeat(64),
      convergenceHash: 'a'.repeat(64),
      files: [],
      operations: [operation],
      operationLocators: [
        {
          operationId: operation.id,
          adapter: operation.adapter,
          spec,
          bindingDigest: installerDigest({ operation, spec }),
        },
      ],
      installedAt: '2025-01-01T00:00:00.000Z',
    });
    await expect(
      new ImmutableInstallerService({ adapters: [adapter], store }).planUninstall(),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^INSTALL_RECEIPT_(FORGED|AMBIGUOUS)$/u),
    });
  }
});

it('keeps concurrent plans bound to their own roots and resources', async () => {
  const firstKey = 'a'.repeat(64),
    secondKey = 'c'.repeat(64),
    files = new FakeBinaryFileSystem(),
    resources = new FakeJsonResourceStore();
  const adapter = new ProductionInstallerOperationAdapter(
    {
      MPX_APPS: 'C:\\Apps-A',
      APPDATA: 'C:\\Roaming-A',
      LOCALAPPDATA: 'C:\\Local-A',
      USERPROFILE: 'C:\\Users\\a',
    },
    'me',
    { files, resources },
  );
  const intent = (releaseKey: string): InstallIntentV1 => ({
    schemaVersion: 1,
    kind: 'install-intent',
    releaseKey,
    convergenceHash: releaseKey,
    components: ['cli'],
  });
  const manifest = (releaseKey: string, cliSha: string): ReleaseManifestV1 => ({
    schemaVersion: 1,
    kind: 'release-manifest',
    releaseKey,
    convergenceHash: releaseKey,
    files: [{ path: 'bin/mpx.mjs', bytes: 3, sha256: cliSha }],
  });
  const first = await adapter.operations(intent(firstKey), manifest(firstKey, 'b'.repeat(64)));
  Object.assign((adapter as unknown as { environment: NodeJS.ProcessEnv }).environment, {
    MPX_APPS: 'C:\\Apps-B',
    APPDATA: 'C:\\Roaming-B',
    LOCALAPPDATA: 'C:\\Local-B',
    USERPROFILE: 'C:\\Users\\b',
  });
  const second = await adapter.operations(intent(secondKey), manifest(secondKey, 'd'.repeat(64)));
  const selected = (set: Awaited<ReturnType<typeof adapter.operations>>) =>
    set.automatic.filter((operation) =>
      ['05-cli-selector', '10-profile-0', '20-terminal-profile'].includes(operation.id),
    );
  await Promise.all(
    [...selected(first), ...selected(second)].map((operation) => adapter.apply(operation)),
  );
  expect((await files.read('C:\\Apps-A\\mpx\\bin\\mpx.cmd'))?.toString()).toContain(
    'active-release',
  );
  expect((await files.read('C:\\Apps-B\\mpx\\bin\\mpx.cmd'))?.toString()).toContain(
    'active-release',
  );
  expect(
    await resources.read(
      'C:\\Local-A\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json',
    ),
  ).toMatchObject({ profiles: [{ name: 'MPX' }] });
  expect(
    await resources.read(
      'C:\\Local-B\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json',
    ),
  ).toMatchObject({ profiles: [{ name: 'MPX' }] });
});

it('inspects managed scheduled-task status through the read-only production port', async () => {
  const releaseKey = 'a'.repeat(64),
    files = new FakeBinaryFileSystem(),
    resources = new FakeJsonResourceStore();
  const inspect = vi.fn(async () => ({
    exists: true,
    state: 'Ready',
    lastRunAt: '2025-01-01T00:00:00.000Z',
    lastResult: 0,
  }));
  const adapter = new ProductionInstallerOperationAdapter(
    {
      MPX_APPS: 'C:\\Apps',
      APPDATA: 'C:\\Roaming',
      LOCALAPPDATA: 'C:\\Local',
      USERPROFILE: 'C:\\Users\\me',
    },
    'me',
    { files, resources, scheduledTaskStatus: { inspect } },
  );
  const intent: InstallIntentV1 = {
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
  } as ReleaseManifestV1;
  const operations = await adapter.operations(intent, manifest),
    task = operations.scheduled[0];
  await expect(adapter.inspectScheduledTaskStatus(task)).resolves.toMatchObject({
    exists: true,
    lastResult: 0,
  });
  expect(inspect).toHaveBeenCalledExactlyOnceWith(task.target);
  await expect(
    adapter.inspectScheduledTaskStatus(operations.automatic[0]),
  ).resolves.toBeUndefined();
  expect(inspect).toHaveBeenCalledTimes(1);
});

it('plans from explicit roots without writes and applies managed profile and Terminal state without replacing foreign bytes', async () => {
  const releaseKey = 'a'.repeat(64),
    profile = 'C:\\Users\\me\\.bashrc',
    terminal =
      'C:\\Local\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json';
  const files = new FakeBinaryFileSystem({ [profile]: Buffer.from('native\r\n') });
  const resources = new FakeJsonResourceStore({
    [terminal]: { profiles: [{ guid: 'foreign', name: 'Keep' }], theme: 'native' },
  });
  const adapter = new ProductionInstallerOperationAdapter(
    {
      MPX_APPS: 'C:\\Apps',
      APPDATA: 'C:\\Roaming',
      LOCALAPPDATA: 'C:\\Local',
      USERPROFILE: 'C:\\Users\\me',
    },
    'me',
    { files, resources },
  );
  const intent: InstallIntentV1 = {
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
  } as ReleaseManifestV1;
  const operations = await adapter.operations(intent, manifest);
  const selector = 'C:\\Apps\\mpx\\bin\\mpx.cmd';
  expect(operations.automatic.map((item) => item.id)).toContain('05-cli-selector');
  expect((await files.read(profile))?.toString()).toBe('native\r\n');
  expect(await resources.read(terminal)).toEqual({
    profiles: [{ guid: 'foreign', name: 'Keep' }],
    theme: 'native',
  });
  expect(operations.scheduled.map((x) => x.id)).toEqual(['90-scheduled-capture']);
  const task = operations.scheduled[0];
  expect(task.desiredDigest).not.toBeNull();
  for (const operation of operations.automatic.filter(
    (x) => x.id === '05-cli-selector' || x.id === '10-profile-0' || x.id === '20-terminal-profile',
  )) {
    await adapter.apply(operation);
  }
  expect((await files.read(selector))?.toString()).toContain('active-release');
  expect((await files.read(profile))?.toString()).toContain(
    'native\r\n# >>> MPX MANAGED LAUNCHERS >>>',
  );
  expect(await resources.read(terminal)).toMatchObject({
    profiles: [{ guid: 'foreign', name: 'Keep' }, { name: 'MPX' }],
    theme: 'native',
  });
  expect(operations.automatic.find((x) => x.id === '20-terminal-profile')?.desiredDigest).toBe(
    installerDigest(((await resources.read(terminal)) as any).profiles[1]),
  );
});
