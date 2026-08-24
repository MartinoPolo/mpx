import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, opendir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const RESOLVED_SKILL_MANIFEST_SCHEMA_VERSION = 4 as const;
export const RUNTIME_SKILL_ARTIFACT_SCHEMA_VERSION = 4 as const;
export const RUNTIME_CONTEXT_SCHEMA_VERSION = 1 as const;
export const RUNTIME_CONTRACT_ERROR_SCHEMA_VERSION = 1 as const;

export type RuntimeName = "claude" | "pi";
export type SkillExposure = "full" | "name-only" | "explicit-only" | "off";
export interface RuntimeBinding { readonly projectId: string | null; readonly repositoryId: string; readonly contentScope: string }
export interface ResolvedSkillDecisionV4 {
  readonly identity: string;
  readonly included: boolean;
  readonly exclusionReasons: readonly string[];
  readonly exposure: SkillExposure;
  readonly permissions: { readonly humanInvocation: boolean; readonly modelInvocation: boolean };
  readonly metadataHash: string;
  readonly sourceHash: string;
}
export interface ResolvedSkillManifestV4 {
  readonly schemaVersion: typeof RESOLVED_SKILL_MANIFEST_SCHEMA_VERSION;
  readonly manifestKey: string;
  readonly binding: RuntimeBinding;
  readonly decisions: readonly ResolvedSkillDecisionV4[];
}
export interface RuntimeSkillArtifactReferenceV4 {
  readonly schemaVersion: typeof RUNTIME_SKILL_ARTIFACT_SCHEMA_VERSION;
  readonly runtime: RuntimeName;
  readonly manifestKey: string;
  readonly artifactKey: string;
  readonly fileMapHash: string;
}
export interface RuntimeContextV1 {
  readonly schemaVersion: typeof RUNTIME_CONTEXT_SCHEMA_VERSION;
  readonly launchKey: string;
  readonly launchDescriptor: { readonly reference: string; readonly digest: string };
  readonly manifestKey: string;
  readonly runtimeArtifact: RuntimeSkillArtifactReferenceV4;
  readonly binding: RuntimeBinding;
}

export interface RuntimeContractDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly restartRequired: boolean;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}
export class RuntimeContractError extends Error {
  readonly schemaVersion = RUNTIME_CONTRACT_ERROR_SCHEMA_VERSION;
  constructor(readonly code: string, message: string, readonly details?: Readonly<Record<string, string | number | boolean | null>>) {
    super(`${code}: ${message}`);
    this.name = "RuntimeContractError";
  }
  toJSON(): { schemaVersion: 1; code: string; message: string; details?: Readonly<Record<string, string | number | boolean | null>> } {
    return { schemaVersion: this.schemaVersion, code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) };
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex"); }
function fail(code: string, message: string, details?: Readonly<Record<string, string | number | boolean | null>>): never { throw new RuntimeContractError(code, message, details); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("INVALID_CONTRACT", `${label} must be an object`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !expected.includes(key));
  if (extras.length) fail("UNKNOWN_FIELD", `${label} contains unknown field '${extras[0]}'`, { field: extras[0]! });
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) fail("INVALID_CONTRACT", `${label} is missing '${missing[0]}'`, { field: missing[0]! });
}
function text(value: unknown, label: string): string { if (typeof value !== "string" || value.length === 0) return fail("INVALID_CONTRACT", `${label} must be a non-empty string`); return value; }
function parseBinding(value: unknown): RuntimeBinding {
  const item = record(value, "binding"); exactKeys(item, ["projectId", "repositoryId", "contentScope"], "binding");
  if (item.projectId !== null && typeof item.projectId !== "string") fail("INVALID_CONTRACT", "binding.projectId must be a string or null");
  return { projectId: item.projectId as string | null, repositoryId: text(item.repositoryId, "binding.repositoryId"), contentScope: text(item.contentScope, "binding.contentScope") };
}
function runtime(value: unknown): RuntimeName { if (value !== "claude" && value !== "pi") return fail("INVALID_CONTRACT", "runtime must be claude or pi"); return value; }
function relativeReference(value: unknown): string {
  const reference = text(value, "launchDescriptor.reference");
  if (path.isAbsolute(reference) || /^[A-Za-z]:[\\/]/u.test(reference)) fail("PUBLIC_ABSOLUTE_PATH", "launch descriptor references must be portable relative paths");
  return reference.replaceAll("\\", "/");
}

