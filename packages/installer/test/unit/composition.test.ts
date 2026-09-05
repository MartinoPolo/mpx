import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FakeBinaryFileSystem, FakeJsonResourceStore } from '@mpx/windows';
import {
  parseInstallIntentV1,
  parseInstallPlanV1,
  installerDigest,
  type InstallIntentV1,
  type InstallOperationV1,
  type OwnershipReceiptV1,
  type ReleaseManifestV1,
} from '../../src/immutable-core.js';
import {
  createRuntimeRegistrationMatrix,
  registerStaticMcp,
  type ProjectionFileV1,
  type RuntimeRegistrationInput,
} from '../../src/runtime-registration.js';
import {
  NodeBinaryFileSystem,
  ProductionInstallerOperationAdapter,
} from '../../src/production-operation.js';
import {
  NodePiNativeSettingsPort,
  type PiNativeSettingsPort,
} from '../../src/pi-native-settings.js';
import { parsePiNativePackageRegistration } from '../../src/pi-native-package.js';
import {
  ImmutableInstallerService,
  MemoryTransactionStore,
  NodeTransactionStore,
  type TransactionStore,
} from '../../src/transaction.js';

const sha = (value: string) => installerDigest(value);
function files(runtime: 'claude' | 'pi'): ProjectionFileV1[] {
  const roles =
    runtime === 'claude'
      ? ([
          'plugin',
          'hooks',
          'status',
          'settings',
          'canonical-content',
          'agents',
          'licenses',
        ] as const)
      : ([
          'extension',
          'profile',
          'keybindings',
          'themes',
          'status',
          'settings',
          'canonical-content',
          'agents',
          'licenses',
        ] as const);
  return roles.map((role, index) => ({
    path: `${runtime}/${index}-${role}.json`,
    sha256: sha(`${runtime}-${role}`),
    bytes: index + 1,
    role,
    owner: 'convergence',
  }));
}
const nativeInventory = [
  { path: 'build-metadata.json', sha256: sha('m'), bytes: 1 },
  { path: 'index.mjs', sha256: sha('i'), bytes: 1 },
  { path: 'package.json', sha256: sha('p'), bytes: 1 },
];
const nativePackage = parsePiNativePackageRegistration({
  name: '@mpx/pi-extensions',
  packageRoot: 'runtimes/pi/extensions/dist/package',
  artifactRootDigest: installerDigest(nativeInventory),
  files: nativeInventory,
});
function required<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

function piUserConfig(personalRoot: string, workRoot: string): string {
  return JSON.stringify({
    identities: {
      personal: {
        domain: 'personal',
        runtimeRoots: { claude: 'C:\\claude-personal', pi: personalRoot },
        gitAuthorRoute: 'personal-git',
      },
      work: {
        domain: 'work',
        runtimeRoots: { claude: 'C:\\claude-work', pi: workRoot },
        gitAuthorRoute: 'work-git',
      },
    },
    domains: { personal: ['C:\\personal'], work: ['C:\\work'] },
    contentScopes: {},
    modes: {},
    skillPolicies: {},
    presets: {},
    launchDefaults: { scopes: {}, projects: {} },
    networkPolicies: {},
    executors: { host: {} },
  });
}

function input(runtime: 'claude' | 'pi', domain: 'personal' | 'work', root: string) {
  const projectionFiles = files(runtime);
  const common = {
    domain,
    nativeRoot: root,
    executable: { path: `C:\\tools\\${runtime}.exe`, sha256: sha(`${runtime}-exe`), version: '1' },
    projection: {
      rootDigest: installerDigest(projectionFiles),
      files: projectionFiles,
      reader: 'canonical' as const,
      activation: 'argv-only' as const,
    },
    routes: {
      git: `${domain}:git`,
      provider: `${domain}:provider`,
      ssh: `${domain}:ssh`,
      mcpSharing: domain === 'personal' ? ('shared' as const) : ('isolated' as const),
    },
  };
  return runtime === 'pi'
    ? { ...common, runtime: 'pi' as const, nativePackage }
    : { ...common, runtime: 'claude' as const };
}

