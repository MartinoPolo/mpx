import { describe, expect, it } from "vitest";
import { ImmutableInstallerService, MemoryTransactionStore, installerDigest, type InstallIntentV1, type InstallOperationV1, type SideEffectAdapter } from "./transaction.js";

class BytesAdapter implements SideEffectAdapter {
  readonly name = "files"; constructor(readonly values: Map<string, Buffer>, private readonly failAt = -1) {}
  calls = 0;
  async observe(target: string) { const value = this.values.get(target); return value ? installerDigest(value.toString("base64")) : null; }
  async capture(target: string) { return this.values.get(target)?.toString("base64") ?? null; }
  async apply(operation: InstallOperationV1) { if (this.calls++ === this.failAt) throw new Error("injected"); operation.action === "remove" ? this.values.delete(operation.target) : this.values.set(operation.target, Buffer.from(operation.desiredDigest!)); }
  async restore(target: string, snapshot: string | null) { snapshot === null ? this.values.delete(target) : this.values.set(target, Buffer.from(snapshot, "base64")); }
}
const intent: InstallIntentV1 = { schemaVersion: 1, kind: "install-intent", releaseKey: "a".repeat(64), convergenceHash: "a".repeat(64), components: ["cli"] };

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