export function createResolvedSkillManifestV4(input: { binding: RuntimeBinding; decisions: readonly ResolvedSkillDecisionV4[] }): ResolvedSkillManifestV4 {
  const binding = parseBinding(input.binding);
  const decisions = input.decisions.map((decision) => ({
    identity: text(decision.identity, "decision.identity"), included: decision.included,
    exclusionReasons: [...decision.exclusionReasons].sort(), exposure: decision.exposure,
    permissions: { humanInvocation: decision.permissions.humanInvocation, modelInvocation: decision.permissions.modelInvocation },
    metadataHash: text(decision.metadataHash, "decision.metadataHash"), sourceHash: text(decision.sourceHash, "decision.sourceHash"),
  })).sort((left, right) => left.identity.localeCompare(right.identity));
  const tuple = { schemaVersion: RESOLVED_SKILL_MANIFEST_SCHEMA_VERSION, binding, decisions };
  return { ...tuple, manifestKey: hash(tuple) };
}

export function parseResolvedSkillManifestV4(value: unknown): ResolvedSkillManifestV4 {
  const item = record(value, "manifest"); exactKeys(item, ["schemaVersion", "manifestKey", "binding", "decisions"], "manifest");
  if (item.schemaVersion !== RESOLVED_SKILL_MANIFEST_SCHEMA_VERSION) fail("UNKNOWN_SCHEMA_VERSION", `unsupported resolved manifest schema version '${String(item.schemaVersion)}'`);
  if (!Array.isArray(item.decisions)) fail("INVALID_CONTRACT", "manifest.decisions must be an array");
  const decisions = item.decisions.map((value, index): ResolvedSkillDecisionV4 => {
    const decision = record(value, `decision[${index}]`); exactKeys(decision, ["identity", "included", "exclusionReasons", "exposure", "permissions", "metadataHash", "sourceHash"], `decision[${index}]`);
    if (typeof decision.included !== "boolean" || !Array.isArray(decision.exclusionReasons) || decision.exclusionReasons.some((reason) => typeof reason !== "string")) fail("INVALID_CONTRACT", `decision[${index}] inclusion fields are invalid`);
    if (!["full", "name-only", "explicit-only", "off"].includes(decision.exposure as string)) fail("INVALID_CONTRACT", `decision[${index}].exposure is invalid`);
    const permissions = record(decision.permissions, `decision[${index}].permissions`); exactKeys(permissions, ["humanInvocation", "modelInvocation"], `decision[${index}].permissions`);
    if (typeof permissions.humanInvocation !== "boolean" || typeof permissions.modelInvocation !== "boolean") fail("INVALID_CONTRACT", `decision[${index}].permissions must be booleans`);
    return { identity: text(decision.identity, `decision[${index}].identity`), included: decision.included, exclusionReasons: decision.exclusionReasons as string[], exposure: decision.exposure as SkillExposure, permissions: { humanInvocation: permissions.humanInvocation, modelInvocation: permissions.modelInvocation }, metadataHash: text(decision.metadataHash, `decision[${index}].metadataHash`), sourceHash: text(decision.sourceHash, `decision[${index}].sourceHash`) };
  });
  const parsed = createResolvedSkillManifestV4({ binding: parseBinding(item.binding), decisions });
  if (text(item.manifestKey, "manifest.manifestKey") !== parsed.manifestKey) fail("MANIFEST_KEY_MISMATCH", "resolved manifest content does not match its manifest key");
  return parsed;
}

