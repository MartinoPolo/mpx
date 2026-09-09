import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MpxError, parseStrictJson } from '@mpx/core';
import {
  acquireAtomicOwnerLock,
  installerDigest,
  parseInstallIntent,
  parseInstallPlan,
  parseInstallOperation,
  parseInstallOperationLocators,
  parseMachineSnapshot,
  parseOwnershipReceipt,
  type InstallIntent,
  type InstallOperationLocator,
  type InstallOperation,
  type InstallPlan,
  type InstallVerification,
  type MachineObservation,
  type MachineSnapshot,
  type OwnershipReceipt,
  type ReleaseManifest,
  type TransactionJournal,
} from './immutable-core.js';
import { aggregateInstallerFailure } from './failure.js';
export { installerDigest } from './immutable-core.js';
export type { InstallIntent, InstallOperation } from './immutable-core.js';

export interface OwnedUserConfigAdoption {
  readonly operationId: '01-user-config';
  readonly adapter: string;
  readonly target: string;
  readonly desiredDigest: string;
  readonly validatedArtifactDigest: string;
}

function fail(code: string, message: string): never {
  throw new MpxError({ code, message });
}
export interface SideEffectAdapter {
  readonly name: string;
  observe(operation: InstallOperation): Promise<string | null>;
  capture(operation: InstallOperation): Promise<string | null>;
  apply(operation: InstallOperation): Promise<void>;
  restore(operation: InstallOperation, snapshot: string | null): Promise<void>;
  receiptLocator?(operation: InstallOperation): Promise<unknown>;
  hydrateReceiptOperation?(
    operation: InstallOperation,
    locator: unknown,
    priorReceipt?: OwnershipReceipt,
  ): Promise<void>;
}
export interface StoredTransaction {
  journal: TransactionJournal;
  snapshots: Readonly<Record<string, string | null>>;
  operations: readonly InstallOperation[];
  operationLocators: readonly InstallOperationLocator[];
  priorReceipt?: OwnershipReceipt;
}
function operationChanges(operation: InstallOperation, digest: string | null): boolean {
  return operation.action === 'ensure' ? digest !== operation.desiredDigest : digest !== null;
}

function adoptedUserConfig(
  receipt: OwnershipReceipt,
  prior: InstallOperation,
  adoption: OwnedUserConfigAdoption | undefined,
  actual: string | null,
): boolean {
  const locator = receipt.operationLocators.find((candidate) => candidate.operationId === prior.id);
  return Boolean(
    adoption &&
    actual !== null &&
    prior.id === '01-user-config' &&
    prior.action === 'ensure' &&
    adoption.operationId === prior.id &&
    adoption.adapter === prior.adapter &&
    adoption.target === prior.target &&
    adoption.desiredDigest === actual &&
    adoption.validatedArtifactDigest === actual &&
    locator?.adapter === prior.adapter &&
    locator.bindingDigest === installerDigest({ operation: prior, spec: locator.spec }) &&
    (locator.spec as { kind?: unknown; retention?: unknown } | null)?.kind === 'user-config' &&
    (locator.spec as { retention?: unknown } | null)?.retention === 'user-owned',
  );
}

function durableSnapshots(
  snapshots: Readonly<Record<string, string | null>>,
  journal: TransactionJournal,
): Record<string, string | null> {
  const ids = [
    ...journal.completedOperationIds,
    ...(journal.inFlightOperationId ? [journal.inFlightOperationId] : []),
  ];
  return Object.fromEntries(ids.map((id) => [id, snapshots[id] ?? null]));
}

