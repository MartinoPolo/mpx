import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ImmutableInstallerService, MemoryTransactionStore, NodeTransactionStore, installerDigest, type InstallIntentV1, type InstallOperationV1, type SideEffectAdapter, type StoredTransaction } from "./transaction.js";

class BytesAdapter implements SideEffectAdapter {
  readonly name = "files"; constructor(readonly values: Map<string, Buffer>, readonly failAt = -1) {}
  calls = 0;
  restoreFailure: Error | undefined;
  async observe(operation: InstallOperationV1) { const value = this.values.get(operation.target); return value ? installerDigest(value.toString("base64")) : null; }
  async capture(operation: InstallOperationV1) { return this.values.get(operation.target)?.toString("base64") ?? null; }
  async apply(operation: InstallOperationV1) { if (this.calls++ === this.failAt) throw new Error("injected"); operation.action === "remove" ? this.values.delete(operation.target) : this.values.set(operation.target, Buffer.from(operation.desiredDigest!)); }
  async restore(operation: InstallOperationV1, snapshot: string | null) { if (this.restoreFailure) throw this.restoreFailure; snapshot === null ? this.values.delete(operation.target) : this.values.set(operation.target, Buffer.from(snapshot, "base64")); }
}
class RetainingAdapter implements SideEffectAdapter {
  readonly name = "retaining";
  readonly values = new Map<string, string>();
  readonly hydrated = new Set<string>();
  async observe(operation: InstallOperationV1) { return this.values.get(operation.target) ?? null; }
  async capture(operation: InstallOperationV1) { return this.values.get(operation.target) ?? null; }
  async apply(operation: InstallOperationV1) { operation.action === "remove" ? this.values.delete(operation.target) : this.values.set(operation.target, operation.desiredDigest!); }
  async restore(operation: InstallOperationV1, snapshot: string | null) { snapshot === null ? this.values.delete(operation.target) : this.values.set(operation.target, snapshot); }
  async receiptLocator(operation: InstallOperationV1) { return { kind: operation.id === "config" ? "user-owned" : "installer-owned" }; }
  async hydrateReceiptOperation(operation: InstallOperationV1, locator: unknown) {
    const kind = (locator as { kind?: unknown } | null)?.kind;
    if (operation.id === "config" ? operation.target !== "C:\\Roaming\\mpx\\config.json" || kind !== "user-owned" : kind !== "installer-owned") throw Object.assign(new Error("forged"), { code: "INSTALL_RECEIPT_FORGED" });
    this.hydrated.add(operation.id);
  }
  async retainOnUninstall(operation: InstallOperationV1) {
    if (!this.hydrated.has(operation.id)) throw new Error("retention checked before hydration");
    return operation.id === "config";
  }
}
const intent: InstallIntentV1 = { schemaVersion: 1, kind: "install-intent", releaseKey: "a".repeat(64), convergenceHash: "a".repeat(64), components: ["cli"] };