export function createRuntimeSkillArtifactReferenceV4(input: Omit<RuntimeSkillArtifactReferenceV4, "schemaVersion">): RuntimeSkillArtifactReferenceV4 {
  return { schemaVersion: RUNTIME_SKILL_ARTIFACT_SCHEMA_VERSION, runtime: runtime(input.runtime), manifestKey: text(input.manifestKey, "manifestKey"), artifactKey: text(input.artifactKey, "artifactKey"), fileMapHash: text(input.fileMapHash, "fileMapHash") };
}
export function parseRuntimeSkillArtifactReferenceV4(value: unknown): RuntimeSkillArtifactReferenceV4 {
  const item = record(value, "runtimeArtifact"); exactKeys(item, ["schemaVersion", "runtime", "manifestKey", "artifactKey", "fileMapHash"], "runtimeArtifact");
  if (item.schemaVersion !== RUNTIME_SKILL_ARTIFACT_SCHEMA_VERSION) fail("UNKNOWN_SCHEMA_VERSION", `unsupported runtime artifact schema version '${String(item.schemaVersion)}'`);
  return createRuntimeSkillArtifactReferenceV4({ runtime: runtime(item.runtime), manifestKey: text(item.manifestKey, "runtimeArtifact.manifestKey"), artifactKey: text(item.artifactKey, "runtimeArtifact.artifactKey"), fileMapHash: text(item.fileMapHash, "runtimeArtifact.fileMapHash") });
}
export function createRuntimeContextV1(input: Omit<RuntimeContextV1, "schemaVersion"> | RuntimeContextV1): RuntimeContextV1 {
  const artifact = parseRuntimeSkillArtifactReferenceV4(input.runtimeArtifact);
  const manifestKey = text(input.manifestKey, "manifestKey");
  if (artifact.manifestKey !== manifestKey) fail("BINDING_MISMATCH", "runtime artifact and context manifest keys differ");
  return { schemaVersion: RUNTIME_CONTEXT_SCHEMA_VERSION, launchKey: text(input.launchKey, "launchKey"), launchDescriptor: { reference: relativeReference(input.launchDescriptor.reference), digest: text(input.launchDescriptor.digest, "launchDescriptor.digest") }, manifestKey, runtimeArtifact: artifact, binding: parseBinding(input.binding) };
}
export function parseRuntimeContextV1(value: unknown): RuntimeContextV1 {
  const item = record(value, "runtimeContext"); exactKeys(item, ["schemaVersion", "launchKey", "launchDescriptor", "manifestKey", "runtimeArtifact", "binding"], "runtimeContext");
  if (item.schemaVersion !== RUNTIME_CONTEXT_SCHEMA_VERSION) fail("UNKNOWN_SCHEMA_VERSION", `unsupported runtime context schema version '${String(item.schemaVersion)}'`);
  const descriptor = record(item.launchDescriptor, "launchDescriptor"); exactKeys(descriptor, ["reference", "digest"], "launchDescriptor");
  return createRuntimeContextV1({ launchKey: text(item.launchKey, "launchKey"), launchDescriptor: { reference: relativeReference(descriptor.reference), digest: text(descriptor.digest, "launchDescriptor.digest") }, manifestKey: text(item.manifestKey, "manifestKey"), runtimeArtifact: parseRuntimeSkillArtifactReferenceV4(item.runtimeArtifact), binding: parseBinding(item.binding) });
}

export type RuntimeProjectionExecutor<TProjection, TResult = TProjection> = (projection: TProjection) => TResult | Promise<TResult>;
export interface RuntimeProjectionBuilder<TProjection, TResult = TProjection> {
  readonly runtime: RuntimeName;
  project(manifest: ResolvedSkillManifestV4, executor: RuntimeProjectionExecutor<TProjection, TResult>): Promise<TResult>;
}
export interface RuntimeAdapter<TContext = RuntimeContextV1, TResult = unknown> {
  readonly runtime: RuntimeName;
  launch(context: TContext): TResult | Promise<TResult>;
}

