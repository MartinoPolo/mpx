import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MpxError } from "@mpx/core";

export const IMMUTABLE_INSTALLER_VERSION = 1 as const;
const SHA = /^[a-f0-9]{64}$/u;

export interface ReleaseFileV1 { readonly path: string; readonly bytes: number; readonly sha256: string }
export interface ReleaseManifestV1 { readonly schemaVersion: 1; readonly kind: "release-manifest"; readonly releaseKey: string; readonly convergenceHash: string; readonly files: readonly ReleaseFileV1[] }
export interface InstallIntentV1 { readonly schemaVersion: 1; readonly kind: "install-intent"; readonly releaseKey: string; readonly convergenceHash: string; readonly components: readonly string[] }
export interface MachineObservationV1 { readonly id: string; readonly digest: string | null }
export interface InstallOperationV1 { readonly id: string; readonly adapter: string; readonly action: "ensure" | "remove"; readonly target: string; readonly desiredDigest: string | null }
export interface InstallPlanV1 { readonly schemaVersion: 1; readonly kind: "install-plan"; readonly intent: InstallIntentV1; readonly observations: readonly MachineObservationV1[]; readonly operations: readonly InstallOperationV1[]; readonly confirmationDigest: string }
export interface OwnershipReceiptV1 { readonly schemaVersion: 1; readonly kind: "ownership-receipt"; readonly releaseKey: string; readonly convergenceHash: string; readonly files: readonly ReleaseFileV1[]; readonly operations: readonly InstallOperationV1[]; readonly installedAt: string }
export interface InstallVerificationV1 { readonly schemaVersion: 1; readonly kind: "install-verification"; readonly releaseKey: string; readonly healthy: boolean; readonly issues: readonly string[]; readonly checkedAt: string }
export interface MachineSnapshotV1 { readonly schemaVersion: 1; readonly kind: "machine-snapshot"; readonly transactionId: string; readonly observations: readonly MachineObservationV1[]; readonly capturedAt: string }
export interface TransactionJournalV1 { readonly schemaVersion: 1; readonly kind: "transaction-journal"; readonly transactionId: string; readonly phase: "applying" | "committed" | "rolled-back"; readonly completedOperationIds: readonly string[]; readonly snapshot: MachineSnapshotV1 }

