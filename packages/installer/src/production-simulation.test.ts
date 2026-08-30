import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { FakeJsonResourceStore } from "@mpx/windows";
import { activateRelease, canonicalJson, installerDigest, type InstallIntentV1 } from "./immutable-core.js";
import { NodeInstalledRunnerAuthority } from "./installed-runner-authority.js";
import { InstallOrchestrator, NodeCurrentReleaseBuilder } from "./orchestration.js";
import { NodeBinaryFileSystem, ProductionInstallerOperationAdapter } from "./production-operation.js";
import { buildWindowsIntegrationSpecs } from "./windows-integration.js";
import { createRuntimeRegistrationMatrix, type ProjectionFileV1 } from "./runtime-registration.js";
import { NodeTransactionStore } from "./transaction.js";
import type { InstallExternalVerificationResultV1 } from "./install-intent-builder.js";

const sha = (value: string) => installerDigest(value);
const externalVerification = (intent: InstallIntentV1): InstallExternalVerificationResultV1 => ({ schemaVersion: 1, kind: "install-external-verification", integrations: (intent.externalIntegrations ?? []).map(item => ({ id: item.id, adapter: item.adapter, planDigest: item.planDigest, verifierRef: item.verifierRef, healthy: true, issues: [] })) });
const roles = (runtime: "claude" | "pi") => runtime === "claude" ? ["plugin", "hooks", "status", "settings", "canonical-content", "agents", "licenses"] as const : ["extension", "profile", "keybindings", "themes", "status", "settings", "canonical-content", "agents", "licenses"] as const;
function registration(runtime: "claude" | "pi", domain: "personal" | "work", nativeRoot: string) {
  const files: ProjectionFileV1[] = roles(runtime).map(role => { const body = Buffer.from(`${runtime}:${role}`); return { path: `${runtime}/${role}.json`, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length, role, owner: "convergence" }; });
  return { runtime, domain, nativeRoot, executable: { path: process.execPath, sha256: sha(`${runtime}:executable`), version: process.version }, projection: { rootDigest: installerDigest(files), files, reader: "canonical" as const, activation: "argv-only" as const }, routes: { git: `${domain}:git`, provider: `${domain}:provider`, ssh: `${domain}:ssh`, mcpSharing: domain === "personal" ? "shared" as const : "isolated" as const } };
}
async function simulation(existing: boolean) {
  const root = await mkdtemp(path.join(tmpdir(), `mpx-production-${existing ? "existing" : "clean"}-`));
  const repositoryRoot = path.join(root, "source"), appsRoot = path.join(root, "apps"), appData = path.join(root, "roaming"), localAppData = path.join(root, "local"), userProfile = path.join(root, "user");
  await mkdir(path.join(repositoryRoot, "bin"), { recursive: true }); await writeFile(path.join(repositoryRoot, "bin", "mpx.mjs"), "export {};\n");
  for (const runtime of ["claude", "pi"] as const) for (const role of roles(runtime)) { const file = path.join(repositoryRoot, runtime, `${role}.json`); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${runtime}:${role}`); }
  const fixtureRoots = ["claude-personal", "claude-work", "pi-personal", "pi-work"].map(name => path.join(userProfile, "native", name));
  const fixtureFiles: string[] = [];
  for (const nativeRoot of fixtureRoots) for (const name of ["auth.json", "session.json", "cache.bin"]) { const file = path.join(nativeRoot, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, Buffer.from([0, 1, 2, 255, ...Buffer.from(name)])); fixtureFiles.push(file); }
  const before = await Promise.all(fixtureFiles.map(file => readFile(file)));
  if (existing) { await mkdir(userProfile, { recursive: true }); await writeFile(path.join(userProfile, ".bashrc"), "native-profile\r\n"); }
  const userConfig = { identities: {}, domains: {}, contentScopes: {}, modes: {}, skillPolicies: {}, presets: {}, launchDefaults: { scopes: {}, projects: {} }, networkPolicies: {}, executors: { host: {} } };
  const userConfigContent = `${JSON.stringify(userConfig, null, 2)}\n`, userConfigTarget = path.join(appData, "mpx", "config.json");
  if (existing) { await mkdir(path.dirname(userConfigTarget), { recursive: true }); await writeFile(userConfigTarget, userConfigContent); await utimes(userConfigTarget, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z")); }
  const environment = { MPX_APPS: appsRoot, APPDATA: appData, LOCALAPPDATA: localAppData, USERPROFILE: userProfile, MPX_NODE_EXECUTABLE: process.execPath };
  const terminalTarget = path.win32.join(localAppData, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json");
  const priorTerminalProfile = buildWindowsIntegrationSpecs(environment, "DOMAIN\\me", "a".repeat(64)).terminal.desired;
  const native = new FakeJsonResourceStore(existing ? { [terminalTarget]: { profiles: [{ guid: "foreign", name: "Keep" }, priorTerminalProfile], theme: "native" } } : {});
  let runtimeRegistrations!: ReturnType<typeof createRuntimeRegistrationMatrix>;
  const adapter = new ProductionInstallerOperationAdapter(environment, "DOMAIN\\me", { files: new NodeBinaryFileSystem(), resources: native, runtimeRegistrations: { inspect: async () => ({
    observations: runtimeRegistrations.registrations.map(({ identity, executable, projection }) => ({ identity, executable, projection })),
    accountProbes: runtimeRegistrations.registrations.map(item => ({ identity: item.identity, runtime: item.runtime, domain: item.domain, nativeRootDigest: item.nativeRootDigest, status: "enrolled" as const, accountLabel: `${item.domain}:account` })),
    mcpSharing: Object.fromEntries(runtimeRegistrations.registrations.map(item => [item.identity, item.routes.mcpSharing])) as never,
  }) }, scheduledTaskStatus: { inspect: async () => ({ exists: true, state: "Ready", lastRunAt: "2025-01-01T00:00:00.000Z", lastResult: 0 }) } });
  const store = new NodeTransactionStore(path.join(localAppData, "mpx", "installer")), releases = new NodeCurrentReleaseBuilder({ repositoryRoot, appsRoot, assetPaths: ["bin", "claude", "pi"] });
  const manifest = await releases.build();
  runtimeRegistrations = createRuntimeRegistrationMatrix([
    registration("claude", "personal", fixtureRoots[0]!), registration("claude", "work", fixtureRoots[1]!), registration("pi", "personal", fixtureRoots[2]!), registration("pi", "work", fixtureRoots[3]!),
  ]);
  const intent: InstallIntentV1 = { schemaVersion: 1, kind: "install-intent", releaseKey: manifest.releaseKey, convergenceHash: manifest.convergenceHash, components: ["cli", "runtime-registration"], userConfigArtifact: { target: "%APPDATA%/mpx/config.json", content: userConfigContent, sha256: createHash("sha256").update(userConfigContent, "utf8").digest("hex") }, runtimeRegistrations, externalIntegrations: [
    { id: "git", adapter: "git-remotes", classification: "confirmation-required", planDigest: sha("git"), verifierRef: "git:repo" },
    { id: "obsidian", adapter: "obsidian", classification: "confirmation-required", planDigest: sha("obsidian"), verifierRef: "obsidian:MPX" },
    { id: "raycast", adapter: "raycast", classification: "manual-only", planDigest: sha("raycast"), verifierRef: "raycast:post-export" },
  ] };
  return { root, repositoryRoot, appsRoot, appData, localAppData, userProfile, fixtureFiles, before, adapter, store, releases, intent, native, userConfigContent, userConfigTarget };
}

it("plans, applies, and verifies a fresh scheduled install with active immutable runner authority", async () => {
  const f = await simulation(false);
  const orchestrator = new InstallOrchestrator({ adapter: f.adapter, store: f.store, releases: f.releases, now: () => new Date("2024-12-31T23:59:59.000Z"), activate: (releaseKey, prior) => activateRelease(f.localAppData, prior, releaseKey) });
  const plan = await orchestrator.plan(f.intent);
  expect(plan.operations.at(-1)?.id).toBe("90-scheduled-capture");
  const receipt = await orchestrator.apply(plan, plan.confirmationDigest);
  await expect(orchestrator.verify(false, externalVerification(f.intent))).resolves.toMatchObject({ healthy: true, releaseKey: receipt.releaseKey });
  const authority = new NodeInstalledRunnerAuthority({ appsRoot: f.appsRoot, localAppData: f.localAppData, store: f.store });
  await expect(authority.resolveInstalled()).resolves.toMatchObject({ path: path.join(f.appsRoot, "mpx", "releases", receipt.releaseKey, "bin", "mpx.mjs"), version: receipt.releaseKey });
}, 30_000);

it("runs clean and existing-machine production-backed simulations without live writes", async () => {
  let successfulSimulations = 0, rollbackSimulations = 0;
  for (const existing of [false, true]) {
    const f = await simulation(existing), originalConfigMtime = existing ? (await stat(f.userConfigTarget)).mtimeMs : undefined;
    const orchestrator = new InstallOrchestrator({ adapter: f.adapter, store: f.store, releases: f.releases, now: () => new Date("2024-12-31T23:59:59.000Z") });
    const plan = await orchestrator.plan(f.intent);
    expect(plan.classifications?.confirmationRequired.map(item => item.id)).toEqual(["git", "obsidian"]);
    expect(plan.classifications?.manualOnly.map(item => item.id)).toEqual(["raycast"]);
    await orchestrator.apply(plan, plan.confirmationDigest);
    const second = await orchestrator.plan(f.intent); await orchestrator.apply(second, second.confirmationDigest);
    expect(await readFile(f.userConfigTarget, "utf8")).toBe(f.userConfigContent);
    if (existing) expect((await stat(f.userConfigTarget)).mtimeMs).toBe(originalConfigMtime);
    await rm(f.repositoryRoot, { recursive: true });
    expect(await orchestrator.verify(false, externalVerification(f.intent))).toMatchObject({ healthy: true, manualOnly: ["raycast"], components: [
      { id: "system", status: "actual-state-verified" }, { id: "claude-personal", status: "actual-state-verified" }, { id: "claude-work", status: "actual-state-verified" }, { id: "pi-personal", status: "actual-state-verified" }, { id: "pi-work", status: "actual-state-verified" },
    ] });
    for (let index = 0; index < f.fixtureFiles.length; index++) expect(await readFile(f.fixtureFiles[index]!)).toEqual(f.before[index]);
    expect((await readFile(path.join(f.userProfile, ".bashrc"), "utf8")).includes(existing ? "native-profile\r\n" : "# >>> MPX")).toBe(true);
    const restartedAdapter = new ProductionInstallerOperationAdapter({ MPX_APPS: f.appsRoot, APPDATA: path.join(f.root, "roaming"), LOCALAPPDATA: f.localAppData, USERPROFILE: f.userProfile, MPX_NODE_EXECUTABLE: process.execPath }, "DOMAIN\\me", { files: new NodeBinaryFileSystem(), resources: f.native });
    const restarted = new InstallOrchestrator({ adapter: restartedAdapter, store: new NodeTransactionStore(path.join(f.localAppData, "mpx", "installer")), releases: f.releases });
    let uninstallPlan = await restarted.planUninstall();
    if (!existing) {
      const selector = path.join(f.appsRoot, "mpx", "bin", "mpx.cmd"), ownedSelector = await readFile(selector);
      await writeFile(selector, "foreign\n"); uninstallPlan = await restarted.planUninstall();
      await expect(restarted.uninstall(uninstallPlan.confirmationDigest)).rejects.toMatchObject({ code: "INSTALL_FOREIGN_OR_DRIFTED" });
      await writeFile(selector, ownedSelector); uninstallPlan = await restarted.planUninstall();
    }
    await restarted.uninstall(uninstallPlan.confirmationDigest);
    expect(await readFile(f.userConfigTarget, "utf8")).toBe(f.userConfigContent);
    if (existing) expect((await stat(f.userConfigTarget)).mtimeMs).toBe(originalConfigMtime);
    expect(await orchestrator.verify()).toMatchObject({ healthy: false, issues: ["receipt-missing"] });
    expect(await readFile(path.join(f.appsRoot, "mpx", "releases", f.intent.releaseKey, "bin", "mpx.mjs"), "utf8")).toBe("export {};\n");
    successfulSimulations += 1;
  }
  const baseline = await simulation(true);
  const baselinePlan = await new InstallOrchestrator({ adapter: baseline.adapter, store: baseline.store, releases: baseline.releases }).plan(baseline.intent);
  const mutatingOperations = baselinePlan.operations.filter((operation, index) => baselinePlan.observations[index]!.digest !== operation.desiredDigest);
  for (let failedIndex = 0; failedIndex < mutatingOperations.length; failedIndex++) {
    const f = await simulation(true), original = f.adapter.apply.bind(f.adapter); let calls = 0;
    f.adapter.apply = async operation => { await original(operation); if (calls++ === failedIndex) throw new Error(`injected:${operation.id}`); };
    const orchestrator = new InstallOrchestrator({ adapter: f.adapter, store: f.store, releases: f.releases }), plan = await orchestrator.plan(f.intent);
    const targetSnapshots = await Promise.all(plan.operations.map(operation => f.adapter.capture(operation)));
    await expect(orchestrator.apply(plan, plan.confirmationDigest)).rejects.toThrow("injected:");
    expect(await Promise.all(plan.operations.map(operation => f.adapter.capture(operation)))).toEqual(targetSnapshots);
    expect(await f.store.readReceipt()).toBeUndefined();
    expect(await f.native.read(path.win32.join(f.localAppData, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"))).toEqual({ profiles: [{ guid: "foreign", name: "Keep" }, buildWindowsIntegrationSpecs({ MPX_APPS: f.appsRoot, APPDATA: path.join(f.root, "roaming"), LOCALAPPDATA: f.localAppData, USERPROFILE: f.userProfile, MPX_NODE_EXECUTABLE: process.execPath }, "DOMAIN\\me", "a".repeat(64)).terminal.desired], theme: "native" });
    for (let index = 0; index < f.fixtureFiles.length; index++) expect(await readFile(f.fixtureFiles[index]!)).toEqual(f.before[index]);
    rollbackSimulations += 1;
  }
  expect({ successfulSimulations, rollbackSimulations }).toEqual({ successfulSimulations: 2, rollbackSimulations: mutatingOperations.length });
}, 120_000);
