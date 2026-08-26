import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MpxError, parseStrictJson } from "@mpx/core";
import { ManagedLauncherAdapter, OwnedJsonResourceAdapter, ProductionWindowsResourceStore, type BinaryFileSystem, type JsonResourceStore, type ManagedLauncherSpec, type OwnedResourceSpec } from "@mpx/windows";
import { canonicalJson, installerDigest, type InstallIntentV1, type InstallOperationV1, type ReleaseManifestV1 } from "./immutable-core.js";
import { buildStableSelectorBody, buildWindowsIntegrationSpecs } from "./windows-integration.js";
import { verifyAccountEnrollment, verifyRuntimeRegistrationMatrix, type AccountProbeV1, type RuntimeIdentity, type RuntimeRegistrationObservationV1 } from "./runtime-registration.js";
import type { InstallerOperationAdapter, InstallerOperationSet } from "./orchestration.js";

const missing = (failure: unknown): boolean => (failure as NodeJS.ErrnoException).code === "ENOENT";
function fail(code: string, message: string): never { throw new MpxError({ code, message }); }
const sha = (body: Uint8Array): string => createHash("sha256").update(body).digest("hex");

export class NodeBinaryFileSystem implements BinaryFileSystem {
  async read(target: string): Promise<Buffer | undefined> { try { const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink()) fail("INSTALL_TARGET_UNSAFE", "Installer file target is unsafe."); return readFile(target); } catch (failure) { if (missing(failure)) return undefined; throw failure; } }
  async write(target: string, body: Buffer): Promise<void> { await mkdir(path.dirname(target), { recursive: true }); const temporary = `${target}.${randomUUID()}.tmp`; try { await writeFile(temporary, body, { flag: "wx" }); await rename(temporary, target); } finally { await rm(temporary, { force: true }); } }
  async remove(target: string): Promise<void> { await rm(target, { force: true }); }
}

/** File-backed host used by integration tests and Terminal. Native stores can be injected by the CLI. */
export class NodeJsonResourceStore implements JsonResourceStore {
  private assertFile(target: string): void { if (!path.isAbsolute(target) || path.extname(target).toLowerCase() !== ".json") fail("INSTALL_ADAPTER_UNSUPPORTED", "A typed native Windows resource adapter is required for this target."); }
  async read(target: string): Promise<unknown | undefined> { this.assertFile(target); try { return parseStrictJson(await readFile(target, "utf8")); } catch (failure) { if (missing(failure)) return undefined; throw failure; } }
  async write(target: string, value: unknown): Promise<void> { this.assertFile(target); await mkdir(path.dirname(target), { recursive: true }); const temporary = `${target}.${randomUUID()}.tmp`; try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); await rename(temporary, target); } finally { await rm(temporary, { force: true }); } }
  async remove(target: string): Promise<void> { this.assertFile(target); await rm(target, { force: true }); }
}

export interface RuntimeRegistrationInspectionPort {
  inspect(): Promise<{ readonly observations: readonly RuntimeRegistrationObservationV1[]; readonly accountProbes: readonly AccountProbeV1[]; readonly mcpSharing: Readonly<Record<RuntimeIdentity, "shared" | "isolated">> }>;
}
export interface ProductionInstallerResources {
  readonly files: BinaryFileSystem;
  readonly resources: JsonResourceStore;
  readonly runtimeRegistrations?: RuntimeRegistrationInspectionPort;
}
class RoutedProductionResourceStore implements JsonResourceStore {
  constructor(private readonly files: JsonResourceStore, private readonly native: JsonResourceStore) {}
  private store(target: string): JsonResourceStore { return path.extname(target).toLowerCase() === ".json" ? this.files : this.native; }
  read(target: string): Promise<unknown | undefined> { return this.store(target).read(target); }
  write(target: string, value: unknown): Promise<void> { return this.store(target).write(target, value); }
  remove(target: string): Promise<void> { return this.store(target).remove(target); }
}
export function createProductionInstallerResources(platform: NodeJS.Platform = process.platform): ProductionInstallerResources {
  const files = new NodeBinaryFileSystem(), json = new NodeJsonResourceStore();
  return { files, resources: platform === "win32" ? new RoutedProductionResourceStore(json, new ProductionWindowsResourceStore({ platform })) : json };
}

