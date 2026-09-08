import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FakeBinaryFileSystem, FakeJsonResourceStore } from '@mpx/windows';
import {
  canonicalJson,
  installerDigest,
  type InstallIntentV1,
  type OwnershipReceiptV1,
  type ReleaseManifestV1,
} from '../../src/immutable-core.js';
import {
  NodeBinaryFileSystem,
  NodeJsonResourceStore,
  ProductionInstallerOperationAdapter,
  ReadOnlyRuntimeRegistrationInspector,
} from '../../src/production-operation.js';
import { ImmutableInstallerService, MemoryTransactionStore } from '../../src/transaction.js';

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

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

it('atomically serializes JSON resources and cleans temporary state after replacement failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-json-replace-failure-')),
    target = path.join(root, 'config.json'),
    initial = { nested: { enabled: true } };
  try {
    await new NodeJsonResourceStore().write(target, initial);
    expect(await readFile(target, 'utf8')).toBe(`${JSON.stringify(initial, null, 2)}\n`);

    const store = new NodeJsonResourceStore({
      temporarySuffix: () => 'injected',
      writeFile: async (temporary, body, options) => {
        expect(Buffer.isBuffer(body)).toBe(true);
        await writeFile(temporary, body, options);
      },
      rename: async () => {
        throw new Error('injected replacement failure');
      },
    });
    await expect(store.write(target, { replaced: true })).rejects.toThrow(
      'injected replacement failure',
    );
    expect(await readFile(target, 'utf8')).toBe(`${JSON.stringify(initial, null, 2)}\n`);
    expect(await readdir(root)).toEqual(['config.json']);
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
      MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
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

it('rejects malformed edited user-config bytes before they can become adoption evidence', async () => {
  const releaseKey = 'a'.repeat(64),
    target = 'C:\\Roaming\\mpx\\config.json',
    malformed = '{"identities":',
    files = new FakeBinaryFileSystem();
  await files.write(target, Buffer.from(malformed));
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
  const malformedIntent = {
    ...withUserConfig(releaseKey),
    userConfigArtifact: {
      target: '%APPDATA%/mpx/config.json',
      content: malformed,
      sha256: createHash('sha256').update(malformed).digest('hex'),
    },
  } satisfies InstallIntentV1;
  await expect(
    adapter.operations(malformedIntent, releaseManifest(releaseKey)),
  ).rejects.toBeDefined();
  expect(await files.read(target)).toEqual(Buffer.from(malformed));
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
      MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
    },
    'me',
    { files, resources: new FakeJsonResourceStore() },
  );
  const operations = await adapter.operations(
      withUserConfig(releaseKey),
      releaseManifest(releaseKey),
    ),
    config = required(operations.automatic[0], 'user-config operation');
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
      MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
    },
    'me',
    { files, resources: new FakeJsonResourceStore() },
  );
  const config = required(
    (await adapter.operations(withUserConfig(releaseKey), releaseManifest(releaseKey)))
      .automatic[0],
    'user-config operation',
  );
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
      MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
    },
    'me',
    { files, resources: new FakeJsonResourceStore() },
  );
  const config = required(
    (await adapter.operations(withUserConfig(releaseKey), releaseManifest(releaseKey)))
      .automatic[0],
    'user-config operation',
  );
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
      MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
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
  const secondPlan = await stable.plan(withUserConfig(releaseKey), [
    required(operations.automatic[0], 'user-config operation'),
  ]);
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
      MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
    },
    'me',
    { files, resources: new FakeJsonResourceStore() },
  );
  const config = required(
      (await adapter.operations(withUserConfig(releaseKey), releaseManifest(releaseKey)))
        .automatic[0],
      'user-config operation',
    ),
    snapshot = await adapter.capture(config);
  await adapter.apply(config);
  await files.write(target, concurrent);
  await expect(adapter.restore(config, snapshot)).rejects.toMatchObject({
    code: 'INSTALL_FOREIGN_OR_DRIFTED',
  });
  expect(await files.read(target)).toEqual(concurrent);
});