async function piRestartRollbackFixture() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mpx-pi-restart-')),
    apps = path.join(temporary, 'apps'),
    personalRoot = path.join(temporary, 'pi-personal'),
    workRoot = path.join(temporary, 'pi-work'),
    packageBodies = {
      'build-metadata.json': 'm',
      'index.mjs': 'i',
      'package.json': 'p',
    },
    packageFiles = Object.entries(packageBodies).map(([file, body]) => ({
      path: file,
      sha256: createHash('sha256').update(body).digest('hex'),
      bytes: Buffer.byteLength(body),
    })),
    rollbackNativePackage = parsePiNativePackageRegistration({
      name: '@mpx/pi-extensions',
      packageRoot: 'runtimes/pi/extensions/dist/package',
      artifactRootDigest: installerDigest(packageFiles),
      files: packageFiles,
    }),
    runtimeRegistrations = createRuntimeRegistrationMatrix([
      input('claude', 'personal', path.join(temporary, 'claude-personal')),
      input('claude', 'work', path.join(temporary, 'claude-work')),
      {
        ...(input('pi', 'personal', personalRoot) as Extract<
          RuntimeRegistrationInput,
          { runtime: 'pi' }
        >),
        nativePackage: rollbackNativePackage,
      },
      {
        ...(input('pi', 'work', workRoot) as Extract<RuntimeRegistrationInput, { runtime: 'pi' }>),
        nativePackage: rollbackNativePackage,
      },
    ]),
    environment = {
      MPX_APPS: apps,
      APPDATA: path.join(temporary, 'roaming'),
      LOCALAPPDATA: path.join(temporary, 'local'),
      USERPROFILE: path.join(temporary, 'user'),
      MPX_NODE_EXECUTABLE: process.execPath,
    };
  await Promise.all([
    mkdir(personalRoot, { recursive: true }),
    mkdir(workRoot, { recursive: true }),
  ]);
  await Promise.all(
    [personalRoot, workRoot].map((root) =>
      writeFile(
        path.join(root, 'settings.json'),
        JSON.stringify({ packages: ['foreign'], credentials: { token: 'keep' }, theme: 'keep' }),
      ),
    ),
  );
  const configContent = piUserConfig(personalRoot, workRoot);
  await mkdir(path.join(environment.APPDATA, 'mpx'), { recursive: true });
  await writeFile(path.join(environment.APPDATA, 'mpx', 'config.json'), configContent);
  const adapter = () =>
      new ProductionInstallerOperationAdapter(environment, 'me', {
        files: new NodeBinaryFileSystem(),
        resources: new FakeJsonResourceStore(),
        runtimeRegistrations: {
          inspect: async () => ({
            observations: [],
            accountProbes: runtimeRegistrations.registrations.map((item) => ({
              identity: item.identity,
              runtime: item.runtime,
              domain: item.domain,
              nativeRootDigest: item.nativeRootDigest,
              status: 'unavailable' as const,
              accountLabel: `${item.domain}:account`,
            })),
            mcpSharing: Object.fromEntries(
              runtimeRegistrations.registrations.map((item) => [
                item.identity,
                item.routes.mcpSharing,
              ]),
            ) as never,
          }),
        },
      }),
    release = async (marker: string) => {
      const manifestFiles = [
          { path: 'bin/mpx.mjs', bytes: marker.length, sha256: sha(marker) },
          ...new Map(
            runtimeRegistrations.registrations
              .flatMap((item) => item.projection.files)
              .map((file) => [
                file.path,
                { path: file.path, bytes: file.bytes, sha256: file.sha256 },
              ]),
          ).values(),
          ...rollbackNativePackage.files.map((file) => ({
            ...file,
            path: `${rollbackNativePackage.packageRoot}/${file.path}`,
          })),
        ].sort((left, right) => left.path.localeCompare(right.path)),
        releaseKey = installerDigest(manifestFiles),
        packageRoot = path.join(
          apps,
          'mpx',
          'releases',
          releaseKey,
          ...rollbackNativePackage.packageRoot.split('/'),
        );
      await mkdir(packageRoot, { recursive: true });
      await Promise.all(
        Object.entries(packageBodies).map(([name, body]) =>
          writeFile(path.join(packageRoot, name), body),
        ),
      );
      const intent = parseInstallIntentV1({
          schemaVersion: 1,
          kind: 'install-intent',
          releaseKey,
          convergenceHash: releaseKey,
          components: ['runtime-registration'],
          userConfigArtifact: {
            target: '%APPDATA%/mpx/config.json',
            content: configContent,
            sha256: createHash('sha256').update(configContent).digest('hex'),
          },
          runtimeRegistrations,
        }),
        manifest = {
          schemaVersion: 1,
          kind: 'release-manifest',
          releaseKey,
          convergenceHash: releaseKey,
          files: manifestFiles,
        } as ReleaseManifestV1;
      return { intent, manifest, packageRoot };
    },
    settings = async () =>
      JSON.parse(await readFile(path.join(personalRoot, 'settings.json'), 'utf8')) as Record<
        string,
        unknown
      >,
    writeSettings = (value: unknown) =>
      writeFile(path.join(personalRoot, 'settings.json'), JSON.stringify(value)),
    operation = async (
      owner: ProductionInstallerOperationAdapter,
      value: { intent: InstallIntentV1; manifest: ReleaseManifestV1 },
      priorReceipt?: OwnershipReceiptV1,
    ) =>
      required(
        (await owner.operations(value.intent, value.manifest, false, priorReceipt)).automatic.find(
          (candidate) => candidate.id === '50-pi-settings-personal',
        ),
        'personal Pi settings operation',
      ),
    receipt = async (
      owner: ProductionInstallerOperationAdapter,
      value: { intent: InstallIntentV1; manifest: ReleaseManifestV1 },
      ownedOperation: InstallOperationV1,
    ): Promise<OwnershipReceiptV1> => {
      const spec = await owner.receiptLocator(ownedOperation);
      return {
        schemaVersion: 2,
        kind: 'ownership-receipt',
        releaseKey: value.intent.releaseKey,
        convergenceHash: value.intent.convergenceHash,
        files: value.manifest.files,
        operations: [ownedOperation],
        operationLocators: [
          {
            operationId: ownedOperation.id,
            adapter: ownedOperation.adapter,
            spec,
            bindingDigest: installerDigest({ operation: ownedOperation, spec }),
          },
        ],
        installIntent: value.intent,
        installedAt: '2026-01-01T00:00:00.000Z',
      };
    };
  return {
    temporary,
    adapter,
    release,
    settings,
    writeSettings,
    operation,
    receipt,
    personalRoot,
  };
}