export interface RuntimeArtifactFile { readonly path: string; readonly sha256: string; readonly bytes: number }
export interface RuntimeProjectionLaunchBinding {
  readonly launchKey: string;
  readonly descriptorDigest: string;
  readonly runtimeArtifactKey: string;
  readonly runtime: RuntimeName;
  readonly manifestKey: string;
}
export interface PublishedRuntimeArtifactReference {
  readonly projectionKey: string;
  readonly launchBinding: RuntimeProjectionLaunchBinding;
  readonly fileMapHash: string;
}
export interface RuntimeArtifactInventoryLimits {
  readonly maxFileCount: number; readonly maxFileBytes: number; readonly maxAggregateBytes: number;
  readonly maxDirectoryCount?: number; readonly maxDepth?: number;
}
export const DEFAULT_RUNTIME_ARTIFACT_INVENTORY_LIMITS = Object.freeze({ maxFileCount: 10_000, maxFileBytes: 16 * 1024 * 1024, maxAggregateBytes: 256 * 1024 * 1024, maxDirectoryCount: 1_024, maxDepth: 32 });
interface ResolvedRuntimeArtifactInventoryLimits { maxFileCount: number; maxFileBytes: number; maxAggregateBytes: number; maxDirectoryCount: number; maxDepth: number }
interface ArtifactMetadata { schemaVersion: 1; reference: PublishedRuntimeArtifactReference; fileMap: RuntimeArtifactFile[] }
interface InventoryFile { relative: string; absolute: string; bytes: number; mtimeMs: number; device: number; inode: number; content: Buffer; sha256: string }
export interface PublishedRuntimeArtifact { readonly directory: string; readonly reference: PublishedRuntimeArtifactReference; readonly fileMap: readonly RuntimeArtifactFile[]; readonly reused: boolean }
const METADATA = ".mpx-runtime-artifact.json";
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

