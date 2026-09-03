import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MpxError, parseStrictJson } from '@mpx/core';
import {
  acquireAtomicOwnerLock,
  installerDigest,
  parseInstallIntentV1,
  parseInstallPlanV1,
  parseInstallOperationV1,
  parseMachineSnapshotV1,
  parseReleaseManifestV1,
  parseOwnershipReceiptV1,
  type InstallIntentV1,
  type InstallOperationLocatorV1,
  type InstallOperationV1,
  type InstallPlanV1,
  type InstallVerificationV1,
  type MachineObservationV1,
  type MachineSnapshotV1,
  type OwnershipReceiptV1,
  type ReleaseManifestV1,
  type TransactionJournalV1,
} from './immutable-core.js';
import { aggregateInstallerFailure } from './failure.js';
export { installerDigest } from './immutable-core.js';
export type { InstallIntentV1, InstallOperationV1 } from './immutable-core.js';

function fail(code: string, message: string): never {
  throw new MpxError({ code, message });
}
export interface SideEffectAdapter {
  readonly name: string;
  observe(operation: InstallOperationV1): Promise<string | null>;
  capture(operation: InstallOperationV1): Promise<string | null>;
  apply(operation: InstallOperationV1): Promise<void>;
  restore(operation: InstallOperationV1, snapshot: string | null): Promise<void>;
  receiptLocator?(operation: InstallOperationV1): Promise<unknown>;
  hydrateReceiptOperation?(operation: InstallOperationV1, locator: unknown): Promise<void>;
  /** Fail-closed retention decision, consulted only after durable locator hydration. */
  retainOnUninstall?(operation: InstallOperationV1): Promise<boolean>;
}
export interface StoredTransaction {
  journal: TransactionJournalV1;
  snapshots: Readonly<Record<string, string | null>>;
  operations: readonly InstallOperationV1[];
  priorReceipt?: OwnershipReceiptV1;
}
function durableSnapshots(
  snapshots: Readonly<Record<string, string | null>>,
  journal: TransactionJournalV1,
): Record<string, string | null> {
  const ids = [
    ...journal.completedOperationIds,
    ...(journal.inFlightOperationId ? [journal.inFlightOperationId] : []),
  ];
  return Object.fromEntries(ids.map((id) => [id, snapshots[id] ?? null]));
}
export interface LegacyOwnershipReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: 'ownership-receipt';
  readonly releaseKey: string;
  readonly convergenceHash: string;
  readonly files: OwnershipReceiptV1['files'];
  readonly operations: readonly InstallOperationV1[];
  readonly installedAt: string;
}
function parseLegacyOwnershipReceiptForMigration(value: unknown): LegacyOwnershipReceiptV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'INSTALL_RECEIPT_MIGRATION_UNSAFE',
      'Legacy ownership receipt is unknown or ambiguous; use manual recovery guidance before changing native state.',
    );
  }
  const source = value as Record<string, unknown>,
    keys = [
      'schemaVersion',
      'kind',
      'releaseKey',
      'convergenceHash',
      'files',
      'operations',
      'installedAt',
    ];
  if (
    Object.keys(source).sort().join('\0') !== keys.sort().join('\0') ||
    source.schemaVersion !== 1 ||
    source.kind !== 'ownership-receipt' ||
    !Array.isArray(source.operations) ||
    typeof source.installedAt !== 'string' ||
    !Number.isFinite(Date.parse(source.installedAt))
  ) {
    fail(
      'INSTALL_RECEIPT_MIGRATION_UNSAFE',
      'Legacy ownership receipt is unknown or ambiguous; use manual recovery guidance before changing native state.',
    );
  }
  try {
    const manifest = parseReleaseManifestV1({
      schemaVersion: 1,
      kind: 'release-manifest',
      releaseKey: source.releaseKey,
      convergenceHash: source.convergenceHash,
      files: source.files,
    });
    const operations = source.operations.map(parseInstallOperationV1);
    if (
      new Set(operations.map((operation) => operation.id)).size !== operations.length ||
      operations.some(
        (operation, index) =>
          index > 0 && operations[index - 1]!.id.localeCompare(operation.id) >= 0,
      )
    ) {
      throw new Error();
    }
    return {
      schemaVersion: 1,
      kind: 'ownership-receipt',
      releaseKey: manifest.releaseKey,
      convergenceHash: manifest.convergenceHash,
      files: manifest.files,
      operations,
      installedAt: source.installedAt,
    };
  } catch {
    fail(
      'INSTALL_RECEIPT_MIGRATION_UNSAFE',
      'Legacy ownership receipt is forged or ambiguous; use manual recovery guidance before changing native state.',
    );
  }
}
export interface TransactionStore {
  readReceipt(): Promise<OwnershipReceiptV1 | undefined>;
  /** Bounded compatibility seam used only by the explicit v1-to-v2 migration. */
  readLegacyReceiptForMigration(): Promise<LegacyOwnershipReceiptV1 | undefined>;
  writeReceipt(receipt: OwnershipReceiptV1): Promise<void>;
  removeReceipt(): Promise<void>;
  writeTransaction(value: StoredTransaction): Promise<void>;
  readTransaction(): Promise<StoredTransaction | undefined>;
  removeTransaction(): Promise<void>;
  exclusive<T>(action: () => Promise<T>): Promise<T>;
}
export class MemoryTransactionStore implements TransactionStore {
  private receipt: OwnershipReceiptV1 | LegacyOwnershipReceiptV1 | undefined;
  private transaction: StoredTransaction | undefined;
  private tail: Promise<void> = Promise.resolve();
  async readReceipt() {
    if (this.receipt?.schemaVersion === 1) {
      fail(
        'INSTALL_RECEIPT_MIGRATION_REQUIRED',
        'Ownership receipt schema v1 requires a confirmed migration; use the install plan or manual recovery guidance.',
      );
    }
    return this.receipt && structuredClone(this.receipt);
  }
  async readLegacyReceiptForMigration() {
    return this.receipt?.schemaVersion === 1 ? structuredClone(this.receipt) : undefined;
  }
  async writeLegacyReceiptForMigration(value: unknown) {
    this.receipt = structuredClone(parseLegacyOwnershipReceiptForMigration(value));
  }
  async writeReceipt(value: OwnershipReceiptV1) {
    this.receipt = structuredClone(value);
  }
  async removeReceipt() {
    this.receipt = undefined;
  }
  async writeTransaction(value: StoredTransaction) {
    this.transaction = structuredClone(value);
  }
  async readTransaction() {
    return this.transaction && structuredClone(this.transaction);
  }
  async removeTransaction() {
    this.transaction = undefined;
  }
  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

/** Durable, atomic installer state. The directory is private and never contains credentials. */
export class NodeTransactionStore implements TransactionStore {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}
  private file(name: string): string {
    return path.join(this.directory, name);
  }
  private async atomic(name: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await chmod(this.directory, 0o700);
    }
    const target = this.file(name),
      temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      if (process.platform !== 'win32') {
        await chmod(temporary, 0o600);
      }
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private async read(name: string): Promise<unknown | undefined> {
    try {
      return parseStrictJson(await readFile(this.file(name), 'utf8'));
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw failure;
    }
  }
  async readReceipt(): Promise<OwnershipReceiptV1 | undefined> {
    const value = await this.read('receipt.json');
    if ((value as { schemaVersion?: unknown } | undefined)?.schemaVersion === 1) {
      fail(
        'INSTALL_RECEIPT_MIGRATION_REQUIRED',
        'Ownership receipt schema v1 requires a confirmed migration; use the install plan or manual recovery guidance.',
      );
    }
    return value === undefined ? undefined : parseOwnershipReceiptV1(value);
  }
  async readLegacyReceiptForMigration(): Promise<LegacyOwnershipReceiptV1 | undefined> {
    const value = await this.read('receipt.json');
    return (value as { schemaVersion?: unknown } | undefined)?.schemaVersion === 1
      ? parseLegacyOwnershipReceiptForMigration(value)
      : undefined;
  }
  async writeReceipt(value: OwnershipReceiptV1): Promise<void> {
    await this.atomic('receipt.json', parseOwnershipReceiptV1(value));
  }
  async removeReceipt(): Promise<void> {
    await rm(this.file('receipt.json'), { force: true });
  }
  async readTransaction(): Promise<StoredTransaction | undefined> {
    let value: unknown | undefined;
    try {
      value = await this.read('transaction.json');
    } catch {
      await this.quarantineTransaction();
      fail('INSTALL_TRANSACTION_INVALID', 'Transaction state is invalid.');
    }
    if (value === undefined) {
      return undefined;
    }
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error();
      }
      const source = value as Record<string, unknown>,
        hasPrior = Object.prototype.hasOwnProperty.call(source, 'priorReceipt');
      if (
        Object.keys(source).sort().join('\0') !==
        ['journal', 'snapshots', 'operations', ...(hasPrior ? ['priorReceipt'] : [])]
          .sort()
          .join('\0')
      ) {
        throw new Error();
      }
      if (
        !Array.isArray(source.operations) ||
        !source.snapshots ||
        typeof source.snapshots !== 'object' ||
        Array.isArray(source.snapshots)
      ) {
        throw new Error();
      }
      const operations = source.operations.map(parseInstallOperationV1);
      if (
        new Set(operations.map((item) => item.id)).size !== operations.length ||
        operations.some(
          (item, index) => index > 0 && operations[index - 1]!.id.localeCompare(item.id) >= 0,
        )
      ) {
        throw new Error();
      }
      const journalSource = source.journal as Record<string, unknown> | null,
        hasInFlight = Boolean(
          journalSource &&
          Object.prototype.hasOwnProperty.call(journalSource, 'inFlightOperationId'),
        );
      if (
        !journalSource ||
        Array.isArray(journalSource) ||
        Object.keys(journalSource).sort().join('\0') !==
          [
            'schemaVersion',
            'kind',
            'transactionId',
            'phase',
            'completedOperationIds',
            'snapshot',
            ...(hasInFlight ? ['inFlightOperationId'] : []),
          ]
            .sort()
            .join('\0')
      ) {
        throw new Error();
      }
      if (
        journalSource.schemaVersion !== 1 ||
        journalSource.kind !== 'transaction-journal' ||
        typeof journalSource.transactionId !== 'string' ||
        !journalSource.transactionId ||
        !['applying', 'committed', 'rolled-back'].includes(journalSource.phase as string) ||
        !Array.isArray(journalSource.completedOperationIds) ||
        journalSource.completedOperationIds.some((id) => typeof id !== 'string')
      ) {
        throw new Error();
      }
      const operationIds = new Set(operations.map((item) => item.id)),
        completed = journalSource.completedOperationIds as string[];
      if (
        new Set(completed).size !== completed.length ||
        completed.some((id) => !operationIds.has(id))
      ) {
        throw new Error();
      }
      const inFlight = journalSource.inFlightOperationId;
      if (
        hasInFlight &&
        (typeof inFlight !== 'string' ||
          !operationIds.has(inFlight) ||
          completed.includes(inFlight) ||
          journalSource.phase !== 'applying')
      ) {
        throw new Error();
      }
      const snapshot = parseMachineSnapshotV1(journalSource.snapshot);
      if (
        snapshot.transactionId !== journalSource.transactionId ||
        snapshot.observations.length !== operations.length ||
        snapshot.observations.some((observation, index) => observation.id !== operations[index]!.id)
      ) {
        throw new Error();
      }
      const eligible = operations
        .filter((operation, index) => {
          const digest = snapshot.observations[index]!.digest;
          return !(
            (operation.action === 'ensure' && digest === operation.desiredDigest) ||
            (operation.action === 'remove' && digest === null)
          );
        })
        .map((operation) => operation.id);
      if (
        completed.some((id, index) => id !== eligible[index]) ||
        (hasInFlight && inFlight !== eligible[completed.length]) ||
        (journalSource.phase === 'committed' && completed.length !== eligible.length)
      ) {
        throw new Error();
      }
      const mutated = [...completed, ...(hasInFlight ? [inFlight as string] : [])];
      const snapshots = source.snapshots as Record<string, unknown>;
      if (
        Object.keys(snapshots).sort().join('\0') !== [...mutated].sort().join('\0') ||
        Object.values(snapshots).some((item) => item !== null && typeof item !== 'string')
      ) {
        throw new Error();
      }
      const priorReceipt = hasPrior ? parseOwnershipReceiptV1(source.priorReceipt) : undefined;
      return {
        journal: {
          schemaVersion: 1,
          kind: 'transaction-journal',
          transactionId: journalSource.transactionId,
          phase: journalSource.phase as TransactionJournalV1['phase'],
          completedOperationIds: completed,
          ...(hasInFlight ? { inFlightOperationId: inFlight as string } : {}),
          snapshot,
        },
        snapshots: snapshots as Record<string, string | null>,
        operations,
        ...(priorReceipt ? { priorReceipt } : {}),
      };
    } catch {
      await this.quarantineTransaction();
      fail('INSTALL_TRANSACTION_INVALID', 'Transaction state is invalid.');
    }
  }
  private async quarantineTransaction(): Promise<void> {
    try {
      await rename(
        this.file('transaction.json'),
        this.file(`transaction.corrupt.${Date.now()}.${randomUUID()}.json`),
      );
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw failure;
      }
    }
  }
  async writeTransaction(value: StoredTransaction): Promise<void> {
    await this.atomic('transaction.json', value);
  }
  async removeTransaction(): Promise<void> {
    await rm(this.file('transaction.json'), { force: true });
  }
  private async acquireProcessLock(): Promise<() => Promise<void>> {
    return acquireAtomicOwnerLock(
      this.file('transaction.lock'),
      'INSTALL_TRANSACTION_LOCKED',
      'Another installer transaction owns the machine lock.',
    );
  }
  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let releaseLocal!: () => void;
    this.tail = new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });
    await previous;
    let releaseProcess: (() => Promise<void>) | undefined, result: T | undefined, primary: unknown;
    try {
      releaseProcess = await this.acquireProcessLock();
      result = await action();
    } catch (failure) {
      primary = failure;
    } finally {
      let releaseFailure: unknown;
      try {
        await releaseProcess?.();
      } catch (failure) {
        releaseFailure = failure;
      } finally {
        releaseLocal();
      }
      if (primary !== undefined && releaseFailure !== undefined) {
        // eslint-disable-next-line no-unsafe-finally -- cleanup outcome intentionally determines the reported failure.
        throw aggregateInstallerFailure(
          primary,
          [releaseFailure],
          'Installer transaction and process-lock release both failed.',
        );
      }
      if (releaseFailure !== undefined) {
        // eslint-disable-next-line no-unsafe-finally -- cleanup outcome intentionally determines the reported failure.
        throw releaseFailure;
      }
    }
    if (primary !== undefined) {
      throw primary;
    }
    return result as T;
  }
}
export interface ImmutableInstallerServiceOptions {
  readonly adapters: readonly SideEffectAdapter[];
  readonly store: TransactionStore;
  readonly manifest?: ReleaseManifestV1;
  readonly now?: () => Date;
  readonly failureInjection?: (operationId: string, index: number) => void;
}
export class ImmutableInstallerService {
  private readonly adapters: Map<string, SideEffectAdapter>;
  private readonly now: () => Date;
  constructor(private readonly options: ImmutableInstallerServiceOptions) {
    this.adapters = new Map(options.adapters.map((x) => [x.name, x]));
    if (this.adapters.size !== options.adapters.length) {
      fail('INSTALL_ADAPTER_DUPLICATE', 'Side effect adapter names must be unique.');
    }
    this.now = options.now ?? (() => new Date());
  }
  private adapter(name: string): SideEffectAdapter {
    return (
      this.adapters.get(name) ??
      fail('INSTALL_ADAPTER_UNAVAILABLE', `Side effect adapter ${name} is unavailable.`)
    );
  }
  async plan(
    intentValue: InstallIntentV1,
    requested: readonly InstallOperationV1[],
  ): Promise<InstallPlanV1> {
    const intent = parseInstallIntentV1(intentValue);
    const operations = [...requested].sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(operations.map((x) => x.id)).size !== operations.length) {
      fail('INSTALL_OPERATION_DUPLICATE', 'Operation IDs must be unique.');
    }
    const observations: MachineObservationV1[] = [];
    for (const operation of operations) {
      observations.push({
        id: operation.id,
        digest: await this.adapter(operation.adapter).observe(operation),
      });
    }
    const base = {
      schemaVersion: 1 as const,
      kind: 'install-plan' as const,
      intent,
      observations,
      operations,
    };
    return parseInstallPlanV1({ ...base, confirmationDigest: installerDigest(base) });
  }
  private async assertCurrent(plan: InstallPlanV1): Promise<void> {
    for (let index = 0; index < plan.operations.length; index++) {
      const operation = plan.operations[index]!,
        expected = plan.observations[index]!;
      if (
        expected.id !== operation.id ||
        (await this.adapter(operation.adapter).observe(operation)) !== expected.digest
      ) {
        fail('INSTALL_OBSERVATION_CHANGED', `Observation changed for ${operation.id}.`);
      }
    }
  }
  async apply(planValue: InstallPlanV1, confirmation: string): Promise<OwnershipReceiptV1> {
    const plan = parseInstallPlanV1(planValue);
    if (confirmation !== plan.confirmationDigest) {
      fail('INSTALL_CONFIRMATION_MISMATCH', 'Exact plan confirmation is required.');
    }
    return this.options.store.exclusive(async () => {
      await this.recover();
      await this.assertCurrent(plan);
      const priorReceipt = await this.options.store.readReceipt();
      if (
        priorReceipt &&
        (priorReceipt.releaseKey !== plan.intent.releaseKey ||
          installerDigest(priorReceipt.operations) !== installerDigest(plan.operations))
      ) {
        fail('INSTALL_OWNERSHIP_MISMATCH', 'Existing ownership differs from the plan.');
      }
      const snapshots: Record<string, string | null> = {};
      for (const operation of plan.operations) {
        snapshots[operation.id] = await this.adapter(operation.adapter).capture(operation);
      }
      const snapshot: MachineSnapshotV1 = {
        schemaVersion: 1,
        kind: 'machine-snapshot',
        transactionId: randomUUID(),
        observations: plan.observations,
        capturedAt: this.now().toISOString(),
      };
      let journal: TransactionJournalV1 = {
        schemaVersion: 1,
        kind: 'transaction-journal',
        transactionId: snapshot.transactionId,
        phase: 'applying',
        completedOperationIds: [],
        snapshot,
      };
      await this.options.store.writeTransaction({
        journal,
        snapshots: {},
        operations: plan.operations,
        ...(priorReceipt ? { priorReceipt } : {}),
      });
      try {
        for (let index = 0; index < plan.operations.length; index++) {
          const operation = plan.operations[index]!,
            observation = plan.observations[index]!;
          if (
            !(operation.action === 'ensure' && observation.digest === operation.desiredDigest) &&
            !(operation.action === 'remove' && observation.digest === null)
          ) {
            const inFlightJournal = { ...journal, inFlightOperationId: operation.id };
            await this.options.store.writeTransaction({
              journal: inFlightJournal,
              snapshots: durableSnapshots(snapshots, inFlightJournal),
              operations: plan.operations,
              ...(priorReceipt ? { priorReceipt } : {}),
            });
            journal = inFlightJournal;
            await this.adapter(operation.adapter).apply(operation);
            this.options.failureInjection?.(operation.id, index);
            const { inFlightOperationId: _inFlightOperationId, ...completedJournal } = journal;
            journal = {
              ...completedJournal,
              completedOperationIds: [...journal.completedOperationIds, operation.id],
            };
            await this.options.store.writeTransaction({
              journal,
              snapshots: durableSnapshots(snapshots, journal),
              operations: plan.operations,
              ...(priorReceipt ? { priorReceipt } : {}),
            });
          }
        }
        const manifest = this.options.manifest;
        if (
          !priorReceipt &&
          (!manifest ||
            manifest.releaseKey !== plan.intent.releaseKey ||
            manifest.convergenceHash !== plan.intent.convergenceHash)
        ) {
          fail(
            'INSTALL_RELEASE_MANIFEST_REQUIRED',
            'Exact release manifest is required for ownership.',
          );
        }
        const operationLocators: InstallOperationLocatorV1[] = [];
        for (const operation of plan.operations) {
          const spec = (await this.adapter(operation.adapter).receiptLocator?.(operation)) ?? null;
          operationLocators.push({
            operationId: operation.id,
            adapter: operation.adapter,
            spec,
            bindingDigest: installerDigest({ operation, spec }),
          });
        }
        const receipt: OwnershipReceiptV1 = priorReceipt ?? {
          schemaVersion: 2,
          kind: 'ownership-receipt',
          releaseKey: plan.intent.releaseKey,
          convergenceHash: plan.intent.convergenceHash,
          files: manifest!.files,
          operations: plan.operations,
          operationLocators,
          installIntent: plan.intent,
          installedAt: this.now().toISOString(),
        };
        await this.options.store.writeReceipt(receipt);
        journal = { ...journal, phase: 'committed' };
        await this.options.store.writeTransaction({
          journal,
          snapshots: durableSnapshots(snapshots, journal),
          operations: plan.operations,
          ...(priorReceipt ? { priorReceipt } : {}),
        });
        return receipt;
      } catch (failure) {
        try {
          await this.rollbackStored(
            {
              journal,
              snapshots,
              operations: plan.operations,
              ...(priorReceipt ? { priorReceipt } : {}),
            },
            plan.operations,
          );
        } catch (rollbackFailure) {
          throw aggregateInstallerFailure(
            failure,
            [rollbackFailure],
            'Install failed and rollback also failed.',
          );
        }
        throw failure;
      }
    });
  }
  private async rollbackStored(
    stored: StoredTransaction,
    operations: readonly InstallOperationV1[],
  ): Promise<void> {
    const mutated = new Set([
      ...stored.journal.completedOperationIds,
      ...(stored.journal.inFlightOperationId ? [stored.journal.inFlightOperationId] : []),
    ]);
    for (const operation of operations.filter((item) => mutated.has(item.id)).reverse()) {
      await this.adapter(operation.adapter).restore(
        operation,
        stored.snapshots[operation.id] ?? null,
      );
    }
    if (stored.priorReceipt) {
      await this.options.store.writeReceipt(stored.priorReceipt);
    } else {
      await this.options.store.removeReceipt();
    }
    const { inFlightOperationId: _inFlightOperationId, ...journal } = stored.journal;
    const rolledBack: TransactionJournalV1 = {
      ...journal,
      phase: 'rolled-back',
      completedOperationIds: operations
        .filter((operation) => mutated.has(operation.id))
        .map((operation) => operation.id),
    };
    await this.options.store.writeTransaction({
      ...stored,
      journal: rolledBack,
      snapshots: durableSnapshots(stored.snapshots, rolledBack),
    });
  }
  async finalize(): Promise<void> {
    await this.options.store.exclusive(async () => {
      const stored = await this.options.store.readTransaction();
      if (!stored || stored.journal.phase !== 'committed') {
        fail('INSTALL_TRANSACTION_UNAVAILABLE', 'Committed transaction is unavailable.');
      }
      await this.options.store.removeTransaction();
    });
  }
  async recover(): Promise<void> {
    const stored = await this.options.store.readTransaction();
    if (!stored || stored.journal.phase === 'rolled-back') {
      return;
    }
    await this.rollbackStored(stored, stored.operations);
  }
  async rollback(): Promise<void> {
    await this.options.store.exclusive(async () => {
      const stored = await this.options.store.readTransaction();
      if (stored && stored.journal.phase !== 'rolled-back') {
        await this.rollbackStored(stored, stored.operations);
      }
    });
  }
  private async hydrateReceiptOperations(receipt: OwnershipReceiptV1): Promise<void> {
    for (let index = 0; index < receipt.operations.length; index++) {
      const operation = receipt.operations[index]!,
        locator = receipt.operationLocators[index]!,
        adapter = this.adapter(operation.adapter);
      if (locator.spec !== null && !adapter.hydrateReceiptOperation) {
        fail(
          'INSTALL_RECEIPT_AMBIGUOUS',
          `Adapter ${operation.adapter} cannot hydrate its durable receipt operation.`,
        );
      }
      await adapter.hydrateReceiptOperation?.(operation, locator.spec);
    }
  }
  async verify(): Promise<InstallVerificationV1> {
    const receipt = await this.options.store.readReceipt();
    const issues: string[] = [];
    if (!receipt) {
      issues.push('receipt-missing');
    } else {
      await this.hydrateReceiptOperations(receipt);
      for (const operation of receipt.operations) {
        const actual = await this.adapter(operation.adapter).observe(operation);
        if (operation.action === 'ensure' ? actual !== operation.desiredDigest : actual !== null) {
          issues.push(`operation-drift:${operation.id}`);
        }
      }
    }
    return {
      schemaVersion: 1,
      kind: 'install-verification',
      releaseKey: receipt?.releaseKey ?? '',
      healthy: issues.length === 0,
      issues,
      checkedAt: this.now().toISOString(),
    };
  }
  private async hydrateUninstallReceipt(
    receipt: OwnershipReceiptV1,
  ): Promise<readonly InstallOperationV1[]> {
    await this.hydrateReceiptOperations(receipt);
    const removable: InstallOperationV1[] = [];
    for (const operation of receipt.operations) {
      const adapter = this.adapter(operation.adapter);
      const retained = adapter.retainOnUninstall
        ? await adapter.retainOnUninstall(operation)
        : false;
      if (!retained) {
        removable.push(operation);
      }
    }
    return removable;
  }
  async planUninstall(): Promise<InstallPlanV1> {
    const receipt = await this.options.store.readReceipt();
    if (!receipt) {
      fail('INSTALL_NOT_OWNED', 'Installation is not owned.');
    }
    const removable = await this.hydrateUninstallReceipt(receipt);
    const intent: InstallIntentV1 = {
      schemaVersion: 1,
      kind: 'install-intent',
      releaseKey: receipt.releaseKey,
      convergenceHash: receipt.convergenceHash,
      components: ['uninstall'],
    };
    const operations = removable.map((operation) => ({
      ...operation,
      action: 'remove' as const,
      desiredDigest: null,
    }));
    return this.plan(intent, operations);
  }
  async uninstall(planValue: InstallPlanV1, confirmation: string): Promise<void> {
    const plan = parseInstallPlanV1(planValue);
    if (confirmation !== plan.confirmationDigest) {
      fail('INSTALL_CONFIRMATION_MISMATCH', 'Exact plan confirmation is required.');
    }
    await this.options.store.exclusive(async () => {
      await this.recover();
      const receipt = await this.options.store.readReceipt();
      if (!receipt || receipt.releaseKey !== plan.intent.releaseKey) {
        fail('INSTALL_NOT_OWNED', 'Installation is not owned.');
      }
      const removable = await this.hydrateUninstallReceipt(receipt);
      if (
        installerDigest(removable.map((operation) => operation.id)) !==
        installerDigest(plan.operations.map((operation) => operation.id))
      ) {
        fail(
          'INSTALL_OWNERSHIP_MISMATCH',
          'Uninstall plan does not match retained receipt ownership.',
        );
      }
      for (const operation of removable) {
        const actual = await this.adapter(operation.adapter).observe(operation);
        if (operation.action === 'ensure' && actual !== operation.desiredDigest) {
          fail('INSTALL_FOREIGN_OR_DRIFTED', `Refusing drifted target ${operation.target}.`);
        }
      }
      await this.assertCurrent(plan);
      const snapshots: Record<string, string | null> = {};
      for (const operation of plan.operations) {
        snapshots[operation.id] = await this.adapter(operation.adapter).capture(operation);
      }
      const snapshot: MachineSnapshotV1 = {
        schemaVersion: 1,
        kind: 'machine-snapshot',
        transactionId: randomUUID(),
        observations: plan.observations,
        capturedAt: this.now().toISOString(),
      };
      let journal: TransactionJournalV1 = {
        schemaVersion: 1,
        kind: 'transaction-journal',
        transactionId: snapshot.transactionId,
        phase: 'applying',
        completedOperationIds: [],
        snapshot,
      };
      const stored: StoredTransaction = {
        journal,
        snapshots,
        operations: plan.operations,
        priorReceipt: receipt,
      };
      await this.options.store.writeTransaction({ ...stored, snapshots: {} });
      try {
        for (let index = 0; index < plan.operations.length; index++) {
          const operation = plan.operations[index]!,
            observation = plan.observations[index]!;
          if (
            !(operation.action === 'ensure' && observation.digest === operation.desiredDigest) &&
            !(operation.action === 'remove' && observation.digest === null)
          ) {
            const inFlightJournal = { ...journal, inFlightOperationId: operation.id };
            await this.options.store.writeTransaction({
              ...stored,
              journal: inFlightJournal,
              snapshots: durableSnapshots(snapshots, inFlightJournal),
            });
            journal = inFlightJournal;
            await this.adapter(operation.adapter).apply(operation);
            const { inFlightOperationId: _inFlightOperationId, ...completedJournal } = journal;
            journal = {
              ...completedJournal,
              completedOperationIds: [...journal.completedOperationIds, operation.id],
            };
            await this.options.store.writeTransaction({
              ...stored,
              journal,
              snapshots: durableSnapshots(snapshots, journal),
            });
          }
        }
        await this.options.store.removeReceipt();
        await this.options.store.removeTransaction();
      } catch (failure) {
        try {
          await this.rollbackStored({ ...stored, journal }, plan.operations);
        } catch (rollbackFailure) {
          throw aggregateInstallerFailure(
            failure,
            [rollbackFailure],
            'Uninstall failed and rollback also failed.',
          );
        }
        throw failure;
      }
    });
  }
}
