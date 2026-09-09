import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  lstat,
  utimes,
  writeFile,
  rename,
  link,
} from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FakeJsonResourceStore } from '@mpx/windows';
import {
  activateRelease,
  installerDigest,
  type InstallIntent,
  type OwnershipReceipt,
  type ReleaseManifest,
} from '../../src/immutable-core.js';
import { InstallOrchestrator, NodeCurrentReleaseBuilder } from '../../src/orchestration.js';
import {
  NodeBinaryFileSystem,
  ProductionInstallerOperationAdapter,
} from '../../src/production-operation.js';
import { NodePiNativeSettingsPort } from '../../src/pi-native-settings.js';
import {
  createRuntimeRegistrationMatrix,
  type ProjectionFile,
} from '../../src/runtime-registration.js';
import { ImmutableInstallerService, NodeTransactionStore } from '../../src/transaction.js';
import {
  createPiNativePackageRegistration,
  type PiNativePackageRegistration,
} from '../../src/pi-native-package.js';
import { preparePiExtensionBuildFixture } from '../fixtures/pi-extension-build.js';

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

const sha = (value: string) => installerDigest(value);
const roles = (runtime: 'claude' | 'pi') =>
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
function registration(
  runtime: 'claude' | 'pi',
  domain: 'personal' | 'work',
  nativeRoot: string,
  nativePackage: PiNativePackageRegistration,
) {
  const files: ProjectionFile[] = roles(runtime).map((role) => {
    const body = Buffer.from(`${runtime}:${role}`);
    return {
      path: `${runtime}/${role}.json`,
      sha256: createHash('sha256').update(body).digest('hex'),
      bytes: body.length,
      role,
      owner: 'convergence',
    };
  });
  const common = {
    domain,
    nativeRoot,
    executable: {
      path: process.execPath,
      sha256: sha(`${runtime}:executable`),
      version: process.version,
    },
    projection: {
      rootDigest: installerDigest(files),
      files,
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
const temporaryRoots = new Set<string>();

afterEach(async () => {
  const roots = [...temporaryRoots];
  temporaryRoots.clear();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })));
});