async function leaveInterruptedApply(
  adapter: ProductionInstallerOperationAdapter,
  store: TransactionStore,
  release: { intent: InstallIntentV1; manifest: ReleaseManifestV1 },
  operation: InstallOperationV1,
  priorReceipt?: OwnershipReceiptV1,
) {
  const service = new ImmutableInstallerService({
      adapters: [adapter],
      store,
      manifest: release.manifest,
      failureInjection: () => {
        throw new Error('simulated process termination');
      },
    }),
    basePlan = await service.plan(release.intent, [operation], priorReceipt),
    classifications = priorReceipt
      ? {
          automatic: [operation.id],
          confirmationRequired: [
            {
              id: 'ownership-release-upgrade',
              planDigest: installerDigest(priorReceipt),
              verifierRef: 'installer:ownership-release-upgrade',
            },
          ],
          manualOnly: [],
        }
      : undefined,
    classifiedPlan = classifications
      ? {
          schemaVersion: basePlan.schemaVersion,
          kind: basePlan.kind,
          intent: basePlan.intent,
          observations: basePlan.observations,
          operations: basePlan.operations,
          classifications,
        }
      : undefined,
    plan = classifiedPlan
      ? parseInstallPlanV1({
          ...classifiedPlan,
          confirmationDigest: installerDigest(classifiedPlan),
        })
      : basePlan;
  adapter.restore = async () => {
    throw new Error('process terminated before rollback');
  };
  await expect(service.apply(plan, plan.confirmationDigest)).rejects.toBeInstanceOf(AggregateError);
  return required(await store.readTransaction(), 'interrupted transaction');
}