interface Entry { operation: InstallOperationV1; launcher?: ManagedLauncherSpec; resource?: OwnedResourceSpec; fileBody?: Buffer }
export class ProductionInstallerOperationAdapter implements InstallerOperationAdapter {
  readonly name = "windows-production";
  private readonly launchers: ManagedLauncherAdapter;
  private readonly owned: OwnedJsonResourceAdapter;
  private readonly files: BinaryFileSystem;
  private readonly runtimeRegistrations: RuntimeRegistrationInspectionPort | undefined;
  private entries = new Map<string, Entry>();
  constructor(private readonly environment: NodeJS.ProcessEnv, private readonly currentUser: string, resources: ProductionInstallerResources = createProductionInstallerResources()) {
    this.files = resources.files; this.launchers = new ManagedLauncherAdapter(resources.files); this.owned = new OwnedJsonResourceAdapter(resources.resources); this.runtimeRegistrations = resources.runtimeRegistrations;
  }
  async operations(intent: InstallIntentV1, manifest: ReleaseManifestV1): Promise<InstallerOperationSet> {
    if (intent.runtimeRegistrations) {
      if (!this.runtimeRegistrations) fail("INSTALL_REGISTRATION_INSPECTION_UNAVAILABLE", "Runtime registration actual-state inspection is required.");
      const inspection = await this.runtimeRegistrations.inspect(), registration = verifyRuntimeRegistrationMatrix(intent.runtimeRegistrations, inspection.observations), enrollment = verifyAccountEnrollment(intent.runtimeRegistrations, inspection.accountProbes);
      const sharingIssues = intent.runtimeRegistrations.registrations.filter(item => inspection.mcpSharing[item.identity] !== item.routes.mcpSharing).map(item => `mcp-sharing-drift:${item.identity}`);
      const issues = [...registration.issues, ...enrollment.issues, ...sharingIssues];
      if (issues.length) fail("INSTALL_REGISTRATION_UNHEALTHY", `Runtime registration actual state is unhealthy: ${issues.sort().join(",")}`);
    }
    const specs = buildWindowsIntegrationSpecs(this.environment, this.currentUser, intent.releaseKey);
    const cliEvidence = manifest.files.find(file => file.path === "bin/mpx.mjs");
    if (!cliEvidence) fail("INSTALL_CLI_BUNDLE_MISSING", "The immutable release has no bundled bin/mpx.mjs.");
    const nodePath = String(specs.task.desired.executable);
    const nodeInfo = await lstat(nodePath);
    if (!nodeInfo.isFile() || nodeInfo.isSymbolicLink()) fail("INSTALL_NODE_UNAVAILABLE", "Scheduled capture Node executable is unsafe.");
    const task: OwnedResourceSpec = { ...specs.task, desired: { ...specs.task.desired, executableSha256: sha(await readFile(nodePath)), cliSha256: cliEvidence.sha256 } }; 
    const selectorBody = Buffer.from(buildStableSelectorBody(), "utf8");
    const selectorTarget = path.win32.join(this.environment.MPX_APPS!, "mpx", "bin", "mpx.cmd");
    const activeBody = Buffer.from(`${intent.releaseKey}\n`, "utf8"), activeTarget = path.win32.join(this.environment.LOCALAPPDATA!, "mpx", "active-release");
    const automatic: Entry[] = [
      { fileBody: selectorBody, operation: { id: "05-cli-selector", adapter: this.name, action: "ensure", target: selectorTarget, desiredDigest: sha(selectorBody) } },
      { fileBody: activeBody, operation: { id: "06-active-release", adapter: this.name, action: "ensure", target: activeTarget, desiredDigest: sha(activeBody) } },
    ];
    for (const [index, launcher] of specs.launchers.entries()) {
      const plan = await this.launchers.plan(launcher), desiredDigest = sha(Buffer.from(plan.managedBase64, "base64"));
      automatic.push({ launcher, operation: { id: `10-profile-${index}`, adapter: this.name, action: "ensure", target: launcher.path, desiredDigest } });
    }
    const resources = [specs.terminal, specs.environment, ...specs.shortcuts];
    for (const [index, resource] of resources.entries()) automatic.push({ resource, operation: { id: `${20 + index * 10}-${resource.kind}`, adapter: this.name, action: "ensure", target: resource.target, desiredDigest: installerDigest(resource.desired) } });
    for (const [index, registration] of (intent.runtimeRegistrations?.registrations ?? []).entries()) {
      const projectionBody = Buffer.from(`${canonicalJson({ schemaVersion: 1, kind: "synthetic-runtime-projection", releaseKey: intent.releaseKey, identity: registration.identity, projection: registration.projection })}\n`, "utf8");
      const projectionTarget = path.win32.join(this.environment.LOCALAPPDATA!, "mpx", "runtime-projections", intent.releaseKey, registration.identity, "projection.json");
      automatic.push({ fileBody: projectionBody, operation: { id: `${60 + index}-projection-${registration.identity}`, adapter: this.name, action: "ensure", target: projectionTarget, desiredDigest: sha(projectionBody) } });
      const receiptBody = Buffer.from(`${canonicalJson({ schemaVersion: 1, kind: "runtime-registration-receipt", releaseKey: intent.releaseKey, registration })}\n`, "utf8");
      const receiptTarget = path.win32.join(this.environment.LOCALAPPDATA!, "mpx", "installer", "registrations", `${registration.identity}.json`);
      automatic.push({ fileBody: receiptBody, operation: { id: `${70 + index}-registration-${registration.identity}`, adapter: this.name, action: "ensure", target: receiptTarget, desiredDigest: sha(receiptBody) } });
    }
    for (const [index, registration] of (intent.staticMcpRegistrations ?? []).entries()) {
      const body = Buffer.from(`${canonicalJson(registration)}\n`, "utf8"), safeLabel = registration.label.replace(":", "-");
      const target = path.win32.join(this.environment.LOCALAPPDATA!, "mpx", "installer", "mcp", `${safeLabel}.json`);
      automatic.push({ fileBody: body, operation: { id: `${74 + index}-registration-mcp-${safeLabel}`, adapter: this.name, action: "ensure", target, desiredDigest: sha(body) } });
    }
    automatic.sort((left, right) => left.operation.id.localeCompare(right.operation.id));
    const scheduled: Entry[] = [{ resource: task, operation: { id: "90-scheduled-capture", adapter: this.name, action: "ensure", target: task.target, desiredDigest: installerDigest(task.desired) } }];
    this.entries = new Map([...automatic, ...scheduled].map(entry => [entry.operation.id, entry]));
    const references = (intent.externalIntegrations ?? []).map(integration => ({ id: integration.id, planDigest: integration.planDigest ?? installerDigest(integration), verifierRef: integration.verifierRef ?? `${integration.adapter}:${integration.id}` }));
    return { automatic: automatic.map(x => x.operation), scheduled: scheduled.map(x => x.operation), classifications: {
      automatic: automatic.map(x => x.operation.id),
      confirmationRequired: references.filter((_reference, index) => intent.externalIntegrations![index]!.classification === "confirmation-required"),
      manualOnly: references.filter((_reference, index) => intent.externalIntegrations![index]!.classification === "manual-only"),
    } };
  }
  private entry(operation: InstallOperationV1): Entry { return this.entries.get(operation.id) ?? fail("INSTALL_PLAN_STALE", `Unknown production operation ${operation.id}.`); }
  private byTarget(target: string): Entry { return [...this.entries.values()].find(x => x.operation.target === target) ?? fail("INSTALL_PLAN_STALE", `Unknown production target ${target}.`); }
  async observe(target: string): Promise<string | null> { const entry = this.byTarget(target); if (entry.fileBody) { const current = await this.files.read(target); return current ? sha(current) : null; } if (entry.launcher) return (await this.launchers.inspect(entry.launcher)).digest; return (await this.owned.inspect(entry.resource!)).digest; }
  async capture(target: string): Promise<string | null> { const entry = this.byTarget(target); if (entry.fileBody || entry.launcher) { const current = await this.files.read(target); return current?.toString("base64") ?? null; } const inspection = await this.owned.inspect(entry.resource!); return inspection.value === undefined ? null : Buffer.from(JSON.stringify(inspection.value)).toString("base64"); }
  async apply(operation: InstallOperationV1): Promise<void> { const entry = this.entry(operation); if (entry.fileBody) { operation.action === "remove" ? await this.files.remove(operation.target) : await this.files.write(operation.target, entry.fileBody); return; } if (operation.action === "remove") { if (entry.launcher) { const plan = await this.launchers.plan(entry.launcher); if (plan.previousManagedBase64 === null) return; await this.launchers.remove({ schemaVersion: 1, kind: "managed-launcher-receipt", target: entry.launcher.path, shell: entry.launcher.shell, managedBase64: plan.previousManagedBase64, previousManagedBase64: null }); } else { const plan = await this.owned.plan(entry.resource!); if (plan.inspection.status === "absent") return; await this.owned.remove({ schemaVersion: 1, kind: "owned-resource-receipt", spec: entry.resource!, desiredDigest: installerDigest(entry.resource!.desired) }); } return; }
    if (entry.launcher) await this.launchers.apply(await this.launchers.plan(entry.launcher)); else await this.owned.apply(await this.owned.plan(entry.resource!)); }
  async restore(target: string, snapshot: string | null): Promise<void> { const entry = this.byTarget(target); if (entry.fileBody || entry.launcher) { snapshot === null ? await this.files.remove(target) : await this.files.write(target, Buffer.from(snapshot, "base64")); return; } if (snapshot === null) { const plan = await this.owned.plan(entry.resource!); if (plan.inspection.status === "owned") await this.owned.remove({ schemaVersion: 1, kind: "owned-resource-receipt", spec: entry.resource!, desiredDigest: installerDigest(entry.resource!.desired) }); } else fail("INSTALL_NATIVE_RESTORE_UNAVAILABLE", "Native resource restoration requires a production native resource store."); }
}