function portable(relative: string): string { return relative.split(path.sep).join("/"); }
function within(candidate: string, root: string): boolean { const rel = path.relative(root, candidate); return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)); }
function positiveLimit(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 0) fail("INVALID_CONTRACT", `${label} must be a non-negative safe integer`); return value; }
function parseLimits(value: RuntimeArtifactInventoryLimits | undefined): ResolvedRuntimeArtifactInventoryLimits {
  const limits = value ?? DEFAULT_RUNTIME_ARTIFACT_INVENTORY_LIMITS;
  return {
    maxFileCount: positiveLimit(limits.maxFileCount, "maxFileCount"), maxFileBytes: positiveLimit(limits.maxFileBytes, "maxFileBytes"),
    maxAggregateBytes: positiveLimit(limits.maxAggregateBytes, "maxAggregateBytes"), maxDirectoryCount: positiveLimit(limits.maxDirectoryCount ?? DEFAULT_RUNTIME_ARTIFACT_INVENTORY_LIMITS.maxDirectoryCount, "maxDirectoryCount"),
    maxDepth: positiveLimit(limits.maxDepth ?? DEFAULT_RUNTIME_ARTIFACT_INVENTORY_LIMITS.maxDepth, "maxDepth"),
  };
}
function parseLaunchBinding(value: RuntimeProjectionLaunchBinding): RuntimeProjectionLaunchBinding {
  const item = record(value, "launchBinding"); exactKeys(item, ["launchKey", "descriptorDigest", "runtimeArtifactKey", "runtime", "manifestKey"], "launchBinding");
  return { launchKey: text(item.launchKey, "launchBinding.launchKey"), descriptorDigest: text(item.descriptorDigest, "launchBinding.descriptorDigest"), runtimeArtifactKey: text(item.runtimeArtifactKey, "launchBinding.runtimeArtifactKey"), runtime: runtime(item.runtime), manifestKey: text(item.manifestKey, "launchBinding.manifestKey") };
}
function digest(value: unknown, label: string): string { const result = text(value, label); if (!SHA256.test(result)) fail("INVALID_CONTRACT", `${label} must be a lowercase SHA-256 digest`); return result; }
function parsePublishedReference(value: PublishedRuntimeArtifactReference): PublishedRuntimeArtifactReference {
  const item = record(value, "reference"); exactKeys(item, ["projectionKey", "launchBinding", "fileMapHash"], "reference");
  return { projectionKey: digest(item.projectionKey, "reference.projectionKey"), launchBinding: parseLaunchBinding(item.launchBinding as RuntimeProjectionLaunchBinding), fileMapHash: digest(item.fileMapHash, "reference.fileMapHash") };
}
function safePortablePath(value: unknown, label: string): string {
  const result = text(value, label); const segments = result.split("/");
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
  if (result.length > 1_024 || result !== result.normalize("NFC") || result.includes("\\") || path.posix.isAbsolute(result) || segments.some(segment => !segment || segment === "." || segment === ".." || reserved.test(segment) || /[\u0000-\u001f<>:"|?*]/u.test(segment) || /[ .]$/u.test(segment))) fail("INVALID_CONTRACT", `${label} must be a safe portable relative path`);
  return result;
}
function comparePortable(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean { return left.dev === right.dev && left.ino === right.ino; }
async function exactHandleRead(file: string, maximumBytes: number, changedCode: string, description: string, expected?: { bytes: number; mtimeMs: number; device: number; inode: number }): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const initial = await handle.stat(); const linked = await lstat(file);
    if (!initial.isFile() || linked.isSymbolicLink() || !linked.isFile() || !sameIdentity(initial, linked) || initial.size > maximumBytes || expected && (initial.size !== expected.bytes || initial.mtimeMs !== expected.mtimeMs || initial.dev !== expected.device || initial.ino !== expected.inode)) fail(changedCode, `${description} is oversized, replaced, or not a regular file`);
    const content = Buffer.alloc(initial.size); let offset = 0;
    while (offset < content.length) { const read = await handle.read(content, offset, content.length - offset, offset); if (read.bytesRead === 0) fail(changedCode, `${description} changed while reading`); offset += read.bytesRead; }
    if ((await handle.read(Buffer.alloc(1), 0, 1, initial.size)).bytesRead !== 0) fail(changedCode, `${description} grew while reading`);
    const final = await handle.stat(); const finalLinked = await lstat(file);
    if (!sameIdentity(initial, final) || !sameIdentity(final, finalLinked) || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || finalLinked.isSymbolicLink()) fail(changedCode, `${description} changed while reading`);
    return content;
  } finally { await handle.close(); }
}
function parseMetadata(value: unknown, limits: ResolvedRuntimeArtifactInventoryLimits): ArtifactMetadata {
  const item = record(value, "metadata"); exactKeys(item, ["schemaVersion", "reference", "fileMap"], "metadata");
  if (item.schemaVersion !== 1 || !Array.isArray(item.fileMap)) fail("INVALID_CONTRACT", "artifact metadata has an unsupported shape");
  if (item.fileMap.length > limits.maxFileCount) fail("MAX_FILE_COUNT", "artifact metadata exceeds the configured file count");
  const seen = new Set<string>(); const directories = new Set<string>(); let aggregateBytes = 0; let previous = "";
  const fileMap = item.fileMap.map((value, index) => {
    const file = record(value, `fileMap[${index}]`); exactKeys(file, ["path", "sha256", "bytes"], `fileMap[${index}]`);
    const relative = safePortablePath(file.path, `fileMap[${index}].path`); const portableIdentity = relative.toLowerCase(); const bytes = positiveLimit(file.bytes as number, `fileMap[${index}].bytes`);
    if (seen.has(portableIdentity) || previous && comparePortable(previous, relative) >= 0) fail("INVALID_CONTRACT", "artifact file map paths must be unique and sorted"); seen.add(portableIdentity); previous = relative;
    if (bytes > limits.maxFileBytes) fail("MAX_FILE_BYTES", "artifact metadata exceeds the configured per-file byte limit"); aggregateBytes += bytes;
    if (aggregateBytes > limits.maxAggregateBytes) fail("MAX_AGGREGATE_BYTES", "artifact metadata exceeds the configured aggregate byte limit");
    const segments = relative.split("/"); if (segments.length - 1 > limits.maxDepth) fail("MAX_DEPTH", "artifact metadata exceeds the configured depth");
    for (let depth = 1; depth < segments.length; depth += 1) directories.add(segments.slice(0, depth).join("/"));
    if (directories.size > limits.maxDirectoryCount) fail("MAX_DIRECTORY_COUNT", "artifact metadata exceeds the configured directory count");
    return { path: relative, sha256: digest(file.sha256, `fileMap[${index}].sha256`), bytes };
  });
  return { schemaVersion: 1, reference: parsePublishedReference(item.reference as PublishedRuntimeArtifactReference), fileMap };
}
async function boundedRead(file: Omit<InventoryFile, "content" | "sha256">): Promise<Buffer> { return exactHandleRead(file.absolute, file.bytes, "SOURCE_CHANGED", `source file ${file.relative}`, file); }
async function inventoryFiles(root: string, omitMetadata = false, configuredLimits?: RuntimeArtifactInventoryLimits): Promise<InventoryFile[]> {
  const limits = parseLimits(configuredLimits); const rootStat = await lstat(root).catch(() => fail("SOURCE_MISSING", `directory does not exist: ${root}`));
  if (rootStat.isSymbolicLink()) fail("SOURCE_SYMLINK", "source or artifact root may not be a symlink");
  if (!rootStat.isDirectory()) fail("INVALID_DIRECTORY", "artifact source must be a directory");
  const realRoot = await realpath(root); const discovered: Array<Omit<InventoryFile, "content" | "sha256">> = []; const portableEntries = new Set<string>(); let aggregateBytes = 0, directoryCount = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const absolute = path.join(directory, entry.name); const stat = await lstat(absolute); const relative = safePortablePath(portable(path.relative(root, absolute)), "artifact source path"); const portableIdentity = relative.toLowerCase();
      if (portableEntries.has(portableIdentity)) fail("INVALID_CONTRACT", "artifact source paths must be uniquely portable"); portableEntries.add(portableIdentity);
      if (stat.isSymbolicLink()) fail("SOURCE_SYMLINK", `symlink is forbidden: ${relative}`);
      const resolved = await realpath(absolute); if (!within(resolved, realRoot)) fail("SOURCE_ESCAPE", "source entry escapes its root");
      if (stat.isDirectory()) {
        directoryCount += 1; if (directoryCount > limits.maxDirectoryCount) fail("MAX_DIRECTORY_COUNT", "artifact source exceeds the configured directory count", { limit: limits.maxDirectoryCount });
        const childDepth = depth + 1; if (childDepth > limits.maxDepth) fail("MAX_DEPTH", "artifact source exceeds the configured depth", { limit: limits.maxDepth });
        await visit(absolute, childDepth);
      } else if (stat.isFile()) {
        if (omitMetadata && relative === METADATA) continue;
        if (discovered.length + 1 > limits.maxFileCount) fail("MAX_FILE_COUNT", "artifact source exceeds the configured file count", { limit: limits.maxFileCount });
        if (stat.size > limits.maxFileBytes) fail("MAX_FILE_BYTES", `artifact file exceeds the configured byte limit: ${relative}`, { limit: limits.maxFileBytes, bytes: stat.size });
        aggregateBytes += stat.size; if (aggregateBytes > limits.maxAggregateBytes) fail("MAX_AGGREGATE_BYTES", "artifact source exceeds the configured aggregate byte limit", { limit: limits.maxAggregateBytes, bytes: aggregateBytes });
        discovered.push({ relative, absolute, bytes: stat.size, mtimeMs: stat.mtimeMs, device: stat.dev, inode: stat.ino });
      } else fail("SOURCE_SPECIAL_FILE", "only regular files and directories may be published");
    }
  }
  await visit(root, 0); discovered.sort((a, b) => comparePortable(a.relative, b.relative));
  const inventory: InventoryFile[] = [];
  for (const file of discovered) { const content = await boundedRead(file); inventory.push({ ...file, content, sha256: createHash("sha256").update(content).digest("hex") }); }
  return inventory;
}
function fileMapFor(inventory: readonly InventoryFile[]): RuntimeArtifactFile[] { return inventory.map((file) => ({ path: file.relative, sha256: file.sha256, bytes: file.bytes })); }
function referenceFor(launchBinding: RuntimeProjectionLaunchBinding, fileMap: readonly RuntimeArtifactFile[]): PublishedRuntimeArtifactReference {
  const canonicalBinding = parseLaunchBinding(launchBinding); const fileMapHash = hash(fileMap); const projectionKey = hash({ schemaVersion: 1, launchBinding: canonicalBinding, fileMapHash });
  return { projectionKey, launchBinding: canonicalBinding, fileMapHash };
}
function metadata(reference: PublishedRuntimeArtifactReference, fileMap: readonly RuntimeArtifactFile[]): ArtifactMetadata { return { schemaVersion: 1, reference, fileMap: [...fileMap] }; }
function same(left: unknown, right: unknown): boolean { return stable(left) === stable(right); }

