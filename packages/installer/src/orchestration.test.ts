import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type InstallIntentV1, type InstallOperationV1 } from "./immutable-core.js";
import { MemoryTransactionStore, installerDigest } from "./transaction.js";
import { InstallOrchestrator, NodeCurrentReleaseBuilder, type InstallerOperationAdapter } from "./orchestration.js";

class FixtureAdapter implements InstallerOperationAdapter {
  readonly name = "fixture";
  readonly values = new Map<string, string>();
  applyCalls: string[] = [];
  constructor(readonly automatic: readonly InstallOperationV1[], readonly scheduled: readonly InstallOperationV1[] = []) {}
  async operations() { return { automatic: this.automatic, scheduled: this.scheduled }; }
  async observe(target: string) { return this.values.get(target) ?? null; }
  async capture(target: string) { return this.values.get(target) ?? null; }
  async apply(operation: InstallOperationV1) { this.applyCalls.push(operation.id); operation.action === "remove" ? this.values.delete(operation.target) : this.values.set(operation.target, operation.desiredDigest!); }
  async restore(target: string, snapshot: string | null) { snapshot === null ? this.values.delete(target) : this.values.set(target, snapshot); }
}
async function fixture() {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "mpx-orchestrator-repo-"));
  const appsRoot = await mkdtemp(path.join(tmpdir(), "mpx-orchestrator-apps-"));
  await mkdir(path.join(repositoryRoot, "dist"));
  await writeFile(path.join(repositoryRoot, "dist", "mpx.js"), "current-release");
  const builder = new NodeCurrentReleaseBuilder({ repositoryRoot, appsRoot, assetPaths: ["dist"] });
  const manifest = await builder.build();
  const intent: InstallIntentV1 = { schemaVersion: 1, kind: "install-intent", releaseKey: manifest.releaseKey, convergenceHash: manifest.convergenceHash, components: ["cli"] };
  return { repositoryRoot, appsRoot, builder, manifest, intent };
}
const operation = (id: string, target = id): InstallOperationV1 => ({ id, adapter: "fixture", action: "ensure", target, desiredDigest: installerDigest(id) });

