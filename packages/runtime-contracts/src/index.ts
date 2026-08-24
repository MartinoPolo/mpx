import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
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
interface ArtifactMetadata { schemaVersion: 1; reference: RuntimeSkillArtifactReferenceV4; fileMap: RuntimeArtifactFile[] }
export interface PublishedRuntimeArtifact { readonly directory: string; readonly reference: RuntimeSkillArtifactReferenceV4; readonly fileMap: readonly RuntimeArtifactFile[]; readonly reused: boolean }
const METADATA = ".mpx-runtime-artifact.json";

function portable(relative: string): string { return relative.split(path.sep).join("/"); }
function within(candidate: string, root: string): boolean { const rel = path.relative(root, candidate); return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)); }
async function scanFiles(root: string, omitMetadata = false): Promise<Array<{ relative: string; absolute: string }>> {
  const rootStat = await lstat(root).catch(() => fail("SOURCE_MISSING", `directory does not exist: ${root}`));
  if (rootStat.isSymbolicLink()) fail("SOURCE_SYMLINK", "source or artifact root may not be a symlink");
  if (!rootStat.isDirectory()) fail("INVALID_DIRECTORY", "artifact source must be a directory");
  const realRoot = await realpath(root); const files: Array<{ relative: string; absolute: string }> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name); const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) fail("SOURCE_SYMLINK", `symlink is forbidden: ${portable(path.relative(root, absolute))}`);
      const resolved = await realpath(absolute); if (!within(resolved, realRoot)) fail("SOURCE_ESCAPE", "source entry escapes its root");
      if (stat.isDirectory()) await visit(absolute);
      else if (stat.isFile()) { const relative = portable(path.relative(root, absolute)); if (!omitMetadata || relative !== METADATA) files.push({ relative, absolute }); }
      else fail("SOURCE_SPECIAL_FILE", "only regular files and directories may be published");
    }
  }
  await visit(root); return files.sort((a, b) => a.relative.localeCompare(b.relative));
}
async function mapFiles(root: string, omitMetadata = false): Promise<RuntimeArtifactFile[]> {
  const result: RuntimeArtifactFile[] = [];
  for (const file of await scanFiles(root, omitMetadata)) {
    const content = await readFile(file.absolute); const current = await lstat(file.absolute);
    if (!current.isFile() || current.isSymbolicLink()) fail("SOURCE_CHANGED", `source changed while reading: ${file.relative}`);
    result.push({ path: file.relative, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.byteLength });
  }
  return result;
}
function referenceFor(runtimeName: RuntimeName, manifestKey: string, fileMap: readonly RuntimeArtifactFile[]): RuntimeSkillArtifactReferenceV4 {
  const fileMapHash = hash(fileMap); const artifactKey = hash({ schemaVersion: 4, runtime: runtimeName, manifestKey, fileMapHash });
  return createRuntimeSkillArtifactReferenceV4({ runtime: runtimeName, manifestKey, artifactKey, fileMapHash });
}
function metadata(reference: RuntimeSkillArtifactReferenceV4, fileMap: readonly RuntimeArtifactFile[]): ArtifactMetadata { return { schemaVersion: 1, reference, fileMap: [...fileMap] }; }
function same(left: unknown, right: unknown): boolean { return stable(left) === stable(right); }

