import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MpxError, parseStrictJson } from "@mpx/core";
import {
  installerDigest,
  parseInstallIntentV1,
  parseInstallPlanV1,
  parseOwnershipReceiptV1,
  type InstallIntentV1,
  type InstallOperationV1,
  type InstallPlanV1,
  type InstallVerificationV1,
  type MachineObservationV1,
  type MachineSnapshotV1,
  type OwnershipReceiptV1,
  type ReleaseManifestV1,
  type TransactionJournalV1,
} from "./immutable-core.js";
export { installerDigest } from "./immutable-core.js";
export type { InstallIntentV1, InstallOperationV1 } from "./immutable-core.js";

function fail(code: string, message: string): never { throw new MpxError({ code, message }); }
export interface SideEffectAdapter {
  readonly name: string;
  observe(target: string): Promise<string | null>;
  capture(target: string): Promise<string | null>;
  apply(operation: InstallOperationV1): Promise<void>;
  restore(target: string, snapshot: string | null): Promise<void>;
}
export interface StoredTransaction { journal: TransactionJournalV1; snapshots: Readonly<Record<string, string | null>>; operations: readonly InstallOperationV1[] }
export interface TransactionStore {
  readReceipt(): Promise<OwnershipReceiptV1 | undefined>;
  writeReceipt(receipt: OwnershipReceiptV1): Promise<void>;
  removeReceipt(): Promise<void>;
  writeTransaction(value: StoredTransaction): Promise<void>;
  readTransaction(): Promise<StoredTransaction | undefined>;
  removeTransaction(): Promise<void>;
  exclusive<T>(action: () => Promise<T>): Promise<T>;
}
export class MemoryTransactionStore implements TransactionStore {
  private receipt: OwnershipReceiptV1 | undefined; private transaction: StoredTransaction | undefined; private tail: Promise<void> = Promise.resolve();
  async readReceipt() { return this.receipt && structuredClone(this.receipt); }
  async writeReceipt(value: OwnershipReceiptV1) { this.receipt = structuredClone(value); }
  async removeReceipt() { this.receipt = undefined; }
  async writeTransaction(value: StoredTransaction) { this.transaction = structuredClone(value); }
  async readTransaction() { return this.transaction && structuredClone(this.transaction); }
  async removeTransaction() { this.transaction = undefined; }
  async exclusive<T>(action: () => Promise<T>): Promise<T> { const previous = this.tail; let release!: () => void; this.tail = new Promise<void>((resolve) => { release = resolve; }); await previous; try { return await action(); } finally { release(); } }
}