function fail(code: string, message: string): never { throw new MpxError({ code, message }); }
export function canonicalJson(value: unknown): string { return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item); }
export function installerDigest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INSTALL_SCHEMA_INVALID", "Protocol value must be an object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) fail("INSTALL_SCHEMA_INVALID", "Unknown or missing protocol field.");
  return record;
}
function safeRelative(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== ".." && !normalized.startsWith("../");
}
function parseFile(value: unknown): ReleaseFileV1 {
  const file = exact(value, ["path", "bytes", "sha256"]);
  if (!safeRelative(file.path) || !Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0 || typeof file.sha256 !== "string" || !SHA.test(file.sha256)) fail("INSTALL_SCHEMA_INVALID", "Invalid release file.");
  return file as unknown as ReleaseFileV1;
}
export function parseReleaseManifestV1(value: unknown): ReleaseManifestV1 {
  const manifest = exact(value, ["schemaVersion", "kind", "releaseKey", "convergenceHash", "files"]);
  if (manifest.schemaVersion !== 1 || manifest.kind !== "release-manifest" || typeof manifest.releaseKey !== "string" || !SHA.test(manifest.releaseKey) || typeof manifest.convergenceHash !== "string" || !SHA.test(manifest.convergenceHash) || !Array.isArray(manifest.files)) fail("INSTALL_SCHEMA_INVALID", "Invalid release manifest.");
  const files = manifest.files.map(parseFile);
  if (new Set(files.map((x) => x.path)).size !== files.length || files.some((x, i) => i > 0 && files[i - 1]!.path.localeCompare(x.path) >= 0)) fail("INSTALL_SCHEMA_INVALID", "Release files must be unique and sorted.");
  const convergenceHash = installerDigest(files);
  if (manifest.releaseKey !== convergenceHash || manifest.convergenceHash !== convergenceHash) fail("INSTALL_SCHEMA_INVALID", "Release convergence hash is invalid.");
  return { schemaVersion: 1, kind: "release-manifest", releaseKey: convergenceHash, convergenceHash, files };
}
export function parseInstallIntentV1(value: unknown): InstallIntentV1 {
  const intent = exact(value, ["schemaVersion", "kind", "releaseKey", "convergenceHash", "components"]);
  if (intent.schemaVersion !== 1 || intent.kind !== "install-intent" || typeof intent.releaseKey !== "string" || !SHA.test(intent.releaseKey) || intent.releaseKey !== intent.convergenceHash || !Array.isArray(intent.components) || intent.components.some((x) => typeof x !== "string" || !x) || new Set(intent.components).size !== intent.components.length || intent.components.some((x, i, a) => i > 0 && a[i - 1].localeCompare(x) >= 0)) fail("INSTALL_SCHEMA_INVALID", "Invalid install intent.");
  return intent as unknown as InstallIntentV1;
}
function parseObservation(value: unknown): MachineObservationV1 { const x = exact(value, ["id", "digest"]); if (typeof x.id !== "string" || !x.id || !(x.digest === null || typeof x.digest === "string" && SHA.test(x.digest))) fail("INSTALL_SCHEMA_INVALID", "Invalid observation."); return x as unknown as MachineObservationV1; }
function parseOperation(value: unknown): InstallOperationV1 { const x = exact(value, ["id", "adapter", "action", "target", "desiredDigest"]); if (typeof x.id !== "string" || !x.id || typeof x.adapter !== "string" || !x.adapter || !["ensure", "remove"].includes(x.action as string) || typeof x.target !== "string" || !x.target || !(x.desiredDigest === null || typeof x.desiredDigest === "string" && SHA.test(x.desiredDigest))) fail("INSTALL_SCHEMA_INVALID", "Invalid operation."); return x as unknown as InstallOperationV1; }
function orderedUnique<T extends { id: string }>(values: T[]): boolean { return new Set(values.map((x) => x.id)).size === values.length && values.every((x, i) => i === 0 || values[i - 1]!.id.localeCompare(x.id) < 0); }
export function parseInstallPlanV1(value: unknown): InstallPlanV1 {
  const plan = exact(value, ["schemaVersion", "kind", "intent", "observations", "operations", "confirmationDigest"]);
  if (plan.schemaVersion !== 1 || plan.kind !== "install-plan" || !Array.isArray(plan.observations) || !Array.isArray(plan.operations) || typeof plan.confirmationDigest !== "string" || !SHA.test(plan.confirmationDigest)) fail("INSTALL_SCHEMA_INVALID", "Invalid install plan.");
  const parsed = { schemaVersion: 1 as const, kind: "install-plan" as const, intent: parseInstallIntentV1(plan.intent), observations: plan.observations.map(parseObservation), operations: plan.operations.map(parseOperation) };
  if (!orderedUnique(parsed.observations) || !orderedUnique(parsed.operations) || installerDigest(parsed) !== plan.confirmationDigest) fail("INSTALL_SCHEMA_INVALID", "Invalid plan confirmation or ordering.");
  return { ...parsed, confirmationDigest: plan.confirmationDigest };
}
export function parseOwnershipReceiptV1(value: unknown): OwnershipReceiptV1 {
  const receipt = exact(value, ["schemaVersion", "kind", "releaseKey", "convergenceHash", "files", "operations", "installedAt"]);
  if (receipt.schemaVersion !== 1 || receipt.kind !== "ownership-receipt" || typeof receipt.installedAt !== "string" || !Number.isFinite(Date.parse(receipt.installedAt)) || !Array.isArray(receipt.operations)) fail("INSTALL_SCHEMA_INVALID", "Invalid ownership receipt.");
  const manifest = parseReleaseManifestV1({ schemaVersion: 1, kind: "release-manifest", releaseKey: receipt.releaseKey, convergenceHash: receipt.convergenceHash, files: receipt.files });
  const operations = receipt.operations.map(parseOperation); if (!orderedUnique(operations)) fail("INSTALL_SCHEMA_INVALID", "Receipt operations must be sorted.");
  return { schemaVersion: 1, kind: "ownership-receipt", releaseKey: manifest.releaseKey, convergenceHash: manifest.convergenceHash, files: manifest.files, operations, installedAt: receipt.installedAt };
}
export function parseInstallVerificationV1(value: unknown): InstallVerificationV1 {
  const verification = exact(value, ["schemaVersion", "kind", "releaseKey", "healthy", "issues", "checkedAt"]);
  if (verification.schemaVersion !== 1 || verification.kind !== "install-verification" || typeof verification.releaseKey !== "string" || !(verification.releaseKey === "" || SHA.test(verification.releaseKey)) || typeof verification.healthy !== "boolean" || !Array.isArray(verification.issues) || verification.issues.some((x) => typeof x !== "string" || !x) || typeof verification.checkedAt !== "string" || !Number.isFinite(Date.parse(verification.checkedAt)) || verification.healthy !== (verification.issues.length === 0)) fail("INSTALL_SCHEMA_INVALID", "Invalid install verification.");
  return verification as unknown as InstallVerificationV1;
}
export function parseMachineSnapshotV1(value: unknown): MachineSnapshotV1 {
  const snapshot = exact(value, ["schemaVersion", "kind", "transactionId", "observations", "capturedAt"]);
  if (snapshot.schemaVersion !== 1 || snapshot.kind !== "machine-snapshot" || typeof snapshot.transactionId !== "string" || !snapshot.transactionId || !Array.isArray(snapshot.observations) || typeof snapshot.capturedAt !== "string" || !Number.isFinite(Date.parse(snapshot.capturedAt))) fail("INSTALL_SCHEMA_INVALID", "Invalid machine snapshot.");
  const observations = snapshot.observations.map(parseObservation); if (!orderedUnique(observations)) fail("INSTALL_SCHEMA_INVALID", "Snapshot observations must be sorted.");
  return { schemaVersion: 1, kind: "machine-snapshot", transactionId: snapshot.transactionId, observations, capturedAt: snapshot.capturedAt };
}

