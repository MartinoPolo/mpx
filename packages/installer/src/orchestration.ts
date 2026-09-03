import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { MpxError } from '@mpx/core';
import {
  buildCurrentReleaseManifest,
  canonicalJson,
  parseInstallIntentV1,
  parseInstallPlanV1,
  publishCurrentRelease,
  type CurrentReleaseOptions,
  type InstallIntentV1,
  type InstallOperationV1,
  type InstallPlanV1,
  type InstallOperationClassificationsV1,
  type InstallVerificationV1,
  type OwnershipReceiptV1,
  type ReleaseManifestV1,
} from './immutable-core.js';
import {
  ImmutableInstallerService,
  installerDigest,
  type LegacyOwnershipReceiptV1,
  type SideEffectAdapter,
  type TransactionStore,
} from './transaction.js';
import {
  parseInstallExternalVerificationResultV1,
  type InstallExternalVerificationResultV1,
} from './install-intent-builder.js';
import { aggregateInstallerFailure } from './failure.js';

function fail(code: string, message: string): never {
  throw new MpxError({ code, message });
}
const missing = (failure: unknown): boolean => (failure as NodeJS.ErrnoException).code === 'ENOENT';

export interface InstallerOperationSet {
  readonly automatic: readonly InstallOperationV1[];
  readonly classifications?: InstallOperationClassificationsV1;
}
/** The host owns native details; orchestration only consumes ordered, reversible operations. */
export interface InstallerOperationAdapter extends SideEffectAdapter {
  operations(
    intent: InstallIntentV1,
    manifest: ReleaseManifestV1,
    requireActual?: boolean,
    priorReceipt?: OwnershipReceiptV1,
  ): Promise<InstallerOperationSet>;
}
export interface CurrentReleaseBuilder {
  readonly appsRoot: string;
  build(): Promise<ReleaseManifestV1>;
  publish(expectedReleaseKey: string): Promise<ReleaseManifestV1>;
  verify(receipt: OwnershipReceiptV1, strict: boolean): Promise<readonly string[]>;
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
  build(): Promise<ReleaseManifestV1> {
    return buildCurrentReleaseManifest(this.current);
  }
  async publish(expectedReleaseKey: string): Promise<ReleaseManifestV1> {
    const manifest = await publishCurrentRelease({ ...this.current, appsRoot: this.appsRoot });
    if (manifest.releaseKey !== expectedReleaseKey) {
      fail('INSTALL_PLAN_STALE', 'Current release changed after planning.');
    }
    return manifest;
  }
  async verify(receipt: OwnershipReceiptV1, strict: boolean): Promise<readonly string[]> {
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
  /** Removes the mutable stable selector only after owned resources uninstall. */
  readonly deactivate?: (releaseKey: string) => Promise<void>;
  readonly now?: () => Date;
}
export interface RollbackResultV1 {
  readonly schemaVersion: 1;
  readonly kind: 'install-rollback';
  readonly transactionId: string;
  readonly rolledBack: true;
}
export interface UninstallResultV1 {
  readonly schemaVersion: 1;
  readonly kind: 'install-uninstall';
  readonly releaseKey: string;
  readonly removed: true;
}

const RECEIPT_MIGRATION_ID = 'ownership-receipt-v1-migration';
const RELEASE_UPGRADE_ID = 'ownership-release-upgrade';
export class InstallOrchestrator {
  private readonly now: () => Date;
  constructor(private readonly options: InstallOrchestratorOptions) {
    this.now = options.now ?? (() => new Date());
  }
  private service(manifest?: ReleaseManifestV1): ImmutableInstallerService {
    return new ImmutableInstallerService({
      adapters: [this.options.adapter],
      store: this.options.store,
      ...(manifest ? { manifest } : {}),
      now: this.now,
    });
  }
  private async current(
    intentValue: InstallIntentV1,
    priorReceipt?: OwnershipReceiptV1,
  ): Promise<{
    intent: InstallIntentV1;
    manifest: ReleaseManifestV1;
    operations: readonly InstallOperationV1[];
    classifications?: InstallOperationClassificationsV1;
  }> {
    const intent = parseInstallIntentV1(intentValue),
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
    };
  }
  private async migratedReceipt(
    current: {
      intent: InstallIntentV1;
      manifest: ReleaseManifestV1;
      operations: readonly InstallOperationV1[];
    },
    legacy: LegacyOwnershipReceiptV1,
  ): Promise<OwnershipReceiptV1> {
    if (
      legacy.releaseKey !== current.manifest.releaseKey ||
      legacy.convergenceHash !== current.manifest.convergenceHash ||
      installerDigest(legacy.files) !== installerDigest(current.manifest.files) ||
      installerDigest(legacy.operations) !== installerDigest(current.operations)
    ) {
      fail(
        'INSTALL_RECEIPT_MIGRATION_UNSAFE',
        'Legacy ownership receipt is foreign or ambiguous; use manual recovery guidance before changing native state.',
      );
    }
    const operationLocators = [];
    for (const operation of current.operations) {
      const actual = await this.options.adapter.observe(operation);
      if (operation.action === 'ensure' ? actual !== operation.desiredDigest : actual !== null) {
        fail(
          'INSTALL_RECEIPT_MIGRATION_UNSAFE',
          `Legacy ownership target ${operation.id} is drifted; use manual recovery guidance before changing native state.`,
        );
      }
      const spec = (await this.options.adapter.receiptLocator?.(operation)) ?? null;
      operationLocators.push({
        operationId: operation.id,
        adapter: operation.adapter,
        spec,
        bindingDigest: installerDigest({ operation, spec }),
      });
    }
    const receipt: OwnershipReceiptV1 = {
      schemaVersion: 2,
      kind: 'ownership-receipt',
      releaseKey: legacy.releaseKey,
      convergenceHash: legacy.convergenceHash,
      files: legacy.files,
      operations: current.operations,
      operationLocators,
      installIntent: current.intent,
      installedAt: legacy.installedAt,
    };
    const releaseIssues = await this.options.releases.verify(receipt, false);
    if (releaseIssues.length) {
      fail(
        'INSTALL_RECEIPT_MIGRATION_UNSAFE',
        `Legacy release receipt is drifted (${releaseIssues.join(', ')}); use manual recovery guidance before changing native state.`,
      );
    }
    return receipt;
  }
  private async validatedReceipt(): Promise<OwnershipReceiptV1 | undefined> {
    const receipt = await this.options.store.readReceipt();
    if (!receipt) {
      return undefined;
    }
    const releaseIssues = await this.options.releases.verify(receipt, false);
    if (releaseIssues.length) {
      fail('INSTALL_FOREIGN_OR_DRIFTED', `Owned release is drifted (${releaseIssues.join(', ')}).`);
    }
    await this.service().assertOwnedReceipt(receipt);
    return receipt;
  }
  async plan(intent: InstallIntentV1): Promise<InstallPlanV1> {
    const legacy = await this.options.store.readLegacyReceiptForMigration();
    const priorReceipt = legacy ? undefined : await this.validatedReceipt();
    const current = await this.current(intent, priorReceipt);
    const migration = legacy ? await this.migratedReceipt(current, legacy) : undefined;
    const base = await this.service(current.manifest).plan(
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
    if (!current.classifications && !migration && !upgrade) {
      return base;
    }
    const classifications: InstallOperationClassificationsV1 = current.classifications ?? {
      automatic: base.operations.map((operation) => operation.id),
      confirmationRequired: [],
      manualOnly: [],
    };
    const merged = migration
      ? {
          ...classifications,
          confirmationRequired: [
            ...classifications.confirmationRequired,
            {
              id: RECEIPT_MIGRATION_ID,
              planDigest: installerDigest(migration),
              verifierRef: 'installer:ownership-receipt-v2',
            },
          ],
        }
      : classifications;
    const upgradeBound = upgrade
      ? { ...merged, confirmationRequired: [...merged.confirmationRequired, upgrade] }
      : merged;
    const classified = {
      schemaVersion: base.schemaVersion,
      kind: base.kind,
      intent: base.intent,
      observations: base.observations,
      operations: base.operations,
      classifications: upgradeBound,
    };
    return parseInstallPlanV1({ ...classified, confirmationDigest: installerDigest(classified) });
  }
  async apply(planValue: InstallPlanV1, confirmation: string): Promise<OwnershipReceiptV1> {
    const plan = parseInstallPlanV1(planValue);
    if (confirmation !== plan.confirmationDigest) {
      fail('INSTALL_CONFIRMATION_MISMATCH', 'Exact plan confirmation is required.');
    }
    const legacyBeforeApply = await this.options.store.readLegacyReceiptForMigration();
    const priorReceipt = legacyBeforeApply ? undefined : await this.validatedReceipt();
    const current = await this.current(plan.intent, priorReceipt);
    const upgradeReference = plan.classifications?.confirmationRequired.find(
        (reference) => reference.id === RELEASE_UPGRADE_ID,
      ),
      migrationReference = plan.classifications?.confirmationRequired.find(
        (reference) => reference.id === RECEIPT_MIGRATION_ID,
      ),
      legacy = legacyBeforeApply;
    let effectiveClassifications = current.classifications;
    if (migrationReference) {
      if (!legacy) {
        fail(
          'INSTALL_PLAN_STALE',
          'Legacy ownership receipt was already migrated or changed after planning.',
        );
      }
      const migrated = await this.migratedReceipt(current, legacy);
      if (migrationReference.planDigest !== installerDigest(migrated)) {
        fail('INSTALL_PLAN_STALE', 'Legacy ownership migration changed after planning.');
      }
      await this.options.store.exclusive(async () => {
        const lockedLegacy = await this.options.store.readLegacyReceiptForMigration();
        if (!lockedLegacy || installerDigest(lockedLegacy) !== installerDigest(legacy)) {
          fail('INSTALL_PLAN_STALE', 'Legacy ownership receipt changed after planning.');
        }
        await this.options.store.writeReceipt(migrated);
      });
      const baseClassifications = current.classifications ?? {
        automatic: current.operations.map((operation) => operation.id),
        confirmationRequired: [],
        manualOnly: [],
      };
      effectiveClassifications = {
        ...baseClassifications,
        confirmationRequired: [...baseClassifications.confirmationRequired, migrationReference],
      };
    } else if (legacy) {
      fail(
        'INSTALL_RECEIPT_MIGRATION_REQUIRED',
        'Ownership receipt schema v1 requires its confirmation-bound migration plan.',
      );
    }
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
        manualOnly: [],
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
    if (
      installerDigest(current.operations) !== installerDigest(plan.operations) ||
      installerDigest(effectiveClassifications ?? null) !==
        installerDigest(plan.classifications ?? null)
    ) {
      fail('INSTALL_PLAN_STALE', 'Install operations changed after planning.');
    }
    const revalidated = await this.service(current.manifest).plan(
      current.intent,
      current.operations,
      priorReceipt,
    );
    if (installerDigest(revalidated.observations) !== installerDigest(plan.observations)) {
      fail('INSTALL_OBSERVATION_CHANGED', 'Machine observations changed after planning.');
    }
    const manifest = await this.options.releases.publish(plan.intent.releaseKey);
    const service = this.service(manifest);
    const receipt = await service.apply(plan, confirmation);
    let rollbackActivation: (() => Promise<void>) | undefined;
    try {
      await this.options.adapter.operations(plan.intent, manifest, true);
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
  async verify(
    strict = false,
    externalSource?:
      InstallExternalVerificationResultV1 | (() => Promise<InstallExternalVerificationResultV1>),
  ): Promise<InstallVerificationV1> {
    const receipt = await this.options.store.readReceipt();
    const base = await this.service().verify();
    const issues = [
      ...base.issues,
      ...(receipt ? await this.options.releases.verify(receipt, strict) : []),
    ];
    if (!receipt?.installIntent) {
      issues.sort((a, b) => a.localeCompare(b));
      return { ...base, healthy: issues.length === 0, issues };
    }
    const automaticIssues = [...issues];
    const expectedExternal = receipt.installIntent.externalIntegrations ?? [];
    const supplied =
      expectedExternal.length > 0 && externalSource
        ? parseInstallExternalVerificationResultV1(
            typeof externalSource === 'function' ? await externalSource() : externalSource,
          )
        : undefined;
    const suppliedById = new Map(supplied?.integrations.map((item) => [item.id, item]) ?? []);
    const externalIntegrations = expectedExternal.map((integration) => {
      const live = suppliedById.get(integration.id);
      const matching =
        live?.adapter === integration.adapter &&
        live.planDigest === integration.planDigest &&
        live.verifierRef === integration.verifierRef;
      if (!matching) {
        issues.push(`external-verification-required:${integration.id}`);
        return {
          id: integration.id,
          classification: integration.classification,
          status: 'verification-required' as const,
          verifierRef: integration.verifierRef,
        };
      }
      if (!live.healthy) {
        for (const issue of live.issues) {
          issues.push(`external-verification:${integration.id}:${issue}`);
        }
        return {
          id: integration.id,
          classification: integration.classification,
          status: 'unhealthy' as const,
          verifierRef: integration.verifierRef,
        };
      }
      return {
        id: integration.id,
        classification: integration.classification,
        status: 'verified' as const,
        verifierRef: integration.verifierRef,
      };
    });
    issues.sort((a, b) => a.localeCompare(b));
    const runtimeIds =
      receipt.installIntent.runtimeRegistrations?.registrations.map(
        (registration) => registration.identity,
      ) ?? [];
    const components = ['system', ...runtimeIds].map((id) => ({
      id,
      automatic: true as const,
      status: automaticIssues.some((issue) =>
        id === 'system'
          ? !issue.includes('registration-') &&
            !runtimeIds.some((runtimeId) => issue.includes(runtimeId))
          : issue.includes(id),
      )
        ? ('unhealthy' as const)
        : ('actual-state-verified' as const),
    }));
    return {
      ...base,
      healthy: issues.length === 0,
      issues,
      components,
      externalIntegrations,
      manualOnly: externalIntegrations
        .filter((item) => item.classification === 'manual-only')
        .map((item) => item.id),
    };
  }
  async rollback(transactionId: string, confirmation: string): Promise<RollbackResultV1> {
    const stored = await this.options.store.readTransaction();
    if (!stored || stored.journal.transactionId !== transactionId) {
      fail('INSTALL_TRANSACTION_UNAVAILABLE', 'Transaction is unavailable.');
    }
    if (confirmation !== installerDigest(stored.journal.snapshot)) {
      fail('INSTALL_CONFIRMATION_MISMATCH', 'Exact transaction confirmation is required.');
    }
    await this.service().rollback();
    return { schemaVersion: 1, kind: 'install-rollback', transactionId, rolledBack: true };
  }
  async planUninstall(): Promise<InstallPlanV1> {
    return this.service().planUninstall();
  }
  async uninstall(confirmation: string): Promise<UninstallResultV1> {
    const plan = await this.planUninstall();
    await this.service().uninstall(plan, confirmation);
    await this.options.deactivate?.(plan.intent.releaseKey);
    return {
      schemaVersion: 1,
      kind: 'install-uninstall',
      releaseKey: plan.intent.releaseKey,
      removed: true,
    };
  }
}