export async function revalidateRuntimeArtifact(directory: string, expectedInput: PublishedRuntimeArtifactReference, inventoryLimits?: RuntimeArtifactInventoryLimits): Promise<{ valid: boolean; diagnostics: RuntimeContractDiagnostic[] }> {
  const diagnostics: RuntimeContractDiagnostic[] = [];
  try {
    const limits = parseLimits(inventoryLimits); const expected = parsePublishedReference(expectedInput);
    const stat = await lstat(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) fail("ARTIFACT_SYMLINK", "artifact destination must be a real directory");
    const metadataBytes = await exactHandleRead(path.join(directory, METADATA), MAX_METADATA_BYTES, "INVALID_CONTRACT", "artifact metadata");
    const stored = parseMetadata(JSON.parse(metadataBytes.toString("utf8")) as unknown, limits);
    const files = fileMapFor(await inventoryFiles(directory, true, inventoryLimits)); const calculated = referenceFor(expected.launchBinding, files);
    if (!same(stored, metadata(expected, files)) || !same(calculated, expected)) diagnostics.push({ code: "ARTIFACT_FILE_MAP_CHANGED", message: "runtime artifact files or metadata no longer match the launch binding", restartRequired: true });
  } catch (error) { diagnostics.push({ code: "ARTIFACT_FILE_MAP_CHANGED", message: error instanceof Error ? error.message : "runtime artifact cannot be validated", restartRequired: true }); }
  return { valid: diagnostics.length === 0, diagnostics };
}

