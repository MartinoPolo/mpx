import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { MpxError } from '@mpx/core';
import {
  buildCurrentReleaseManifest,
  canonicalJson,
  parseInstallIntent,
  parseInstallPlan,
  parseOwnershipReceipt,
  publishCurrentRelease,
  type CurrentReleaseOptions,
  type InstallIntent,
  type InstallOperation,
  type InstallPlan,
  type InstallOperationClassifications,
  type InstallVerification,
  type OwnershipReceipt,
  type ReleaseManifest,
} from './immutable-core.js';
import {
  ImmutableInstallerService,
  installerDigest,
  type SideEffectAdapter,
  type TransactionStore,
  type OwnedUserConfigAdoption,
} from './transaction.js';
import { aggregateInstallerFailure } from './failure.js';
import {
  assertPiNativePackagesMatchRelease,
  type AccountDomain,
  type RuntimeIdentity,
} from './runtime-registration.js';
import { parsePiSettingsLocator } from './pi-native-settings-operation.js';
import {
  PI_NATIVE_PACKAGE_ROOT,
  parsePiSettings,
  planPiNativePackageSettings,
  resolvePiNativePackageSource,
} from './pi-native-package.js';

function fail(code: string, message: string): never {
  throw new MpxError({ code, message });
}
const missing = (failure: unknown): boolean => (failure as NodeJS.ErrnoException).code === 'ENOENT';

export interface InstallerOperationSet {
  readonly automatic: readonly InstallOperation[];
  readonly classifications?: InstallOperationClassifications;
  readonly userConfigAdoption?: OwnedUserConfigAdoption;
}
export interface OperationAuthority {
  readonly operation: InstallOperation;
  readonly locator: unknown;
}
/** The host owns native details; orchestration only consumes ordered, reversible operations. */
export interface InstallerOperationAdapter extends SideEffectAdapter {
  operations(
    intent: InstallIntent,
    manifest: ReleaseManifest,
    requireActual?: boolean,
    priorReceipt?: OwnershipReceipt,
  ): Promise<InstallerOperationSet>;
  authorizeOwnedOperations(
    receipt: OwnershipReceipt,
    desired: readonly OperationAuthority[],
  ): Promise<void>;
}
export interface CurrentReleaseBuilder {
  readonly appsRoot: string;
  build(): Promise<ReleaseManifest>;
  publish(expectedReleaseKey: string): Promise<ReleaseManifest>;
  verify(receipt: OwnershipReceipt, strict: boolean): Promise<readonly string[]>;
}

async function walkRelative(root: string, relative = ''): Promise<string[]> {
  const directory = path.join(root, ...relative.split('/').filter(Boolean));
  const names = await readdir(directory);
  const result: string[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    const next = relative ? `${relative}/${name}` : name;
    const info = await lstat(path.join(root, ...next.split('/')));
    if (info.isDirectory() && !info.isSymbolicLink()) {
      result.push(...(await walkRelative(root, next)));
    } else {
      result.push(next);
    }
  }
  return result;
}

