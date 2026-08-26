import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { FakeJsonResourceStore } from "@mpx/windows";
import { installerDigest, type InstallIntentV1 } from "./immutable-core.js";
import { InstallOrchestrator, NodeCurrentReleaseBuilder } from "./orchestration.js";
import { NodeBinaryFileSystem, ProductionInstallerOperationAdapter } from "./production-operation.js";
import { buildWindowsIntegrationSpecs } from "./windows-integration.js";
import { createRuntimeRegistrationMatrix, type ProjectionFileV1 } from "./runtime-registration.js";
import { NodeTransactionStore } from "./transaction.js";

const sha = (value: string) => installerDigest(value);
const roles = (runtime: "claude" | "pi") => runtime === "claude" ? ["plugin", "hooks", "status", "settings", "canonical-content", "agents", "licenses"] as const : ["extension", "profile", "keybindings", "themes", "status", "settings", "canonical-content", "agents", "licenses"] as const;
function registration(runtime: "claude" | "pi", domain: "personal" | "work", nativeRoot: string) {
  const files: ProjectionFileV1[] = roles(runtime).map((role, index) => ({ path: `${runtime}/${role}.json`, sha256: sha(`${runtime}:${role}`), bytes: index, role, owner: "convergence" }));
  return { runtime, domain, nativeRoot, executable: { path: process.execPath, sha256: sha(`${runtime}:executable`), version: process.version }, projection: { rootDigest: installerDigest(files), files, reader: "canonical" as const, activation: "argv-only" as const }, routes: { git: `${domain}:git`, provider: `${domain}:provider`, ssh: `${domain}:ssh`, mcpSharing: domain === "personal" ? "shared" as const : "isolated" as const } };
}
async function simulation(existing: boolean) {
  const root = await mkdtemp(path.join(tmpdir(), `mpx-production-${existing ? "existing" : "clean"}-`));
  const repositoryRoot = path.join(root, "source"), appsRoot = path.join(root, "apps"), appData = path.join(root, "roaming"), localAppData = path.join(root, "local"), userProfile = path.join(root, "user");
  await mkdir(path.join(repositoryRoot, "bin"), { recursive: true }); await writeFile(path.join(repositoryRoot, "bin", "mpx.mjs"), "export {};\n");
  const fixtureRoots = ["claude-personal", "claude-work", "pi-personal", "pi-work"].map(name => path.join(userProfile, "native", name));
  const fixtureFiles: string[] = [];
  for (const nativeRoot of fixtureRoots) for (const name of ["auth.json", "session.json", "cache.bin"]) { const file = path.join(nativeRoot, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, Buffer.from([0, 1, 2, 255, ...Buffer.from(name)])); fixtureFiles.push(file); }
  const before = await Promise.all(fixtureFiles.map(file => readFile(file)));
  if (existing) { await mkdir(userProfile, { recursive: true }); await writeFile(path.join(userProfile, ".bashrc"), "native-profile\r\n"); }
  const environment = { MPX_APPS: appsRoot, APPDATA: appData, LOCALAPPDATA: localAppData, USERPROFILE: userProfile, MPX_NODE_EXECUTABLE: process.execPath };
  const terminalTarget = path.win32.join(localAppData, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json");
  const priorTerminalProfile = buildWindowsIntegrationSpecs(environment, "DOMAIN\\me", "a".repeat(64)).terminal.desired;
  const native = new FakeJsonResourceStore(existing ? { [terminalTarget]: { profiles: [{ guid: "foreign", name: "Keep" }, priorTerminalProfile], theme: "native" } } : {});
  let runtimeRegistrations!: ReturnType<typeof createRuntimeRegistrationMatrix>;
  const adapter = new ProductionInstallerOperationAdapter(environment, "DOMAIN\\me", { files: new NodeBinaryFileSystem(), resources: native, runtimeRegistrations: { inspect: async () => ({
    observations: runtimeRegistrations.registrations.map(({ identity, executable, projection }) => ({ identity, executable, projection })),
    accountProbes: runtimeRegistrations.registrations.map(item => ({ identity: item.identity, runtime: item.runtime, domain: item.domain, nativeRootDigest: item.nativeRootDigest, status: "enrolled" as const, accountLabel: `${item.domain}:account` })),
    mcpSharing: Object.fromEntries(runtimeRegistrations.registrations.map(item => [item.identity, item.routes.mcpSharing])) as never,
  }) } });
  const store = new NodeTransactionStore(path.join(localAppData, "mpx", "installer")), releases = new NodeCurrentReleaseBuilder({ repositoryRoot, appsRoot, assetPaths: ["bin"] });
  const manifest = await releases.build();
  runtimeRegistrations = createRuntimeRegistrationMatrix([
    registration("claude", "personal", fixtureRoots[0]!), registration("claude", "work", fixtureRoots[1]!), registration("pi", "personal", fixtureRoots[2]!), registration("pi", "work", fixtureRoots[3]!),
  ]);
  const intent: InstallIntentV1 = { schemaVersion: 1, kind: "install-intent", releaseKey: manifest.releaseKey, convergenceHash: manifest.convergenceHash, components: ["cli", "runtime-registration"], runtimeRegistrations, externalIntegrations: [
    { id: "git", adapter: "git-remotes", classification: "confirmation-required", planDigest: sha("git"), verifierRef: "git:repo" },
    { id: "obsidian", adapter: "obsidian", classification: "confirmation-required", planDigest: sha("obsidian"), verifierRef: "obsidian:MPX" },
    { id: "raycast", adapter: "raycast", classification: "manual-only", planDigest: sha("raycast"), verifierRef: "raycast:post-export" },
  ] };
  return { root, repositoryRoot, appsRoot, localAppData, userProfile, fixtureFiles, before, adapter, store, releases, intent, native };
}

it("runs clean and existing-machine production-backed simulations without live writes", async () => {
  let successfulSimulations = 0, rollbackSimulations = 0;
  for (const existing of [false, true]) {
    const f = await simulation(existing), orchestrator = new InstallOrchestrator({ adapter: f.adapter, store: f.store, releases: f.releases });
    const plan = await orchestrator.plan(f.intent);
    expect(plan.classifications?.confirmationRequired.map(item => item.id)).toEqual(["git", "obsidian"]);
    expect(plan.classifications?.manualOnly.map(item => item.id)).toEqual(["raycast"]);
    await orchestrator.apply(plan, plan.confirmationDigest);
    const second = await orchestrator.plan(f.intent); await orchestrator.apply(second, second.confirmationDigest);
    await rm(f.repositoryRoot, { recursive: true });
    expect(await orchestrator.verify()).toMatchObject({ healthy: true, manualOnly: ["raycast"], components: [
      { id: "system", status: "actual-state-verified" }, { id: "claude-personal", status: "actual-state-verified" }, { id: "claude-work", status: "actual-state-verified" }, { id: "pi-personal", status: "actual-state-verified" }, { id: "pi-work", status: "actual-state-verified" },
    ] });
    for (let index = 0; index < f.fixtureFiles.length; index++) expect(await readFile(f.fixtureFiles[index]!)).toEqual(f.before[index]);
    expect((await readFile(path.join(f.userProfile, ".bashrc"), "utf8")).includes(existing ? "native-profile\r\n" : "# >>> MPX")).toBe(true);
    const uninstallPlan = await orchestrator.planUninstall();
    await orchestrator.uninstall(uninstallPlan.confirmationDigest);
    expect(await orchestrator.verify()).toMatchObject({ healthy: false, issues: ["receipt-missing"] });
    expect(await readFile(path.join(f.appsRoot, "mpx", "releases", f.intent.releaseKey, "bin", "mpx.mjs"), "utf8")).toBe("export {};\n");
    successfulSimulations += 1;
  }
  const baseline = await simulation(true);
  const baselinePlan = await new InstallOrchestrator({ adapter: baseline.adapter, store: baseline.store, releases: baseline.releases }).plan(baseline.intent);
  const nativeSnapshots = await Promise.all(baselinePlan.operations.filter(operation => operation.target.endsWith("settings.json") || operation.target === "HKCU\\Environment" || operation.target.endsWith(".lnk") || operation.target.startsWith("\\MPX\\")).map(operation => baseline.adapter.capture(operation.target)));
  expect(nativeSnapshots.some(snapshot => snapshot !== null)).toBe(true);
  const mutatingOperations = baselinePlan.operations.filter((operation, index) => baselinePlan.observations[index]!.digest !== operation.desiredDigest);
  for (let failedIndex = 0; failedIndex < mutatingOperations.length; failedIndex++) {
    const f = await simulation(true), original = f.adapter.apply.bind(f.adapter); let calls = 0;
    f.adapter.apply = async operation => { await original(operation); if (calls++ === failedIndex) throw new Error(`injected:${operation.id}`); };
    const orchestrator = new InstallOrchestrator({ adapter: f.adapter, store: f.store, releases: f.releases }), plan = await orchestrator.plan(f.intent);
    await expect(orchestrator.apply(plan, plan.confirmationDigest)).rejects.toThrow("injected:");
    expect(await f.store.readReceipt()).toBeUndefined();
    expect(await f.native.read(path.win32.join(f.localAppData, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"))).toEqual({ profiles: [{ guid: "foreign", name: "Keep" }, buildWindowsIntegrationSpecs({ MPX_APPS: f.appsRoot, APPDATA: path.join(f.root, "roaming"), LOCALAPPDATA: f.localAppData, USERPROFILE: f.userProfile, MPX_NODE_EXECUTABLE: process.execPath }, "DOMAIN\\me", "a".repeat(64)).terminal.desired], theme: "native" });
    for (let index = 0; index < f.fixtureFiles.length; index++) expect(await readFile(f.fixtureFiles[index]!)).toEqual(f.before[index]);
    rollbackSimulations += 1;
  }
  expect({ successfulSimulations, rollbackSimulations }).toEqual({ successfulSimulations: 2, rollbackSimulations: mutatingOperations.length });
}, 120_000);