it('rejects legacy Terminal receipt locators without inspecting their target', async () => {
  const target =
      'C:\\Local\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json',
    resources = new FakeJsonResourceStore({
      [target]: { profiles: [{ guid: 'legacy-mpx', name: 'MPX' }] },
    }),
    readResource = vi.spyOn(resources, 'read'),
    adapter = new ProductionInstallerOperationAdapter(
      {
        MPX_APPS: 'C:\\Apps',
        APPDATA: 'C:\\Roaming',
        LOCALAPPDATA: 'C:\\Local',
        USERPROFILE: 'C:\\Users\\me',
        MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
      },
      'me',
      { files: new FakeBinaryFileSystem(), resources },
    ),
    spec = {
      kind: 'terminal-profile' as const,
      target,
      ownershipKey: 'legacy-mpx',
      desired: { guid: 'legacy-mpx', name: 'MPX' },
    },
    operation = {
      id: '20-terminal-profile',
      adapter: adapter.name,
      action: 'ensure' as const,
      target,
      desiredDigest: installerDigest(spec.desired),
    };

  await expect(
    adapter.hydrateReceiptOperation(operation, { kind: 'resource', spec }),
  ).rejects.toMatchObject({ code: 'INSTALL_RECEIPT_AMBIGUOUS' });
  expect(readResource).not.toHaveBeenCalled();
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
      MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
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
    MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
  });
  const second = await adapter.operations(intent(secondKey), manifest(secondKey, 'd'.repeat(64)));
  const selected = (set: Awaited<ReturnType<typeof adapter.operations>>) =>
    set.automatic.filter((operation) => ['05-cli-selector', '10-profile-0'].includes(operation.id));
  await Promise.all(
    [...selected(first), ...selected(second)].map((operation) => adapter.apply(operation)),
  );
  expect((await files.read('C:\\Apps-A\\mpx\\bin\\mpx.cmd'))?.toString()).toContain(
    '%~dp0mpx-node.mjs',
  );
  expect((await files.read('C:\\Apps-B\\mpx\\bin\\mpx.cmd'))?.toString()).toContain(
    '%~dp0mpx-node.mjs',
  );
});

it('captures the complete environment Path and resumes restore when the snapshot already matches', async () => {
  const releaseKey = 'a'.repeat(64),
    target = 'HKCU\\Environment',
    snapshot = { TEMP: 'C:\\Temp', Path: 'C:\\Foreign;C:\\Tools' },
    resources = new FakeJsonResourceStore({ [target]: snapshot }),
    readResource = vi.spyOn(resources, 'read'),
    writeResource = vi.spyOn(resources, 'write'),
    adapter = new ProductionInstallerOperationAdapter(
      {
        MPX_APPS: 'C:\\Apps',
        APPDATA: 'C:\\Roaming',
        LOCALAPPDATA: 'C:\\Local',
        USERPROFILE: 'C:\\Users\\me',
        MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
      },
      'me',
      { files: new FakeBinaryFileSystem(), resources },
    ),
    operations = await adapter.operations(
      {
        schemaVersion: 1,
        kind: 'install-intent',
        releaseKey,
        convergenceHash: releaseKey,
        components: ['cli'],
      },
      releaseManifest(releaseKey),
    ),
    environment = required(
      operations.automatic.find((operation) => operation.id === '20-user-environment'),
      'user environment operation',
    ),
    captured = await adapter.capture(environment),
    locatorSpec = await adapter.receiptLocator(environment);

  if (captured === null) {
    throw new Error('Expected environment snapshot');
  }
  expect(JSON.parse(Buffer.from(captured, 'base64').toString())).toEqual(snapshot);
  const store = new MemoryTransactionStore();
  await store.writeTransaction({
    journal: {
      schemaVersion: 1,
      kind: 'transaction-journal',
      transactionId: 'interrupted-environment',
      phase: 'applying',
      completedOperationIds: [],
      inFlightOperationId: environment.id,
      snapshot: {
        schemaVersion: 1,
        kind: 'machine-snapshot',
        transactionId: 'interrupted-environment',
        observations: [{ id: environment.id, digest: installerDigest(snapshot) }],
        capturedAt: '2025-01-01T00:00:00.000Z',
      },
    },
    snapshots: { [environment.id]: captured },
    operations: [environment],
    operationLocators: [
      {
        operationId: environment.id,
        adapter: environment.adapter,
        spec: locatorSpec,
        bindingDigest: installerDigest({ operation: environment, spec: locatorSpec }),
      },
    ],
  });
  readResource.mockClear();
  await expect(
    new ImmutableInstallerService({ adapters: [adapter], store }).recover(),
  ).resolves.toBeUndefined();
  expect(readResource).toHaveBeenCalledTimes(1);
  expect(writeResource).not.toHaveBeenCalled();
  expect((await store.readTransaction())?.journal).toMatchObject({ phase: 'rolled-back' });
});