export class NodeCurrentReleaseBuilder implements CurrentReleaseBuilder {
  readonly appsRoot: string;
  private readonly current: CurrentReleaseOptions;
  constructor(options: CurrentReleaseOptions & { readonly appsRoot: string }) {
    this.appsRoot = options.appsRoot;
    this.current = {
      repositoryRoot: options.repositoryRoot,
      ...(options.assetPaths ? { assetPaths: options.assetPaths } : {}),
    };
  }
  build(): Promise<ReleaseManifest> {
    return buildCurrentReleaseManifest(this.current);
  }
  async publish(expectedReleaseKey: string): Promise<ReleaseManifest> {
    const manifest = await publishCurrentRelease({ ...this.current, appsRoot: this.appsRoot });
    if (manifest.releaseKey !== expectedReleaseKey) {
      fail('INSTALL_PLAN_STALE', 'Current release changed after planning.');
    }
    return manifest;
  }
  async verify(receipt: OwnershipReceipt, strict: boolean): Promise<readonly string[]> {
    const root = path.join(this.appsRoot, 'mpx', 'releases', receipt.releaseKey),
      issues: string[] = [];
    const expectedManifest = canonicalJson({
      schemaVersion: 1,
      kind: 'release-manifest',
      releaseKey: receipt.releaseKey,
      convergenceHash: receipt.convergenceHash,
      files: receipt.files,
    });
    try {
      const manifestInfo = await lstat(path.join(root, 'release-manifest.json'));
      if (
        !manifestInfo.isFile() ||
        manifestInfo.isSymbolicLink() ||
        (await readFile(path.join(root, 'release-manifest.json'), 'utf8')).trim() !==
          expectedManifest
      ) {
        issues.push('release-manifest-drift');
      }
    } catch (failure) {
      if (missing(failure)) {
        issues.push('release-manifest-missing');
      } else {
        throw failure;
      }
    }
    for (const file of receipt.files) {
      const absolute = path.join(root, ...file.path.split('/'));
      try {
        const info = await lstat(absolute);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes) {
          issues.push(`release-file-drift:${file.path}`);
          continue;
        }
        const actual = createHash('sha256')
          .update(await readFile(absolute))
          .digest('hex');
        if (actual !== file.sha256) {
          issues.push(`release-file-drift:${file.path}`);
        }
      } catch (failure) {
        if (missing(failure)) {
          issues.push(`release-file-missing:${file.path}`);
        } else {
          throw failure;
        }
      }
    }
    if (strict) {
      let actual: string[] = [];
      try {
        actual = await walkRelative(root);
      } catch (failure) {
        if (!missing(failure)) {
          throw failure;
        }
      }
      const owned = new Set([...receipt.files.map((file) => file.path), 'release-manifest.json']);
      for (const entry of actual) {
        if (!owned.has(entry)) {
          issues.push(`foreign-release-entry:${entry}`);
        }
      }
    }
    return issues.sort((a, b) => a.localeCompare(b));
  }
}

export interface InstallOrchestratorOptions {
  readonly adapter: InstallerOperationAdapter;
  readonly store: TransactionStore;
  readonly releases: CurrentReleaseBuilder;
  /** Publishes the mutable stable selector after all release-bound operations commit. */
  readonly activate?: (
    releaseKey: string,
    expectedPriorReleaseKey: string | null,
  ) => Promise<() => Promise<void>>;
  readonly now?: () => Date;
}
export interface CurrentInstallationProbe {
  observe(intent: InstallIntent): Promise<{
    readonly selectedReleaseKey: string | null;
    readonly hasArtifacts: boolean;
    readonly piRoots: readonly {
      readonly identity: RuntimeIdentity;
      readonly domain: AccountDomain;
      readonly nativeRootDigest: string;
      readonly settings: unknown;
    }[];
  }>;
}

export interface CurrentInstallationAdmission {
  readonly status: 'initial' | 'current';
  readonly digest: string;
}