export async function publishRuntimeArtifact(input: { sourceRoot: string; artifactsRoot: string; launchBinding: RuntimeProjectionLaunchBinding; inventoryLimits?: RuntimeArtifactInventoryLimits; revalidate?: typeof revalidateRuntimeArtifact }): Promise<PublishedRuntimeArtifact> {
  const revalidate = input.revalidate ?? revalidateRuntimeArtifact;
  const inventory = await inventoryFiles(input.sourceRoot, false, input.inventoryLimits); const fileMap = fileMapFor(inventory); const reference = referenceFor(input.launchBinding, fileMap);
  await mkdir(input.artifactsRoot, { recursive: true }); const rootStat = await lstat(input.artifactsRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("ARTIFACT_ROOT_INVALID", "artifact root must be a real directory");
  const destination = path.join(input.artifactsRoot, reference.projectionKey); const existing = await lstat(destination).catch(() => undefined);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) fail("ARTIFACT_DESTINATION_INVALID", "existing artifact destination is not a real directory");
    const validation = await revalidate(destination, reference, input.inventoryLimits);
    if (!validation.valid) fail("ARTIFACT_MISMATCH", "existing artifact destination is not exactly equal to the requested artifact");
    return { directory: destination, reference, fileMap, reused: true };
  }
  const temporary = path.join(input.artifactsRoot, `.${reference.projectionKey}.tmp-${randomUUID()}`); await mkdir(temporary);
  try {
    for (const file of inventory) { const target = path.join(temporary, ...file.relative.split("/")); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.content, { flag: "wx" }); }
    await writeFile(path.join(temporary, METADATA), `${stable(metadata(reference, fileMap))}\n`, { flag: "wx" });
    try { await rename(temporary, destination); }
    catch (error) {
      const raced = await lstat(destination).catch(() => undefined); if (!raced) throw error;
      const validation = await revalidate(destination, reference, input.inventoryLimits);
      if (!validation.valid) fail("ARTIFACT_MISMATCH", "concurrent artifact destination does not exactly match");
      await rm(temporary, { recursive: true }); return { directory: destination, reference, fileMap, reused: true };
    }
    const validation = await revalidate(destination, reference, input.inventoryLimits);
    if (!validation.valid) fail("ARTIFACT_MISMATCH", "published artifact destination does not exactly match");
    return { directory: destination, reference, fileMap, reused: false };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