it('refuses to replace a concurrently changed foreign Path during environment rollback', async () => {
  const releaseKey = 'a'.repeat(64),
    target = 'HKCU\\Environment',
    snapshot = { TEMP: 'C:\\Temp', Path: 'C:\\Foreign' },
    resources = new FakeJsonResourceStore({ [target]: snapshot }),
    adapter = new ProductionInstallerOperationAdapter(
      {
        MPX_APPS: 'C:\\Apps',
        APPDATA: 'C:\\Roaming',
        LOCALAPPDATA: 'C:\\Local',
        USERPROFILE: 'C:\\Users\\me',
        MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
      },
      'me',
      { files: new FakeBinaryFileSystem(), resources },
    ),
    operations = await adapter.operations(
      {
        schemaVersion: 1,
        kind: 'install-intent',
        releaseKey,
        convergenceHash: releaseKey,
        components: ['cli'],
      },
      releaseManifest(releaseKey),
    ),
    environment = required(
      operations.automatic.find((operation) => operation.id === '20-user-environment'),
      'user environment operation',
    ),
    captured = await adapter.capture(environment),
    prepend = 'C:\\Apps\\mpx\\bin';
  await adapter.apply(environment);
  const applied = required(await resources.read(target), 'applied environment') as Record<
    string,
    unknown
  >;
  await resources.write(target, {
    ...snapshot,
    ...applied,
    Path: `${prepend};C:\\Concurrent`,
  });

  await expect(adapter.restore(environment, captured)).rejects.toMatchObject({
    code: 'INSTALL_FOREIGN_OR_DRIFTED',
  });
  await expect(resources.read(target)).resolves.toMatchObject({
    Path: `${prepend};C:\\Concurrent`,
  });
});

it('excludes scheduled capture from production base operations without Task Scheduler inspection', async () => {
  const releaseKey = 'a'.repeat(64),
    resources = new FakeJsonResourceStore(),
    readResource = vi.spyOn(resources, 'read'),
    adapter = new ProductionInstallerOperationAdapter(
      {
        MPX_APPS: 'C:\\Apps',
        APPDATA: 'C:\\Roaming',
        LOCALAPPDATA: 'C:\\Local',
        USERPROFILE: 'C:\\Users\\me',
        MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
      },
      'me',
      { files: new FakeBinaryFileSystem(), resources },
    );

  const operations = await adapter.operations(
    {
      schemaVersion: 1,
      kind: 'install-intent',
      releaseKey,
      convergenceHash: releaseKey,
      components: ['cli'],
    },
    releaseManifest(releaseKey),
  );

  expect(operations.automatic).not.toContainEqual(
    expect.objectContaining({ id: '90-scheduled-capture' }),
  );
  expect(readResource).not.toHaveBeenCalledWith('\\MPX\\Session Capture');
});

it('rejects legacy scheduled-task receipt locators without Task Scheduler access', async () => {
  const target = '\\MPX\\Session Capture',
    resources = new FakeJsonResourceStore(),
    readResource = vi.spyOn(resources, 'read'),
    adapter = new ProductionInstallerOperationAdapter(
      {
        MPX_APPS: 'C:\\Apps',
        APPDATA: 'C:\\Roaming',
        LOCALAPPDATA: 'C:\\Local',
        USERPROFILE: 'C:\\Users\\me',
        MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
      },
      'me',
      {
        files: new FakeBinaryFileSystem(),
        resources,
      },
    ),
    spec = {
      kind: 'scheduled-task' as const,
      target,
      ownershipKey: 'mpx',
      desired: { owner: 'mpx' },
    },
    operation = {
      id: '90-scheduled-capture',
      adapter: adapter.name,
      action: 'ensure' as const,
      target,
      desiredDigest: installerDigest(spec.desired),
    };

  await expect(
    adapter.hydrateReceiptOperation(operation, { kind: 'resource', spec }),
  ).rejects.toMatchObject({ code: 'INSTALL_RECEIPT_AMBIGUOUS' });
  expect(readResource).not.toHaveBeenCalled();
});

