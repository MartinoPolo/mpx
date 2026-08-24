import { EXPOSURES, SKILL_PACKS, resolveEffectiveSkillPacks, type Exposure, type SkillPack, type SkillPolicyConfig } from "@mpx/config";
import { isPathWithinRoot } from "@mpx/core";
import {
  createResolvedSkillManifestV4,
  createRuntimeSkillArtifactReferenceV4,
  parseResolvedSkillManifestV4,
  parseRuntimeSkillArtifactReferenceV4,
  type ResolvedSkillDecisionV4,
  type ResolvedSkillManifestV4,
  RuntimeContractError,
  type RuntimeSkillArtifactReferenceV4,
} from "@mpx/runtime-contracts";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export { EXPOSURES, SKILL_PACKS, type Exposure, type SkillPack, type SkillPolicyConfig } from "@mpx/config";
export type Runtime = "claude" | "pi";

export interface Diagnostic { code: string; message: string; path?: string }
export class SkillCatalogError extends Error {
  constructor(public readonly diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    this.name = "SkillCatalogError";
  }
}
export interface CanonicalSkill {
  identity: string; description: string; triggers?: string; skillPacks: SkillPack[];
  defaultExposure: Exposure; sourcePath: string; realPath: string; contentHash: string;
}
export interface ProjectSkill {
  identity: string; description: string; projectExposure?: "full" | "explicit-only";
  disableModelInvocation: boolean; sourcePath: string; realPath: string;
}
export interface ExposureSettings { default?: Exposure; skills?: Record<string, Exposure> }
export interface ResolveOptions {
  repositoryId: string; contentScope: string; projectId?: string; enabledPacks: readonly SkillPack[];
  identity: string; skillPolicy: string; skillPolicyConfig: SkillPolicyConfig;
  contentScopeExposure?: ExposureSettings; projectExposure?: ExposureSettings;
  /** Public command-name mapping. It is resolution input and therefore manifest-key material. */
  mapping?: Readonly<Record<string, string>>;
}
export const SKILL_MANIFEST_SCHEMA_VERSION = 4 as const;
export type ResolvedManifest = ResolvedSkillManifestV4;

export interface RuntimeSkillEntry {
  identity: string; publicName: string; packs: SkillPack[]; exposure: Exposure; metadataHash: string;
  description?: string; triggers?: string;
  source: { kind: "canonical"; path: string; realPath: string; contentHash: string };
  permissions: { humanInvocation: boolean; modelInvocation: boolean };
}
export interface RuntimeSkillArtifact {
  schemaVersion: 4; runtime: Runtime; manifestKey: string;
  reference: RuntimeSkillArtifactReferenceV4; entries: RuntimeSkillEntry[];
}

export const MAX_SKILL_SEARCH_QUERY_LENGTH = 200;
export const MAX_SKILL_SEARCH_RESULTS = 20;
export const MAX_HUMAN_SKILL_SEARCH_QUERY_LENGTH = 200;
export const MAX_HUMAN_SKILL_SEARCH_RESULTS = 20;
export const MAX_SKILL_BODY_BYTES = 256 * 1024;
export const MAX_SKILL_DIRECTORY_FILES = 128;
export const MAX_SKILL_DIRECTORY_BYTES = 4 * 1024 * 1024;
export interface SkillDirectoryFile { readonly relativePath: string; readonly bytes: Buffer }

/** Snapshots one validated skill directory without following links or special files. */
export async function enumerateSkillDirectory(directory: string): Promise<readonly SkillDirectoryFile[]> {
  const rootStat = await lstat(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("skill directory must be a regular directory");
  const root = await realpath(directory); const files: SkillDirectoryFile[] = []; let totalBytes = 0;
  const visit = async (current: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = path.join(current, entry.name); const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) throw new Error("skill directory cannot contain symlinks");
      const resolved = await realpath(candidate);
      if (!isPathWithinRoot(resolved, root)) throw new Error("skill directory entry escapes its root");
      if (stat.isDirectory()) await visit(candidate);
      else if (stat.isFile()) {
        if (files.length >= MAX_SKILL_DIRECTORY_FILES) throw new Error("skill directory exceeds file count limit");
        const bytes = await readFile(candidate); totalBytes += bytes.length;
        if (totalBytes > MAX_SKILL_DIRECTORY_BYTES) throw new Error("skill directory exceeds byte limit");
        files.push(Object.freeze({ relativePath: path.relative(root, candidate).split(path.sep).join("/"), bytes }));
      } else throw new Error("skill directory contains a special file");
    }
  };
  await visit(root); return Object.freeze(files);
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const allowedTop = new Set(["name", "description", "triggers", "metadata"]);