export async function validateRuntimeContext(input: { context: RuntimeContextV1; expectedLaunch: { launchKey: string; descriptorDigest: string }; expectedManifestKey: string; expectedRuntimeArtifact?: RuntimeSkillArtifactReferenceV4; currentBinding: RuntimeBinding; artifactDirectory?: string; expectedPublishedArtifact?: PublishedRuntimeArtifactReference }): Promise<{ valid: boolean; diagnostics: RuntimeContractDiagnostic[] }> {
  const context = parseRuntimeContextV1(input.context); const current = parseBinding(input.currentBinding); const diagnostics: RuntimeContractDiagnostic[] = [];
  const add = (code: string, message: string, restartRequired = true): void => { diagnostics.push({ code, message, restartRequired }); };
  if (context.launchKey !== input.expectedLaunch.launchKey || context.launchDescriptor.digest !== input.expectedLaunch.descriptorDigest) add("LAUNCH_BINDING_CHANGED", "launch descriptor binding changed");
  if (context.manifestKey !== input.expectedManifestKey || context.runtimeArtifact.manifestKey !== input.expectedManifestKey) add("MANIFEST_BINDING_CHANGED", "resolved manifest binding changed");
  if (input.expectedRuntimeArtifact !== undefined && !same(context.runtimeArtifact, parseRuntimeSkillArtifactReferenceV4(input.expectedRuntimeArtifact))) add("ARTIFACT_BINDING_CHANGED", "runtime artifact reference changed");
  if (context.binding.projectId !== current.projectId) add("PROJECT_CHANGED", "project binding changed");
  if (context.binding.repositoryId !== current.repositoryId) add("REPOSITORY_CHANGED", "repository binding changed");
  if (context.binding.contentScope !== current.contentScope) add("CONTENT_SCOPE_CHANGED", "content-scope binding changed");
  if (input.artifactDirectory !== undefined) {
    if (input.expectedPublishedArtifact === undefined) add("PUBLISHED_ARTIFACT_BINDING_MISSING", "published projection launch binding is required for revalidation");
    else diagnostics.push(...(await revalidateRuntimeArtifact(input.artifactDirectory, input.expectedPublishedArtifact)).diagnostics);
  }
  return { valid: diagnostics.length === 0, diagnostics };
}