async function walk(root: string, relative = ""): Promise<ReleaseFileV1[]> {
  const directory = path.join(root, ...relative.split("/").filter(Boolean));
  const names = (await readdir(directory)).sort((a, b) => a.localeCompare(b));
  const result: ReleaseFileV1[] = [];
  for (const name of names) {
    const rel = relative ? `${relative}/${name}` : name; if (!safeRelative(rel)) fail("INSTALL_RELEASE_PATH_ESCAPE", "Unsafe release path.");
    const absolute = path.join(root, ...rel.split("/")); const info = await lstat(absolute);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) fail("INSTALL_RELEASE_UNSAFE_ENTRY", "Release contains a link or special entry.");
    if (info.isDirectory()) result.push(...await walk(root, rel));
    else { const body = await readFile(absolute); result.push({ path: rel, bytes: body.byteLength, sha256: createHash("sha256").update(body).digest("hex") }); }
  }
  return result;
}
export async function buildReleaseManifest(sourceDirectory: string): Promise<ReleaseManifestV1> {
  const info = await lstat(sourceDirectory).catch(() => fail("INSTALL_RELEASE_SOURCE_INVALID", "Release source is unavailable."));
  if (!info.isDirectory() || info.isSymbolicLink()) fail("INSTALL_RELEASE_SOURCE_INVALID", "Release source must be a regular directory.");
  const files = await walk(sourceDirectory); const convergenceHash = installerDigest(files);
  return { schemaVersion: 1, kind: "release-manifest", releaseKey: convergenceHash, convergenceHash, files };
}
async function copyManifest(source: string, destination: string, manifest: ReleaseManifestV1): Promise<void> {
  for (const file of manifest.files) { const target = path.join(destination, ...file.path.split("/")); await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(source, ...file.path.split("/")), target); }
  await writeFile(path.join(destination, "release-manifest.json"), `${canonicalJson(manifest)}\n`, { flag: "wx", mode: 0o444 });
  const copied = await buildReleaseManifestWithoutMetadata(destination); if (copied.convergenceHash !== manifest.convergenceHash) fail("INSTALL_RELEASE_COPY_DRIFT", "Staged release differs from source.");
}
async function buildReleaseManifestWithoutMetadata(root: string): Promise<ReleaseManifestV1> { const all = await walk(root); const files = all.filter((x) => x.path !== "release-manifest.json"); const convergenceHash = installerDigest(files); return { schemaVersion: 1, kind: "release-manifest", releaseKey: convergenceHash, convergenceHash, files }; }
export async function publishRelease(options: { sourceDirectory: string; appsRoot: string; releaseKey?: string }): Promise<ReleaseManifestV1> {
  const manifest = await buildReleaseManifest(options.sourceDirectory); if (options.releaseKey !== undefined && options.releaseKey !== manifest.releaseKey) fail("INSTALL_RELEASE_KEY_MISMATCH", "Requested key does not describe source content.");
  const releases = path.join(options.appsRoot, "mpx", "releases"), destination = path.join(releases, manifest.releaseKey); await mkdir(releases, { recursive: true });
  try { const existing = await lstat(destination); if (!existing.isDirectory() || existing.isSymbolicLink()) fail("INSTALL_RELEASE_COLLISION", "Release destination is unsafe."); const actual = await buildReleaseManifestWithoutMetadata(destination); if (actual.convergenceHash !== manifest.convergenceHash) fail("INSTALL_RELEASE_COLLISION", "Existing release is drifted."); return manifest; } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure; }
  const staging = path.join(releases, `.staging-${manifest.releaseKey}-${randomUUID()}`); await mkdir(staging, { recursive: false });
  try { await copyManifest(options.sourceDirectory, staging, manifest); try { await rename(staging, destination); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "EEXIST" && (failure as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw failure; const actual = await buildReleaseManifestWithoutMetadata(destination); if (actual.convergenceHash !== manifest.convergenceHash) fail("INSTALL_RELEASE_COLLISION", "Concurrent release differs."); } } finally { await rm(staging, { recursive: true, force: true }); }
  return manifest;
}

