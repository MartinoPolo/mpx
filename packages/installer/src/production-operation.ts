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
  inspect(intent: InstallIntentV1): Promise<{ readonly observations: readonly RuntimeRegistrationObservationV1[]; readonly accountProbes: readonly AccountProbeV1[]; readonly mcpSharing: Readonly<Record<RuntimeIdentity, "shared" | "isolated">>; readonly staticMcpIssues?: readonly string[]; readonly staticMcpAbsent?: readonly string[]; readonly runtimeIssues?: readonly string[] }>;
}
export class ReadOnlyRuntimeRegistrationInspector implements RuntimeRegistrationInspectionPort {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}
  async inspect(intent: InstallIntentV1) {
    const matrix = intent.runtimeRegistrations ?? fail("INSTALL_SCHEMA_INVALID", "Runtime registration intent is required.");
    const observations: RuntimeRegistrationObservationV1[] = [], accountProbes: AccountProbeV1[] = [], runtimeIssues: string[] = []; const mcpSharing = {} as Record<RuntimeIdentity, "shared" | "isolated">;
    for (const registration of matrix.registrations) {
      const key = registration.identity.replace("-", "_").toUpperCase(), nativeRoot = this.environment[`MPX_${key}_ROOT`], projectionRoot = this.environment[`MPX_${key}_PROJECTION_ROOT`];
      let enrolled = false; if (nativeRoot && path.isAbsolute(nativeRoot)) { const info = await lstat(nativeRoot).catch(() => undefined); enrolled = Boolean(info?.isDirectory() && !info.isSymbolicLink() && installerDigest(path.win32.normalize(nativeRoot).replace(/[\\]+$/u, "").toLowerCase()) === registration.nativeRootDigest); }
      accountProbes.push({ identity: registration.identity, runtime: registration.runtime, domain: registration.domain, nativeRootDigest: registration.nativeRootDigest, status: enrolled ? "enrolled" : "unavailable", accountLabel: `${registration.domain}:safe-root-metadata` });
      mcpSharing[registration.identity] = registration.routes.mcpSharing;
      const executableInfo = await lstat(registration.executable.path).catch(() => undefined);
      if (!executableInfo) continue;
      if (!executableInfo.isFile() || executableInfo.isSymbolicLink() || sha(await readFile(registration.executable.path)) !== registration.executable.sha256) { runtimeIssues.push(`executable-drift:${registration.identity}`); continue; }
      const effectiveProjectionRoot = projectionRoot && path.isAbsolute(projectionRoot) ? projectionRoot : path.join(this.environment.LOCALAPPDATA ?? "", "mpx", "runtime-projections", intent.releaseKey, registration.identity);
      let missingFiles = 0, drifted = false;
      for (const file of registration.projection.files) { const candidate = path.join(effectiveProjectionRoot, ...file.path.split("/")); const info = await lstat(candidate).catch(() => undefined); if (!info) { missingFiles += 1; continue; } if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes || sha(await readFile(candidate)) !== file.sha256) { drifted = true; break; } }
      const receiptTarget = path.join(this.environment.LOCALAPPDATA ?? "", "mpx", "installer", "registrations", `${registration.identity}.json`);
      const receipt = await readFile(receiptTarget, "utf8").catch(() => undefined);
      if (receipt !== undefined) { let parsed: unknown; try { parsed = parseStrictJson(receipt); } catch { parsed = null; } if (canonicalJson(parsed) !== canonicalJson({ schemaVersion: 1, kind: "runtime-registration-receipt", releaseKey: intent.releaseKey, registration })) runtimeIssues.push(`registration-drift:${registration.identity}`); }
      if (drifted || (missingFiles > 0 && missingFiles < registration.projection.files.length)) runtimeIssues.push(`projection-drift:${registration.identity}`);
      else if (missingFiles === 0 && receipt !== undefined) observations.push({ identity: registration.identity, executable: registration.executable, projection: registration.projection });
    }
    const staticMcpIssues: string[] = [], staticMcpAbsent: string[] = [];
    for (const registration of intent.staticMcpRegistrations ?? []) {
      const target = path.join(this.environment.LOCALAPPDATA ?? "", "mpx", "installer", "mcp", `${registration.label.replace(":", "-")}.json`), body = await readFile(target, "utf8").catch(() => undefined);
      if (body === undefined) { staticMcpAbsent.push(registration.label); continue; }
      let parsed: unknown; try { parsed = parseStrictJson(body); } catch { parsed = null; }
      if (canonicalJson(parsed) !== canonicalJson(registration)) staticMcpIssues.push(`static-mcp-drift:${registration.label}`);
    }
    return { observations, accountProbes, mcpSharing, staticMcpIssues, staticMcpAbsent, runtimeIssues };
  }
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
export function createProductionInstallerResources(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env): ProductionInstallerResources {
  const files = new NodeBinaryFileSystem(), json = new NodeJsonResourceStore();
  return { files, resources: platform === "win32" ? new RoutedProductionResourceStore(json, new ProductionWindowsResourceStore({ platform })) : json, runtimeRegistrations: new ReadOnlyRuntimeRegistrationInspector(environment) };
}

