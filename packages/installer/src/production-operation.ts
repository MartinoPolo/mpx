import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MpxError, parseStrictJson } from "@mpx/core";
import { ManagedLauncherAdapter, OwnedJsonResourceAdapter, ProductionWindowsResourceStore, type BinaryFileSystem, type JsonResourceStore, type ManagedLauncherSpec, type OwnedResourceSpec } from "@mpx/windows";
import { installerDigest, type InstallIntentV1, type InstallOperationV1, type ReleaseManifestV1 } from "./immutable-core.js";
import { buildStableSelectorBody, buildWindowsIntegrationSpecs } from "./windows-integration.js";
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

export interface ProductionInstallerResources {
  readonly files: BinaryFileSystem;
  readonly resources: JsonResourceStore;
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
  private entries = new Map<string, Entry>();
  constructor(private readonly environment: NodeJS.ProcessEnv, private readonly currentUser: string, resources: ProductionInstallerResources = createProductionInstallerResources()) {
    this.files = resources.files; this.launchers = new ManagedLauncherAdapter(resources.files); this.owned = new OwnedJsonResourceAdapter(resources.resources);
  }
  async operations(intent: InstallIntentV1, manifest: ReleaseManifestV1): Promise<InstallerOperationSet> {
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
    const scheduled: Entry[] = [{ resource: task, operation: { id: "90-scheduled-capture", adapter: this.name, action: "ensure", target: task.target, desiredDigest: installerDigest(task.desired) } }];
    this.entries = new Map([...automatic, ...scheduled].map(entry => [entry.operation.id, entry]));
    return { automatic: automatic.map(x => x.operation), scheduled: scheduled.map(x => x.operation) };
  }
  private entry(operation: InstallOperationV1): Entry { return this.entries.get(operation.id) ?? fail("INSTALL_PLAN_STALE", `Unknown production operation ${operation.id}.`); }
  private byTarget(target: string): Entry { return [...this.entries.values()].find(x => x.operation.target === target) ?? fail("INSTALL_PLAN_STALE", `Unknown production target ${target}.`); }
  async observe(target: string): Promise<string | null> { const entry = this.byTarget(target); if (entry.fileBody) { const current = await this.files.read(target); return current ? sha(current) : null; } if (entry.launcher) return (await this.launchers.inspect(entry.launcher)).digest; return (await this.owned.inspect(entry.resource!)).digest; }
  async capture(target: string): Promise<string | null> { const entry = this.byTarget(target); if (entry.fileBody || entry.launcher) { const current = await this.files.read(target); return current?.toString("base64") ?? null; } const inspection = await this.owned.inspect(entry.resource!); return inspection.value === undefined ? null : Buffer.from(JSON.stringify(inspection.value)).toString("base64"); }
  async apply(operation: InstallOperationV1): Promise<void> { const entry = this.entry(operation); if (entry.fileBody) { operation.action === "remove" ? await this.files.remove(operation.target) : await this.files.write(operation.target, entry.fileBody); return; } if (operation.action === "remove") { if (entry.launcher) { const plan = await this.launchers.plan(entry.launcher); if (plan.previousManagedBase64 === null) return; await this.launchers.remove({ schemaVersion: 1, kind: "managed-launcher-receipt", target: entry.launcher.path, shell: entry.launcher.shell, managedBase64: plan.previousManagedBase64, previousManagedBase64: null }); } else { const plan = await this.owned.plan(entry.resource!); if (plan.inspection.status === "absent") return; await this.owned.remove({ schemaVersion: 1, kind: "owned-resource-receipt", spec: entry.resource!, desiredDigest: installerDigest(entry.resource!.desired) }); } return; }
    if (entry.launcher) await this.launchers.apply(await this.launchers.plan(entry.launcher)); else await this.owned.apply(await this.owned.plan(entry.resource!)); }
  async restore(target: string, snapshot: string | null): Promise<void> { const entry = this.byTarget(target); if (entry.fileBody || entry.launcher) { snapshot === null ? await this.files.remove(target) : await this.files.write(target, Buffer.from(snapshot, "base64")); return; } if (snapshot === null) { const plan = await this.owned.plan(entry.resource!); if (plan.inspection.status === "owned") await this.owned.remove({ schemaVersion: 1, kind: "owned-resource-receipt", spec: entry.resource!, desiredDigest: installerDigest(entry.resource!.desired) }); } else fail("INSTALL_NATIVE_RESTORE_UNAVAILABLE", "Native resource restoration requires a production native resource store."); }
}