export interface InstalledReleaseEvidence { readonly path: string; readonly sha256: string; readonly bytes?: number; readonly version: string }
export class NodeInstalledReleaseAuthority {
  constructor(private readonly options: { appsRoot: string; receipt: () => Promise<OwnershipReceiptV1 | undefined>; prohibitedRoots?: readonly string[] }) {}
  async verifyInstalled(evidence: InstalledReleaseEvidence): Promise<InstalledReleaseEvidence> {
    if (!path.isAbsolute(evidence.path) || !SHA.test(evidence.sha256)) fail("INSTALL_RUNNER_UNAVAILABLE", "Runner evidence is invalid.");
    const releaseRoot = path.resolve(this.options.appsRoot, "mpx", "releases"), candidate = path.resolve(evidence.path), relative = path.relative(releaseRoot, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || (this.options.prohibitedRoots ?? []).some((root) => root && (candidate === path.resolve(root) || candidate.startsWith(`${path.resolve(root)}${path.sep}`)))) fail("INSTALL_RUNNER_UNAVAILABLE", "Runner is outside immutable release authority.");
    const parts = relative.split(path.sep); if (parts.length < 2 || !SHA.test(parts[0]!)) fail("INSTALL_RUNNER_UNAVAILABLE", "Runner has no immutable release key.");
    const receipt = await this.options.receipt(); const filePath = parts.slice(1).join("/"); const owned = receipt && receipt.releaseKey === parts[0] ? receipt.files.find((x) => x.path === filePath) : undefined;
    if (!owned || owned.sha256 !== evidence.sha256 || (evidence.bytes !== undefined && evidence.bytes !== owned.bytes)) fail("INSTALL_RUNNER_UNAVAILABLE", "Runner is not bound to ownership receipt.");
    const handle = await open(candidate, "r").catch(() => fail("INSTALL_RUNNER_UNAVAILABLE", "Runner is unavailable."));
    try { const info = await handle.stat(); if (!info.isFile() || info.size !== owned.bytes) fail("INSTALL_RUNNER_STALE", "Runner size changed."); const body = await handle.readFile(); const actual = createHash("sha256").update(body).digest("hex"); if (actual !== owned.sha256) fail("INSTALL_RUNNER_STALE", "Runner hash changed."); return { ...evidence, path: candidate, sha256: actual, ...(evidence.bytes === undefined ? {} : { bytes: info.size }) }; } finally { await handle.close(); }
  }
}