describe("durable installer transaction state", () => {
  it("atomically persists private receipts and in-flight snapshots across process instances", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-installer-state-"));
    const store = new NodeTransactionStore(root);
    const releaseKey = installerDigest([]);
    const receipt = { schemaVersion: 2 as const, kind: "ownership-receipt" as const, releaseKey, convergenceHash: releaseKey, files: [], operations: [], operationLocators: [], installedAt: "2025-01-01T00:00:00.000Z" };
    const snapshot = { schemaVersion: 1 as const, kind: "machine-snapshot" as const, transactionId: "tx", observations: [], capturedAt: "2025-01-01T00:00:00.000Z" };
    const stored = { journal: { schemaVersion: 1 as const, kind: "transaction-journal" as const, transactionId: "tx", phase: "applying" as const, completedOperationIds: [], snapshot }, snapshots: {}, operations: [] };
    await store.writeReceipt(receipt);
    await store.writeTransaction(stored);
    const restarted = new NodeTransactionStore(root);
    expect(await restarted.readReceipt()).toEqual(receipt);
    expect(await restarted.readTransaction()).toEqual(stored);
    if (process.platform !== "win32") expect((await stat(path.join(root, "receipt.json"))).mode & 0o077).toBe(0);
  });

  it("quarantines journals whose completed IDs are not the exact eligible prefix", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-invalid-prefix-")); await mkdir(root, { recursive: true });
    const operations = ["owned-a", "owned-b", "owned-c"].map((target, index) => ({ id: `op-${index}`, adapter: "files", action: "ensure", target, desiredDigest: String(index + 1).repeat(64) }));
    const snapshot = { schemaVersion: 1, kind: "machine-snapshot", transactionId: "tx", observations: operations.map(operation => ({ id: operation.id, digest: null })), capturedAt: "2025-01-01T00:00:00.000Z" };
    await writeFile(path.join(root, "transaction.json"), JSON.stringify({ journal: { schemaVersion: 1, kind: "transaction-journal", transactionId: "tx", phase: "applying", completedOperationIds: ["op-1"], snapshot }, snapshots: { "op-1": null }, operations }));
    const values=new Map([["owned-a",Buffer.from("untouched-a")],["owned-b",Buffer.from("mutated")],["owned-c",Buffer.from("untouched-c")]]);
    await expect(new ImmutableInstallerService({adapters:[new BytesAdapter(values)],store:new NodeTransactionStore(root)}).recover()).rejects.toMatchObject({ code: "INSTALL_TRANSACTION_INVALID" });
    expect([...values.values()].map(value=>value.toString())).toEqual(["untouched-a","mutated","untouched-c"]);
    expect(await readdir(root)).toEqual([expect.stringMatching(/^transaction\.corrupt\./u)]);
  });

  it("rejects an independently malformed snapshot map after valid operation IDs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-invalid-snapshots-")); await mkdir(root, { recursive: true });
    const operation = { id: "op", adapter: "files", action: "ensure", target: "owned", desiredDigest: "b".repeat(64) };
    const snapshot = { schemaVersion: 1, kind: "machine-snapshot", transactionId: "tx", observations: [{ id: "op", digest: null }], capturedAt: "2025-01-01T00:00:00.000Z" };
    await writeFile(path.join(root, "transaction.json"), JSON.stringify({ journal: { schemaVersion: 1, kind: "transaction-journal", transactionId: "tx", phase: "applying", completedOperationIds: [], inFlightOperationId: "op", snapshot }, snapshots: {}, operations: [operation] }));
    await expect(new NodeTransactionStore(root).readTransaction()).rejects.toMatchObject({ code: "INSTALL_TRANSACTION_INVALID" });
  });

  it("serializes transactions across independent store instances", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-installer-lock-"));
    const first = new NodeTransactionStore(root), second = new NodeTransactionStore(root);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const events: string[] = [];
    const a = first.exclusive(async () => { events.push("first-enter"); await held; events.push("first-exit"); });
    await new Promise(resolve => setTimeout(resolve, 20));
    const b = second.exclusive(async () => { events.push("second-enter"); });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(events).toEqual(["first-enter"]);
    release();
    await Promise.all([a, b]);
    expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
  });
});

