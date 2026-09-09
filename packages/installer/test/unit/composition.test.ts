import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FakeJsonResourceStore } from '@mpx/windows';
import {
  parseInstallIntent,
  parseInstallPlan,
  installerDigest,
  type InstallIntent,
  type InstallOperation,
  type OwnershipReceipt,
  type ReleaseManifest,
} from '../../src/immutable-core.js';
import {
  createRuntimeRegistrationMatrix,
  type ProjectionFile,
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
function files(runtime: 'claude' | 'pi'): ProjectionFile[] {
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
      : (['profile', 'canonical-content', 'agents', 'licenses'] as const);
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
  { path: 'mpx-extension.mjs', sha256: sha('i'), bytes: 1 },
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
    schemaVersion: 2,
    identities: {
      personal: {
        domain: 'personal',
        runtimeRoots: { claude: 'C:\\claude-personal', pi: personalRoot },
        gitAuthorRoute: 'personal-git',
        allowedSkillPacks: ['development', 'personal'],
      },
      work: {
        domain: 'work',
        runtimeRoots: { claude: 'C:\\claude-work', pi: workRoot },
        gitAuthorRoute: 'work-git',
        allowedSkillPacks: ['development'],
      },
    },
    domains: { personal: ['C:\\personal'], work: ['C:\\work'] },
    locations: {},
    modes: {},
    presets: {},
    launchDefaults: { locations: {}, projects: {} },
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
      'mpx-extension.mjs': 'i',
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
            nativeRootProbes: runtimeRegistrations.registrations.map((item) => ({
              identity: item.identity,
              runtime: item.runtime,
              domain: item.domain,
              nativeRootDigest: item.nativeRootDigest,
              status: 'unavailable' as const,
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
      const intent = parseInstallIntent({
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
        } as ReleaseManifest;
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
      value: { intent: InstallIntent; manifest: ReleaseManifest },
      priorReceipt?: OwnershipReceipt,
    ) =>
      required(
        (await owner.operations(value.intent, value.manifest, false, priorReceipt)).automatic.find(
          (candidate) => candidate.id === '50-pi-settings-personal',
        ),
        'personal Pi settings operation',
      ),
    receipt = async (
      owner: ProductionInstallerOperationAdapter,
      value: { intent: InstallIntent; manifest: ReleaseManifest },
      ownedOperation: InstallOperation,
    ): Promise<OwnershipReceipt> => {
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
  release: { intent: InstallIntent; manifest: ReleaseManifest },
  operation: InstallOperation,
  priorReceipt?: OwnershipReceipt,
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
      ? parseInstallPlan({
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

it('registers the native Pi package without exposing or overwriting private root state', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mpx-pi-settings-')),
    apps = path.join(temporary, 'apps'),
    personalRoot = path.join(temporary, 'private-pi-personal'),
    workRoot = path.join(temporary, 'private-pi-work');
  try {
    const bodies = {
        'build-metadata.json': 'm',
        'mpx-extension.mjs': 'i',
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
            nativeRootProbes: runtimeRegistrations.registrations.map((item) => ({
              identity: item.identity,
              runtime: item.runtime,
              domain: item.domain,
              nativeRootDigest: item.nativeRootDigest,
              status: 'unavailable' as const,
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
    const intent = parseInstallIntent({
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
      } as ReleaseManifest,
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
            nativeRootProbes: runtimeRegistrations.registrations.map((item) => ({
              identity: item.identity,
              runtime: item.runtime,
              domain: item.domain,
              nativeRootDigest: item.nativeRootDigest,
              status: 'unavailable' as const,
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