function parseStoredOperationState(source: Record<string, unknown>): {
  operations: readonly InstallOperation[];
  operationLocators: readonly InstallOperationLocator[];
} {
  if (!Array.isArray(source.operations) || !Array.isArray(source.operationLocators)) {
    throw new Error('Stored transaction operations are invalid.');
  }
  const operations = source.operations.map(parseInstallOperation);
  if (
    new Set(operations.map((item) => item.id)).size !== operations.length ||
    operations.some(
      (item, index) => index > 0 && operations[index - 1]!.id.localeCompare(item.id) >= 0,
    )
  ) {
    throw new Error('Stored transaction operations are invalid.');
  }
  return {
    operations,
    operationLocators: parseInstallOperationLocators(source.operationLocators, operations),
  };
}
export interface TransactionStore {
  readReceipt(): Promise<OwnershipReceipt | undefined>;
  writeReceipt(receipt: OwnershipReceipt): Promise<void>;
  removeReceipt(): Promise<void>;
  writeTransaction(value: StoredTransaction): Promise<void>;
  readTransaction(): Promise<StoredTransaction | undefined>;
  removeTransaction(): Promise<void>;
  exclusive<T>(action: () => Promise<T>): Promise<T>;
}
export class MemoryTransactionStore implements TransactionStore {
  private receipt: OwnershipReceipt | undefined;
  private transaction: StoredTransaction | undefined;
  private tail: Promise<void> = Promise.resolve();
  async readReceipt() {
    return this.receipt && structuredClone(parseOwnershipReceipt(this.receipt));
  }
  async writeReceipt(value: OwnershipReceipt) {
    this.receipt = structuredClone(value);
  }
  async removeReceipt() {
    this.receipt = undefined;
  }
  async writeTransaction(value: StoredTransaction) {
    this.transaction = structuredClone(value);
  }
  async readTransaction() {
    if (!this.transaction) {
      return undefined;
    }
    const transaction = structuredClone(this.transaction);
    try {
      const parsed = parseStoredOperationState(transaction as unknown as Record<string, unknown>);
      return { ...transaction, ...parsed };
    } catch {
      fail('INSTALL_TRANSACTION_INVALID', 'Transaction state is invalid.');
    }
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
  async readReceipt(): Promise<OwnershipReceipt | undefined> {
    const value = await this.read('receipt.json');
    return value === undefined ? undefined : parseOwnershipReceipt(value);
  }
  async writeReceipt(value: OwnershipReceipt): Promise<void> {
    await this.atomic('receipt.json', parseOwnershipReceipt(value));
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
        [
          'journal',
          'snapshots',
          'operations',
          'operationLocators',
          ...(hasPrior ? ['priorReceipt'] : []),
        ]
          .sort()
          .join('\0')
      ) {
        throw new Error();
      }
      if (
        !source.snapshots ||
        typeof source.snapshots !== 'object' ||
        Array.isArray(source.snapshots)
      ) {
        throw new Error();
      }
      const { operations, operationLocators } = parseStoredOperationState(source),
        journalSource = source.journal as Record<string, unknown> | null,
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
      const snapshot = parseMachineSnapshot(journalSource.snapshot);
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
          return operationChanges(operation, digest);
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
      const priorReceipt = hasPrior ? parseOwnershipReceipt(source.priorReceipt) : undefined;
      return {
        journal: {
          schemaVersion: 1,
          kind: 'transaction-journal',
          transactionId: journalSource.transactionId,
          phase: journalSource.phase as TransactionJournal['phase'],
          completedOperationIds: completed,
          ...(hasInFlight ? { inFlightOperationId: inFlight as string } : {}),
          snapshot,
        },
        snapshots: snapshots as Record<string, string | null>,
        operations,
        operationLocators,
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
  readonly manifest?: ReleaseManifest;
  readonly now?: () => Date;
  readonly failureInjection?: (operationId: string, index: number) => void;
  readonly beforeApply?: () => Promise<void>;
  readonly userConfigAdoption?: OwnedUserConfigAdoption;
}
const RELEASE_UPGRADE_ID = 'ownership-release-upgrade';
const RELEASE_UPGRADE_VERIFIER = 'installer:ownership-release-upgrade';

function runtimeProjectionLocation(target: string, releaseKey: string): string | undefined {
  const segments = path.win32
      .normalize(target)
      .toLowerCase()
      .split(/[\\/]+/u),
    marker = segments.lastIndexOf('runtime-projections');
  if (
    marker > 0 &&
    segments[marker - 1] === 'mpx' &&
    segments[marker + 1] === releaseKey &&
    segments.length > marker + 3 &&
    ['claude-personal', 'claude-work', 'pi-personal', 'pi-work'].includes(segments[marker + 2]!)
  ) {
    return [...segments.slice(0, marker + 1), ...segments.slice(marker + 2)].join('/');
  }
  return undefined;
}

function validateUpgradeOperations(
  priorReceipt: OwnershipReceipt,
  targetReleaseKey: string,
  operations: readonly InstallOperation[],
  observations?: readonly MachineObservation[],
): void {
  const currentById = new Map(operations.map((operation) => [operation.id, operation]));
  for (const prior of priorReceipt.operations) {
    const current = currentById.get(prior.id);
    if (!current) {
      fail('INSTALL_OWNERSHIP_MISMATCH', `Upgrade drops prior owned operation ${prior.id}.`);
    }
    if (prior.adapter !== current.adapter || prior.action !== current.action) {
      fail('INSTALL_OWNERSHIP_MISMATCH', `Upgrade changes ownership for operation ${prior.id}.`);
    }
    if (prior.target !== current.target) {
      const locator = priorReceipt.operationLocators.find(
        (candidate) => candidate.operationId === prior.id,
      )?.spec as { kind?: string; projection?: { releaseKey?: string } } | null;
      const originalReleaseKey =
        locator?.kind === 'projection-retained'
          ? (locator.projection?.releaseKey ?? priorReceipt.releaseKey)
          : priorReceipt.releaseKey;
      if (
        prior.action !== 'ensure' ||
        !runtimeProjectionLocation(prior.target, originalReleaseKey) ||
        runtimeProjectionLocation(prior.target, originalReleaseKey) !==
          runtimeProjectionLocation(current.target, targetReleaseKey)
      ) {
        fail('INSTALL_OWNERSHIP_MISMATCH', `Upgrade moves prior owned operation ${prior.id}.`);
      }
      continue;
    }
    const observed = observations?.find((observation) => observation.id === current.id)?.digest;
    if (
      observations &&
      current.action === 'ensure' &&
      observed !== prior.desiredDigest &&
      observed !== current.desiredDigest
    ) {
      fail('INSTALL_FOREIGN_OR_DRIFTED', `Refusing drifted target ${current.target}.`);
    }
  }
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

  private async locateOperations(
    operations: readonly InstallOperation[],
  ): Promise<readonly InstallOperationLocator[]> {
    const locators: InstallOperationLocator[] = [];
    for (const operation of operations) {
      const spec = (await this.adapter(operation.adapter).receiptLocator?.(operation)) ?? null;
      locators.push({
        operationId: operation.id,
        adapter: operation.adapter,
        spec,
        bindingDigest: installerDigest({ operation, spec }),
      });
    }
    return parseInstallOperationLocators(locators, operations);
  }

  private async hydrateOperations(
    operations: readonly InstallOperation[],
    locatorValues: unknown,
    ambiguousCode: string,
    priorReceipt?: OwnershipReceipt,
  ): Promise<void> {
    const locators = parseInstallOperationLocators(locatorValues, operations);
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index]!,
        locator = locators[index]!,
        adapter = this.adapter(operation.adapter);
      if (locator.spec === null) {
        continue;
      }
      if (!adapter.hydrateReceiptOperation) {
        fail(
          ambiguousCode,
          `Adapter ${operation.adapter} cannot hydrate its durable operation locator.`,
        );
      }
      await adapter.hydrateReceiptOperation(operation, locator.spec, priorReceipt);
    }
  }