export interface CurrentReleaseOptions { readonly repositoryRoot: string; readonly assetPaths?: readonly string[] }
async function withCurrentReleaseSource<T>(options: CurrentReleaseOptions, action: (sourceDirectory: string) => Promise<T>): Promise<T> {
  const assets = options.assetPaths ?? ["bin", "content", "packages/subagents/dist", "runtimes", "LICENSE", "LICENSE.md"];
  const staging = await mkdtemp(path.join(tmpdir(), "mpx-current-release-"));
  try {
    for (const asset of [...assets].sort()) {
      if (!safeRelative(asset)) fail("INSTALL_RELEASE_PATH_ESCAPE", "Unsafe repository asset path.");
      const source = path.join(options.repositoryRoot, ...asset.split("/")); const info = await lstat(source).catch((failure) => { if ((failure as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw failure; }); if (!info) continue;
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) fail("INSTALL_RELEASE_UNSAFE_ENTRY", "Repository asset is unsafe.");
      const destination = path.join(staging, ...asset.split("/")); if (info.isFile()) { await mkdir(path.dirname(destination), { recursive: true }); await copyFile(source, destination); } else { const entries = await walk(source); for (const entry of entries) { const target = path.join(destination, ...entry.path.split("/")); await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(source, ...entry.path.split("/")), target); } }
    }
    return await action(staging);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
export async function buildCurrentReleaseManifest(options: CurrentReleaseOptions): Promise<ReleaseManifestV1> {
  return withCurrentReleaseSource(options, buildReleaseManifest);
}
export async function publishCurrentRelease(options: CurrentReleaseOptions & { readonly appsRoot: string }): Promise<ReleaseManifestV1> {
  return withCurrentReleaseSource(options, sourceDirectory => publishRelease({ sourceDirectory, appsRoot: options.appsRoot }));
}
export function mutableStateRoots(environment: NodeJS.ProcessEnv = process.env): readonly string[] { const roots = [environment.APPDATA, environment.LOCALAPPDATA].filter((x): x is string => Boolean(x)); if (roots.length !== 2) fail("INSTALL_MUTABLE_ROOT_UNAVAILABLE", "APPDATA and LOCALAPPDATA are required."); return roots; }
export async function writeActiveRelease(localAppData: string, releaseKey: string): Promise<void> { if (!SHA.test(releaseKey)) fail("INSTALL_SELECTOR_INVALID", "Release key is invalid."); const directory = path.join(localAppData, "mpx"), file = path.join(directory, "active-release"), temporary = `${file}.${randomUUID()}.tmp`; await mkdir(directory, { recursive: true }); try { await writeFile(temporary, `${releaseKey}\n`, { flag: "wx", mode: 0o600 }); await rename(temporary, file); } finally { await rm(temporary, { force: true }); } }
export async function removeActiveRelease(localAppData: string, expectedReleaseKey: string): Promise<void> {
  const actual = await readActiveRelease(localAppData);
  if (actual !== expectedReleaseKey) fail("INSTALL_FOREIGN_OR_DRIFTED", "Refusing to remove a drifted active release selector.");
  await rm(path.join(localAppData, "mpx", "active-release"));
}
export async function readActiveRelease(localAppData: string): Promise<string> { const file = path.join(localAppData, "mpx", "active-release"); const info = await lstat(file).catch(() => fail("INSTALL_SELECTOR_UNAVAILABLE", "Active release selector is unavailable.")); if (!info.isFile() || info.isSymbolicLink()) fail("INSTALL_SELECTOR_UNAVAILABLE", "Active release selector is unsafe."); const key = (await readFile(file, "utf8")).trim(); if (!SHA.test(key)) fail("INSTALL_SELECTOR_UNAVAILABLE", "Active release selector is invalid."); return key; }
