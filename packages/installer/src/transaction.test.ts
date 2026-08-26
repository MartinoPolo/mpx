import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ImmutableInstallerService, MemoryTransactionStore, NodeTransactionStore, installerDigest, type InstallIntentV1, type InstallOperationV1, type SideEffectAdapter } from "./transaction.js";

class BytesAdapter implements SideEffectAdapter {
  readonly name = "files"; constructor(readonly values: Map<string, Buffer>, private readonly failAt = -1) {}
  calls = 0;
  async observe(target: string) { const value = this.values.get(target); return value ? installerDigest(value.toString("base64")) : null; }
  async capture(target: string) { return this.values.get(target)?.toString("base64") ?? null; }
  async apply(operation: InstallOperationV1) { if (this.calls++ === this.failAt) throw new Error("injected"); operation.action === "remove" ? this.values.delete(operation.target) : this.values.set(operation.target, Buffer.from(operation.desiredDigest!)); }
  async restore(target: string, snapshot: string | null) { snapshot === null ? this.values.delete(target) : this.values.set(target, Buffer.from(snapshot, "base64")); }
}
const intent: InstallIntentV1 = { schemaVersion: 1, kind: "install-intent", releaseKey: "a".repeat(64), convergenceHash: "a".repeat(64), components: ["cli"] };

describe("durable installer transaction state", () => {
  it("atomically persists private receipts and in-flight snapshots across process instances", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-installer-state-"));
    const store = new NodeTransactionStore(root);
    const releaseKey = installerDigest([]);
    const receipt = { schemaVersion: 1 as const, kind: "ownership-receipt" as const, releaseKey, convergenceHash: releaseKey, files: [], operations: [], installedAt: "2025-01-01T00:00:00.000Z" };
    const snapshot = { schemaVersion: 1 as const, kind: "machine-snapshot" as const, transactionId: "tx", observations: [], capturedAt: "2025-01-01T00:00:00.000Z" };
    const stored = { journal: { schemaVersion: 1 as const, kind: "transaction-journal" as const, transactionId: "tx", phase: "applying" as const, completedOperationIds: [], snapshot }, snapshots: { operation: "opaque" }, operations: [] };
    await store.writeReceipt(receipt);
    await store.writeTransaction(stored);
    const restarted = new NodeTransactionStore(root);
    expect(await restarted.readReceipt()).toEqual(receipt);
    expect(await restarted.readTransaction()).toEqual(stored);
    if (process.platform !== "win32") expect((await stat(path.join(root, "receipt.json"))).mode & 0o077).toBe(0);
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
});