  async plan(
    intentValue: InstallIntent,
    requested: readonly InstallOperation[],
    priorReceipt?: OwnershipReceipt,
  ): Promise<InstallPlan> {
    const intent = parseInstallIntent(intentValue),
      prior = priorReceipt ? parseOwnershipReceipt(priorReceipt) : undefined;
    const operations = [...requested].sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(operations.map((x) => x.id)).size !== operations.length) {
      fail('INSTALL_OPERATION_DUPLICATE', 'Operation IDs must be unique.');
    }
    const observations: MachineObservation[] = [];
    for (const operation of operations) {
      const digest = await this.adapter(operation.adapter).observe(operation);
      if (prior && digest !== null && digest !== operation.desiredDigest) {
        const owned = prior.operations.find(
          (prior) =>
            prior.id === operation.id &&
            prior.adapter === operation.adapter &&
            prior.target === operation.target &&
            prior.action === 'ensure' &&
            operation.action === 'ensure',
        );
        if (!owned || digest !== owned.desiredDigest) {
          fail('INSTALL_FOREIGN_OR_DRIFTED', `Refusing drifted target ${operation.target}.`);
        }
      }
      observations.push({ id: operation.id, digest });
    }
    if (prior && prior.releaseKey !== intent.releaseKey) {
      validateUpgradeOperations(prior, intent.releaseKey, operations, observations);
    }
    const base = {
      schemaVersion: 1 as const,
      kind: 'install-plan' as const,
      intent,
      observations,
      operations,
    };
    return parseInstallPlan({ ...base, confirmationDigest: installerDigest(base) });
  }
  private async assertCurrent(plan: InstallPlan): Promise<void> {
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
  async apply(planValue: InstallPlan, confirmation: string): Promise<OwnershipReceipt> {
    const plan = parseInstallPlan(planValue);
    if (confirmation !== plan.confirmationDigest) {
      fail('INSTALL_CONFIRMATION_MISMATCH', 'Exact plan confirmation is required.');
    }
    return this.options.store.exclusive(async () => {
      if (this.options.beforeApply) {
        await this.options.beforeApply();
      } else {
        await this.recover();
      }
      await this.assertCurrent(plan);
      const priorReceipt = await this.options.store.readReceipt(),
        upgrading = Boolean(priorReceipt && priorReceipt.releaseKey !== plan.intent.releaseKey),
        confirmationReferences = plan.classifications?.confirmationRequired ?? [],
        allReferences = confirmationReferences,
        upgradeReferences = allReferences.filter(
          (reference) =>
            reference.id === RELEASE_UPGRADE_ID ||
            reference.verifierRef === RELEASE_UPGRADE_VERIFIER,
        );
      if (upgrading) {
        const authority = upgradeReferences[0];
        if (
          upgradeReferences.length !== 1 ||
          !authority ||
          !confirmationReferences.includes(authority) ||
          authority.id !== RELEASE_UPGRADE_ID ||
          authority.verifierRef !== RELEASE_UPGRADE_VERIFIER
        ) {
          fail('INSTALL_OWNERSHIP_MISMATCH', 'Upgrade authority is missing or malformed.');
        }
        if (authority.planDigest !== installerDigest(priorReceipt)) {
          fail('INSTALL_PLAN_STALE', 'Prior ownership receipt changed after upgrade planning.');
        }
        validateUpgradeOperations(
          priorReceipt!,
          plan.intent.releaseKey,
          plan.operations,
          plan.observations,
        );
        await this.assertOwnedReceipt(priorReceipt!);
      } else if (upgradeReferences.length > 0) {
        fail('INSTALL_OWNERSHIP_MISMATCH', 'Upgrade authority is extraneous.');
      } else if (
        priorReceipt &&
        installerDigest(priorReceipt.operations) !== installerDigest(plan.operations)
      ) {
        await this.assertOwnedReceipt(priorReceipt);
        const changed = priorReceipt.operations.filter(
          (prior) =>
            installerDigest(prior) !==
            installerDigest(plan.operations.find((operation) => operation.id === prior.id) ?? null),
        );
        if (
          priorReceipt.operations.length !== plan.operations.length ||
          changed.length !== 1 ||
          !adoptedUserConfig(
            priorReceipt,
            changed[0]!,
            this.options.userConfigAdoption,
            plan.observations.find((item) => item.id === changed[0]!.id)?.digest ?? null,
          )
        ) {
          fail('INSTALL_OWNERSHIP_MISMATCH', 'Existing ownership differs from the plan.');
        }
      }
      const snapshots: Record<string, string | null> = {};
      for (const [index, operation] of plan.operations.entries()) {
        if (operationChanges(operation, plan.observations[index]!.digest)) {
          snapshots[operation.id] = await this.adapter(operation.adapter).capture(operation);
        }
      }
      const operationLocators = await this.locateOperations(plan.operations),
        snapshot: MachineSnapshot = {
          schemaVersion: 1,
          kind: 'machine-snapshot',
          transactionId: randomUUID(),
          observations: plan.observations,
          capturedAt: this.now().toISOString(),
        };
      let journal: TransactionJournal = {
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
        operationLocators,
        ...(priorReceipt ? { priorReceipt } : {}),
      });
      try {
        for (let index = 0; index < plan.operations.length; index++) {
          const operation = plan.operations[index]!,
            observation = plan.observations[index]!;
          if (operationChanges(operation, observation.digest)) {
            const inFlightJournal = { ...journal, inFlightOperationId: operation.id };
            await this.options.store.writeTransaction({
              journal: inFlightJournal,
              snapshots: durableSnapshots(snapshots, inFlightJournal),
              operations: plan.operations,
              operationLocators,
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
              operationLocators,
              ...(priorReceipt ? { priorReceipt } : {}),
            });
          }
        }
        const manifest = this.options.manifest;
        if (
          (!priorReceipt || upgrading) &&
          (!manifest ||
            manifest.releaseKey !== plan.intent.releaseKey ||
            manifest.convergenceHash !== plan.intent.convergenceHash)
        ) {
          fail(
            'INSTALL_RELEASE_MANIFEST_REQUIRED',
            'Exact release manifest is required for ownership.',
          );
        }
        const receiptOperationLocators = await this.locateOperations(plan.operations);
        const receipt: OwnershipReceipt =
          priorReceipt &&
          !upgrading &&
          installerDigest(priorReceipt.operations) === installerDigest(plan.operations)
            ? priorReceipt
            : {
                schemaVersion: 2,
                kind: 'ownership-receipt',
                releaseKey: plan.intent.releaseKey,
                convergenceHash: plan.intent.convergenceHash,
                files: manifest?.files ?? priorReceipt!.files,
                operations: plan.operations,
                operationLocators: receiptOperationLocators,
                installIntent: plan.intent,
                installedAt: this.now().toISOString(),
              };
        await this.options.store.writeReceipt(receipt);
        journal = { ...journal, phase: 'committed' };
        await this.options.store.writeTransaction({
          journal,
          snapshots: durableSnapshots(snapshots, journal),
          operations: plan.operations,
          operationLocators,
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
              operationLocators,
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
    operations: readonly InstallOperation[],
  ): Promise<void> {
    const mutated = new Set([
      ...stored.journal.completedOperationIds,
      ...(stored.journal.inFlightOperationId ? [stored.journal.inFlightOperationId] : []),
    ]);
    await this.hydrateOperations(
      operations.filter((operation) => mutated.has(operation.id)),
      stored.operationLocators.filter((locator) => mutated.has(locator.operationId)),
      'INSTALL_TRANSACTION_INVALID',
      stored.priorReceipt,
    );
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
    const rolledBack: TransactionJournal = {
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
  private async hydrateReceiptOperations(receipt: OwnershipReceipt): Promise<void> {
    await this.hydrateOperations(
      receipt.operations,
      receipt.operationLocators,
      'INSTALL_RECEIPT_AMBIGUOUS',
    );
  }
  async assertOwnedReceipt(receiptValue: OwnershipReceipt): Promise<void> {
    const receipt = parseOwnershipReceipt(receiptValue);
    await this.hydrateReceiptOperations(receipt);
    for (const operation of receipt.operations) {
      const actual = await this.adapter(operation.adapter).observe(operation);
      if (
        (operation.action === 'ensure' ? actual !== operation.desiredDigest : actual !== null) &&
        !adoptedUserConfig(receipt, operation, this.options.userConfigAdoption, actual)
      ) {
        fail('INSTALL_FOREIGN_OR_DRIFTED', `Owned target ${operation.target} is drifted.`);
      }
    }
  }
  async verify(): Promise<InstallVerification> {
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
}