interface Entry { operation: InstallOperationV1; launcher?: ManagedLauncherSpec; resource?: OwnedResourceSpec; fileBody?: Buffer; fileSource?: string; expectedBytes?: number }
export class ProductionInstallerOperationAdapter implements InstallerOperationAdapter {
  readonly name = "windows-production";
  private readonly launchers: ManagedLauncherAdapter;
  private readonly owned: OwnedJsonResourceAdapter;
  private readonly files: BinaryFileSystem;
  private readonly runtimeRegistrations: RuntimeRegistrationInspectionPort | undefined;
  private readonly resources: JsonResourceStore;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private readonly entries = new Map<string, Entry>();
  constructor(environment: NodeJS.ProcessEnv, private readonly currentUser: string, resources: ProductionInstallerResources = createProductionInstallerResources(process.platform, environment)) {
    this.environment = { ...environment }; this.files = resources.files; this.resources = resources.resources; this.launchers = new ManagedLauncherAdapter(resources.files); this.owned = new OwnedJsonResourceAdapter(resources.resources); this.runtimeRegistrations = resources.runtimeRegistrations;
  }
  async operations(intent: InstallIntentV1, manifest: ReleaseManifestV1, requireActual = false): Promise<InstallerOperationSet> {
    if (intent.runtimeRegistrations) {
      if (!this.runtimeRegistrations) fail("INSTALL_REGISTRATION_INSPECTION_UNAVAILABLE", "Runtime registration actual-state inspection is required.");
      const inspection = await this.runtimeRegistrations.inspect(intent), registration = verifyRuntimeRegistrationMatrix(intent.runtimeRegistrations, inspection.observations), enrollment = verifyAccountEnrollment(intent.runtimeRegistrations, inspection.accountProbes);
      const sharingIssues = intent.runtimeRegistrations.registrations.filter(item => inspection.mcpSharing[item.identity] !== item.routes.mcpSharing).map(item => `mcp-sharing-drift:${item.identity}`);
      const unavailable = new Set(inspection.accountProbes.filter(probe => probe.status === "unavailable").map(probe => probe.identity));
      const issues = [...registration.issues.filter(issue => requireActual || !issue.startsWith("observation-missing:")), ...enrollment.issues.filter(issue => !issue.startsWith("account-not-enrolled:") || !unavailable.has(issue.slice("account-not-enrolled:".length) as RuntimeIdentity)), ...sharingIssues, ...(inspection.staticMcpIssues ?? []), ...(requireActual ? (inspection.staticMcpAbsent ?? []).map(label => `static-mcp-missing:${label}`) : []), ...(inspection.runtimeIssues ?? [])];
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
    const automatic: Entry[] = [
      { fileBody: selectorBody, operation: { id: "05-cli-selector", adapter: this.name, action: "ensure", target: selectorTarget, desiredDigest: sha(selectorBody) } },
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
      automatic.push({ fileBody: projectionBody, operation: { id: `60-projection-${registration.identity}-descriptor`, adapter: this.name, action: "ensure", target: projectionTarget, desiredDigest: sha(projectionBody) } });
      for (const [fileIndex, file] of registration.projection.files.entries()) {
        const evidence = manifest.files.find(candidate => candidate.path === file.path);
        if (!evidence || evidence.sha256 !== file.sha256 || evidence.bytes !== file.bytes) continue;
        const target = path.win32.join(this.environment.LOCALAPPDATA!, "mpx", "runtime-projections", intent.releaseKey, registration.identity, ...file.path.split("/"));
        const source = path.win32.join(this.environment.MPX_APPS!, "mpx", "releases", intent.releaseKey, ...file.path.split("/"));
        automatic.push({ fileSource: source, expectedBytes: file.bytes, operation: { id: `61-projection-${registration.identity}-${String(fileIndex).padStart(4, "0")}`, adapter: this.name, action: "ensure", target, desiredDigest: file.sha256 } });
      }
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
    for (const entry of [...automatic, ...scheduled]) this.entries.set(installerDigest(entry.operation), entry);
    while (this.entries.size > 2_048) this.entries.delete(this.entries.keys().next().value!);
    const references = (intent.externalIntegrations ?? []).map(integration => ({ id: integration.id, planDigest: integration.planDigest, verifierRef: integration.verifierRef }));
    return { automatic: automatic.map(x => x.operation), scheduled: scheduled.map(x => x.operation), classifications: {
      automatic: automatic.map(x => x.operation.id),
      confirmationRequired: references.filter((_reference, index) => intent.externalIntegrations![index]!.classification === "confirmation-required"),
      manualOnly: references.filter((_reference, index) => intent.externalIntegrations![index]!.classification === "manual-only"),
    } };
  }
  private async entry(operation: InstallOperationV1): Promise<Entry> {
    const exact=this.entries.get(installerDigest(operation));if(exact)return exact;
    if(operation.action==="remove")for(const entry of this.entries.values())if(entry.operation.id===operation.id&&entry.operation.target===operation.target){if(entry.resource&&(await this.owned.inspect(entry.resource)).status==="owned")return entry;if(entry.fileBody||entry.fileSource||entry.launcher)return entry;}
    return fail("INSTALL_PLAN_STALE", `Unknown or stale production operation ${operation.id}.`);
  }
  async observe(operation: InstallOperationV1): Promise<string | null> { const entry = await this.entry(operation), target=operation.target; if (entry.fileBody || entry.fileSource) { const current = await this.files.read(target); return current ? sha(current) : null; } if (entry.launcher) return (await this.launchers.inspect(entry.launcher)).digest; return (await this.owned.inspect(entry.resource!)).digest; }
  async capture(operation: InstallOperationV1): Promise<string | null> { const entry = await this.entry(operation), target=operation.target; if (entry.fileBody || entry.fileSource || entry.launcher) { const current = await this.files.read(target); return current?.toString("base64") ?? null; } const current = await this.resources.read(target); return current === undefined ? null : Buffer.from(JSON.stringify(current)).toString("base64"); }
  async apply(operation: InstallOperationV1): Promise<void> { const entry = await this.entry(operation); if (entry.fileBody || entry.fileSource) { if (operation.action === "remove") await this.files.remove(operation.target); else { const body = entry.fileBody ?? await this.files.read(entry.fileSource!); if (!body || body.length !== entry.expectedBytes && entry.expectedBytes !== undefined || sha(body) !== operation.desiredDigest) fail("INSTALL_RELEASE_PROJECTION_DRIFT", `Immutable projection source changed for ${operation.id}.`); await this.files.write(operation.target, body); } return; } if (operation.action === "remove") { if (entry.launcher) { const plan = await this.launchers.plan(entry.launcher); if (plan.previousManagedBase64 === null) return; await this.launchers.remove({ schemaVersion: 1, kind: "managed-launcher-receipt", target: entry.launcher.path, shell: entry.launcher.shell, managedBase64: plan.previousManagedBase64, previousManagedBase64: null }); } else { const plan = await this.owned.plan(entry.resource!); if (plan.inspection.status === "absent") return; await this.owned.remove({ schemaVersion: 1, kind: "owned-resource-receipt", spec: entry.resource!, desiredDigest: installerDigest(entry.resource!.desired) }); } return; }
    if (entry.launcher) await this.launchers.apply(await this.launchers.plan(entry.launcher)); else await this.owned.apply(await this.owned.plan(entry.resource!)); }
  async restore(operation: InstallOperationV1, snapshot: string | null): Promise<void> {
    const entry = await this.entry(operation), target=operation.target;
    if (entry.fileBody || entry.fileSource || entry.launcher) { snapshot === null ? await this.files.remove(target) : await this.files.write(target, Buffer.from(snapshot, "base64")); return; }
    const inspection = await this.owned.inspect(entry.resource!);
    const prior = snapshot === null ? undefined : JSON.parse(Buffer.from(snapshot, "base64").toString("utf8"));
    const current = await this.resources.read(target), priorDigest = prior === undefined ? null : installerDigest(prior), currentDigest = current === undefined ? null : installerDigest(current);
    if (currentDigest === priorDigest) return;
    if (inspection.status !== "owned" || inspection.digest !== installerDigest(entry.resource!.desired)) fail("INSTALL_FOREIGN_OR_DRIFTED", "Refusing to restore over a foreign or drifted native resource.");
    if (snapshot === null) await this.owned.remove({ schemaVersion: 1, kind: "owned-resource-receipt", spec: entry.resource!, desiredDigest: installerDigest(entry.resource!.desired) });
    else await this.resources.write(target, prior);
  }
}