function scalar(raw: string): string | boolean | string[] {
  const value = raw.trim();
  if (/[*&!]|<<\s*:/.test(value)) throw new Error("YAML tags, anchors, aliases, and merge keys are forbidden");
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1).split(",").map(x => x.trim().replace(/^['\"]|['\"]$/g, "")).filter(Boolean);
  if (/^(null|~|[-+]?\d|\{|\})/i.test(value)) throw new Error("only strings, booleans, and string arrays are supported");
  return value.replace(/^(['\"])(.*)\1$/, "$2");
}

function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) throw new Error("SKILL.md must start with YAML frontmatter");
  const normalized = text.replace(/\r\n/g, "\n");
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("frontmatter closing delimiter is missing");
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [{ indent: -1, value: root }];
  for (const [index, line] of normalized.slice(4, end).split("\n").entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (line.includes("\t")) throw new Error(`tabs are forbidden at line ${index + 2}`);
    const match = /^( *)([A-Za-z][A-Za-z0-9-]*):(?: +(.*))?$/.exec(line);
    if (!match) throw new Error(`unsupported YAML at line ${index + 2}`);
    const indent = match[1]!.length;
    if (indent % 2) throw new Error(`indentation must use two spaces at line ${index + 2}`);
    while (stack.at(-1)!.indent >= indent) stack.pop();
    if (indent > stack.at(-1)!.indent + 2) throw new Error(`invalid indentation at line ${index + 2}`);
    const parent = stack.at(-1)!.value; const key = match[2]!;
    if (Object.hasOwn(parent, key)) throw new Error(`duplicate YAML key: ${key}`);
    if (match[3] === undefined) { const child: Record<string, unknown> = {}; parent[key] = child; stack.push({ indent, value: child }); }
    else parent[key] = scalar(match[3]);
  }
  return { data: root, body: normalized.slice(end + 5) };
}

async function contained(root: string, candidate: string): Promise<string> {
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  if (!isPathWithinRoot(realCandidate, realRoot)) throw new Error(`source escapes inventory root: ${candidate}`);
  return realCandidate;
}

function parseCanonical(data: Record<string, unknown>, directory: string): { identity: string; description: string; triggers?: string; packs: SkillPack[]; exposure: Exposure } {
  for (const key of Object.keys(data)) if (!allowedTop.has(key)) throw new Error(`unknown frontmatter key: ${key}`);
  const identity = data.name;
  if (typeof identity !== "string" || !ID.test(identity) || identity.includes(":")) throw new Error("name must be a lowercase bare kebab identity");
  if (identity !== directory) throw new Error(`identity ${identity} does not agree with directory ${directory}`);
  if (typeof data.description !== "string" || !data.description.trim()) throw new Error("description is required");
  const metadata = data.metadata as Record<string, unknown> | undefined;
  const mpx = metadata?.mpx as Record<string, unknown> | undefined;
  if (!metadata || Object.keys(metadata).join() !== "mpx" || !mpx || Object.keys(mpx).some(k => !["skillPacks", "defaultExposure"].includes(k))) throw new Error("metadata.mpx with only skillPacks/defaultExposure is required");
  const packs = mpx.skillPacks;
  if (!Array.isArray(packs) || packs.length === 0 || packs.some(p => !SKILL_PACKS.includes(p as SkillPack))) throw new Error("metadata.mpx.skillPacks contains an unknown pack");
  const exposure = mpx.defaultExposure;
  if (!EXPOSURES.includes(exposure as Exposure)) throw new Error("metadata.mpx.defaultExposure is invalid");
  const result = { identity, description: data.description, packs: [...new Set(packs as SkillPack[])].sort(), exposure: exposure as Exposure };
  return typeof data.triggers === "string" ? { ...result, triggers: data.triggers } : result;
}

export async function inventoryCanonical(root: string): Promise<CanonicalSkill[]> {
  const diagnostics: Diagnostic[] = []; const skills: CanonicalSkill[] = []; const byReal = new Set<string>(); const byId = new Map<string, string>();
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "SKILL.md");
    try {
      const real = await contained(root, file);
      if (byReal.has(real)) continue;
      const text = await readFile(real, "utf8"); const parsed = frontmatter(text); const value = parseCanonical(parsed.data, entry.name);
      const previous = byId.get(value.identity);
      if (previous && previous !== real) throw new Error(`identity collides with ${previous}`);
      byId.set(value.identity, real); byReal.add(real);
      skills.push({ identity: value.identity, description: value.description, ...(value.triggers ? { triggers: value.triggers } : {}), skillPacks: value.packs, defaultExposure: value.exposure, sourcePath: file, realPath: real, contentHash: createHash("sha256").update(text).digest("hex") });
    } catch (error) { diagnostics.push({ code: "SKILL_INVALID", message: String((error as Error).message), path: file }); }
  }
  if (diagnostics.length) throw new SkillCatalogError(diagnostics);
  return skills.sort((a,b) => a.identity.localeCompare(b.identity));
}

export interface ProjectSkillDirectoryEntry { readonly name: string; isDirectory(): boolean; isSymbolicLink?(): boolean }
export interface ProjectSkillFileSystem {
  readdir(root: string, options: { withFileTypes: true }): Promise<ProjectSkillDirectoryEntry[]>;
  realpath(file: string): Promise<string>;
  readFile(file: string, encoding: "utf8"): Promise<string>;
}
const projectSkillFileSystem: ProjectSkillFileSystem = {
  readdir: (root, options) => readdir(root, options),
  realpath,
  readFile: (file, encoding) => readFile(file, encoding),
};
function absentInventory(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT" || (error as NodeJS.ErrnoException)?.code === "ENOTDIR"; }
function inventoryIoFailure(error: unknown): boolean { return typeof (error as NodeJS.ErrnoException)?.code === "string" && !absentInventory(error); }
async function containedProject(root: string, candidate: string, filesystem: ProjectSkillFileSystem): Promise<string> {
  const [realRoot, realCandidate] = await Promise.all([filesystem.realpath(root), filesystem.realpath(candidate)]);
  if (!isPathWithinRoot(realCandidate, realRoot)) throw new Error(`source escapes inventory root: ${candidate}`);
  return realCandidate;
}
export async function inventoryProjectSkills(projectRoot: string, canonical: readonly CanonicalSkill[] = [], filesystem: ProjectSkillFileSystem = projectSkillFileSystem): Promise<{ skills: ProjectSkill[]; diagnostics: Diagnostic[] }> {
  const root = path.join(projectRoot, ".agents", "skills"); const diagnostics: Diagnostic[] = []; const skills: ProjectSkill[] = []; const names = new Set(canonical.map(x => x.identity));
  let entries: ProjectSkillDirectoryEntry[];
  try { entries = await filesystem.readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (absentInventory(error)) return { skills, diagnostics };
    throw new SkillCatalogError([{ code: "PROJECT_SKILL_INVENTORY_FAILED", message: String((error as Error).message), path: root }]);
  }
  for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink?.()) { diagnostics.push({ code: "PROJECT_SKILL_INVALID", message: "project skill directories cannot be symlinks", path: path.join(root, entry.name) }); continue; }
    if (!entry.isDirectory()) continue; const file = path.join(root, entry.name, "SKILL.md");
    try {
      const real = await containedProject(root, file, filesystem); const { data } = frontmatter(await filesystem.readFile(real, "utf8"));
      const name = data.name;
      if (typeof name !== "string" || !ID.test(name) || name !== entry.name || name.startsWith("mpx-") || name.includes(":")) throw new Error("project identity is invalid or attempts /mpx:* namespace");
      if (names.has(name) || skills.some(x => x.identity === name)) throw new Error("deterministic runtime collision");
      const mpx = (data.metadata as Record<string, unknown> | undefined)?.mpx as Record<string, unknown> | undefined;
      const exposure = mpx?.projectExposure;
      if (exposure !== "full" && exposure !== "explicit-only") throw new Error("metadata.mpx.projectExposure must be full or explicit-only");
      const disabled = data["disable-model-invocation"] === true;
      if ((exposure === "full" && disabled) || (exposure === "explicit-only" && !disabled)) throw new Error("projectExposure and disable-model-invocation mismatch");
      if (typeof data.description !== "string") throw new Error("description is required");
      skills.push({ identity: name, description: data.description, projectExposure: exposure, disableModelInvocation: disabled, sourcePath: file, realPath: real });
    } catch (error) {
      if (inventoryIoFailure(error)) throw new SkillCatalogError([{ code: "PROJECT_SKILL_INVENTORY_FAILED", message: String((error as Error).message), path: file }]);
      diagnostics.push({ code: "PROJECT_SKILL_INVALID", message: String((error as Error).message), path: file });
    }
  }
  return { skills, diagnostics };
}