const CURRENT_INSTALLATION_ID = 'setup-current-installation';
const RELEASE_UPGRADE_ID = 'ownership-release-upgrade';
export class InstallOrchestrator {
  private readonly now: () => Date;
  private readonly admissions = new WeakMap<
    CurrentInstallationAdmission,
    { intentDigest: string; probe: CurrentInstallationProbe }
  >();
  private readonly admittedPlans = new Map<string, CurrentInstallationAdmission>();
  constructor(private readonly options: InstallOrchestratorOptions) {
    this.now = options.now ?? (() => new Date());
  }
  private service(
    manifest?: ReleaseManifest,
    beforeApply?: () => Promise<void>,
    userConfigAdoption?: OwnedUserConfigAdoption,
  ): ImmutableInstallerService {
    return new ImmutableInstallerService({
      adapters: [this.options.adapter],
      store: this.options.store,
      ...(manifest ? { manifest } : {}),
      ...(beforeApply ? { beforeApply } : {}),
      ...(userConfigAdoption ? { userConfigAdoption } : {}),
      now: this.now,
    });
  }
  private async current(
    intentValue: InstallIntent,
    priorReceipt?: OwnershipReceipt,
  ): Promise<{
    intent: InstallIntent;
    manifest: ReleaseManifest;
    operations: readonly InstallOperation[];
    classifications?: InstallOperationClassifications;
    userConfigAdoption?: OwnedUserConfigAdoption;
  }> {
    const intent = parseInstallIntent(intentValue),
      manifest = await this.options.releases.build();
    if (
      intent.releaseKey !== manifest.releaseKey ||
      intent.convergenceHash !== manifest.convergenceHash
    ) {
      fail('INSTALL_INTENT_STALE', 'Intent does not describe the current deterministic release.');
    }
    const grouped = await this.options.adapter.operations(intent, manifest, false, priorReceipt);
    const automatic = [...grouped.automatic].sort((a, b) => a.id.localeCompare(b.id));
    const operations = automatic;
    if (new Set(operations.map((operation) => operation.id)).size !== operations.length) {
      fail('INSTALL_OPERATION_DUPLICATE', 'Operation IDs must be unique.');
    }
    if (
      operations.some(
        (operation, index) =>
          index > 0 && operations[index - 1]!.id.localeCompare(operation.id) >= 0,
      )
    ) {
      fail('INSTALL_OPERATION_ORDER_INVALID', 'Automatic operations must be sorted by ID.');
    }
    return {
      intent,
      manifest,
      operations,
      ...(grouped.classifications ? { classifications: grouped.classifications } : {}),
      ...(grouped.userConfigAdoption ? { userConfigAdoption: grouped.userConfigAdoption } : {}),
    };
  }
  private async validatedReceipt(
    userConfigAdoption?: OwnedUserConfigAdoption,
  ): Promise<OwnershipReceipt | undefined> {
    const receipt = await this.options.store.readReceipt();
    if (!receipt) {
      return undefined;
    }
    const releaseIssues = await this.options.releases.verify(receipt, false);
    if (releaseIssues.length) {
      fail('INSTALL_FOREIGN_OR_DRIFTED', `Owned release is drifted (${releaseIssues.join(', ')}).`);
    }
    await this.service(undefined, undefined, userConfigAdoption).assertOwnedReceipt(receipt);
    return receipt;
  }
  private async recoverPending(): Promise<void> {
    try {
      await this.service().recover();
    } catch {
      fail(
        'INSTALL_RECOVERY_FAILED',
        'Pending installer transaction recovery failed; no fresh plan was created.',
      );
    }
  }