describe("installer transactions", () => {
  it("hydrates signed locators before retaining user-owned state and removes other owned operations", async () => {
    const adapter = new RetainingAdapter(), store = new MemoryTransactionStore(), manifest = { schemaVersion: 1 as const, kind: "release-manifest" as const, releaseKey: "a".repeat(64), convergenceHash: "a".repeat(64), files: [] };
    const service = new ImmutableInstallerService({ adapters: [adapter], store, manifest });
    const operations: InstallOperationV1[] = [
      { id: "config", adapter: adapter.name, action: "ensure", target: "C:\\Roaming\\mpx\\config.json", desiredDigest: "b".repeat(64) },
      { id: "native", adapter: adapter.name, action: "ensure", target: "C:\\native", desiredDigest: "c".repeat(64) },
    ];
    const install = await service.plan(intent, operations); await service.apply(install, install.confirmationDigest); await service.finalize();
    const restarted = new RetainingAdapter(); restarted.values.set("C:\\Roaming\\mpx\\config.json", "b".repeat(64)); restarted.values.set("C:\\native", "c".repeat(64));
    const uninstalling = new ImmutableInstallerService({ adapters: [restarted], store });
    const plan = await uninstalling.planUninstall();
    expect(plan.operations.map(operation => operation.id)).toEqual(["native"]);
    expect([...restarted.hydrated].sort()).toEqual(["config", "native"]);
    await uninstalling.uninstall(plan, plan.confirmationDigest);
    expect(restarted.values.get("C:\\Roaming\\mpx\\config.json")).toBe("b".repeat(64));
    expect(restarted.values.has("C:\\native")).toBe(false);
  });

  it("refuses a recomputed locator that forges retention for an arbitrary resource", async () => {
    const adapter = new RetainingAdapter(), store = new MemoryTransactionStore(), operation: InstallOperationV1 = { id: "config", adapter: adapter.name, action: "ensure", target: "C:\\Roaming\\arbitrary.json", desiredDigest: "b".repeat(64) }, spec = { kind: "user-owned" };
    await store.writeReceipt({ schemaVersion: 2, kind: "ownership-receipt", releaseKey: "a".repeat(64), convergenceHash: "a".repeat(64), files: [], operations: [operation], operationLocators: [{ operationId: operation.id, adapter: operation.adapter, spec, bindingDigest: installerDigest({ operation, spec }) }], installedAt: "2025-01-01T00:00:00.000Z" });
    await expect(new ImmutableInstallerService({ adapters: [adapter], store }).planUninstall()).rejects.toMatchObject({ code: "INSTALL_RECEIPT_FORGED" });
  });

  it("revalidates observations and exact confirmation before side effects", async () => {
    const values = new Map([["config", Buffer.from("native")]]), adapter = new BytesAdapter(values), service = new ImmutableInstallerService({ adapters: [adapter], store: new MemoryTransactionStore(), now: () => new Date("2025-01-01") });
    const plan = await service.plan(intent, [{ id: "write", adapter: "files", action: "ensure", target: "owned", desiredDigest: "b".repeat(64) }]);
    values.set("owned", Buffer.from("foreign"));
    await expect(service.apply(plan, plan.confirmationDigest)).rejects.toMatchObject({ code: "INSTALL_OBSERVATION_CHANGED" });
    expect(values.get("config")?.toString()).toBe("native");
  });

  it("rolls back every completed operation and preserves native state byte-for-byte on failure", async () => {
    for (let failure = 0; failure < 3; failure++) {
      const before = new Map([["native-config", Buffer.from([0, 1, 2, 255])]]), adapter = new BytesAdapter(before, failure), service = new ImmutableInstallerService({ adapters: [adapter], store: new MemoryTransactionStore(), now: () => new Date("2025-01-01") });
      const operations = ["owned-a", "owned-b", "owned-c"].map((target, index): InstallOperationV1 => ({ id: `op-${index}`, adapter: "files", action: "ensure", target, desiredDigest: String(index + 1).repeat(64) }));
      const plan = await service.plan(intent, operations);
      await expect(service.apply(plan, plan.confirmationDigest)).rejects.toThrow("injected");
      expect([...before.entries()].map(([key, value]) => [key, value.toString("hex")])).toEqual([["native-config", "000102ff"]]);
    }
  });

  it("restores completed and in-flight mutations without overwriting a never-run target", async () => {
    const values = new Map<string, Buffer>(), adapter = new BytesAdapter(values);
    adapter.apply = async operation => {
      adapter.calls += 1;
      if (operation.id === "op-1") { values.set(operation.target, Buffer.from("partial")); values.set("owned-c", Buffer.from("external")); throw new Error("injected"); }
      values.set(operation.target, Buffer.from(operation.desiredDigest!));
    };
    const service = new ImmutableInstallerService({ adapters: [adapter], store: new MemoryTransactionStore() });
    const operations = ["owned-a", "owned-b", "owned-c"].map((target, index): InstallOperationV1 => ({ id: `op-${index}`, adapter: "files", action: "ensure", target, desiredDigest: String(index + 1).repeat(64) }));
    const plan = await service.plan(intent, operations);
    await expect(service.apply(plan, plan.confirmationDigest)).rejects.toThrow("injected");
    expect(values.get("owned-a")).toBeUndefined();
    expect(values.get("owned-b")).toBeUndefined();
    expect(values.get("owned-c")?.toString()).toBe("external");
  });

  it("recovers disk-persisted completed and in-flight mutations through a fresh store instance", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-crash-recovery-"));
    const values = new Map([["owned-a", Buffer.from("mutated")], ["owned-b", Buffer.from("partial")], ["owned-c", Buffer.from("external")]]), adapter = new BytesAdapter(values);
    const operations = ["owned-a", "owned-b", "owned-c"].map((target, index): InstallOperationV1 => ({ id: `op-${index}`, adapter: "files", action: "ensure", target, desiredDigest: String(index + 1).repeat(64) }));
    const snapshot = { schemaVersion: 1 as const, kind: "machine-snapshot" as const, transactionId: "crashed", observations: operations.map(operation => ({ id: operation.id, digest: null })), capturedAt: "2025-01-01T00:00:00.000Z" };
    const stored: StoredTransaction = { journal: { schemaVersion: 1, kind: "transaction-journal", transactionId: "crashed", phase: "applying", completedOperationIds: ["op-0"], inFlightOperationId: "op-1", snapshot }, snapshots: { "op-0": null, "op-1": null }, operations };
    await new NodeTransactionStore(root).writeTransaction(stored);
    const restarted = new NodeTransactionStore(root);
    await new ImmutableInstallerService({ adapters: [adapter], store: restarted }).recover();
    expect(values.has("owned-a")).toBe(false); expect(values.has("owned-b")).toBe(false); expect(values.get("owned-c")?.toString()).toBe("external");
    expect((await restarted.readTransaction())?.journal).toMatchObject({ phase: "rolled-back" });
    expect((await restarted.readTransaction())?.journal).not.toHaveProperty("inFlightOperationId");
  });

  it("retains apply transaction state and both failures when rollback fails", async () => {
    const values = new Map<string, Buffer>(), adapter = new BytesAdapter(values, 0), store = new MemoryTransactionStore(), service = new ImmutableInstallerService({ adapters: [adapter], store });
    adapter.restoreFailure = new Error("restore failed");
    const plan = await service.plan(intent, [{ id: "write", adapter: "files", action: "ensure", target: "owned", desiredDigest: "b".repeat(64) }]);
    const failure = await service.apply(plan, plan.confirmationDigest).catch(error => error as AggregateError);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toBe("injected");
    expect(failure.errors.map(error => (error as Error).message)).toEqual(["injected", "restore failed"]);
    expect(failure.cause).toBe(failure.errors[0]);
    expect((await store.readTransaction())?.journal).toMatchObject({ phase: "applying", inFlightOperationId: "write" });
  });

  it("retains uninstall transaction state and both failures when rollback fails", async () => {
    const values = new Map<string, Buffer>(), adapter = new BytesAdapter(values), store = new MemoryTransactionStore(), service = new ImmutableInstallerService({ adapters: [adapter], store, manifest: { schemaVersion: 1, kind: "release-manifest", releaseKey: "a".repeat(64), convergenceHash: "a".repeat(64), files: [] } });
    const installPlan = await service.plan(intent, [{ id: "write", adapter: "files", action: "ensure", target: "owned", desiredDigest: "b".repeat(64) }]);
    await service.apply(installPlan, installPlan.confirmationDigest); await service.finalize();
    adapter.observe = async operation => values.has(operation.target) ? "b".repeat(64) : null;
    const uninstallPlan = await service.planUninstall();
    adapter.apply = async () => { values.delete("owned"); throw new Error("uninstall failed"); };
    adapter.restoreFailure = new Error("restore failed");
    const failure = await service.uninstall(uninstallPlan, uninstallPlan.confirmationDigest).catch(error => error as AggregateError);
    expect(failure.errors.map(error => (error as Error).message)).toEqual(["uninstall failed", "restore failed"]);
    expect(failure.cause).toBe(failure.errors[0]);
    expect((await store.readTransaction())?.journal).toMatchObject({ phase: "applying", inFlightOperationId: "write" });
  });
});