describe("Phase I install orchestration", () => {
  it("plans the current deterministic release without publishing or applying", async () => {
    const f = await fixture(), adapter = new FixtureAdapter([operation("automatic")]);
    const orchestrator = new InstallOrchestrator({ adapter, store: new MemoryTransactionStore(), releases: f.builder, now: () => new Date("2025-01-01T00:00:00.000Z") });
    const plan = await orchestrator.plan(f.intent);
    expect(plan.intent).toEqual(f.intent);
    expect(adapter.applyCalls).toEqual([]);
    await expect(readFile(path.join(f.appsRoot, "mpx", "releases", f.manifest.releaseKey, "dist", "mpx.js"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("activates the immutable release only after every apply side effect succeeds", async () => {
    const f = await fixture(), adapter = new FixtureAdapter([operation("10-automatic")], [operation("90-scheduled")]), events: string[] = [];
    const originalApply = adapter.apply.bind(adapter);
    adapter.apply = async operation => { events.push(operation.id); await originalApply(operation); };
    const orchestrator = new InstallOrchestrator({ adapter, store: new MemoryTransactionStore(), releases: f.builder, activate: async releaseKey => { events.push(`active:${releaseKey}`); } });
    const plan = await orchestrator.plan(f.intent);
    await orchestrator.apply(plan, plan.confirmationDigest);
    expect(events).toEqual(["10-automatic", "90-scheduled", `active:${f.manifest.releaseKey}`]);
  });

  it("publishes before automatic operations, schedules last, and converges idempotently", async () => {
    const f = await fixture(), adapter = new FixtureAdapter([operation("10-automatic")], [operation("90-scheduled")]), store = new MemoryTransactionStore();
    const originalApply = adapter.apply.bind(adapter);
    adapter.apply = async operation => {
      expect(await readFile(path.join(f.appsRoot, "mpx", "releases", f.manifest.releaseKey, "dist", "mpx.js"), "utf8")).toBe("current-release");
      await originalApply(operation);
    };
    const orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder, now: () => new Date("2025-01-01T00:00:00.000Z") });
    const firstPlan = await orchestrator.plan(f.intent);
    const first = await orchestrator.apply(firstPlan, firstPlan.confirmationDigest);
    expect(adapter.applyCalls).toEqual(["10-automatic", "90-scheduled"]);
    const secondPlan = await orchestrator.plan(f.intent);
    const second = await orchestrator.apply(secondPlan, secondPlan.confirmationDigest);
    expect(second).toEqual(first);
    expect(adapter.applyCalls).toEqual(["10-automatic", "90-scheduled"]);
  });

  it("verifies actual release and operation state rather than trusting receipts", async () => {
    const f = await fixture(), adapter = new FixtureAdapter([operation("10-automatic")]), store = new MemoryTransactionStore();
    const orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder, now: () => new Date("2025-01-01T00:00:00.000Z") });
    const clean = await orchestrator.verify();
    expect(clean).toMatchObject({ healthy: false, issues: ["receipt-missing"] });
    const plan = await orchestrator.plan(f.intent);
    await orchestrator.apply(plan, plan.confirmationDigest);
    expect(await orchestrator.verify()).toMatchObject({ healthy: true, issues: [] });
    adapter.values.set("10-automatic", "tampered");
    await writeFile(path.join(f.appsRoot, "mpx", "releases", f.manifest.releaseKey, "dist", "mpx.js"), "tampered");
    expect(await orchestrator.verify()).toMatchObject({ healthy: false, issues: ["operation-drift:10-automatic", "release-file-drift:dist/mpx.js"] });
  });

  it("recomposes production operations from the receipt in a fresh verify process", async () => {
    const f = await fixture(), store = new MemoryTransactionStore(), installed = new FixtureAdapter([operation("10-automatic")]);
    const first = new InstallOrchestrator({ adapter: installed, store, releases: f.builder });
    const plan = await first.plan(f.intent);
    await first.apply(plan, plan.confirmationDigest);
    let composed = false;
    const fresh = new FixtureAdapter([operation("10-automatic")]);
    const baseOperations = fresh.operations.bind(fresh), baseObserve = fresh.observe.bind(fresh);
    fresh.operations = async () => { composed = true; return baseOperations(); };
    fresh.observe = async target => composed ? baseObserve(target) : Promise.reject(new Error("operations not composed"));
    fresh.values.set("10-automatic", installerDigest("10-automatic"));
    await expect(new InstallOrchestrator({ adapter: fresh, store, releases: f.builder }).verify()).resolves.toMatchObject({ healthy: true, issues: [] });
  });

  it("strict verification reports foreign release entries without deleting them", async () => {
    const f = await fixture(), adapter = new FixtureAdapter([operation("10-automatic")]), store = new MemoryTransactionStore();
    const orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    const plan = await orchestrator.plan(f.intent);
    await orchestrator.apply(plan, plan.confirmationDigest);
    const foreign = path.join(f.appsRoot, "mpx", "releases", f.manifest.releaseKey, "foreign.txt");
    await writeFile(foreign, "native");
    expect(await orchestrator.verify(false)).toMatchObject({ healthy: true, issues: [] });
    expect(await orchestrator.verify(true)).toMatchObject({ healthy: false, issues: ["foreign-release-entry:foreign.txt"] });
    expect(await readFile(foreign, "utf8")).toBe("native");
  });

  it("refuses a same-name foreign target before publishing or mutation", async () => {
    const f = await fixture(), adapter = new FixtureAdapter([operation("10-automatic")]), store = new MemoryTransactionStore();
    const foreignDigest = installerDigest("foreign");
    adapter.values.set("10-automatic", foreignDigest);
    const orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder });
    const plan = await orchestrator.plan(f.intent);
    await expect(orchestrator.apply(plan, plan.confirmationDigest)).rejects.toMatchObject({ code: "INSTALL_FOREIGN_OR_DRIFTED" });
    expect(adapter.values.get("10-automatic")).toBe(foreignDigest);
    await expect(readFile(path.join(f.appsRoot, "mpx", "releases", f.manifest.releaseKey, "dist", "mpx.js"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uninstalls only receipt-owned state with exact confirmation", async () => {
    const f = await fixture(), adapter = new FixtureAdapter([operation("10-automatic")]), store = new MemoryTransactionStore();
    const deactivated: string[] = [];
    const orchestrator = new InstallOrchestrator({ adapter, store, releases: f.builder, deactivate: async releaseKey => { deactivated.push(releaseKey); } });
    await expect(orchestrator.uninstall("x")).rejects.toMatchObject({ code: "INSTALL_NOT_OWNED" });
    const installPlan = await orchestrator.plan(f.intent);
    await orchestrator.apply(installPlan, installPlan.confirmationDigest);
    const uninstallPlan = await orchestrator.planUninstall();
    await expect(orchestrator.uninstall("x")).rejects.toMatchObject({ code: "INSTALL_CONFIRMATION_MISMATCH" });
    await expect(orchestrator.uninstall(uninstallPlan.confirmationDigest)).resolves.toMatchObject({ removed: true, releaseKey: f.manifest.releaseKey });
    expect(adapter.values.size).toBe(0);
    expect(deactivated).toEqual([f.manifest.releaseKey]);
  });
});