async function simulation(
  existing: boolean,
  prepareExtension: typeof preparePiExtensionBuildFixture = preparePiExtensionBuildFixture,
) {
  const checkoutRoot = path.resolve(import.meta.dirname, '../../../..');
  const root = await mkdtemp(
    path.join(checkoutRoot, 'node_modules', `mpx-production-${existing ? 'existing' : 'clean'}-`),
  );
  temporaryRoots.add(root);
  try {
    return await prepareSimulation(existing, checkoutRoot, root, prepareExtension);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function prepareSimulation(
  existing: boolean,
  checkoutRoot: string,
  root: string,
  prepareExtension: typeof preparePiExtensionBuildFixture,
) {
  const repositoryRoot = path.join(root, 'source'),
    appsRoot = path.join(root, 'apps'),
    appData = path.join(root, 'roaming'),
    localAppData = path.join(root, 'local'),
    userProfile = path.join(root, 'user');
  await mkdir(path.join(repositoryRoot, 'bin'), { recursive: true });
  await writeFile(path.join(repositoryRoot, 'bin', 'mpx.mjs'), 'export {};\n');
  await prepareExtension(checkoutRoot, repositoryRoot, `simulation-${Date.now()}`);
  for (const runtime of ['claude', 'pi'] as const) {
    for (const role of roles(runtime)) {
      const file = path.join(repositoryRoot, runtime, `${role}.json`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${runtime}:${role}`);
    }
  }
  const fixtureRoots = ['claude-personal', 'claude-work', 'pi-personal', 'pi-work'].map((name) =>
    path.join(userProfile, 'native', name),
  );
  const fixtureFiles: string[] = [];
  for (const nativeRoot of fixtureRoots) {
    for (const name of ['auth.json', 'session.json', 'cache.bin']) {
      const file = path.join(nativeRoot, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, Buffer.from([0, 1, 2, 255, ...Buffer.from(name)]));
      fixtureFiles.push(file);
    }
  }
  const before = await Promise.all(fixtureFiles.map((file) => readFile(file)));
  const piSettingsBefore = { packages: ['foreign'], theme: 'keep' };
  await Promise.all(
    fixtureRoots
      .slice(2)
      .map((nativeRoot) =>
        writeFile(path.join(nativeRoot, 'settings.json'), JSON.stringify(piSettingsBefore)),
      ),
  );
  if (existing) {
    await mkdir(userProfile, { recursive: true });
    await writeFile(path.join(userProfile, '.bashrc'), 'native-profile\r\n');
  }
  const userConfig = {
    schemaVersion: 2,
    identities: {
      personal: {
        domain: 'personal',
        runtimeRoots: {
          claude: required(fixtureRoots[0], 'Claude personal fixture root'),
          pi: required(fixtureRoots[2], 'Pi personal fixture root'),
        },
        gitAuthorRoute: 'personal-git',
        allowedSkillPacks: ['development', 'personal'],
      },
      work: {
        domain: 'work',
        runtimeRoots: {
          claude: required(fixtureRoots[1], 'Claude work fixture root'),
          pi: required(fixtureRoots[3], 'Pi work fixture root'),
        },
        gitAuthorRoute: 'work-git',
        allowedSkillPacks: ['development'],
      },
    },
    domains: {
      personal: [required(fixtureRoots[0], 'Claude personal fixture root')],
      work: [required(fixtureRoots[1], 'Claude work fixture root')],
    },
    locations: {},
    modes: {},
    presets: {},
    launchDefaults: { locations: {}, projects: {} },
    networkPolicies: {},
    executors: { host: {} },
  };
  const userConfigContent = `${JSON.stringify(userConfig, null, 2)}\n`,
    userConfigTarget = path.join(appData, 'mpx', 'config.json');
  if (existing) {
    await mkdir(path.dirname(userConfigTarget), { recursive: true });
    await writeFile(userConfigTarget, userConfigContent);
    await utimes(
      userConfigTarget,
      new Date('2020-01-01T00:00:00.000Z'),
      new Date('2020-01-01T00:00:00.000Z'),
    );
  }
  const environment = {
    MPX_APPS: appsRoot,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    USERPROFILE: userProfile,
    MPX_NODE_EXECUTABLE: process.execPath,
  };
  const terminalTarget = path.win32.join(
    localAppData,
    'Packages',
    'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
    'LocalState',
    'settings.json',
  );
  const terminalSettings = {
    profiles: [
      { guid: 'foreign', name: 'Keep' },
      { guid: 'prior-mpx', name: 'MPX' },
    ],
    theme: 'native',
  };
  const native = new FakeJsonResourceStore(existing ? { [terminalTarget]: terminalSettings } : {});
  const piNativeSettings = new NodePiNativeSettingsPort();
  let runtimeRegistrations!: ReturnType<typeof createRuntimeRegistrationMatrix>;
  const createAdapter = () =>
    new ProductionInstallerOperationAdapter(environment, 'DOMAIN\\me', {
      files: new NodeBinaryFileSystem(),
      resources: native,
      piNativeSettings,
      runtimeRegistrations: {
        inspect: async (requested) => ({
          observations: requested.runtimeRegistrations!.registrations.map(
            ({ identity, executable, projection }) => ({ identity, executable, projection }),
          ),
          nativeRootProbes: runtimeRegistrations.registrations.map((item) => ({
            identity: item.identity,
            runtime: item.runtime,
            domain: item.domain,
            nativeRootDigest: item.nativeRootDigest,
            status: 'available' as const,
          })),
          mcpSharing: Object.fromEntries(
            runtimeRegistrations.registrations.map((item) => [
              item.identity,
              item.routes.mcpSharing,
            ]),
          ) as never,
        }),
      },
    });
  const adapter = createAdapter();
  const store = new NodeTransactionStore(path.join(localAppData, 'mpx', 'installer')),
    releases = new NodeCurrentReleaseBuilder({
      repositoryRoot,
      appsRoot,
      assetPaths: ['bin', 'claude', 'pi', 'runtimes'],
    });
  const manifest = await releases.build(),
    nativePackage = createPiNativePackageRegistration(manifest);
  runtimeRegistrations = createRuntimeRegistrationMatrix([
    registration(
      'claude',
      'personal',
      required(fixtureRoots[0], 'Claude personal fixture root'),
      nativePackage,
    ),
    registration(
      'claude',
      'work',
      required(fixtureRoots[1], 'Claude work fixture root'),
      nativePackage,
    ),
    registration(
      'pi',
      'personal',
      required(fixtureRoots[2], 'Pi personal fixture root'),
      nativePackage,
    ),
    registration('pi', 'work', required(fixtureRoots[3], 'Pi work fixture root'), nativePackage),
  ]);
  const intent: InstallIntent = {
    schemaVersion: 1,
    kind: 'install-intent',
    releaseKey: manifest.releaseKey,
    convergenceHash: manifest.convergenceHash,
    components: ['cli', 'runtime-registration'],
    userConfigArtifact: {
      target: '%APPDATA%/mpx/config.json',
      content: userConfigContent,
      sha256: createHash('sha256').update(userConfigContent, 'utf8').digest('hex'),
    },
    runtimeRegistrations,
  };
  return {
    root,
    environment,
    createAdapter,
    repositoryRoot,
    appsRoot,
    appData,
    localAppData,
    userProfile,
    fixtureFiles,
    before,
    piSettingsBefore,
    fixtureRoots,
    adapter,
    piNativeSettings,
    store,
    releases,
    intent,
    native,
    userConfigContent,
    userConfigTarget,
  };
}

it('removes only its allocated simulation root when setup fails', async () => {
  const checkoutRoot = path.resolve(import.meta.dirname, '../../../..');
  const sibling = await mkdtemp(path.join(checkoutRoot, 'node_modules', 'mpx-production-sibling-'));
  const siblingSentinel = Buffer.from([0x00, 0x7f, 0x80, 0xff]);
  const siblingSentinelPath = path.join(sibling, 'sentinel.bin');
  await writeFile(siblingSentinelPath, siblingSentinel);
  let allocatedRoot: string | undefined;
  try {
    await expect(
      simulation(false, async (_checkoutRoot, repositoryRoot) => {
        allocatedRoot = path.dirname(repositoryRoot);
        throw new Error('injected simulation setup failure');
      }),
    ).rejects.toThrow('injected simulation setup failure');
    if (allocatedRoot === undefined) {
      throw new Error('Simulation setup did not expose its allocated root.');
    }
    await expect(stat(allocatedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(sibling)).isDirectory()).toBe(true);
    expect(await readFile(siblingSentinelPath)).toEqual(siblingSentinel);
  } finally {
    await rm(sibling, { recursive: true, force: true });
  }
});

it('plans, applies, and verifies a fresh base install without scheduled capture', async () => {
  const f = await simulation(false),
    writePiSettings = vi.spyOn(f.piNativeSettings, 'atomicWrite'),
    readNative = vi.spyOn(f.native, 'read'),
    writeNative = vi.spyOn(f.native, 'write'),
    removeNative = vi.spyOn(f.native, 'remove'),
    scheduledTarget = '\\MPX\\Session Capture';
  const orchestrator = new InstallOrchestrator({
    adapter: f.adapter,
    store: f.store,
    releases: f.releases,
    now: () => new Date('2024-12-31T23:59:59.000Z'),
    activate: (releaseKey, prior) => activateRelease(f.localAppData, prior, releaseKey),
  });
  const plan = await orchestrator.plan(f.intent);
  const operationIds = plan.operations.map((operation) => operation.id);
  await expect(
    readFile(path.join(f.appsRoot, 'mpx', 'releases', f.intent.releaseKey, 'bin', 'mpx-node.mjs')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(operationIds).not.toContain('90-scheduled-capture');
  expect(operationIds).toEqual(
    expect.arrayContaining([
      '05-cli-selector',
      '06-node-entry',
      '10-profile-0',
      '10-profile-1',
      '20-user-environment',
      '30-shortcut',
      '40-shortcut',
      '60-projection-claude-personal-descriptor',
      '70-registration-claude-personal',
    ]),
  );
  const receipt = await orchestrator.apply(plan, plan.confirmationDigest);
  expect(receipt.operations.map((operation) => operation.id)).not.toContain('90-scheduled-capture');
  const packageSource = path.join(
    f.appsRoot,
    'mpx',
    'releases',
    receipt.releaseKey,
    'runtimes',
    'pi',
    'extensions',
    'dist',
    'package',
  );
  for (const nativeRoot of f.fixtureRoots.slice(2)) {
    expect(JSON.parse(await readFile(path.join(nativeRoot, 'settings.json'), 'utf8'))).toEqual({
      packages: ['foreign', packageSource],
      theme: 'keep',
    });
  }
  expect(writePiSettings).toHaveBeenCalledTimes(2);
  await expect(orchestrator.verify(false)).resolves.toMatchObject({
    healthy: true,
    releaseKey: receipt.releaseKey,
  });
  expect(readNative).not.toHaveBeenCalledWith(scheduledTarget);
  expect(writeNative).not.toHaveBeenCalledWith(scheduledTarget, expect.anything());
  expect(removeNative).not.toHaveBeenCalledWith(scheduledTarget);
  for (const file of ['build-metadata.json', 'mpx-extension.mjs', 'package.json']) {
    expect(await readFile(path.join(packageSource, file))).toEqual(
      await readFile(
        path.join(f.repositoryRoot, 'runtimes', 'pi', 'extensions', 'dist', 'package', file),
      ),
    );
  }
}, 30_000);

it('upgrades an exact pre-node-entry v2 receipt and owned environment state', async () => {
  const f = await simulation(false),
    orchestrator = new InstallOrchestrator({
      adapter: f.adapter,
      store: f.store,
      releases: f.releases,
    });
  const planA = await orchestrator.plan(f.intent),
    receiptA = await orchestrator.apply(planA, planA.confirmationDigest),
    environmentOperation = required(
      receiptA.operations.find((operation) => operation.id === '20-user-environment'),
      'environment operation',
    ),
    environmentLocator = required(
      receiptA.operationLocators.find((locator) => locator.operationId === environmentOperation.id),
      'environment locator',
    ),
    locatorSpec = environmentLocator.spec as {
      kind: 'resource';
      spec: { desired: Record<string, unknown> };
    },
    priorDesired = { ...locatorSpec.spec.desired };
  delete priorDesired.MPX_NODE_ENTRY;
  const priorOperation = {
      ...environmentOperation,
      desiredDigest: installerDigest(priorDesired),
    },
    priorLocatorSpec = {
      kind: 'resource' as const,
      spec: { ...locatorSpec.spec, desired: priorDesired },
    },
    priorReceipt = {
      ...receiptA,
      operations: receiptA.operations.map((operation) =>
        operation.id === priorOperation.id ? priorOperation : operation,
      ),
      operationLocators: receiptA.operationLocators.map((locator) =>
        locator.operationId === priorOperation.id
          ? {
              ...locator,
              spec: priorLocatorSpec,
              bindingDigest: installerDigest({ operation: priorOperation, spec: priorLocatorSpec }),
            }
          : locator,
      ),
    };
  const environment = (await f.native.read(environmentOperation.target)) as Record<string, unknown>;
  delete environment.MPX_NODE_ENTRY;
  await f.native.write(environmentOperation.target, environment);
  await f.store.writeReceipt(priorReceipt);

  await writeFile(path.join(f.repositoryRoot, 'bin', 'mpx.mjs'), 'export const next = true;\n');
  const manifestB = await f.releases.build(),
    intentB = {
      ...f.intent,
      releaseKey: manifestB.releaseKey,
      convergenceHash: manifestB.convergenceHash,
    },
    planB = await orchestrator.plan(intentB);
  await expect(orchestrator.apply(planB, planB.confirmationDigest)).resolves.toMatchObject({
    releaseKey: manifestB.releaseKey,
  });
  await expect(f.native.read(environmentOperation.target)).resolves.toMatchObject({
    owner: 'mpx',
    MPX_NODE_ENTRY: path.win32.join(f.appsRoot, 'mpx', 'bin', 'mpx-node.mjs'),
  });
  const packageB = path.join(
    f.appsRoot,
    'mpx',
    'releases',
    manifestB.releaseKey,
    'runtimes',
    'pi',
    'extensions',
    'dist',
    'package',
  );
  for (const nativeRoot of f.fixtureRoots.slice(2)) {
    expect(
      JSON.parse(await readFile(path.join(nativeRoot, 'settings.json'), 'utf8')).packages,
    ).toEqual(['foreign', packageB]);
  }
}, 30_000);

it('restores the prior Pi package when upgrade selector activation fails', async () => {
  const f = await simulation(false);
  let failActivation = false;
  const orchestrator = new InstallOrchestrator({
    adapter: f.adapter,
    store: f.store,
    releases: f.releases,
    activate: async () => {
      if (failActivation) {
        throw new Error('injected selector activation failure');
      }
      return async () => undefined;
    },
  });
  const planA = await orchestrator.plan(f.intent),
    receiptA = await orchestrator.apply(planA, planA.confirmationDigest),
    packageA = path.join(
      f.appsRoot,
      'mpx',
      'releases',
      receiptA.releaseKey,
      'runtimes',
      'pi',
      'extensions',
      'dist',
      'package',
    );

  await writeFile(path.join(f.repositoryRoot, 'bin', 'mpx.mjs'), 'export const next = true;\n');
  const manifestB = await f.releases.build(),
    intentB = {
      ...f.intent,
      releaseKey: manifestB.releaseKey,
      convergenceHash: manifestB.convergenceHash,
    },
    planB = await orchestrator.plan(intentB);
  failActivation = true;

  const failure = await orchestrator
    .apply(planB, planB.confirmationDigest)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({ message: 'injected selector activation failure' });
  expect((await f.store.readTransaction())?.journal.phase).toBe('rolled-back');
  expect(await f.store.readReceipt()).toEqual(receiptA);
  for (const nativeRoot of f.fixtureRoots.slice(2)) {
    expect(JSON.parse(await readFile(path.join(nativeRoot, 'settings.json'), 'utf8'))).toEqual({
      packages: ['foreign', packageA],
      theme: 'keep',
    });
  }
}, 30_000);

it('rolls back an apply transaction when Pi settings fail before the temporary write', async () => {
  const f = await simulation(true);
  const orchestrator = new InstallOrchestrator({
    adapter: f.adapter,
    store: f.store,
    releases: f.releases,
  });
  const plan = await orchestrator.plan(f.intent);
  (f.adapter as unknown as { piNativeSettings: NodePiNativeSettingsPort }).piNativeSettings =
    new NodePiNativeSettingsPort({
      writeFile: async () => {
        throw new Error('injected pre-write failure');
      },
    });

  await expect(orchestrator.apply(plan, plan.confirmationDigest)).rejects.toMatchObject({
    code: 'INSTALL_PI_SETTINGS_UNAVAILABLE',
    cause: expect.objectContaining({ message: 'injected pre-write failure' }),
  });
  expect((await f.store.readTransaction())?.journal.phase).toBe('rolled-back');
  expect(await f.store.readReceipt()).toBeUndefined();
  for (const nativeRoot of f.fixtureRoots.slice(2)) {
    expect(JSON.parse(await readFile(path.join(nativeRoot, 'settings.json'), 'utf8'))).toEqual(
      f.piSettingsBefore,
    );
  }
}, 30_000);

it('runs clean and existing-machine production-backed simulations without live writes', async () => {
  let successfulSimulations = 0,
    rollbackSimulations = 0;
  for (const existing of [false, true]) {
    const f = await simulation(existing),
      originalConfigMtime = existing ? (await stat(f.userConfigTarget)).mtimeMs : undefined;
    const orchestrator = new InstallOrchestrator({
      adapter: f.adapter,
      store: f.store,
      releases: f.releases,
      now: () => new Date('2024-12-31T23:59:59.000Z'),
    });
    const plan = await orchestrator.plan(f.intent);
    expect(plan.classifications?.confirmationRequired).toEqual([]);
    await orchestrator.apply(plan, plan.confirmationDigest);
    const repeatWrites = vi.spyOn(f.piNativeSettings, 'atomicWrite');
    const second = await orchestrator.plan(f.intent);
    await orchestrator.apply(second, second.confirmationDigest);
    expect(repeatWrites).not.toHaveBeenCalled();
    expect(await readFile(f.userConfigTarget, 'utf8')).toBe(f.userConfigContent);
    if (existing) {
      expect((await stat(f.userConfigTarget)).mtimeMs).toBe(originalConfigMtime);
    }
    await rm(f.repositoryRoot, { recursive: true });
    expect(await orchestrator.verify(false)).toMatchObject({
      healthy: true,
      components: [
        { id: 'system', status: 'actual-state-verified' },
        { id: 'claude-personal', status: 'actual-state-verified' },
        { id: 'claude-work', status: 'actual-state-verified' },
        { id: 'pi-personal', status: 'actual-state-verified' },
        { id: 'pi-work', status: 'actual-state-verified' },
      ],
    });
    for (let index = 0; index < f.fixtureFiles.length; index++) {
      expect(await readFile(required(f.fixtureFiles[index], `fixture file ${index}`))).toEqual(
        required(f.before[index], `fixture snapshot ${index}`),
      );
    }
    expect(
      (await readFile(path.join(f.userProfile, '.bashrc'), 'utf8')).includes(
        existing ? 'native-profile\r\n' : '# >>> MPX',
      ),
    ).toBe(true);
    const restartedAdapter = new ProductionInstallerOperationAdapter(
      {
        MPX_APPS: f.appsRoot,
        APPDATA: path.join(f.root, 'roaming'),
        LOCALAPPDATA: f.localAppData,
        USERPROFILE: f.userProfile,
        MPX_NODE_EXECUTABLE: process.execPath,
      },
      'DOMAIN\\me',
      { files: new NodeBinaryFileSystem(), resources: f.native },
    );
    const restartedStore = new NodeTransactionStore(path.join(f.localAppData, 'mpx', 'installer'));
    await expect(
      new ImmutableInstallerService({
        adapters: [restartedAdapter],
        store: restartedStore,
      }).verify(),
    ).resolves.toMatchObject({ healthy: true, issues: [] });
    successfulSimulations += 1;
  }
  const baseline = await simulation(true);
  const baselinePlan = await new InstallOrchestrator({
    adapter: baseline.adapter,
    store: baseline.store,
    releases: baseline.releases,
  }).plan(baseline.intent);
  const mutatingOperations = baselinePlan.operations.filter(
    (operation, index) =>
      required(baselinePlan.observations[index], `operation observation ${index}`).digest !==
      operation.desiredDigest,
  );
  const originalApply = baseline.adapter.apply.bind(baseline.adapter),
    targetSnapshots = await Promise.all(
      baselinePlan.operations.map((operation) => baseline.adapter.capture(operation)),
    );
  let injectedIndex = 0,
    calls = 0;
  baseline.adapter.apply = async (operation) => {
    await originalApply(operation);
    if (calls++ === injectedIndex) {
      throw new Error(`injected:${operation.id}`);
    }
  };
  const rollbackOrchestrator = new InstallOrchestrator({
    adapter: baseline.adapter,
    store: baseline.store,
    releases: baseline.releases,
  });
  for (injectedIndex = 0; injectedIndex < mutatingOperations.length; injectedIndex++) {
    calls = 0;
    await expect(
      rollbackOrchestrator.apply(baselinePlan, baselinePlan.confirmationDigest),
    ).rejects.toThrow(
      `injected:${required(mutatingOperations[injectedIndex], `mutating operation ${injectedIndex}`).id}`,
    );
    expect(
      await Promise.all(
        baselinePlan.operations.map((operation) => baseline.adapter.capture(operation)),
      ),
      `rollback after mutating operation ${injectedIndex} (${required(mutatingOperations[injectedIndex], `mutating operation ${injectedIndex}`).id})`,
    ).toEqual(targetSnapshots);
    expect(await baseline.store.readReceipt()).toBeUndefined();
    expect(
      await baseline.native.read(
        path.win32.join(
          baseline.localAppData,
          'Packages',
          'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
          'LocalState',
          'settings.json',
        ),
      ),
    ).toEqual({
      profiles: [
        { guid: 'foreign', name: 'Keep' },
        { guid: 'prior-mpx', name: 'MPX' },
      ],
      theme: 'native',
    });
    for (let index = 0; index < baseline.fixtureFiles.length; index++) {
      expect(
        await readFile(required(baseline.fixtureFiles[index], `fixture file ${index}`)),
      ).toEqual(required(baseline.before[index], `fixture snapshot ${index}`));
    }
    rollbackSimulations += 1;
  }
  expect({ successfulSimulations, rollbackSimulations }).toEqual({
    successfulSimulations: 2,
    rollbackSimulations: mutatingOperations.length,
  });
}, 300_000);

function projectionIntent(
  intent: InstallIntent,
  manifest: ReleaseManifest,
  change: (runtime: 'claude' | 'pi', files: readonly ProjectionFile[]) => ProjectionFile[],
): InstallIntent {
  const registrations = intent.runtimeRegistrations!.registrations.map((registration) => {
    const files = change(registration.runtime, registration.projection.files).sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    return {
      ...registration,
      ...(registration.runtime === 'pi'
        ? { nativePackage: createPiNativePackageRegistration(manifest) }
        : {}),
      projection: { ...registration.projection, files, rootDigest: installerDigest(files) },
    };
  });
  const matrix = {
    schemaVersion: 1 as const,
    kind: 'runtime-registration-matrix' as const,
    registrations,
  };
  return {
    ...intent,
    releaseKey: manifest.releaseKey,
    convergenceHash: manifest.convergenceHash,
    runtimeRegistrations: { ...matrix, matrixDigest: installerDigest(matrix) },
  } as InstallIntent;
}

async function projectionUpgradeFixture() {
  const fixture = await simulation(false);
  const obsoleteBody = Buffer.from('old-only\r\n\0payload');
  await writeFile(path.join(fixture.repositoryRoot, 'pi', 'obsolete.json'), obsoleteBody);
  const oldManifest = await fixture.releases.build();
  const oldIntent = projectionIntent(fixture.intent, oldManifest, (runtime, files) => [
    ...files,
    ...(runtime === 'pi'
      ? [
          {
            path: 'pi/obsolete.json',
            bytes: obsoleteBody.length,
            sha256: createHash('sha256').update(obsoleteBody).digest('hex'),
            role: 'licenses' as const,
            owner: 'convergence' as const,
          },
        ]
      : []),
  ]);
  const orchestrator = new InstallOrchestrator({
    adapter: fixture.adapter,
    store: fixture.store,
    releases: fixture.releases,
    activate: (releaseKey, prior) => activateRelease(fixture.localAppData, prior, releaseKey),
  });
  const oldPlan = await orchestrator.plan(oldIntent);
  const installed = await orchestrator.apply(oldPlan, oldPlan.confirmationDigest);
  const operations = installed.operations
    .map((operation) => {
      if (!operation.id.startsWith('61-projection-')) {
        return operation;
      }
      const identity = operation.id.split('-').slice(2, 4).join('-');
      const ordinal = oldIntent
        .runtimeRegistrations!.registrations.find(
          (registration) => registration.identity === identity,
        )!
        .projection.files.findIndex((file) =>
          operation.target.endsWith(file.path.replaceAll('/', '\\')),
        );
      expect(ordinal).toBeGreaterThanOrEqual(0);
      return { ...operation, id: `61-projection-${identity}-${String(ordinal).padStart(4, '0')}` };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const priorReceipt: OwnershipReceipt = {
    ...installed,
    operations,
    operationLocators: operations.map((operation) => {
      const original = installed.operationLocators.find(
        (locator) =>
          installed.operations.find((candidate) => candidate.id === locator.operationId)?.target ===
          operation.target,
      )!;
      const spec = operation.id.startsWith('61-projection-') ? { kind: 'file' } : original.spec;
      return {
        operationId: operation.id,
        adapter: operation.adapter,
        spec,
        bindingDigest: installerDigest({ operation, spec }),
      };
    }),
  };
  await fixture.store.writeReceipt(priorReceipt);
  const retiredPaths = [
    'claude/agents.json',
    'claude/hooks.json',
    'claude/licenses.json',
    'pi/obsolete.json',
  ];
  const newPath = (relative: string) =>
    `claude/inserted/${path.basename(relative) === 'licenses.json' ? 'LICENSE' : path.basename(relative)}`;
  for (const relative of retiredPaths) {
    const source = path.join(fixture.repositoryRoot, relative);
    if (relative.startsWith('claude/')) {
      const target = path.join(fixture.repositoryRoot, newPath(relative));
      await mkdir(path.dirname(target), { recursive: true });
      await rename(source, target);
    } else {
      await rm(source);
    }
  }
  const manifest = await fixture.releases.build();
  const intent = projectionIntent(oldIntent, manifest, (_runtime, files) =>
    files
      .filter((file) => file.path !== 'pi/obsolete.json')
      .map((file) => ({
        ...file,
        path: retiredPaths.includes(file.path) ? newPath(file.path) : file.path,
      })),
  );
  const plan = await orchestrator.plan(intent);
  const retained = plan.operations.filter(
    (operation) =>
      operation.id.startsWith('61-projection-') && operation.target.includes(oldIntent.releaseKey),
  );
  const preserved = new Map(
    await Promise.all(
      priorReceipt.operations
        .filter(
          (operation) =>
            operation.id.startsWith('61-projection-') || operation.id.startsWith('60-projection-'),
        )
        .map(async (operation) => [operation.target, await readFile(operation.target)] as const),
    ),
  );
  const sibling = path.join(
    fixture.localAppData,
    'mpx',
    'runtime-projections',
    oldIntent.releaseKey,
    'claude-personal',
    'foreign.bin',
  );
  await writeFile(sibling, 'foreign-sibling');
  preserved.set(sibling, await readFile(sibling));
  return {
    ...fixture,
    orchestrator,
    priorReceipt,
    oldIntent,
    intent,
    manifest,
    plan,
    retained,
    preserved,
    sibling,
  };
}

it('reconciles ordinal inventories by logical path and retains inert historical ownership across upgrades', async () => {
  const fixture = await projectionUpgradeFixture();
  try {
    const oldPayloads = fixture.priorReceipt.operations.filter((operation) =>
      operation.id.startsWith('61-projection-'),
    );
    expect(oldPayloads).toHaveLength(24);
    expect(
      fixture.plan.operations.filter(
        (operation) =>
          operation.id.startsWith('61-projection-') &&
          operation.target.includes(fixture.intent.releaseKey),
      ),
    ).toHaveLength(22);
    expect(fixture.retained).toHaveLength(8);
    const regenerated = await fixture.createAdapter().operations(
      fixture.oldIntent,
      {
        schemaVersion: 1,
        kind: 'release-manifest',
        releaseKey: fixture.priorReceipt.releaseKey,
        convergenceHash: fixture.priorReceipt.convergenceHash,
        files: fixture.priorReceipt.files,
      },
      true,
      fixture.priorReceipt,
    );
    expect(regenerated.automatic).toEqual(fixture.priorReceipt.operations);
    const historicalDescriptors = regenerated.automatic.filter((operation) =>
      operation.id.startsWith('60-projection-'),
    );
    const currentDescriptors = fixture.plan.operations.filter((operation) =>
      operation.id.startsWith('60-projection-'),
    );
    expect(historicalDescriptors.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        '60-projection-claude-personal-descriptor',
        '60-projection-pi-personal-descriptor',
      ]),
    );
    expect(currentDescriptors.map(({ id }) => id)).toEqual(
      historicalDescriptors.map(({ id }) => id),
    );
    for (const historical of historicalDescriptors) {
      const current = currentDescriptors.find(({ id }) => id === historical.id)!;
      expect(current.target.replace(fixture.intent.releaseKey, fixture.oldIntent.releaseKey)).toBe(
        historical.target,
      );
    }
    for (const prior of oldPayloads) {
      const current = fixture.plan.operations.find((operation) => operation.id === prior.id)!;
      if (!fixture.retained.some((operation) => operation.id === current.id)) {
        expect(
          current.target.replace(fixture.intent.releaseKey, fixture.oldIntent.releaseKey),
        ).toBe(prior.target);
      } else {
        expect(current).toEqual(prior);
      }
    }
    const modifiedTimes = await Promise.all(
      fixture.retained.map(async (operation) => (await lstat(operation.target)).mtimeMs),
    );
    const transitionAuthority = await Promise.all(
      fixture.plan.operations.map(async (operation) => ({
        operation,
        locator: await fixture.adapter.receiptLocator(operation),
      })),
    );
    await expect(
      fixture.adapter.authorizeOwnedOperations(fixture.priorReceipt, transitionAuthority),
    ).resolves.toBeUndefined();
    const capture = vi.spyOn(fixture.adapter, 'capture');
    const apply = vi.spyOn(fixture.adapter, 'apply');
    const restore = vi.spyOn(fixture.adapter, 'restore');
    const writes = vi.spyOn(fixture.store, 'writeTransaction');
    const receipt = await fixture.orchestrator.apply(fixture.plan, fixture.plan.confirmationDigest);
    const retainedIds = new Set(fixture.retained.map((operation) => operation.id));
    for (const spy of [capture, apply, restore]) {
      expect(spy.mock.calls.filter(([operation]) => retainedIds.has(operation.id))).toEqual([]);
    }
    for (const [stored] of writes.mock.calls) {
      expect(Object.keys(stored.snapshots).some((id) => retainedIds.has(id))).toBe(false);
      expect(stored.journal.completedOperationIds.some((id) => retainedIds.has(id))).toBe(false);
      expect(retainedIds.has(stored.journal.inFlightOperationId ?? '')).toBe(false);
    }
    expect(receipt.operations.every((operation) => operation.action === 'ensure')).toBe(true);
    const retainedLocators = receipt.operationLocators.filter(
      (locator) => (locator.spec as { kind?: string })?.kind === 'projection-retained',
    );
    expect(retainedLocators).toHaveLength(8);
    expect(
      await Promise.all(
        fixture.retained.map(async (operation) => (await lstat(operation.target)).mtimeMs),
      ),
    ).toEqual(modifiedTimes);
    for (const [target, bytes] of fixture.preserved) {
      expect(await readFile(target)).toEqual(bytes);
    }
    for (const retirement of fixture.retained.filter((operation) =>
      operation.target.endsWith('licenses.json'),
    )) {
      const priorSource = retirement.target
        .replace(
          path.win32.join(
            fixture.localAppData,
            'mpx',
            'runtime-projections',
            fixture.oldIntent.releaseKey,
          ),
          path.win32.join(fixture.appsRoot, 'mpx', 'releases', fixture.oldIntent.releaseKey),
        )
        .replace(/\\claude-(?:personal|work)\\/u, '\\');
      expect(await readFile(priorSource)).toEqual(fixture.preserved.get(retirement.target));
      const identity = retirement.id.split('-').slice(2, 4).join('-');
      const currentTarget = path.join(
        fixture.localAppData,
        'mpx',
        'runtime-projections',
        fixture.intent.releaseKey,
        identity,
        'claude/inserted/LICENSE',
      );
      expect(await readFile(currentTarget)).toEqual(fixture.preserved.get(retirement.target));
    }
    await rm(path.join(fixture.appsRoot, 'mpx', 'releases', fixture.oldIntent.releaseKey), {
      recursive: true,
    });
    const restartedAdapter = fixture.createAdapter();
    const restarted = new InstallOrchestrator({
      adapter: restartedAdapter,
      store: fixture.store,
      releases: fixture.releases,
    });
    const rerun = await restarted.plan(fixture.intent);
    expect(rerun.operations).toEqual(receipt.operations);
    expect(rerun.operations.every((operation) => operation.action === 'ensure')).toBe(true);
    await restarted.apply(rerun, rerun.confirmationDigest);
    await expect(restarted.verify(true)).resolves.toMatchObject({ healthy: true });
    await writeFile(
      path.join(fixture.repositoryRoot, 'bin/mpx.mjs'),
      'export const nextRelease = true;\n',
    );
    const nextManifest = await fixture.releases.build();
    const nextIntent = projectionIntent(fixture.intent, nextManifest, (_runtime, files) => [
      ...files,
    ]);
    const nextPlan = await restarted.plan(nextIntent);
    const retainedAuthority = await Promise.all(
      nextPlan.operations.map(async (operation) => ({
        operation,
        locator: await restartedAdapter.receiptLocator(operation),
      })),
    );
    await expect(
      restartedAdapter.authorizeOwnedOperations(receipt, retainedAuthority),
    ).resolves.toBeUndefined();
    expect(nextPlan.operations.every((operation) => operation.action === 'ensure')).toBe(true);
    expect(nextPlan.operations.map((operation) => operation.id)).toEqual(
      receipt.operations.map((operation) => operation.id),
    );
    const nextReceipt = await restarted.apply(nextPlan, nextPlan.confirmationDigest);
    expect(
      nextReceipt.operationLocators.filter((locator) => retainedIds.has(locator.operationId)),
    ).toEqual(retainedLocators);
    await expect(restarted.verify(true)).resolves.toMatchObject({ healthy: true });
    const returning = fixture.retained.find((operation) =>
      operation.target.endsWith('obsolete.json'),
    )!;
    const returningBytes = fixture.preserved.get(returning.target)!;
    await writeFile(path.join(fixture.repositoryRoot, 'pi', 'obsolete.json'), returningBytes);
    const returnManifest = await fixture.releases.build();
    const returnIntent = projectionIntent(nextIntent, returnManifest, (runtime, files) => [
      ...files,
      ...(runtime === 'pi'
        ? [
            {
              path: 'pi/obsolete.json',
              bytes: returningBytes.length,
              sha256: returning.desiredDigest!,
              role: 'licenses' as const,
              owner: 'convergence' as const,
            },
          ]
        : []),
    ]);
    const returnPlan = await restarted.plan(returnIntent);
    expect(returnPlan.operations.find((operation) => operation.id === returning.id)).toEqual({
      ...returning,
      target: returning.target.replace(fixture.oldIntent.releaseKey, returnIntent.releaseKey),
    });
    await restarted.apply(returnPlan, returnPlan.confirmationDigest);
    await expect(restarted.verify(true)).resolves.toMatchObject({ healthy: true });
    expect(await readFile(returning.target)).toEqual(returningBytes);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}, 60_000);

it.each(['mutation', 'verification', 'activation'])(
  'rolls back only changed resources while preserving external retained drift during %s',
  async (phase) => {
    const fixture = await projectionUpgradeFixture();
    const selector = path.join(fixture.localAppData, 'mpx', 'active-release');
    const selectorBefore = await readFile(selector);
    const retained = fixture.retained[0]!;
    const replacement = Buffer.from('foreign retained replacement');
    const restore = vi.spyOn(fixture.adapter, 'restore');
    const capture = vi.spyOn(fixture.adapter, 'capture');
    const originalApply = fixture.adapter.apply.bind(fixture.adapter);
    const apply = vi.spyOn(fixture.adapter, 'apply').mockImplementation(async (operation) => {
      await originalApply(operation);
      if (phase !== 'activation') {
        await writeFile(retained.target, replacement);
        if (phase === 'mutation') {
          throw new Error('injected-after-mutation');
        }
      }
    });
    const activation = vi.fn(async (releaseKey: string, prior: string | null) => {
      const rollback = await activateRelease(fixture.localAppData, prior, releaseKey);
      if (phase === 'activation') {
        await writeFile(retained.target, replacement);
      }
      return rollback;
    });
    try {
      const orchestrator = new InstallOrchestrator({
        adapter: fixture.adapter,
        store: fixture.store,
        releases: fixture.releases,
        activate: activation,
      });
      await expect(
        orchestrator.apply(fixture.plan, fixture.plan.confirmationDigest),
      ).rejects.toThrow();
      expect(await readFile(retained.target)).toEqual(replacement);
      expect(await fixture.store.readReceipt()).toEqual(fixture.priorReceipt);
      expect(await readFile(selector)).toEqual(selectorBefore);
      expect(restore.mock.calls.length).toBeGreaterThan(0);
      for (const spy of [capture, apply, restore]) {
        expect(
          spy.mock.calls.filter(([operation]) =>
            fixture.retained.some((candidate) => candidate.id === operation.id),
          ),
        ).toEqual([]);
      }
      expect(activation).toHaveBeenCalledTimes(phase === 'activation' ? 1 : 0);
    } finally {
      vi.restoreAllMocks();
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
  60_000,
);

it('rejects missing, changed, linked and forged retained ownership without touching siblings or native files', async () => {
  const fixture = await projectionUpgradeFixture();
  try {
    const retire = fixture.retained[0]!;
    const bytes = fixture.preserved.get(retire.target)!;
    const survivor = fixture.priorReceipt.operations.find(
      (operation) =>
        operation.id.startsWith('61-projection-') &&
        !fixture.retained.some((candidate) => candidate.id === operation.id),
    )!;
    await rm(survivor.target);
    await expect(
      new ImmutableInstallerService({
        adapters: [fixture.adapter],
        store: fixture.store,
        manifest: fixture.manifest,
      }).apply(fixture.plan, fixture.plan.confirmationDigest),
    ).rejects.toMatchObject({ code: 'INSTALL_FOREIGN_OR_DRIFTED' });
    await writeFile(survivor.target, fixture.preserved.get(survivor.target)!);
    await rm(retire.target);
    await expect(
      fixture.orchestrator.apply(fixture.plan, fixture.plan.confirmationDigest),
    ).rejects.toThrow();
    await writeFile(retire.target, 'tampered');
    await expect(fixture.adapter.apply(retire)).rejects.toMatchObject({
      code: 'INSTALL_FOREIGN_OR_DRIFTED',
    });
    await expect(fixture.adapter.restore(retire, bytes.toString('base64'))).rejects.toMatchObject({
      code: 'INSTALL_TRANSACTION_INVALID',
    });
    expect(await readFile(retire.target, 'utf8')).toBe('tampered');
    await writeFile(retire.target, bytes);
    const modified = (await lstat(retire.target)).mtimeMs;
    await fixture.adapter.apply(retire);
    expect((await lstat(retire.target)).mtimeMs).toBe(modified);
    const locator = (await fixture.adapter.receiptLocator(retire)) as Record<string, unknown>;
    const newPayload = fixture.plan.operations.find(
      (operation) =>
        operation.id.startsWith('61-projection-claude-personal-') &&
        !fixture.priorReceipt.operations.some((prior) => prior.id === operation.id),
    )!;
    const collidingPrior = fixture.priorReceipt.operations.find((operation) =>
      operation.id.startsWith('61-projection-claude-personal-'),
    )!;
    const collisionOperations = fixture.priorReceipt.operations
      .map((operation) =>
        operation.id === collidingPrior.id ? { ...operation, id: newPayload.id } : operation,
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const collisionReceipt = {
      ...fixture.priorReceipt,
      operations: collisionOperations,
      operationLocators: collisionOperations.map((operation) => {
        const priorId = operation.id === newPayload.id ? collidingPrior.id : operation.id;
        const spec = fixture.priorReceipt.operationLocators.find(
          (candidate) => candidate.operationId === priorId,
        )!.spec;
        return {
          operationId: operation.id,
          adapter: operation.adapter,
          spec,
          bindingDigest: installerDigest({ operation, spec }),
        };
      }),
    };
    await expect(
      fixture.createAdapter().operations(fixture.intent, fixture.manifest, false, collisionReceipt),
    ).rejects.toMatchObject({ code: 'INSTALL_OPERATION_DUPLICATE' });
    const cases = [
      { ...retire, target: fixture.fixtureFiles[0]! },
      { ...retire, target: fixture.sibling },
      { ...retire, target: path.join(fixture.root, 'outside.bin') },
      { ...retire, id: '60-projection-claude-personal-descriptor' },
      { ...retire, id: '50-pi-settings-personal' },
      { ...retire, desiredDigest: 'a'.repeat(64) },
    ];
    for (const operation of cases) {
      await expect(
        fixture.createAdapter().hydrateReceiptOperation(operation, locator, fixture.priorReceipt),
      ).rejects.toThrow();
    }
    for (const forgedLocator of [
      { ...locator, unexpected: true },
      { ...locator, file: { ...(locator.file as object), sha256: 'a'.repeat(64) } },
      { ...locator, file: { ...(locator.file as object), bytes: -1 } },
      { ...locator, projection: { ...(locator.projection as object), releaseKey: 'a'.repeat(64) } },
      { ...locator, projection: { ...(locator.projection as object), identity: 'pi-work' } },
      {
        ...locator,
        projection: { ...(locator.projection as object), relativePath: '../foreign.bin' },
      },
    ]) {
      await expect(
        fixture
          .createAdapter()
          .hydrateReceiptOperation(retire, forgedLocator, fixture.priorReceipt),
      ).rejects.toThrow();
    }
    const receiptWithoutMembership = {
      ...fixture.priorReceipt,
      files: fixture.priorReceipt.files.filter(
        (file) => !retire.target.endsWith(file.path.replaceAll('/', '\\')),
      ),
    };
    await expect(
      fixture.createAdapter().hydrateReceiptOperation(retire, locator, receiptWithoutMembership),
    ).rejects.toThrow();
    const ancestor = path.dirname(retire.target);
    const redirected = `${ancestor}-redirected`;
    await rename(ancestor, redirected);
    if (process.platform === 'win32') {
      await promisify(execFile)(
        'cmd.exe',
        ['/d', '/s', '/c', 'mklink', '/J', ancestor, redirected],
        { windowsVerbatimArguments: true },
      );
    } else {
      const { symlink } = await import('node:fs/promises');
      await symlink(redirected, ancestor, 'dir');
    }
    try {
      await expect(fixture.adapter.observe(retire)).rejects.toMatchObject({
        code: 'INSTALL_TARGET_UNSAFE',
      });
      await expect(fixture.adapter.apply(retire)).rejects.toMatchObject({
        code: 'INSTALL_TARGET_UNSAFE',
      });
      expect(await readFile(path.join(redirected, path.basename(retire.target)))).toEqual(bytes);
    } finally {
      await rm(ancestor);
      await rename(redirected, ancestor);
    }
    const hardlink = path.join(fixture.root, 'hardlink.bin');
    await link(retire.target, hardlink);
    await expect(fixture.adapter.apply(retire)).rejects.toMatchObject({
      code: 'INSTALL_TARGET_UNSAFE',
    });
    await rm(hardlink);
    for (const [target, original] of fixture.preserved) {
      expect(await readFile(target)).toEqual(original);
    }
    for (const [index, target] of fixture.fixtureFiles.entries()) {
      expect(await readFile(target)).toEqual(fixture.before[index]);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}, 60_000);

it('validates retained observations under the apply lock before capture and never reconstructs missing historical bytes', async () => {
  const fixture = await projectionUpgradeFixture();
  try {
    const retained = fixture.retained[0]!;
    const capture = vi.spyOn(fixture.adapter, 'capture');
    const apply = vi.spyOn(fixture.adapter, 'apply');
    const service = new ImmutableInstallerService({
      adapters: [fixture.adapter],
      store: fixture.store,
      manifest: fixture.manifest,
      beforeApply: async () => {
        await writeFile(retained.target, 'changed-under-lock');
      },
    });
    await expect(
      service.apply(fixture.plan, fixture.plan.confirmationDigest),
    ).rejects.toMatchObject({ code: 'INSTALL_FOREIGN_OR_DRIFTED' });
    expect(capture).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(await readFile(retained.target, 'utf8')).toBe('changed-under-lock');
    await writeFile(retained.target, fixture.preserved.get(retained.target)!);
    const receipt = await fixture.orchestrator.apply(fixture.plan, fixture.plan.confirmationDigest);
    await rm(path.join(fixture.appsRoot, 'mpx', 'releases', fixture.oldIntent.releaseKey), {
      recursive: true,
    });
    const locator = receipt.operationLocators.find(
      (candidate) => candidate.operationId === retained.id,
    )!.spec;
    await fixture.createAdapter().hydrateReceiptOperation(retained, locator);
    const inputPath = path.join(fixture.root, 'retained-input.json');
    await writeFile(
      inputPath,
      JSON.stringify({ environment: fixture.environment, operation: retained, locator }),
    );
    const run = () =>
      promisify(execFile)(process.execPath, [
        path.resolve(import.meta.dirname, '../fixtures/projection-retention-process.mjs'),
        inputPath,
      ]);
    expect(JSON.parse((await run()).stdout)).toEqual({ digest: retained.desiredDigest });
    await writeFile(retained.target, 'tampered-without-source');
    await expect(run()).rejects.toMatchObject({
      stderr: expect.stringContaining('Retained projection is changed'),
    });
    expect(await readFile(retained.target, 'utf8')).toBe('tampered-without-source');
    await rm(retained.target);
    await expect(
      fixture.createAdapter().hydrateReceiptOperation(retained, locator),
    ).rejects.toMatchObject({ code: 'INSTALL_FOREIGN_OR_DRIFTED' });
    await expect(run()).rejects.toMatchObject({
      stderr: expect.stringContaining('Retained projection is missing'),
    });
    await expect(readFile(retained.target)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    vi.restoreAllMocks();
    await rm(fixture.root, { recursive: true, force: true });
  }
}, 60_000);