  private async classifyInstallation(
    intent: InstallIntent,
    probe: CurrentInstallationProbe,
  ): Promise<CurrentInstallationAdmission> {
    const transaction = await this.options.store.readTransaction();
    if (transaction && transaction.journal.phase !== 'rolled-back') {
      fail('INSTALL_PLAN_STALE', 'A pending transaction appeared after setup recovery.');
    }
    const receiptValue = await this.options.store.readReceipt();
    const observed = await probe.observe(intent);
    const requested =
      intent.runtimeRegistrations?.registrations.filter(
        (registration) => registration.runtime === 'pi',
      ) ?? [];
    if (
      requested.length !== 2 ||
      new Set(requested.map((registration) => registration.domain)).size !== 2 ||
      observed.piRoots.length !== requested.length
    ) {
      fail(
        'INSTALL_CURRENT_UNVERIFIED',
        'Setup requires the requested personal and work Pi roots.',
      );
    }
    for (const registration of requested) {
      const roots = observed.piRoots.filter(
        (root) =>
          root.identity === registration.identity &&
          root.domain === registration.domain &&
          root.nativeRootDigest === registration.nativeRootDigest,
      );
      if (roots.length !== 1) {
        fail('INSTALL_CURRENT_UNVERIFIED', 'Setup Pi root registration changed.');
      }
    }
    if (!receiptValue) {
      const hasPackage = observed.piRoots.some((root) =>
        (parsePiSettings(root.settings).packages as unknown[] | undefined)?.some((entry) => {
          const source =
            typeof entry === 'string' ? entry : (entry as { source?: unknown })?.source;
          return (
            typeof source === 'string' &&
            (source.includes('@mpx/pi-extensions') ||
              /(?:^|[\\/])mpx[\\/]releases[\\/]/iu.test(source))
          );
        }),
      );
      if (observed.selectedReleaseKey !== null || observed.hasArtifacts || hasPackage) {
        fail(
          'INSTALL_CURRENT_UNVERIFIED',
          'Installation evidence exists without an ownership receipt.',
        );
      }
      return {
        status: 'initial',
        digest: installerDigest({ intent, receipt: null, transaction: transaction ?? null }),
      };
    }
    const receipt = parseOwnershipReceipt(receiptValue);
    const priorIntent = receipt.installIntent;
    if (
      !priorIntent?.runtimeRegistrations ||
      priorIntent.convergenceHash !== receipt.convergenceHash ||
      observed.selectedReleaseKey !== receipt.releaseKey
    ) {
      fail(
        'INSTALL_CURRENT_UNVERIFIED',
        'Installed intent or selected release disagrees with ownership.',
      );
    }
    const releaseIssues = await this.options.releases.verify(receipt, true);
    if (releaseIssues.length) {
      fail('INSTALL_CURRENT_UNVERIFIED', 'The owned immutable release failed strict verification.');
    }
    const ownedManifest: ReleaseManifest = {
      schemaVersion: 1,
      kind: 'release-manifest',
      releaseKey: receipt.releaseKey,
      convergenceHash: receipt.convergenceHash,
      files: receipt.files,
    };
    assertPiNativePackagesMatchRelease(ownedManifest, priorIntent.runtimeRegistrations);
    const desiredManifest = await this.options.releases.build();
    const desired = await this.options.adapter.operations(intent, desiredManifest, false, receipt);
    const desiredAuthority: OperationAuthority[] = [];
    for (const operation of desired.automatic) {
      desiredAuthority.push({
        operation,
        locator: (await this.options.adapter.receiptLocator?.(operation)) ?? null,
      });
    }
    await this.service(undefined, undefined, desired.userConfigAdoption).assertOwnedReceipt(
      receipt,
    );
    await this.options.adapter.authorizeOwnedOperations(receipt, desiredAuthority);
    const priorRegistrations = priorIntent.runtimeRegistrations.registrations.filter(
      (registration) => registration.runtime === 'pi',
    );
    if (priorRegistrations.length !== requested.length) {
      fail('INSTALL_CURRENT_UNVERIFIED', 'Installed Pi registrations disagree with setup.');
    }
    const locators = receipt.operationLocators
      .filter(
        (locator) =>
          locator.operationId.startsWith('50-pi-settings-') ||
          (locator.spec as { kind?: unknown } | null)?.kind === 'pi-settings',
      )
      .map((locator) => ({ locator, settings: parsePiSettingsLocator(locator.spec) }));
    for (const registration of requested) {
      const prior = priorRegistrations.find(
        (candidate) =>
          candidate.identity === registration.identity &&
          candidate.domain === registration.domain &&
          candidate.nativeRootDigest === registration.nativeRootDigest,
      );
      if (!prior) {
        fail('INSTALL_CURRENT_UNVERIFIED', 'Installed Pi root registration disagrees with setup.');
      }
      const owned = locators.filter(({ settings }) =>
        settings.bindings.some(
          (binding) =>
            binding.identity === prior.identity &&
            binding.domain === prior.domain &&
            binding.nativeRootDigest === prior.nativeRootDigest,
        ),
      );
      const owner = owned[0];
      const operation = receipt.operations.find(
        (candidate) => candidate.id === owner?.locator.operationId,
      );
      if (
        owned.length !== 1 ||
        !owner ||
        operation?.action !== 'ensure' ||
        owner.settings.currentRelease.releaseKey !== receipt.releaseKey ||
        owner.settings.currentRelease.registrationDigest !== installerDigest(prior.nativePackage)
      ) {
        fail('INSTALL_CURRENT_UNVERIFIED', 'Pi settings ownership is incomplete or inconsistent.');
      }
      const releaseRoot = path.join(
        this.options.releases.appsRoot,
        'mpx',
        'releases',
        receipt.releaseKey,
      );
      const desiredSource = resolvePiNativePackageSource(releaseRoot, PI_NATIVE_PACKAGE_ROOT);
      const root = observed.piRoots.find(
        (candidate) => candidate.identity === registration.identity,
      )!;
      const inventory = planPiNativePackageSettings({
        settings: root.settings,
        releaseRoot,
        desiredSource,
        nativePackage: prior.nativePackage,
        priorOwnedSources: [],
      });
      if (
        inventory.priorOwnedEntries.length !== 1 ||
        inventory.priorOwnedEntries[0]?.source !== desiredSource ||
        inventory.beforeDigest !== inventory.afterDigest ||
        inventory.afterDigest !== operation.desiredDigest
      ) {
        fail(
          'INSTALL_CURRENT_UNVERIFIED',
          'Pi settings must contain exactly one owned canonical package.',
        );
      }
    }
    return {
      status: 'current',
      digest: installerDigest({
        intent,
        receipt,
        transaction: transaction ?? null,
        selectedReleaseKey: observed.selectedReleaseKey,
        roots: observed.piRoots.map(({ settings, ...binding }) => ({
          ...binding,
          packages: parsePiSettings(settings).packages ?? [],
        })),
      }),
    };
  }