function effectiveExposure(skill: CanonicalSkill, options: ResolveOptions): { exposure: Exposure; source: string } {
  const p = options.projectExposure, s = options.contentScopeExposure;
  if (p?.skills?.[skill.identity]) return { exposure: p.skills[skill.identity]!, source: "project skill override" };
  if (p?.default) return { exposure: p.default, source: "project default" };
  if (s?.skills?.[skill.identity]) return { exposure: s.skills[skill.identity]!, source: "content-scope skill override" };
  if (s?.default) return { exposure: s.default, source: "content-scope default" };
  const catalogExposure = { exposure: skill.defaultExposure ?? "name-only", source: skill.defaultExposure ? "canonical default" : "fallback" };
  return catalogExposure;
}

/** Disclosure descends from initial body metadata to name, explicit human lookup, then absence. */
const disclosureRank: Record<Exposure, number> = { full: 3, "name-only": 2, "explicit-only": 1, off: 0 };

function policyExposure(skill: CanonicalSkill, options: ResolveOptions): { exposure: Exposure; source: string } {
  const base = effectiveExposure(skill, options);
  const policy = options.skillPolicyConfig.skillExposure;
  const policyExposure = policy.skills?.[skill.identity] ?? policy.default;
  const policySource = policy.skills?.[skill.identity] ? "skill override" : "default";
  const exposure = disclosureRank[policyExposure] < disclosureRank[base.exposure] ? policyExposure : base.exposure;
  return { exposure, source: `${base.source}; narrowed by skill policy '${options.skillPolicy}' ${policySource} (${policyExposure})` };
}