export async function revalidateRuntimeArtifact(directory: string, expected: RuntimeSkillArtifactReferenceV4): Promise<{ valid: boolean; diagnostics: RuntimeContractDiagnostic[] }> {
  const diagnostics: RuntimeContractDiagnostic[] = [];
  try {
    const stat = await lstat(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) fail("ARTIFACT_SYMLINK", "artifact destination must be a real directory");
    const stored = JSON.parse(await readFile(path.join(directory, METADATA), "utf8")) as ArtifactMetadata;
    const files = await mapFiles(directory, true); const calculated = referenceFor(expected.runtime, expected.manifestKey, files);
    if (!same(stored, metadata(expected, files)) || !same(calculated, expected)) diagnostics.push({ code: "ARTIFACT_FILE_MAP_CHANGED", message: "runtime artifact files or metadata no longer match the launch binding", restartRequired: true });
  } catch (error) {
    diagnostics.push({ code: "ARTIFACT_FILE_MAP_CHANGED", message: error instanceof Error ? error.message : "runtime artifact cannot be validated", restartRequired: true });
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

export async function publishRuntimeArtifact(input: { sourceRoot: string; artifactsRoot: string; runtime: RuntimeName; manifestKey: string }): Promise<PublishedRuntimeArtifact> {
  const fileMap = await mapFiles(input.sourceRoot); const reference = referenceFor(runtime(input.runtime), text(input.manifestKey, "manifestKey"), fileMap);
  await mkdir(input.artifactsRoot, { recursive: true }); const rootStat = await lstat(input.artifactsRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("ARTIFACT_ROOT_INVALID", "artifact root must be a real directory");
  const destination = path.join(input.artifactsRoot, reference.artifactKey);
  const existing = await lstat(destination).catch(() => undefined);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) fail("ARTIFACT_DESTINATION_INVALID", "existing artifact destination is not a real directory");
    const validation = await revalidateRuntimeArtifact(destination, reference);
    if (!validation.valid) fail("ARTIFACT_MISMATCH", "existing artifact destination is not exactly equal to the requested artifact");
    return { directory: destination, reference, fileMap, reused: true };
  }
  const temporary = path.join(input.artifactsRoot, `.${reference.artifactKey}.tmp-${randomUUID()}`);
  await mkdir(temporary);
  try {
    for (const file of await scanFiles(input.sourceRoot)) { const target = path.join(temporary, ...file.relative.split("/")); await mkdir(path.dirname(target), { recursive: true }); await copyFile(file.absolute, target); }
    const copiedMap = await mapFiles(temporary); if (!same(copiedMap, fileMap)) fail("SOURCE_CHANGED", "source changed while the artifact was copied");
    await writeFile(path.join(temporary, METADATA), `${stable(metadata(reference, fileMap))}\n`, { flag: "wx" });
    try { await rename(temporary, destination); }
    catch (error) {
      const raced = await lstat(destination).catch(() => undefined);
      if (!raced) throw error;
      const validation = await revalidateRuntimeArtifact(destination, reference);
      if (!validation.valid) fail("ARTIFACT_MISMATCH", "concurrent artifact destination does not exactly match");
      await rm(temporary, { recursive: true });
      return { directory: destination, reference, fileMap, reused: true };
    }
    return { directory: destination, reference, fileMap, reused: false };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

export async function validateRuntimeContext(input: { context: RuntimeContextV1; expectedLaunch: { launchKey: string; descriptorDigest: string }; expectedManifestKey: string; expectedRuntimeArtifact?: RuntimeSkillArtifactReferenceV4; currentBinding: RuntimeBinding; artifactDirectory?: string }): Promise<{ valid: boolean; diagnostics: RuntimeContractDiagnostic[] }> {
  const context = parseRuntimeContextV1(input.context); const current = parseBinding(input.currentBinding); const diagnostics: RuntimeContractDiagnostic[] = [];
  const add = (code: string, message: string, restartRequired = true): void => { diagnostics.push({ code, message, restartRequired }); };
  if (context.launchKey !== input.expectedLaunch.launchKey || context.launchDescriptor.digest !== input.expectedLaunch.descriptorDigest) add("LAUNCH_BINDING_CHANGED", "launch descriptor binding changed");
  if (context.manifestKey !== input.expectedManifestKey || context.runtimeArtifact.manifestKey !== input.expectedManifestKey) add("MANIFEST_BINDING_CHANGED", "resolved manifest binding changed");
  if (input.expectedRuntimeArtifact !== undefined && !same(context.runtimeArtifact, parseRuntimeSkillArtifactReferenceV4(input.expectedRuntimeArtifact))) add("ARTIFACT_BINDING_CHANGED", "runtime artifact reference changed");
  if (context.binding.projectId !== current.projectId) add("PROJECT_CHANGED", "project binding changed");
  if (context.binding.repositoryId !== current.repositoryId) add("REPOSITORY_CHANGED", "repository binding changed");
  if (context.binding.contentScope !== current.contentScope) add("CONTENT_SCOPE_CHANGED", "content-scope binding changed");
  if (input.artifactDirectory !== undefined) diagnostics.push(...(await revalidateRuntimeArtifact(input.artifactDirectory, context.runtimeArtifact)).diagnostics);
  return { valid: diagnostics.length === 0, diagnostics };
}
