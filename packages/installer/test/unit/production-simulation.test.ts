import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FakeJsonResourceStore } from '@mpx/windows';
import {
  activateRelease,
  installerDigest,
  type InstallIntentV1,
} from '../../src/immutable-core.js';
import { InstallOrchestrator, NodeCurrentReleaseBuilder } from '../../src/orchestration.js';
import {
  NodeBinaryFileSystem,
  ProductionInstallerOperationAdapter,
} from '../../src/production-operation.js';
import { NodePiNativeSettingsPort } from '../../src/pi-native-settings.js';
import {
  createRuntimeRegistrationMatrix,
  type ProjectionFileV1,
} from '../../src/runtime-registration.js';
import { ImmutableInstallerService, NodeTransactionStore } from '../../src/transaction.js';
import {
  createPiNativePackageRegistration,
  type PiNativePackageRegistrationV1,
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
  nativePackage: PiNativePackageRegistrationV1,
) {
  const files: ProjectionFileV1[] = roles(runtime).map((role) => {
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
async function simulation(
  existing: boolean,
  prepareExtension: typeof preparePiExtensionBuildFixture = preparePiExtensionBuildFixture,
) {
  const checkoutRoot = path.resolve(import.meta.dirname, '../../../..');
  const root = await mkdtemp(
    path.join(checkoutRoot, 'node_modules', `mpx-production-${existing ? 'existing' : 'clean'}-`),
  );
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
    identities: {
      personal: {
        domain: 'personal',
        runtimeRoots: {
          claude: required(fixtureRoots[0], 'Claude personal fixture root'),
          pi: required(fixtureRoots[2], 'Pi personal fixture root'),
        },
        gitAuthorRoute: 'personal-git',
      },
      work: {
        domain: 'work',
        runtimeRoots: {
          claude: required(fixtureRoots[1], 'Claude work fixture root'),
          pi: required(fixtureRoots[3], 'Pi work fixture root'),
        },
        gitAuthorRoute: 'work-git',
      },
    },
    domains: {
      personal: [required(fixtureRoots[0], 'Claude personal fixture root')],
      work: [required(fixtureRoots[1], 'Claude work fixture root')],
    },
    contentScopes: {},
    modes: {},
    skillPolicies: {},
    presets: {},
    launchDefaults: { scopes: {}, projects: {} },
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
  const adapter = new ProductionInstallerOperationAdapter(environment, 'DOMAIN\\me', {
    files: new NodeBinaryFileSystem(),
    resources: native,
    piNativeSettings,
    runtimeRegistrations: {
      inspect: async () => ({
        observations: runtimeRegistrations.registrations.map(
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
          runtimeRegistrations.registrations.map((item) => [item.identity, item.routes.mcpSharing]),
        ) as never,
      }),
    },
  });
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
  const intent: InstallIntentV1 = {
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
  for (const file of ['build-metadata.json', 'index.mjs', 'package.json']) {
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