function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`; return JSON.stringify(value); }

function effectiveSkillPacks(options: ResolveOptions): SkillPack[] {
  return resolveEffectiveSkillPacks({ contentScopeSkillPacks: options.enabledPacks, skillPolicySkillPacks: options.skillPolicyConfig.skillPacks });
}

export function resolveManifest(catalog: readonly CanonicalSkill[], options: ResolveOptions): ResolvedManifest {
  const enabled = new Set(effectiveSkillPacks(options));
  const resolution = {
    identity: options.identity,
    skillPolicy: options.skillPolicy,
    skillPolicyConfig: options.skillPolicyConfig,
    enabledPacks: [...enabled].sort(),
    contentScopeExposure: options.contentScopeExposure ?? null,
    projectExposure: options.projectExposure ?? null,
    mapping: options.mapping ?? {},
  };
  const decisions: ResolvedSkillDecisionV4[] = catalog.map((skill) => {
    const packIncluded = skill.skillPacks.some((pack) => enabled.has(pack));
    const effective = policyExposure(skill, options);
    const off = effective.exposure === "off";
    const included = packIncluded && !off;
    return {
      identity: skill.identity,
      included,
      exclusionReasons: [...(!packIncluded ? ["pack-excluded"] : []), ...(packIncluded && off ? ["off"] : [])],
      exposure: effective.exposure,
      permissions: {
        humanInvocation: included,
        modelInvocation: included && (effective.exposure === "full" || effective.exposure === "name-only"),
      },
      metadataHash: digest({
        resolution,
        identity: skill.identity,
        description: skill.description,
        triggers: skill.triggers ?? null,
        packs: [...skill.skillPacks].sort(),
        defaultExposure: skill.defaultExposure,
        effectiveExposure: effective.exposure,
        exposureSource: effective.source,
      }),
      sourceHash: skill.contentHash,
    };
  });
  return createResolvedSkillManifestV4({
    binding: { projectId: options.projectId ?? null, repositoryId: options.repositoryId, contentScope: options.contentScope },
    decisions,
  });
}

export function explainSkill(skill: CanonicalSkill, options: ResolveOptions): { identity: string; included: boolean; exposure?: Exposure; source?: string } {
  const enabled = new Set(effectiveSkillPacks(options));
  const packIncluded = skill.skillPacks.some((pack) => enabled.has(pack));
  if (!packIncluded) return { identity: skill.identity, included: false };
  const result = policyExposure(skill, options);
  return { identity: skill.identity, included: result.exposure !== "off", exposure: result.exposure, source: result.source };
}

export function doctor(canonical: readonly CanonicalSkill[], project: { skills: ProjectSkill[]; diagnostics: Diagnostic[] }): Diagnostic[] {
  const diagnostics = [...project.diagnostics]; const ids = new Set(canonical.map(x => x.identity));
  for (const skill of project.skills) { if (ids.has(skill.identity)) diagnostics.push({ code: "SKILL_COLLISION", message: `${skill.identity} collides with /mpx:${skill.identity}`, path: skill.sourcePath }); if (skill.projectExposure === "full") diagnostics.push({ code: "PROJECT_SKILL_CONTEXT_COST", message: `${skill.identity} opts its description into initial context`, path: skill.sourcePath }); }
  return diagnostics.sort((a,b) => `${a.code}\0${a.path ?? ""}\0${a.message}`.localeCompare(`${b.code}\0${b.path ?? ""}\0${b.message}`));
}

function digest(value: unknown): string { return createHash("sha256").update(stable(value)).digest("hex"); }
function artifactFileMap(entries: readonly RuntimeSkillEntry[]): unknown[] {
  return entries.map((entry) => ({
    identity: entry.identity,
    publicName: entry.publicName,
    packs: [...entry.packs].sort(),
    exposure: entry.exposure,
    metadataHash: entry.metadataHash,
    description: entry.description ?? null,
    triggers: entry.triggers ?? null,
    source: { kind: entry.source.kind, path: entry.source.path, realPath: entry.source.realPath, contentHash: entry.source.contentHash },
    permissions: { ...entry.permissions },
  })).sort((a,b) => a.identity.localeCompare(b.identity));
}

export function createRuntimeSkillArtifact(manifestValue: ResolvedManifest, catalog: readonly CanonicalSkill[], options: { runtime: Runtime; mapping?: Readonly<Record<string, string>> }): RuntimeSkillArtifact {
  const manifest = parseResolvedSkillManifestV4(manifestValue);
  const source = new Map(catalog.map((skill) => [skill.identity, skill]));
  if (source.size !== manifest.decisions.length) catalogError("STALE_CATALOG", "canonical catalog membership no longer matches the resolved manifest");
  for (const decision of manifest.decisions) {
    if (source.get(decision.identity)?.contentHash !== decision.sourceHash) catalogError("STALE_CATALOG", `skill '${decision.identity}' no longer matches the resolved manifest`);
  }
  const entries = manifest.decisions.filter((decision) => decision.included).map((decision): RuntimeSkillEntry => {
    const skill = source.get(decision.identity)!;
    const publicName = options.mapping?.[skill.identity] ?? `/mpx:${skill.identity}`;
    return {
      identity: skill.identity, publicName, packs: [...skill.skillPacks].sort(), exposure: decision.exposure, metadataHash: decision.metadataHash,
      ...(decision.exposure === "full" ? { description: skill.description, ...(skill.triggers ? { triggers: skill.triggers } : {}) } : {}),
      source: { kind: "canonical", path: skill.sourcePath, realPath: skill.realPath, contentHash: skill.contentHash },
      permissions: { ...decision.permissions },
    };
  }).sort((a,b) => a.identity.localeCompare(b.identity));
  const fileMapHash = digest(artifactFileMap(entries));
  const artifactKey = digest({ schemaVersion: 4, runtime: options.runtime, manifestKey: manifest.manifestKey, fileMapHash });
  const reference = createRuntimeSkillArtifactReferenceV4({ runtime: options.runtime, manifestKey: manifest.manifestKey, artifactKey, fileMapHash });
  const artifact: RuntimeSkillArtifact = { schemaVersion: 4, runtime: options.runtime, manifestKey: manifest.manifestKey, reference, entries };
  return verifyRuntimeSkillArtifact(artifact, manifest, catalog, options);
}

function catalogError(code: string, message: string): never { throw new SkillCatalogError([{ code, message }]); }
function tampered(reason: string, identity?: string): never {
  throw new RuntimeContractError("RUNTIME_ARTIFACT_TAMPERED", "runtime artifact no longer matches its bound resolved manifest", { restartRequired: true, reason, ...(identity === undefined ? {} : { identity }) });
}
function expectedRuntimeEntries(manifest: ResolvedManifest, catalog: readonly CanonicalSkill[], mapping: Readonly<Record<string, string>>): RuntimeSkillEntry[] {
  const source = new Map<string, CanonicalSkill>();
  for (const skill of catalog) { if (source.has(skill.identity)) tampered("duplicate-catalog-identity", skill.identity); source.set(skill.identity, skill); }
  if (source.size !== manifest.decisions.length) tampered("catalog-membership");
  const decisionIds = new Set<string>();
  const entries: RuntimeSkillEntry[] = [];
  for (const decision of manifest.decisions) {
    if (decisionIds.has(decision.identity)) tampered("duplicate-manifest-decision", decision.identity);
    decisionIds.add(decision.identity);
    const skill = source.get(decision.identity);
    if (!skill || skill.contentHash !== decision.sourceHash) tampered("catalog-source-hash", decision.identity);
    if (!decision.included) continue;
    if (decision.exposure === "off" || decision.exclusionReasons.includes("off") || decision.exclusionReasons.includes("pack-excluded")) tampered("invalid-inclusion-decision", decision.identity);
    entries.push({
      identity: skill.identity, publicName: mapping[skill.identity] ?? `/mpx:${skill.identity}`, packs: [...skill.skillPacks].sort(), exposure: decision.exposure, metadataHash: decision.metadataHash,
      ...(decision.exposure === "full" ? { description: skill.description, ...(skill.triggers ? { triggers: skill.triggers } : {}) } : {}),
      source: { kind: "canonical", path: skill.sourcePath, realPath: skill.realPath, contentHash: skill.contentHash }, permissions: { ...decision.permissions },
    });
  }
  return entries.sort((a,b) => a.identity.localeCompare(b.identity));
}
export function verifyRuntimeSkillArtifact(artifact: RuntimeSkillArtifact, manifestValue: ResolvedManifest, catalog: readonly CanonicalSkill[], options: { runtime: Runtime; mapping?: Readonly<Record<string, string>> }): RuntimeSkillArtifact {
  let manifest: ResolvedManifest;
  try { manifest = parseResolvedSkillManifestV4(manifestValue); } catch { return tampered("manifest-invalid"); }
  if (artifact.schemaVersion !== 4 || artifact.runtime !== options.runtime || artifact.manifestKey !== manifest.manifestKey) tampered("artifact-binding");
  const expectedEntries = expectedRuntimeEntries(manifest, catalog, options.mapping ?? {});
  const expectedById = new Map(expectedEntries.map((entry) => [entry.identity, entry]));
  const actualIds = new Set<string>();
  for (const entry of artifact.entries) {
    if (actualIds.has(entry.identity)) tampered("duplicate-entry", entry.identity);
    actualIds.add(entry.identity);
    const expected = expectedById.get(entry.identity);
    if (!expected) tampered("extra-or-excluded-entry", entry.identity);
    for (const field of ["publicName", "packs", "exposure", "metadataHash", "description", "triggers", "source", "permissions"] as const) {
      if (stable(entry[field]) !== stable(expected[field])) tampered(`${field}-mismatch`, entry.identity);
    }
  }
  for (const expected of expectedEntries) if (!actualIds.has(expected.identity)) tampered("missing-entry", expected.identity);
  if (artifact.entries.map((entry) => entry.identity).join("\0") !== expectedEntries.map((entry) => entry.identity).join("\0")) tampered("entry-order");
  const fileMapHash = digest(artifactFileMap(expectedEntries));
  const expectedReference = createRuntimeSkillArtifactReferenceV4({ runtime: options.runtime, manifestKey: manifest.manifestKey, fileMapHash, artifactKey: digest({ schemaVersion: 4, runtime: options.runtime, manifestKey: manifest.manifestKey, fileMapHash }) });
  let reference: RuntimeSkillArtifactReferenceV4;
  try { reference = parseRuntimeSkillArtifactReferenceV4(artifact.reference); } catch { return tampered("reference-invalid"); }
  if (stable(reference) !== stable(expectedReference)) tampered("file-map-binding");
  return artifact;
}

function validateArtifact(artifact: RuntimeSkillArtifact, catalog?: readonly CanonicalSkill[], artifactKey?: string): RuntimeSkillArtifact {
  try {
    if (artifact.schemaVersion !== 4 || artifact.manifestKey !== artifact.reference.manifestKey || artifact.runtime !== artifact.reference.runtime) throw new Error("schema or binding mismatch");
    const reference = parseRuntimeSkillArtifactReferenceV4(artifact.reference);
    const fileMapHash = digest(artifactFileMap(artifact.entries));
    const calculatedKey = digest({ schemaVersion: 4, runtime: artifact.runtime, manifestKey: artifact.manifestKey, fileMapHash });
    if (reference.fileMapHash !== fileMapHash || reference.artifactKey !== calculatedKey || (artifactKey !== undefined && artifactKey !== reference.artifactKey)) throw new Error("artifact hash mismatch");
    if (catalog) {
      const source = new Map(catalog.map((skill) => [skill.identity, skill]));
      for (const entry of artifact.entries) if (source.get(entry.identity)?.contentHash !== entry.source.contentHash) throw new Error("catalog hash mismatch");
    }
    return artifact;
  } catch { return catalogError("STALE_ARTIFACT", "runtime operation requires the current exact v4 artifact"); }
}

export function searchSkills(artifact: RuntimeSkillArtifact, catalog: readonly CanonicalSkill[], query: string, options: { artifactKey?: string; runtime?: boolean; limit?: number } = {}): Array<{ identity: string; publicName: string; description: string; score: number }> {
  if (query.length > MAX_SKILL_SEARCH_QUERY_LENGTH) catalogError("QUERY_TOO_LONG", `skill search queries are limited to ${MAX_SKILL_SEARCH_QUERY_LENGTH} characters`);
  validateArtifact(artifact, catalog, options.runtime ? options.artifactKey : undefined);
  const limit = Math.max(0, Math.min(MAX_SKILL_SEARCH_RESULTS, options.limit ?? MAX_SKILL_SEARCH_RESULTS));
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean); const source = new Map(catalog.map(x => [x.identity, x]));
  return artifact.entries.filter((entry) => (entry.exposure === "full" || entry.exposure === "name-only") && entry.permissions.modelInvocation).flatMap(entry => {
    const skill = source.get(entry.identity); if (!skill) return [];
    const haystack = `${skill.identity} ${skill.description} ${skill.triggers ?? ""}`.toLowerCase();
    const score = terms.reduce((n,t) => n + (haystack.includes(t) ? (skill.identity.includes(t) ? 3 : 1) : 0), 0);
    return [{ identity: skill.identity, publicName: entry.publicName, description: skill.description, score }];
  }).filter(x => terms.length === 0 || x.score > 0).sort((a,b) => b.score-a.score || a.identity.localeCompare(b.identity)).slice(0, limit);
}

export function modelSearchSkills(artifact: RuntimeSkillArtifact, catalog: readonly CanonicalSkill[], query: string, options: { artifactKey: string; limit?: number }): Array<{ identity: string; publicName: string; description: string; score: number }> {
  return searchSkills(artifact, catalog, query, { runtime: true, artifactKey: options.artifactKey, ...(options.limit === undefined ? {} : { limit: options.limit }) });
}

export function humanSearchSkills(artifact: RuntimeSkillArtifact, catalog: readonly CanonicalSkill[], query: string, options: { limit?: number } = {}): Array<{ identity: string; publicName: string; description: string; score: number }> {
  if (query.length > MAX_HUMAN_SKILL_SEARCH_QUERY_LENGTH) catalogError("QUERY_TOO_LONG", `human skill search queries are limited to ${MAX_HUMAN_SKILL_SEARCH_QUERY_LENGTH} characters`);
  validateArtifact(artifact, catalog);
  const limit = Math.max(0, Math.min(MAX_HUMAN_SKILL_SEARCH_RESULTS, options.limit ?? MAX_HUMAN_SKILL_SEARCH_RESULTS));
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean); const source = new Map(catalog.map((skill) => [skill.identity, skill]));
  return artifact.entries.filter((entry) => entry.permissions.humanInvocation).flatMap((entry) => {
    const skill = source.get(entry.identity); if (!skill) return [];
    const haystack = `${skill.identity} ${skill.description} ${skill.triggers ?? ""}`.toLowerCase();
    const score = terms.reduce((total, term) => total + (haystack.includes(term) ? (skill.identity.includes(term) ? 3 : 1) : 0), 0);
    return [{ identity: skill.identity, publicName: entry.publicName, description: skill.description, score }];
  }).filter((result) => terms.length === 0 || result.score > 0).sort((a,b) => b.score-a.score || a.identity.localeCompare(b.identity)).slice(0, limit);
}

export interface HumanSkillName { identity: string; publicName: string }
export function humanListSkills(artifact: RuntimeSkillArtifact): HumanSkillName[] { validateArtifact(artifact); return artifact.entries.filter(x => x.permissions.humanInvocation).map(({identity, publicName}) => ({identity, publicName})).sort((a,b) => a.identity.localeCompare(b.identity)); }
export function humanCompleteSkills(artifact: RuntimeSkillArtifact, prefix: string): string[] { const normalized = prefix.toLowerCase(); return humanListSkills(artifact).map(x => x.publicName).filter(x => x.toLowerCase().startsWith(normalized)); }
export function humanSkillDetail(artifact: RuntimeSkillArtifact, catalog: readonly CanonicalSkill[], identity: string): { identity: string; publicName: string; description: string } | undefined { validateArtifact(artifact, catalog); const entry = artifact.entries.find(x => x.identity === identity && x.permissions.humanInvocation); const skill = catalog.find(x => x.identity === identity); return entry && skill ? { identity, publicName: entry.publicName, description: skill.description } : undefined; }
export function initialModelContext(artifact: RuntimeSkillArtifact): Array<{ identity: string; publicName: string; description?: string; triggers?: string }> { validateArtifact(artifact); return artifact.entries.filter(x => x.permissions.modelInvocation).map(x => ({ identity: x.identity, publicName: x.publicName, ...(x.exposure === "full" && x.description ? {description:x.description} : {}), ...(x.exposure === "full" && x.triggers ? {triggers:x.triggers} : {}) })); }

export type SkillInvocation = "model" | "human-explicit";
export interface LoadedSkillBody { identity: string; body: string; wrappedBody: string; provenance: { artifactKey: string; contentHash: string; invocation: SkillInvocation; runtime: Runtime; sourcePath: string } }
export interface SkillBodyRequest { canonicalRoot: string; manifest: ResolvedManifest; artifact: RuntimeSkillArtifact; runtime: Runtime; identity: string; invocation: SkillInvocation }
function samePath(left: string, right: string): boolean { const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value); return normalize(left) === normalize(right); }

export async function loadSkillBody(request: SkillBodyRequest): Promise<LoadedSkillBody> {
  let manifest: ResolvedManifest;
  try { manifest = parseResolvedSkillManifestV4(request.manifest); } catch { return catalogError("STALE_ARTIFACT", "skill loading requires the current exact v4 manifest"); }
  validateArtifact(request.artifact);
  if (request.artifact.manifestKey !== manifest.manifestKey) catalogError("STALE_ARTIFACT", "artifact does not belong to the resolved manifest");
  if (request.runtime !== request.artifact.runtime) catalogError("SKILL_RUNTIME_MISMATCH", "requested runtime does not match the artifact");
  const entry = request.artifact.entries.find(x => x.identity === request.identity);
  if (!entry) catalogError("SKILL_NOT_IN_ARTIFACT", `skill '${request.identity}' is excluded from the runtime artifact`);
  if (request.invocation !== "model" && request.invocation !== "human-explicit") catalogError("SKILL_INVOCATION_INVALID", "skill invocation must be model or human-explicit");
  const permitted = request.invocation === "model" ? entry.permissions.modelInvocation : entry.permissions.humanInvocation;
  if (!permitted) catalogError("SKILL_INVOCATION_DENIED", `skill '${request.identity}' does not permit ${request.invocation} loading`);
  const expectedSourcePath = path.join(request.canonicalRoot, entry.identity, "SKILL.md");
  let currentPath: string; try { currentPath = await contained(request.canonicalRoot, entry.source.path); } catch { return catalogError("SKILL_PATH_INVALID", `skill '${request.identity}' is outside its canonical root`); }
  if (entry.source.kind !== "canonical" || !samePath(entry.source.path, expectedSourcePath)) catalogError("SKILL_PROVENANCE_MISMATCH", `skill '${request.identity}' source does not match its canonical identity path`);
  if (!samePath(currentPath, entry.source.realPath)) catalogError("SKILL_PATH_STALE", `skill '${request.identity}' no longer resolves to its artifact path`);
  const text = await readFile(currentPath, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_SKILL_BODY_BYTES) catalogError("SKILL_BODY_TOO_LARGE", `skill files are limited to ${MAX_SKILL_BODY_BYTES} bytes`);
  const contentHash = createHash("sha256").update(text).digest("hex");
  if (contentHash !== entry.source.contentHash) catalogError("SKILL_CONTENT_STALE", `skill '${request.identity}' content no longer matches the artifact`);
  const body = frontmatter(text).body; const artifactKey = request.artifact.reference.artifactKey;
  const provenance = { artifactKey, contentHash, invocation: request.invocation, runtime: request.runtime, sourcePath: `content/skills/${entry.identity}/SKILL.md` };
  return { identity: entry.identity, body, wrappedBody: `<!-- mpx-skill identity=${entry.identity} origin=${request.invocation} runtime=${request.runtime} artifact=${artifactKey} hash=${contentHash} -->\n${body}<!-- /mpx-skill -->`, provenance };
}
