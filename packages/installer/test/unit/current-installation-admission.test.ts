import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  canonicalJson,
  installerDigest,
  parseOwnershipReceipt,
  type InstallIntent,
  type InstallOperation,
  type OwnershipReceipt,
} from '../../src/immutable-core.js';
import {
  InstallOrchestrator,
  type CurrentInstallationProbe,
  type InstallerOperationAdapter,
} from '../../src/orchestration.js';
import { ImmutableInstallerService, MemoryTransactionStore } from '../../src/transaction.js';
import {
  createRuntimeRegistrationMatrix,
  type ProjectionRole,
} from '../../src/runtime-registration.js';
import {
  createPiNativePackageRegistration,
  PI_NATIVE_PACKAGE_ROOT,
  planPiNativePackageSettings,
  resolvePiNativePackageSource,
} from '../../src/pi-native-package.js';

function fixture() {
  const files = ['build-metadata.json', 'mpx-extension.mjs', 'package.json'].map((name) => ({
    path: `${PI_NATIVE_PACKAGE_ROOT}/${name}`,
    bytes: 1,
    sha256: installerDigest(name),
  }));
  const releaseKey = installerDigest(files);
  const manifest = {
    schemaVersion: 1 as const,
    kind: 'release-manifest' as const,
    releaseKey,
    convergenceHash: releaseKey,
    files,
  };
  const nativePackage = createPiNativePackageRegistration(manifest);
  const matrix = createRuntimeRegistrationMatrix(
    (['claude', 'pi'] as const).flatMap((runtime) =>
      (['personal', 'work'] as const).map((domain) => {
        const roles: ProjectionRole[] =
          runtime === 'claude'
            ? ['plugin', 'hooks', 'status', 'settings', 'canonical-content', 'agents', 'licenses']
            : ['profile', 'canonical-content', 'agents', 'licenses'];
        const projectedFiles = roles.map((role) => ({
          path: `${role}/owned`,
          sha256: installerDigest(role),
          bytes: 1,
          role,
          owner: 'convergence' as const,
        }));
        const common = {
          domain,
          nativeRoot: `C:\\native\\${runtime}-${domain}`,
          executable: {
            path: `C:\\apps\\${runtime}.exe`,
            sha256: installerDigest(runtime),
            version: '1',
          },
          projection: {
            files: projectedFiles,
            rootDigest: installerDigest(projectedFiles),
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
        return runtime === 'pi' ? { ...common, runtime, nativePackage } : { ...common, runtime };
      }),
    ),
  );
  const intent: InstallIntent = {
    schemaVersion: 1,
    kind: 'install-intent',
    releaseKey,
    convergenceHash: releaseKey,
    components: ['cli'],
    runtimeRegistrations: matrix,
  };
  const appsRoot = path.resolve('admission-fixture-apps');
  const releaseRoot = path.join(appsRoot, 'mpx', 'releases', releaseKey);
  const desiredSource = resolvePiNativePackageSource(releaseRoot, PI_NATIVE_PACKAGE_ROOT);
  const piRoots = matrix.registrations
    .filter((registration) => registration.runtime === 'pi')
    .map(({ identity, domain, nativeRootDigest }) => ({
      identity,
      domain,
      nativeRootDigest,
      settings: { packages: ['foreign', desiredSource], unrelated: true },
    }));
  const operations: InstallOperation[] = piRoots.map((root) => ({
    id: `50-pi-settings-${root.domain}`,
    adapter: 'fixture',
    action: 'ensure',
    target: `pi:${root.domain}:settings-packages`,
    desiredDigest: installerDigest(root.settings.packages),
  }));
  const operationLocators = operations.map((operation, index) => {
    const { settings, ...binding } = piRoots[index]!;
    const spec = {
      schemaVersion: 1,
      kind: 'pi-settings',
      bindings: [binding],
      currentRelease: {
        releaseKey,
        packageRoot: PI_NATIVE_PACKAGE_ROOT,
        registrationDigest: installerDigest(nativePackage),
        registration: nativePackage,
      },
      priorRelease: null,
      plan: planPiNativePackageSettings({
        settings,
        releaseRoot,
        desiredSource,
        nativePackage,
        priorOwnedSources: [],
      }),
    };
    return {
      operationId: operation.id,
      adapter: operation.adapter,
      spec,
      bindingDigest: installerDigest({ operation, spec }),
    };
  });
  const historicalContent = canonicalJson({
    schemaVersion: 2,
    identities: {},
    domains: {},
    locations: {},
    modes: {},
    presets: {},
    launchDefaults: { locations: {}, projects: {} },
    networkPolicies: {},
    executors: { host: {} },
    contentScopes: { obsolete: true },
  });
  const historicalIntent: InstallIntent = {
    ...intent,
    userConfigArtifact: {
      target: '%APPDATA%/mpx/config.json',
      content: historicalContent,
      sha256: installerDigest(JSON.parse(historicalContent)),
    },
  };
  const receipt = parseOwnershipReceipt({
    schemaVersion: 2,
    kind: 'ownership-receipt',
    releaseKey,
    convergenceHash: releaseKey,
    files,
    operations,
    operationLocators,
    installIntent: historicalIntent,
    installedAt: '2025-01-01T00:00:00.000Z',
  });
  const store = new MemoryTransactionStore();
  const adapter = {
    name: 'fixture',
    operations: vi.fn(async (requestedIntent: InstallIntent) => {
      if (requestedIntent.userConfigArtifact) {
        throw new Error('historical user config is rejected by the current parser');
      }
      return { automatic: operations };
    }),
    observe: vi.fn(async (operation: InstallOperation) => operation.desiredDigest),
    hydrateReceiptOperation: vi.fn(async () => undefined),
    capture: vi.fn(async () => null),
    receiptLocator: vi.fn(
      async (operation: InstallOperation) =>
        operationLocators.find((locator) => locator.operationId === operation.id)!.spec,
    ),
    authorizeOwnedOperations: vi.fn(async () => undefined),
    apply: vi.fn(async () => undefined),
    restore: vi.fn(async () => undefined),
  } satisfies InstallerOperationAdapter;
  const releases = {
    appsRoot,
    build: vi.fn(async () => manifest),
    publish: vi.fn(async () => manifest),
    verify: vi.fn(
      async (_receipt: OwnershipReceipt, _strict: boolean): Promise<readonly string[]> => [],
    ),
  };
  const observed = { selectedReleaseKey: releaseKey as string | null, hasArtifacts: true, piRoots };
  const probe: CurrentInstallationProbe = { observe: vi.fn(async () => observed) };
  const orchestrator = new InstallOrchestrator({ adapter, store, releases });
  return {
    intent,
    receipt,
    store,
    adapter,
    releases,
    observed,
    probe,
    orchestrator,
    desiredSource,
  };
}

it('authenticates the complete current receipt and binds a strict admission to planning and locked apply', async () => {
  const value = fixture();
  await value.store.writeReceipt(value.receipt);
  const admission = await value.orchestrator.admitCurrentInstallation(value.intent, value.probe);
  expect(admission.status).toBe('current');
  expect(value.releases.verify).toHaveBeenCalledWith(value.receipt, true);
  expect(value.adapter.operations).toHaveBeenCalled();
  expect(value.adapter.operations.mock.calls[0]?.[0]).toEqual(value.intent);
  expect(value.adapter.operations.mock.calls[0]?.[0].userConfigArtifact).toBeUndefined();
  const plan = await value.orchestrator.plan(value.intent, admission);
  expect(plan.classifications?.confirmationRequired).toContainEqual({
    id: 'setup-current-installation',
    planDigest: admission.digest,
    verifierRef: 'installer:setup-current-installation',
  });
  await value.orchestrator.apply(plan, plan.confirmationDigest);
  expect(value.adapter.apply).not.toHaveBeenCalled();
});

it('admits initial installation only when all current-installation evidence is absent', async () => {
  const value = fixture();
  value.observed.selectedReleaseKey = null;
  value.observed.hasArtifacts = false;
  value.observed.piRoots.forEach((root) => {
    root.settings.packages = ['foreign'];
  });
  await expect(
    value.orchestrator.admitCurrentInstallation(value.intent, value.probe),
  ).resolves.toMatchObject({ status: 'initial' });
  expect(value.adapter.apply).not.toHaveBeenCalled();
  expect(value.releases.publish).not.toHaveBeenCalled();
});

it.each(['selector', 'artifacts', 'package'])(
  'rejects partial %s evidence without a receipt',
  async (kind) => {
    const value = fixture();
    value.observed.selectedReleaseKey = kind === 'selector' ? value.intent.releaseKey : null;
    value.observed.hasArtifacts = kind === 'artifacts';
    if (kind !== 'package') {
      value.observed.piRoots.forEach((root) => {
        root.settings.packages = ['foreign'];
      });
    }
    await expect(
      value.orchestrator.admitCurrentInstallation(value.intent, value.probe),
    ).rejects.toMatchObject({ code: 'INSTALL_CURRENT_UNVERIFIED' });
    expect(value.adapter.apply).not.toHaveBeenCalled();
    expect(value.releases.publish).not.toHaveBeenCalled();
  },
);

it.each([
  'forged',
  'stale-release',
  'selector',
  'root',
  'identity',
  'domain',
  'missing-package',
  'duplicate-package',
  'receipt-package',
  'missing-operation',
  'observation',
])('rejects %s evidence before any apply or publish', async (kind) => {
  const value = fixture();
  const receipt = structuredClone(value.receipt);
  await value.store.writeReceipt(receipt);
  if (kind === 'forged') {
    await value.store.writeReceipt({ ...receipt, releaseKey: 'a'.repeat(64) });
  }
  if (kind === 'stale-release') {
    value.releases.verify.mockResolvedValue(['foreign-release-entry']);
  }
  if (kind === 'selector') {
    value.observed.selectedReleaseKey = 'a'.repeat(64);
  }
  if (kind === 'root') {
    value.observed.piRoots[0]!.nativeRootDigest = 'a'.repeat(64);
  }
  if (kind === 'identity') {
    value.observed.piRoots[0]!.identity = 'pi-work';
  }
  if (kind === 'domain') {
    value.observed.piRoots[0]!.domain = 'work';
  }
  if (kind === 'missing-package') {
    value.observed.piRoots[0]!.settings.packages = ['foreign'];
  }
  if (kind === 'duplicate-package') {
    value.observed.piRoots[0]!.settings.packages.push(value.desiredSource);
  }
  if (kind === 'receipt-package') {
    const locator = receipt.operationLocators[0]!;
    const spec = structuredClone(locator.spec) as { currentRelease: { releaseKey: string } };
    spec.currentRelease.releaseKey = 'a'.repeat(64);
    await value.store.writeReceipt({
      ...receipt,
      operationLocators: [
        {
          ...locator,
          spec,
          bindingDigest: installerDigest({ operation: receipt.operations[0], spec }),
        },
        receipt.operationLocators[1]!,
      ],
    });
  }
  if (kind === 'missing-operation') {
    await value.store.writeReceipt({
      ...receipt,
      operations: receipt.operations.slice(1),
      operationLocators: receipt.operationLocators.slice(1),
    });
  }
  if (kind === 'observation') {
    value.adapter.observe.mockResolvedValue(null);
  }
  await expect(
    value.orchestrator.admitCurrentInstallation(value.intent, value.probe),
  ).rejects.toBeDefined();
  expect(value.adapter.apply).not.toHaveBeenCalled();
  expect(value.adapter.capture).not.toHaveBeenCalled();
  expect(value.releases.publish).not.toHaveBeenCalled();
});

it.each(['planning', 'locked-apply'])(
  'rejects a receipt swap during %s without captures or writes',
  async (boundary) => {
    const value = fixture();
    await value.store.writeReceipt(value.receipt);
    const admission = await value.orchestrator.admitCurrentInstallation(value.intent, value.probe);
    const changed = { ...value.receipt, installedAt: '2025-02-01T00:00:00.000Z' };
    if (boundary === 'planning') {
      await value.store.writeReceipt(changed);
      await expect(value.orchestrator.plan(value.intent, admission)).rejects.toMatchObject({
        code: 'INSTALL_PLAN_STALE',
      });
    } else {
      const plan = await value.orchestrator.plan(value.intent, admission);
      const exclusive = value.store.exclusive.bind(value.store);
      vi.spyOn(value.store, 'exclusive').mockImplementation(async (action) =>
        exclusive(async () => {
          await value.store.writeReceipt(changed);
          return action();
        }),
      );
      await expect(value.orchestrator.apply(plan, plan.confirmationDigest)).rejects.toMatchObject({
        code: 'INSTALL_PLAN_STALE',
      });
    }
    expect(value.adapter.apply).not.toHaveBeenCalled();
    expect(value.adapter.capture).not.toHaveBeenCalled();
  },
);

it('recovers an authorized pending transaction exactly once before strict classification under the same lock', async () => {
  const value = fixture();
  await value.store.writeReceipt(value.receipt);
  const operation = value.receipt.operations[0]!;
  const transactionId = 'interrupted';
  await value.store.writeTransaction({
    journal: {
      schemaVersion: 1,
      kind: 'transaction-journal',
      transactionId,
      phase: 'applying',
      completedOperationIds: [operation.id],
      snapshot: {
        schemaVersion: 1,
        kind: 'machine-snapshot',
        transactionId,
        observations: value.receipt.operations.map((operation) => ({
          id: operation.id,
          digest: operation.desiredDigest,
        })),
        capturedAt: '2025-01-01T00:00:00.000Z',
      },
    },
    snapshots: { [operation.id]: null },
    operations: value.receipt.operations,
    operationLocators: value.receipt.operationLocators,
    priorReceipt: value.receipt,
  });
  const recover = vi.spyOn(ImmutableInstallerService.prototype, 'recover');
  try {
    const admission = await value.orchestrator.admitCurrentInstallation(value.intent, value.probe);
    const plan = await value.orchestrator.plan(value.intent, admission);
    await value.orchestrator.apply(plan, plan.confirmationDigest);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(value.adapter.restore).toHaveBeenCalledTimes(1);
    expect(await value.store.readTransaction()).toBeUndefined();
  } finally {
    recover.mockRestore();
  }
});

it('fails closed on an unknown pending locator instead of classifying it as initial', async () => {
  const value = fixture();
  vi.spyOn(value.store, 'readTransaction').mockRejectedValue(new Error('untrusted journal'));
  await expect(
    value.orchestrator.admitCurrentInstallation(value.intent, value.probe),
  ).rejects.toMatchObject({ code: 'INSTALL_RECOVERY_FAILED' });
  expect(value.probe.observe).not.toHaveBeenCalled();
  expect(value.adapter.apply).not.toHaveBeenCalled();
});