it('restores fresh Pi installation settings through durable recovery after restart', async () => {
  const fixture = await piRestartRollbackFixture();
  try {
    const release = await fixture.release('release-a'),
      first = fixture.adapter(),
      operation = await fixture.operation(first, release),
      stateRoot = path.join(fixture.temporary, 'installer-state'),
      stored = await leaveInterruptedApply(
        first,
        new NodeTransactionStore(stateRoot),
        release,
        operation,
      ),
      persisted = await readFile(path.join(stateRoot, 'transaction.json'), 'utf8');
    expect(persisted).not.toContain(fixture.personalRoot);
    expect(persisted).not.toMatch(/credentials|token|theme/u);
    expect(
      Buffer.from(
        required(stored.snapshots[operation.id], 'Pi settings snapshot'),
        'base64',
      ).toString('utf8'),
    ).not.toMatch(/credentials|token|theme/u);
    await fixture.writeSettings({
      ...(await fixture.settings()),
      packages: ['foreign', release.packageRoot, 'concurrent'],
      concurrentField: true,
    });

    await new ImmutableInstallerService({
      adapters: [fixture.adapter()],
      store: new NodeTransactionStore(stateRoot),
    }).recover();
    expect(await fixture.settings()).toEqual({
      packages: ['foreign', 'concurrent'],
      credentials: { token: 'keep' },
      theme: 'keep',
      concurrentField: true,
    });
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

it('restores prior Pi package ownership through in-memory recovery after restart', async () => {
  const fixture = await piRestartRollbackFixture();
  try {
    const releaseA = await fixture.release('release-a'),
      first = fixture.adapter(),
      operationA = await fixture.operation(first, releaseA);
    await first.apply(operationA);
    const receiptA = await fixture.receipt(first, releaseA, operationA),
      store = new MemoryTransactionStore(),
      releaseB = await fixture.release('release-b'),
      operationB = await fixture.operation(first, releaseB, receiptA);
    await store.writeReceipt(receiptA);
    await leaveInterruptedApply(first, store, releaseB, operationB, receiptA);
    await fixture.writeSettings({
      ...(await fixture.settings()),
      packages: ['foreign', releaseB.packageRoot, 'concurrent'],
      concurrentField: true,
    });

    await new ImmutableInstallerService({ adapters: [fixture.adapter()], store }).recover();
    expect(await fixture.settings()).toEqual({
      packages: ['foreign', releaseA.packageRoot, 'concurrent'],
      credentials: { token: 'keep' },
      theme: 'keep',
      concurrentField: true,
    });
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

it('rolls back Pi uninstall through explicit transaction rollback after restart', async () => {
  const fixture = await piRestartRollbackFixture();
  try {
    const releaseA = await fixture.release('release-a'),
      first = fixture.adapter(),
      operationA = await fixture.operation(first, releaseA);
    await first.apply(operationA);
    const receiptA = await fixture.receipt(first, releaseA, operationA),
      releaseB = await fixture.release('release-b'),
      operationB = await fixture.operation(first, releaseB, receiptA);
    await first.apply(operationB);
    const receiptB = await fixture.receipt(first, releaseB, operationB),
      store = new MemoryTransactionStore();
    await store.writeReceipt(receiptB);
    const service = new ImmutableInstallerService({ adapters: [first], store }),
      uninstallPlan = await service.planUninstall(),
      apply = first.apply.bind(first);
    first.apply = async (operation) => {
      await apply(operation);
      throw new Error('simulated process termination');
    };
    first.restore = async () => {
      throw new Error('process terminated before rollback');
    };
    await expect(
      service.uninstall(uninstallPlan, uninstallPlan.confirmationDigest),
    ).rejects.toBeInstanceOf(AggregateError);
    await fixture.writeSettings({
      ...(await fixture.settings()),
      packages: ['foreign', releaseA.packageRoot, 'concurrent'],
      concurrentField: true,
    });

    await new ImmutableInstallerService({ adapters: [fixture.adapter()], store }).rollback();
    expect(await fixture.settings()).toEqual({
      packages: ['foreign', releaseB.packageRoot, 'concurrent'],
      credentials: { token: 'keep' },
      theme: 'keep',
      concurrentField: true,
    });
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

it('registers the native Pi package without exposing or overwriting private root state', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mpx-pi-settings-')),
    apps = path.join(temporary, 'apps'),
    personalRoot = path.join(temporary, 'private-pi-personal'),
    workRoot = path.join(temporary, 'private-pi-work');
  try {
    const bodies = {
        'build-metadata.json': 'm',
        'index.mjs': 'i',
        'package.json': 'p',
      },
      inventory = Object.entries(bodies).map(([file, body]) => ({
        path: file,
        sha256: createHash('sha256').update(body).digest('hex'),
        bytes: Buffer.byteLength(body),
      })),
      registration = parsePiNativePackageRegistration({
        name: '@mpx/pi-extensions',
        packageRoot: 'runtimes/pi/extensions/dist/package',
        artifactRootDigest: installerDigest(inventory),
        files: inventory,
      }),
      runtimeRegistrations = createRuntimeRegistrationMatrix([
        input('claude', 'personal', path.join(temporary, 'claude-personal')),
        input('claude', 'work', path.join(temporary, 'claude-work')),
        {
          ...(input('pi', 'personal', personalRoot) as Extract<
            RuntimeRegistrationInput,
            { runtime: 'pi' }
          >),
          nativePackage: registration,
        },
        {
          ...(input('pi', 'work', workRoot) as Extract<
            RuntimeRegistrationInput,
            { runtime: 'pi' }
          >),
          nativePackage: registration,
        },
      ]),
      packageEvidence = inventory.map((file) => ({
        ...file,
        path: `runtimes/pi/extensions/dist/package/${file.path}`,
      })),
      manifestFiles = [
        { path: 'bin/mpx.mjs', bytes: 3, sha256: sha('cli') },
        ...new Map(
          runtimeRegistrations.registrations
            .flatMap((item) => item.projection.files)
            .map((file) => [
              file.path,
              { path: file.path, bytes: file.bytes, sha256: file.sha256 },
            ]),
        ).values(),
        ...packageEvidence,
      ].sort((left, right) => left.path.localeCompare(right.path)),
      releaseKey = installerDigest(manifestFiles),
      releasePackage = path.join(
        apps,
        'mpx',
        'releases',
        releaseKey,
        'runtimes',
        'pi',
        'extensions',
        'dist',
        'package',
      );
    await mkdir(releasePackage, { recursive: true });
    await mkdir(personalRoot, { recursive: true });
    await mkdir(workRoot, { recursive: true });
    await Promise.all(
      Object.entries(bodies).map(([file, body]) =>
        writeFile(path.join(releasePackage, file), body),
      ),
    );
    await writeFile(
      path.join(personalRoot, 'settings.json'),
      JSON.stringify({ packages: ['foreign'], credentials: { token: 'keep' } }),
    );
    const configContent = piUserConfig(personalRoot, workRoot);
    const adapter = new ProductionInstallerOperationAdapter(
      {
        MPX_APPS: apps,
        APPDATA: path.join(temporary, 'roaming'),
        LOCALAPPDATA: path.join(temporary, 'local'),
        USERPROFILE: path.join(temporary, 'user'),
        MPX_NODE_EXECUTABLE: process.execPath,
      },
      'me',
      {
        files: new NodeBinaryFileSystem(),
        resources: new FakeJsonResourceStore(),
        runtimeRegistrations: {
          inspect: async () => ({
            observations: [],
            accountProbes: runtimeRegistrations.registrations.map((item) => ({
              identity: item.identity,
              runtime: item.runtime,
              domain: item.domain,
              nativeRootDigest: item.nativeRootDigest,
              status: 'unavailable' as const,
              accountLabel: `${item.domain}:account`,
            })),
            mcpSharing: Object.fromEntries(
              runtimeRegistrations.registrations.map((item) => [
                item.identity,
                item.routes.mcpSharing,
              ]),
            ) as never,
          }),
        },
      },
    );
    const intent = parseInstallIntentV1({
        schemaVersion: 1,
        kind: 'install-intent',
        releaseKey,
        convergenceHash: releaseKey,
        components: ['runtime-registration'],
        userConfigArtifact: {
          target: '%APPDATA%/mpx/config.json',
          content: configContent,
          sha256: createHash('sha256').update(configContent).digest('hex'),
        },
        runtimeRegistrations,
      }),
      manifest = {
        schemaVersion: 1,
        kind: 'release-manifest',
        releaseKey,
        convergenceHash: releaseKey,
        files: manifestFiles,
      } as ReleaseManifestV1,
      operations = await adapter.operations(intent, manifest),
      operation = operations.automatic.find((item) => item.id === '50-pi-settings-personal')!;
    expect(operation.target).toBe('pi:personal:settings-packages');
    expect(JSON.stringify(operations)).not.toContain(personalRoot);
    await adapter.capture(operation);
    await adapter.apply(operation);
    const settings = JSON.parse(await readFile(path.join(personalRoot, 'settings.json'), 'utf8'));
    expect(settings).toEqual({
      credentials: { token: 'keep' },
      packages: ['foreign', releasePackage],
    });
    const locator = (await adapter.receiptLocator(operation)) as Record<string, unknown>;
    expect(JSON.stringify(locator)).not.toContain(personalRoot);
    for (const malformed of [
      { ...locator, currentRelease: null },
      { ...locator, currentRelease: [] },
      { ...locator, priorRelease: {} },
      { ...locator, bindings: [null] },
    ]) {
      await expect(adapter.hydrateReceiptOperation(operation, malformed)).rejects.toMatchObject({
        code: 'INSTALL_RECEIPT_FORGED',
      });
    }
    const nativePort = new NodePiNativeSettingsPort();
    const withLock = (lock: PiNativeSettingsPort['lock']): PiNativeSettingsPort => ({
      lstat: nativePort.lstat.bind(nativePort),
      realpath: nativePort.realpath.bind(nativePort),
      read: nativePort.read.bind(nativePort),
      atomicWrite: nativePort.atomicWrite.bind(nativePort),
      remove: nativePort.remove.bind(nativePort),
      lock,
    });
    const mutableAdapter = adapter as unknown as { piNativeSettings: PiNativeSettingsPort };
    mutableAdapter.piNativeSettings = withLock(async () => {
      throw Object.assign(new Error('held'), { code: 'ELOCKED' });
    });
    await expect(adapter.observe(operation)).rejects.toMatchObject({
      code: 'INSTALL_PI_SETTINGS_LOCKED',
      cause: expect.objectContaining({ code: 'ELOCKED' }),
    });
    let checks = 0;
    const compromised = Object.assign(new Error('compromised'), {
      code: 'INSTALL_PI_SETTINGS_LOCK_COMPROMISED',
    });
    mutableAdapter.piNativeSettings = withLock(async () => ({
      compromisedFailure: () => (++checks > 1 ? compromised : undefined),
      release: async () => undefined,
    }));
    await expect(adapter.observe(operation)).rejects.toBe(compromised);
    const unsafeWrite = async () => {
      throw new Error('unsafe settings must not be written');
    };
    mutableAdapter.piNativeSettings = {
      lstat: async (target) =>
        target === path.join(personalRoot, 'settings.json')
          ? ({
              isDirectory: () => false,
              isFile: () => false,
              isSymbolicLink: () => true,
              size: 0,
            } as Stats)
          : nativePort.lstat(target),
      realpath: nativePort.realpath.bind(nativePort),
      read: nativePort.read.bind(nativePort),
      atomicWrite: unsafeWrite,
      remove: nativePort.remove.bind(nativePort),
      lock: nativePort.lock.bind(nativePort),
    };
    const settingsBeforeUnsafeInspection = await readFile(path.join(personalRoot, 'settings.json'));
    await expect(adapter.operations(intent, manifest)).rejects.toMatchObject({
      code: 'INSTALL_PI_SETTINGS_UNHEALTHY',
    });
    expect(await readFile(path.join(personalRoot, 'settings.json'))).toEqual(
      settingsBeforeUnsafeInspection,
    );
    mutableAdapter.piNativeSettings = nativePort;
    const beforeMissingRootCheck = await readFile(path.join(personalRoot, 'settings.json'));
    const missingRootAdapter = new ProductionInstallerOperationAdapter(
      {
        MPX_APPS: apps,
        APPDATA: path.join(temporary, 'roaming'),
        LOCALAPPDATA: path.join(temporary, 'local'),
        USERPROFILE: path.join(temporary, 'user'),
        MPX_NODE_EXECUTABLE: process.execPath,
      },
      'me',
      {
        files: new NodeBinaryFileSystem(),
        resources: new FakeJsonResourceStore(),
        piPrivateRoots: {
          resolvePiNativeRoot: async () => {
            throw new Error('unavailable');
          },
        },
        runtimeRegistrations: {
          inspect: async () => ({
            observations: [],
            accountProbes: runtimeRegistrations.registrations.map((item) => ({
              identity: item.identity,
              runtime: item.runtime,
              domain: item.domain,
              nativeRootDigest: item.nativeRootDigest,
              status: 'unavailable' as const,
              accountLabel: `${item.domain}:account`,
            })),
            mcpSharing: Object.fromEntries(
              runtimeRegistrations.registrations.map((item) => [
                item.identity,
                item.routes.mcpSharing,
              ]),
            ) as never,
          }),
        },
      },
    );
    await expect(missingRootAdapter.operations(intent, manifest)).rejects.toMatchObject({
      code: 'INSTALL_PI_ROOT_UNAVAILABLE',
    });
    expect(await readFile(path.join(personalRoot, 'settings.json'))).toEqual(
      beforeMissingRootCheck,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it('composes four runtime registrations and external references into automatic, confirmed, and manual installer state', async () => {
  const runtimeRegistrations = createRuntimeRegistrationMatrix([
    input('claude', 'personal', 'C:\\native\\claude-personal'),
    input('claude', 'work', 'C:\\native\\claude-work'),
    input('pi', 'personal', 'C:\\native\\pi-personal'),
    input('pi', 'work', 'C:\\native\\pi-work'),
  ]);
  const staticMcpRegistrations = [
    registerStaticMcp({
      label: 'personal:github',
      executable: { path: 'C:\\tools\\mcp.exe', sha256: sha('mcp'), version: '1' },
      argv: ['--stdio'],
    }),
  ];
  const files = new FakeBinaryFileSystem();
  const resources = new FakeJsonResourceStore();
  const piRoots = {
    'pi-personal': 'C:\\native\\pi-personal',
    'pi-work': 'C:\\native\\pi-work',
  } as const;
  const absent = Object.assign(new Error('absent'), { code: 'ENOENT' });
  const piNativeSettings: PiNativeSettingsPort = {
    lstat: async (target) => {
      if (Object.values(piRoots).includes(target as (typeof piRoots)[keyof typeof piRoots])) {
        return {
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
          size: 0,
        } as Stats;
      }
      const artifact = nativeInventory.find((item) => target.endsWith(item.path));
      if (artifact) {
        return {
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
          size: artifact.bytes,
        } as Stats;
      }
      throw absent;
    },
    realpath: async (target) => target,
    read: async (target) =>
      Buffer.from(
        target.endsWith('build-metadata.json') ? 'm' : target.endsWith('index.mjs') ? 'i' : 'p',
      ),
    atomicWrite: async () => undefined,
    remove: async () => undefined,
    lock: async () => ({ compromisedFailure: () => undefined, release: async () => undefined }),
  };
  const adapter = new ProductionInstallerOperationAdapter(
    {
      MPX_APPS: 'C:\\Apps',
      APPDATA: 'C:\\Roaming',
      LOCALAPPDATA: 'C:\\Local',
      USERPROFILE: 'C:\\Users\\me',
      MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
    },
    'me',
    {
      files,
      resources,
      piNativeSettings,
      piPrivateRoots: {
        resolvePiNativeRoot: async ({ identity }) => piRoots[identity as keyof typeof piRoots],
      },
      runtimeRegistrations: {
        inspect: async () => ({
          observations: [],
          accountProbes: runtimeRegistrations.registrations.map((registration) => ({
            identity: registration.identity,
            runtime: registration.runtime,
            domain: registration.domain,
            nativeRootDigest: registration.nativeRootDigest,
            status: 'unavailable' as const,
            accountLabel: `${registration.domain}:account`,
          })),
          mcpSharing: Object.fromEntries(
            runtimeRegistrations.registrations.map((registration) => [
              registration.identity,
              registration.routes.mcpSharing,
            ]),
          ) as never,
        }),
      },
    },
  );
  const node = await lstat(process.execPath);
  expect(node.isFile()).toBe(true);
  // Production planning uses the configured immutable Node boundary, never a shell.
  (adapter as unknown as { environment: NodeJS.ProcessEnv }).environment.MPX_NODE_EXECUTABLE =
    process.execPath;
  const projectionEvidence = [
    ...new Map(
      runtimeRegistrations.registrations
        .flatMap((registration) => registration.projection.files)
        .map((file) => [file.path, { path: file.path, bytes: file.bytes, sha256: file.sha256 }]),
    ).values(),
  ];
  const nativeEvidence = nativePackage.files.map((file) => ({
    ...file,
    path: `${nativePackage.packageRoot}/${file.path}`,
  }));
  const manifestFiles = [
    { path: 'bin/mpx.mjs', bytes: 3, sha256: sha('cli') },
    ...projectionEvidence,
    ...nativeEvidence,
  ].sort((a, b) => a.path.localeCompare(b.path));
  const releaseKey = installerDigest(manifestFiles);
  const manifest = {
    schemaVersion: 1,
    kind: 'release-manifest',
    releaseKey,
    convergenceHash: releaseKey,
    files: manifestFiles,
  } as ReleaseManifestV1;
  const intent = parseInstallIntentV1({
    schemaVersion: 1,
    kind: 'install-intent',
    releaseKey,
    convergenceHash: releaseKey,
    components: ['cli', 'runtime-registration'],
    runtimeRegistrations,
    staticMcpRegistrations,
    externalIntegrations: [
      {
        id: 'git',
        adapter: 'git-remotes',
        classification: 'confirmation-required',
        planDigest: sha('git-plan'),
        verifierRef: 'git:repo',
      },
    ],
  });
  const changedManifest = (files: ReleaseManifestV1['files']): ReleaseManifestV1 => {
    const convergenceHash = installerDigest(files);
    return { ...manifest, releaseKey: convergenceHash, convergenceHash, files };
  };
  await expect(
    adapter.operations(
      intent,
      changedManifest(
        manifest.files.map((file) =>
          file.path.startsWith('claude/') || file.path.startsWith('pi/')
            ? { ...file, sha256: sha('mismatch') }
            : file,
        ),
      ),
    ),
  ).rejects.toMatchObject({ code: 'INSTALL_PROJECTION_MISMATCH' });
  await expect(
    adapter.operations(
      intent,
      changedManifest(
        manifest.files.map((file) =>
          file.path.endsWith('/index.mjs') ? { ...file, sha256: sha('alternate-native') } : file,
        ),
      ),
    ),
  ).rejects.toMatchObject({ code: 'REGISTRATION_NATIVE_PACKAGE_RELEASE_MISMATCH' });
  const operations = await adapter.operations(intent, manifest);
  const environmentOperation = operations.automatic.find(
    (operation) => operation.id === '20-user-environment',
  );
  if (!environmentOperation) {
    throw new Error('Expected user environment operation');
  }
  await adapter.apply(environmentOperation);
  await expect(resources.read('HKCU\\Environment')).resolves.toMatchObject({
    MPX_CLAUDE_EXECUTABLE: 'C:\\tools\\claude.exe',
    MPX_PI_EXECUTABLE: 'C:\\tools\\pi.exe',
  });
  expect(
    operations.automatic
      .map((operation) => operation.id)
      .filter((id) => id.includes('registration')),
  ).toEqual([
    '70-registration-claude-personal',
    '71-registration-claude-work',
    '72-registration-pi-personal',
    '73-registration-pi-work',
    '74-registration-mcp-personal-github',
  ]);
  expect(operations.classifications).toEqual({
    automatic: operations.automatic.map((operation) => operation.id),
    confirmationRequired: [{ id: 'git', planDigest: sha('git-plan'), verifierRef: 'git:repo' }],
    manualOnly: [],
  });
  expect(operations.automatic.some((operation) => ['git'].includes(operation.id))).toBe(false);
});