/** Durable, atomic installer state. The directory is private and never contains credentials. */
export class NodeTransactionStore implements TransactionStore {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}
  private file(name: string): string { return path.join(this.directory, name); }
  private async atomic(name: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(this.directory, 0o700);
    const target = this.file(name), temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      if (process.platform !== "win32") await chmod(temporary, 0o600);
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  private async read(name: string): Promise<unknown | undefined> {
    try { return parseStrictJson(await readFile(this.file(name), "utf8")); }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw failure; }
  }
  async readReceipt(): Promise<OwnershipReceiptV1 | undefined> { const value = await this.read("receipt.json"); return value === undefined ? undefined : parseOwnershipReceiptV1(value); }
  async writeReceipt(value: OwnershipReceiptV1): Promise<void> { await this.atomic("receipt.json", parseOwnershipReceiptV1(value)); }
  async removeReceipt(): Promise<void> { await rm(this.file("receipt.json"), { force: true }); }
  async readTransaction(): Promise<StoredTransaction | undefined> {
    const value = await this.read("transaction.json");
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("INSTALL_TRANSACTION_INVALID", "Transaction state is invalid.");
    const stored = value as Partial<StoredTransaction>;
    if (!stored.journal || !Array.isArray(stored.operations) || !stored.snapshots || typeof stored.snapshots !== "object") fail("INSTALL_TRANSACTION_INVALID", "Transaction state is invalid.");
    return structuredClone(value) as StoredTransaction;
  }
  async writeTransaction(value: StoredTransaction): Promise<void> { await this.atomic("transaction.json", value); }
  async removeTransaction(): Promise<void> { await rm(this.file("transaction.json"), { force: true }); }
  private processExists(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (failure) { return (failure as NodeJS.ErrnoException).code === "EPERM"; }
  }
  private async removeAbandonedLock(lock: string): Promise<boolean> {
    let body: string;
    try { body = await readFile(lock, "utf8"); } catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ENOENT") return true; throw failure; }
    let value: unknown; try { value = parseStrictJson(body); } catch { return false; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.pid) || (record.pid as number) < 1 || this.processExists(record.pid as number)) return false;
    // Re-read before removal so a lock that changed ownership is never intentionally removed.
    if (await readFile(lock, "utf8").catch(() => "") !== body) return true;
    await rm(lock, { force: true }); return true;
  }
  private async acquireProcessLock(): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = this.file("transaction.lock"), deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const handle = await open(lock, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce: randomUUID() })}\n`);
        return async () => { await handle.close(); await rm(lock, { force: true }); };
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "EEXIST") throw failure;
        if (await this.removeAbandonedLock(lock)) continue;
        if (Date.now() >= deadline) fail("INSTALL_TRANSACTION_LOCKED", "Another installer transaction owns the machine lock.");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }
  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail; let releaseLocal!: () => void;
    this.tail = new Promise<void>(resolve => { releaseLocal = resolve; });
    await previous;
    let releaseProcess: (() => Promise<void>) | undefined;
    try { releaseProcess = await this.acquireProcessLock(); return await action(); }
    finally { await releaseProcess?.(); releaseLocal(); }
  }
}
export interface ImmutableInstallerServiceOptions { readonly adapters: readonly SideEffectAdapter[]; readonly store: TransactionStore; readonly manifest?: ReleaseManifestV1; readonly now?: () => Date; readonly failureInjection?: (operationId: string, index: number) => void }
export class ImmutableInstallerService {
  private readonly adapters: Map<string, SideEffectAdapter>; private readonly now: () => Date;
  constructor(private readonly options: ImmutableInstallerServiceOptions) { this.adapters = new Map(options.adapters.map((x) => [x.name, x])); if (this.adapters.size !== options.adapters.length) fail("INSTALL_ADAPTER_DUPLICATE", "Side effect adapter names must be unique."); this.now = options.now ?? (() => new Date()); }
  private adapter(name: string): SideEffectAdapter { return this.adapters.get(name) ?? fail("INSTALL_ADAPTER_UNAVAILABLE", `Side effect adapter ${name} is unavailable.`); }
  async plan(intentValue: InstallIntentV1, requested: readonly InstallOperationV1[]): Promise<InstallPlanV1> {
    const intent = parseInstallIntentV1(intentValue); const operations = [...requested].sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(operations.map((x) => x.id)).size !== operations.length) fail("INSTALL_OPERATION_DUPLICATE", "Operation IDs must be unique.");
    const observations: MachineObservationV1[] = [];
    for (const operation of operations) observations.push({ id: operation.id, digest: await this.adapter(operation.adapter).observe(operation.target) });
    const base = { schemaVersion: 1 as const, kind: "install-plan" as const, intent, observations, operations };
    return parseInstallPlanV1({ ...base, confirmationDigest: installerDigest(base) });
  }
  private async assertCurrent(plan: InstallPlanV1): Promise<void> { for (let index = 0; index < plan.operations.length; index++) { const operation = plan.operations[index]!, expected = plan.observations[index]!; if (expected.id !== operation.id || await this.adapter(operation.adapter).observe(operation.target) !== expected.digest) fail("INSTALL_OBSERVATION_CHANGED", `Observation changed for ${operation.id}.`); } }
  async apply(planValue: InstallPlanV1, confirmation: string): Promise<OwnershipReceiptV1> {
    const plan = parseInstallPlanV1(planValue); if (confirmation !== plan.confirmationDigest) fail("INSTALL_CONFIRMATION_MISMATCH", "Exact plan confirmation is required.");
    return this.options.store.exclusive(async () => {
      await this.recover(); await this.assertCurrent(plan);
      const priorReceipt = await this.options.store.readReceipt();
      if (priorReceipt && (priorReceipt.releaseKey !== plan.intent.releaseKey || installerDigest(priorReceipt.operations) !== installerDigest(plan.operations))) fail("INSTALL_OWNERSHIP_MISMATCH", "Existing ownership differs from the plan.");
      const snapshots: Record<string, string | null> = {};
      for (const operation of plan.operations) snapshots[operation.id] = await this.adapter(operation.adapter).capture(operation.target);
      const snapshot: MachineSnapshotV1 = { schemaVersion: 1, kind: "machine-snapshot", transactionId: randomUUID(), observations: plan.observations, capturedAt: this.now().toISOString() };
      let journal: TransactionJournalV1 = { schemaVersion: 1, kind: "transaction-journal", transactionId: snapshot.transactionId, phase: "applying", completedOperationIds: [], snapshot };
      await this.options.store.writeTransaction({ journal, snapshots, operations: plan.operations });
      try {
        for (let index = 0; index < plan.operations.length; index++) {
          const operation = plan.operations[index]!, observation = plan.observations[index]!;
          if (!(operation.action === "ensure" && observation.digest === operation.desiredDigest) && !(operation.action === "remove" && observation.digest === null)) { await this.adapter(operation.adapter).apply(operation); this.options.failureInjection?.(operation.id, index); }
          journal = { ...journal, completedOperationIds: [...journal.completedOperationIds, operation.id] }; await this.options.store.writeTransaction({ journal, snapshots, operations: plan.operations });
        }
        const manifest = this.options.manifest;
        if (!priorReceipt && (!manifest || manifest.releaseKey !== plan.intent.releaseKey || manifest.convergenceHash !== plan.intent.convergenceHash)) fail("INSTALL_RELEASE_MANIFEST_REQUIRED", "Exact release manifest is required for ownership.");
        const receipt: OwnershipReceiptV1 = priorReceipt ?? { schemaVersion: 1, kind: "ownership-receipt", releaseKey: plan.intent.releaseKey, convergenceHash: plan.intent.convergenceHash, files: manifest!.files, operations: plan.operations, installedAt: this.now().toISOString() };
        await this.options.store.writeReceipt(receipt); journal = { ...journal, phase: "committed" }; await this.options.store.writeTransaction({ journal, snapshots, operations: plan.operations }); await this.options.store.removeTransaction(); return receipt;
      } catch (failure) { await this.rollbackStored({ journal, snapshots, operations: plan.operations }, plan.operations); throw failure; }
    });
  }
  private async rollbackStored(stored: StoredTransaction, operations: readonly InstallOperationV1[]): Promise<void> { for (const operation of [...operations].reverse()) await this.adapter(operation.adapter).restore(operation.target, stored.snapshots[operation.id] ?? null); await this.options.store.writeTransaction({ ...stored, journal: { ...stored.journal, phase: "rolled-back" } }); await this.options.store.removeTransaction(); }
  async recover(): Promise<void> { const stored = await this.options.store.readTransaction(); if (!stored || stored.journal.phase !== "applying") return; await this.rollbackStored(stored, stored.operations); }
  async rollback(): Promise<void> { await this.options.store.exclusive(async () => { const stored = await this.options.store.readTransaction(); if (stored) await this.rollbackStored(stored, stored.operations); }); }
  async verify(): Promise<InstallVerificationV1> { const receipt = await this.options.store.readReceipt(); const issues: string[] = []; if (!receipt) issues.push("receipt-missing"); else for (const operation of receipt.operations) { const actual = await this.adapter(operation.adapter).observe(operation.target); if (operation.action === "ensure" ? actual !== operation.desiredDigest : actual !== null) issues.push(`operation-drift:${operation.id}`); } return { schemaVersion: 1, kind: "install-verification", releaseKey: receipt?.releaseKey ?? "", healthy: issues.length === 0, issues, checkedAt: this.now().toISOString() }; }
  async planUninstall(): Promise<InstallPlanV1> { const receipt = await this.options.store.readReceipt(); if (!receipt) fail("INSTALL_NOT_OWNED", "Installation is not owned."); const intent: InstallIntentV1 = { schemaVersion: 1, kind: "install-intent", releaseKey: receipt.releaseKey, convergenceHash: receipt.convergenceHash, components: ["uninstall"] }; const operations = receipt.operations.map((operation) => ({ ...operation, action: "remove" as const, desiredDigest: null })); return this.plan(intent, operations); }
  async uninstall(planValue: InstallPlanV1, confirmation: string): Promise<void> {
    const plan = parseInstallPlanV1(planValue); if (confirmation !== plan.confirmationDigest) fail("INSTALL_CONFIRMATION_MISMATCH", "Exact plan confirmation is required.");
    await this.options.store.exclusive(async () => {
      await this.recover(); const receipt = await this.options.store.readReceipt(); if (!receipt || receipt.releaseKey !== plan.intent.releaseKey) fail("INSTALL_NOT_OWNED", "Installation is not owned.");
      for (const operation of receipt.operations) { const actual = await this.adapter(operation.adapter).observe(operation.target); if (operation.action === "ensure" && actual !== operation.desiredDigest) fail("INSTALL_FOREIGN_OR_DRIFTED", `Refusing drifted target ${operation.target}.`); }
      await this.assertCurrent(plan); const snapshots: Record<string, string | null> = {}; for (const operation of plan.operations) snapshots[operation.id] = await this.adapter(operation.adapter).capture(operation.target);
      const snapshot: MachineSnapshotV1 = { schemaVersion: 1, kind: "machine-snapshot", transactionId: randomUUID(), observations: plan.observations, capturedAt: this.now().toISOString() }; let journal: TransactionJournalV1 = { schemaVersion: 1, kind: "transaction-journal", transactionId: snapshot.transactionId, phase: "applying", completedOperationIds: [], snapshot }; const stored: StoredTransaction = { journal, snapshots, operations: plan.operations }; await this.options.store.writeTransaction(stored);
      try { for (const operation of plan.operations) { await this.adapter(operation.adapter).apply(operation); journal = { ...journal, completedOperationIds: [...journal.completedOperationIds, operation.id] }; await this.options.store.writeTransaction({ ...stored, journal }); } await this.options.store.removeReceipt(); await this.options.store.removeTransaction(); } catch (failure) { await this.rollbackStored({ ...stored, journal }, plan.operations); throw failure; }
    });
  }
}