  async admitCurrentInstallation(
    intentValue: InstallIntent,
    probe: CurrentInstallationProbe,
  ): Promise<CurrentInstallationAdmission> {
    const intent = parseInstallIntent(intentValue);
    return this.options.store.exclusive(async () => {
      // Recovery owns its existing lock; classification must inspect the restored state.
      await this.recoverPending();
      const admission = await this.classifyInstallation(intent, probe);
      this.admissions.set(admission, { intentDigest: installerDigest(intent), probe });
      return admission;
    });
  }

  private async assertAdmission(
    intent: InstallIntent,
    admission: CurrentInstallationAdmission,
  ): Promise<void> {
    const authority = this.admissions.get(admission);
    if (!authority || authority.intentDigest !== installerDigest(intent)) {
      fail('INSTALL_PLAN_STALE', 'Setup admission is unavailable or belongs to another intent.');
    }
    const actual = await this.classifyInstallation(intent, authority.probe);
    if (actual.status !== admission.status || actual.digest !== admission.digest) {
      fail('INSTALL_PLAN_STALE', 'Installation changed after setup admission.');
    }
  }

  async plan(
    intent: InstallIntent,
    admission?: CurrentInstallationAdmission,
  ): Promise<InstallPlan> {
    return this.options.store.exclusive(async () => {
      if (admission) {
        await this.assertAdmission(intent, admission);
      } else {
        await this.recoverPending();
      }
      const receipt = await this.options.store.readReceipt();
      const current = await this.current(intent, receipt);
      const priorReceipt = await this.validatedReceipt(current.userConfigAdoption);
      const base = await this.service(current.manifest, undefined, current.userConfigAdoption).plan(
        current.intent,
        current.operations,
        priorReceipt,
      );
      const upgrade =
        priorReceipt && priorReceipt.releaseKey !== current.intent.releaseKey
          ? {
              id: RELEASE_UPGRADE_ID,
              planDigest: installerDigest(priorReceipt),
              verifierRef: 'installer:ownership-release-upgrade',
            }
          : undefined;
      if (!current.classifications && !upgrade && !admission) {
        return base;
      }
      const classifications: InstallOperationClassifications = current.classifications ?? {
        automatic: base.operations.map((operation) => operation.id),
        confirmationRequired: [],
      };
      const upgradeBound = upgrade
        ? {
            ...classifications,
            confirmationRequired: [...classifications.confirmationRequired, upgrade],
          }
        : classifications;
      const admissionBound = admission
        ? {
            ...upgradeBound,
            confirmationRequired: [
              ...upgradeBound.confirmationRequired,
              {
                id: CURRENT_INSTALLATION_ID,
                planDigest: admission.digest,
                verifierRef: 'installer:setup-current-installation',
              },
            ],
          }
        : upgradeBound;
      const classified = {
        schemaVersion: base.schemaVersion,
        kind: base.kind,
        intent: base.intent,
        observations: base.observations,
        operations: base.operations,
        classifications: admissionBound,
      };
      const plan = parseInstallPlan({
        ...classified,
        confirmationDigest: installerDigest(classified),
      });
      if (admission) {
        this.admittedPlans.set(plan.confirmationDigest, admission);
      }
      return plan;
    });
  }
  async apply(planValue: InstallPlan, confirmation: string): Promise<OwnershipReceipt> {
    const plan = parseInstallPlan(planValue);
    if (confirmation !== plan.confirmationDigest) {
      fail('INSTALL_CONFIRMATION_MISMATCH', 'Exact plan confirmation is required.');
    }
    const admissionReference = plan.classifications?.confirmationRequired.find(
      (reference) => reference.id === CURRENT_INSTALLATION_ID,
    );
    const admission = this.admittedPlans.get(plan.confirmationDigest);
    if (admissionReference && (!admission || admission.digest !== admissionReference.planDigest)) {
      fail('INSTALL_PLAN_STALE', 'Setup admission authority is unavailable.');
    }
    if (admission) {
      await this.assertAdmission(plan.intent, admission);
    }
    const receiptBeforeApply = await this.options.store.readReceipt();
    const current = await this.current(plan.intent, receiptBeforeApply);
    const priorReceipt = await this.validatedReceipt(current.userConfigAdoption);
    const upgradeReference = plan.classifications?.confirmationRequired.find(
      (reference) => reference.id === RELEASE_UPGRADE_ID,
    );
    let effectiveClassifications = current.classifications;
    if (upgradeReference) {
      if (
        !priorReceipt ||
        priorReceipt.releaseKey === plan.intent.releaseKey ||
        upgradeReference.planDigest !== installerDigest(priorReceipt)
      ) {
        fail('INSTALL_PLAN_STALE', 'Prior ownership receipt changed after upgrade planning.');
      }
      const baseClassifications = current.classifications ?? {
        automatic: current.operations.map((operation) => operation.id),
        confirmationRequired: [],
      };
      effectiveClassifications = {
        ...baseClassifications,
        confirmationRequired: [...baseClassifications.confirmationRequired, upgradeReference],
      };
    } else if (priorReceipt && priorReceipt.releaseKey !== plan.intent.releaseKey) {
      fail(
        'INSTALL_PLAN_STALE',
        'Release upgrade requires its confirmation-bound ownership receipt.',
      );
    }
    if (admissionReference) {
      const baseClassifications = effectiveClassifications ?? {
        automatic: current.operations.map((operation) => operation.id),
        confirmationRequired: [],
      };
      effectiveClassifications = {
        ...baseClassifications,
        confirmationRequired: [...baseClassifications.confirmationRequired, admissionReference],
      };
    }
    if (
      installerDigest(current.operations) !== installerDigest(plan.operations) ||
      installerDigest(effectiveClassifications ?? null) !==
        installerDigest(plan.classifications ?? null)
    ) {
      fail('INSTALL_PLAN_STALE', 'Install operations changed after planning.');
    }
    const revalidated = await this.service(
      current.manifest,
      undefined,
      current.userConfigAdoption,
    ).plan(current.intent, current.operations, priorReceipt);
    if (installerDigest(revalidated.observations) !== installerDigest(plan.observations)) {
      fail('INSTALL_OBSERVATION_CHANGED', 'Machine observations changed after planning.');
    }
    const manifest = admission
      ? current.manifest
      : await this.options.releases.publish(plan.intent.releaseKey);
    const service = this.service(
      manifest,
      admission
        ? async () => {
            await this.assertAdmission(plan.intent, admission);
            const lockedCurrent = await this.current(plan.intent, priorReceipt);
            if (installerDigest(lockedCurrent.operations) !== installerDigest(plan.operations)) {
              fail('INSTALL_PLAN_STALE', 'Install operations changed after setup admission.');
            }
            const published = await this.options.releases.publish(plan.intent.releaseKey);
            if (installerDigest(published) !== installerDigest(manifest)) {
              fail('INSTALL_PLAN_STALE', 'Release changed after setup admission.');
            }
          }
        : undefined,
      current.userConfigAdoption,
    );
    const receipt = await service.apply(plan, confirmation);
    let rollbackActivation: (() => Promise<void>) | undefined;
    try {
      await this.options.adapter.operations(plan.intent, manifest, true, receipt);
      const operationVerification = await service.verify();
      const releaseIssues = await this.options.releases.verify(receipt, false);
      if (!operationVerification.healthy || releaseIssues.length > 0) {
        fail(
          'INSTALL_POST_COMMIT_VERIFY_FAILED',
          'Committed installation failed actual-state verification; release was not activated.',
        );
      }
      rollbackActivation = await this.options.activate?.(
        receipt.releaseKey,
        priorReceipt?.releaseKey ?? null,
      );
      const activatedVerification = await service.verify();
      const activatedReleaseIssues = await this.options.releases.verify(receipt, false);
      if (!activatedVerification.healthy || activatedReleaseIssues.length > 0) {
        fail(
          'INSTALL_POST_ACTIVATION_VERIFY_FAILED',
          'Activated installation failed actual-state verification.',
        );
      }
      await service.finalize();
      return receipt;
    } catch (failure) {
      const rollbackFailures: unknown[] = [];
      if (rollbackActivation) {
        try {
          await rollbackActivation();
        } catch (rollbackFailure) {
          rollbackFailures.push(rollbackFailure);
        }
      }
      try {
        await service.rollback();
      } catch (rollbackFailure) {
        rollbackFailures.push(rollbackFailure);
      }
      if (rollbackFailures.length > 0) {
        throw aggregateInstallerFailure(
          failure,
          rollbackFailures,
          'Install failed and rollback also failed.',
        );
      }
      throw failure;
    }
  }
  async verify(strict = false): Promise<InstallVerification> {
    const receipt = await this.options.store.readReceipt();
    const base = await this.service().verify();
    const issues = [
      ...base.issues,
      ...(receipt ? await this.options.releases.verify(receipt, strict) : []),
    ].sort((a, b) => a.localeCompare(b));
    if (!receipt?.installIntent) {
      return { ...base, healthy: issues.length === 0, issues };
    }
    const runtimeIds =
      receipt.installIntent.runtimeRegistrations?.registrations.map(
        (registration) => registration.identity,
      ) ?? [];
    const components = ['system', ...runtimeIds].map((id) => ({
      id,
      automatic: true as const,
      status: issues.some((issue) =>
        id === 'system'
          ? !issue.includes('registration-') &&
            !runtimeIds.some((runtimeId) => issue.includes(runtimeId))
          : issue.includes(id),
      )
        ? ('unhealthy' as const)
        : ('actual-state-verified' as const),
    }));
    return { ...base, healthy: issues.length === 0, issues, components };
  }
}