it('never inspects, plans, or writes Windows Terminal while retaining managed installer operations', async () => {
  const releaseKey = 'a'.repeat(64),
    profile = 'C:\\Users\\me\\.bashrc',
    terminal =
      'C:\\Local\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json';
  const files = new FakeBinaryFileSystem({ [profile]: Buffer.from('native\r\n') });
  const resources = new FakeJsonResourceStore({
    [terminal]: { profiles: [{ guid: 'foreign', name: 'Keep' }], theme: 'native' },
  });
  const readResource = vi.spyOn(resources, 'read');
  const writeResource = vi.spyOn(resources, 'write');
  const adapter = new ProductionInstallerOperationAdapter(
    {
      MPX_APPS: 'C:\\Apps',
      APPDATA: 'C:\\Roaming',
      LOCALAPPDATA: 'C:\\Local',
      USERPROFILE: 'C:\\Users\\me',
      MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
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
  expect(operations.automatic).toContainEqual(
    expect.objectContaining({
      id: '06-node-entry',
      target: 'C:\\Apps\\mpx\\bin\\mpx-node.mjs',
    }),
  );
  expect(operations.automatic.map((item) => item.id)).not.toContain('20-terminal-profile');
  expect((await files.read(profile))?.toString()).toBe('native\r\n');
  expect(readResource).not.toHaveBeenCalledWith(terminal);
  for (const operation of operations.automatic) {
    await adapter.apply(operation);
  }
  expect((await files.read(selector))?.toString()).toContain('%~dp0mpx-node.mjs');
  expect((await files.read(profile))?.toString()).toContain(
    'native\r\n# >>> MPX MANAGED LAUNCHERS >>>',
  );
  expect(readResource).not.toHaveBeenCalledWith(terminal);
  expect(writeResource).not.toHaveBeenCalledWith(terminal, expect.anything());
});

it('preserves a concurrently changed ordinary file during rollback', async () => {
  const releaseKey = 'a'.repeat(64),
    files = new FakeBinaryFileSystem(),
    adapter = new ProductionInstallerOperationAdapter(
      {
        MPX_APPS: 'C:\\Apps',
        APPDATA: 'C:\\Roaming',
        LOCALAPPDATA: 'C:\\Local',
        USERPROFILE: 'C:\\Users\\me',
        MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
      },
      'me',
      { files, resources: new FakeJsonResourceStore() },
    ),
    operations = await adapter.operations(
      {
        schemaVersion: 1,
        kind: 'install-intent',
        releaseKey,
        convergenceHash: releaseKey,
        components: ['cli'],
      },
      releaseManifest(releaseKey),
    ),
    selector = required(
      operations.automatic.find((operation) => operation.id === '05-cli-selector'),
      'selector operation',
    ),
    prior = Buffer.from('prior-selector'),
    concurrent = Buffer.from('concurrent-selector');
  await files.write(selector.target, prior);
  const snapshot = await adapter.capture(selector);
  await adapter.apply(selector);
  await files.write(selector.target, concurrent);

  await expect(adapter.restore(selector, snapshot)).rejects.toMatchObject({
    code: 'INSTALL_FOREIGN_OR_DRIFTED',
  });
  expect(await files.read(selector.target)).toEqual(concurrent);
});

it('preserves a concurrently changed managed launcher during rollback', async () => {
  const releaseKey = 'a'.repeat(64),
    files = new FakeBinaryFileSystem(),
    adapter = new ProductionInstallerOperationAdapter(
      {
        MPX_APPS: 'C:\\Apps',
        APPDATA: 'C:\\Roaming',
        LOCALAPPDATA: 'C:\\Local',
        USERPROFILE: 'C:\\Users\\me',
        MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
      },
      'me',
      { files, resources: new FakeJsonResourceStore() },
    ),
    operations = await adapter.operations(
      {
        schemaVersion: 1,
        kind: 'install-intent',
        releaseKey,
        convergenceHash: releaseKey,
        components: ['cli'],
      },
      releaseManifest(releaseKey),
    ),
    launcher = required(
      operations.automatic.find((operation) => operation.id === '10-profile-0'),
      'launcher operation',
    ),
    prior = Buffer.from('# prior launcher'),
    concurrent = Buffer.from('# concurrent launcher');
  await files.write(launcher.target, prior);
  const snapshot = await adapter.capture(launcher);
  await adapter.apply(launcher);
  await files.write(launcher.target, concurrent);

  await expect(adapter.restore(launcher, snapshot)).rejects.toMatchObject({
    code: 'INSTALL_FOREIGN_OR_DRIFTED',
  });
  expect(await files.read(launcher.target)).toEqual(concurrent);
});

it('accepts only desired or exact prior runtime registration receipts during an upgrade', async () => {
  const local = await mkdtemp(path.join(tmpdir(), 'mpx-registration-upgrade-')),
    executable = path.join(local, 'runtime.exe'),
    executableBody = Buffer.from('runtime'),
    identity = 'claude-personal' as const;
  await writeFile(executable, executableBody);
  const registration = {
    schemaVersion: 1 as const,
    kind: 'runtime-registration' as const,
    identity,
    runtime: 'claude' as const,
    domain: 'personal' as const,
    nativeRootDigest: installerDigest('native'),
    executable: {
      path: executable,
      sha256: createHash('sha256').update(executableBody).digest('hex'),
      version: '1',
    },
    projection: {
      rootDigest: installerDigest('projection'),
      files: [
        {
          path: 'missing.json',
          sha256: installerDigest('missing'),
          bytes: 1,
          role: 'plugin' as const,
          owner: 'convergence' as const,
        },
      ],
      reader: 'canonical' as const,
      activation: 'argv-only' as const,
    },
    routes: {
      git: 'personal:git',
      provider: 'personal:provider',
      ssh: 'personal:ssh',
      mcpSharing: 'shared' as const,
    },
  };
  const matrix = {
    schemaVersion: 1 as const,
    kind: 'runtime-registration-matrix' as const,
    registrations: [registration],
    matrixDigest: installerDigest('matrix'),
  };
  const intentA = {
      schemaVersion: 1 as const,
      kind: 'install-intent' as const,
      releaseKey: 'a'.repeat(64),
      convergenceHash: 'a'.repeat(64),
      components: ['runtime-registration'],
      runtimeRegistrations: matrix,
    } as InstallIntentV1,
    intentB = { ...intentA, releaseKey: 'b'.repeat(64), convergenceHash: 'b'.repeat(64) },
    prior = { releaseKey: intentA.releaseKey, installIntent: intentA } as OwnershipReceiptV1,
    receiptTarget = path.join(local, 'mpx', 'installer', 'registrations', `${identity}.json`),
    inspector = new ReadOnlyRuntimeRegistrationInspector({ LOCALAPPDATA: local });
  await mkdir(path.dirname(receiptTarget), { recursive: true });
  const writeRegistrationReceipt = (releaseKey: string) =>
    writeFile(
      receiptTarget,
      `${canonicalJson({ schemaVersion: 1, kind: 'runtime-registration-receipt', releaseKey, registration })}\n`,
    );

  await writeRegistrationReceipt(intentA.releaseKey);
  await expect(inspector.inspect(intentB, prior)).resolves.toMatchObject({ runtimeIssues: [] });
  await expect(inspector.inspect(intentB)).resolves.toMatchObject({
    runtimeIssues: [`registration-drift:${identity}`],
  });
  await writeRegistrationReceipt(intentB.releaseKey);
  await expect(inspector.inspect(intentB, prior)).resolves.toMatchObject({ runtimeIssues: [] });
  await writeRegistrationReceipt('c'.repeat(64));
  await expect(inspector.inspect(intentB, prior)).resolves.toMatchObject({
    runtimeIssues: [`registration-drift:${identity}`],
  });
});
