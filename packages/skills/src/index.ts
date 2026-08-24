import { EXPOSURES, SKILL_PACKS, resolveEffectiveSkillPacks, type Exposure, type SkillPack, type SkillPolicyConfig } from "@mpx/config";
import { createSkillArtifactReference, isPathWithinRoot, isValidSkillArtifactReference, type JsonValue, type SkillArtifactReference } from "@mpx/core";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
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
  runtime: Runtime; contentScope: string; projectId?: string; enabledPacks: readonly SkillPack[];
  identity: string; skillPolicy: string; skillPolicyConfig: SkillPolicyConfig;
  contentScopeExposure?: ExposureSettings; projectExposure?: ExposureSettings;
}
export interface ManifestEntry {
  identity: string; publicName: string; packs: SkillPack[]; exposure: Exposure; exposureSource: string;
  description?: string; triggers?: string; source: { kind: "canonical"; path: string; realPath: string; contentHash: string };
  permissions: { humanInvocation: boolean; modelInvocation: boolean };
  compatibility: { claude: boolean; pi: boolean; diagnostics: string[] };
}
export const SKILL_MANIFEST_SCHEMA_VERSION = 3 as const;

export interface ResolvedManifest {
  schemaVersion: typeof SKILL_MANIFEST_SCHEMA_VERSION; artifactKey: string; artifactReference: SkillArtifactReference; catalogHash: string; runtime: Runtime; contentScope: string; projectId?: string;
  identity: string; skillPolicy: string; effectivePolicyHash: string;
  entries: ManifestEntry[];
}

export const MAX_SKILL_SEARCH_QUERY_LENGTH = 200;
export const MAX_SKILL_SEARCH_RESULTS = 20;
export const MAX_HUMAN_SKILL_SEARCH_QUERY_LENGTH = 200;
export const MAX_HUMAN_SKILL_SEARCH_RESULTS = 20;
export const MAX_SKILL_BODY_BYTES = 256 * 1024;

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

export async function inventoryProjectSkills(projectRoot: string, canonical: readonly CanonicalSkill[] = []): Promise<{ skills: ProjectSkill[]; diagnostics: Diagnostic[] }> {
  const root = path.join(projectRoot, ".agents", "skills"); const diagnostics: Diagnostic[] = []; const skills: ProjectSkill[] = []; const names = new Set(canonical.map(x => x.identity));
  let entries; try { entries = await readdir(root, { withFileTypes: true }); } catch { return { skills, diagnostics }; }
  for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue; const file = path.join(root, entry.name, "SKILL.md");
    try {
      const real = await contained(root, file); const { data } = frontmatter(await readFile(real, "utf8"));
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
    } catch (error) { diagnostics.push({ code: "PROJECT_SKILL_INVALID", message: String((error as Error).message), path: file }); }
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
  const entries: ManifestEntry[] = catalog.filter(s => s.skillPacks.some(p => enabled.has(p))).map((skill): ManifestEntry => {
    const effective = policyExposure(skill, options);
    const exposure = effective.exposure;
    const visible = exposure === "full";
    return { identity: skill.identity, publicName: `/mpx:${skill.identity}`, packs: [...skill.skillPacks].sort(), exposure, exposureSource: effective.source,
      ...(visible ? { description: skill.description, ...(skill.triggers ? { triggers: skill.triggers } : {}) } : {}),
      source: { kind: "canonical", path: skill.sourcePath, realPath: skill.realPath, contentHash: skill.contentHash },
      permissions: {
        humanInvocation: exposure !== "off",
        modelInvocation: exposure === "full" || exposure === "name-only",
      },
      compatibility: { claude: true, pi: true, diagnostics: [] } };
  }).filter(x => x.exposure !== "off").sort((a,b) => a.identity.localeCompare(b.identity));
  const catalogProjection = catalog.map(x => ({ identity:x.identity, hash:x.contentHash })).sort((a,b)=>a.identity.localeCompare(b.identity));
  const catalogHash = createHash("sha256").update(stable(catalogProjection)).digest("hex");
  const artifactReference = createSkillArtifactReference({
    identity: options.identity,
    skillPolicy: options.skillPolicy,
    runtime: options.runtime,
    contentScope: options.contentScope,
    projectId: options.projectId ?? null,
    enabledPacks: [...enabled].sort(),
    skillPolicyConfig: options.skillPolicyConfig as unknown as JsonValue,
    contentScopeExposure: (options.contentScopeExposure ?? null) as unknown as JsonValue,
    projectExposure: (options.projectExposure ?? null) as unknown as JsonValue,
    catalogHash,
  });
  const base = {
    schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
    artifactKey: artifactReference.artifactKey,
    artifactReference,
    catalogHash,
    runtime: options.runtime,
    contentScope: options.contentScope,
    entries,
    identity: options.identity,
    skillPolicy: options.skillPolicy,
    effectivePolicyHash: artifactReference.effectivePolicyHash,
  };
  return options.projectId ? { ...base, projectId: options.projectId } : base;
}

export function explainSkill(skill: CanonicalSkill, options: ResolveOptions): { identity: string; included: boolean; exposure?: Exposure; source?: string } {
  const enabled = new Set(effectiveSkillPacks(options));
  const included = skill.skillPacks.some((pack) => enabled.has(pack));
  if (!included) return { identity: skill.identity, included: false };
  const result = policyExposure(skill, options);
  return { identity: skill.identity, included: true, exposure: result.exposure, source: result.source };
}

export function doctor(canonical: readonly CanonicalSkill[], project: { skills: ProjectSkill[]; diagnostics: Diagnostic[] }): Diagnostic[] {
  const diagnostics = [...project.diagnostics]; const ids = new Set(canonical.map(x => x.identity));
  for (const skill of project.skills) { if (ids.has(skill.identity)) diagnostics.push({ code: "SKILL_COLLISION", message: `${skill.identity} collides with /mpx:${skill.identity}`, path: skill.sourcePath }); if (skill.projectExposure === "full") diagnostics.push({ code: "PROJECT_SKILL_CONTEXT_COST", message: `${skill.identity} opts its description into initial context`, path: skill.sourcePath }); }
  return diagnostics.sort((a,b) => `${a.code}\0${a.path ?? ""}\0${a.message}`.localeCompare(`${b.code}\0${b.path ?? ""}\0${b.message}`));
}

function isCurrentManifest(manifest: ResolvedManifest): boolean {
  return manifest.schemaVersion === SKILL_MANIFEST_SCHEMA_VERSION
    && manifest.artifactKey === manifest.artifactReference.artifactKey
    && isValidSkillArtifactReference(manifest.artifactReference);
}

export function searchSkills(manifest: ResolvedManifest, catalog: readonly CanonicalSkill[], query: string, options: { artifactKey?: string; runtime?: boolean; limit?: number } = {}): Array<{ identity: string; publicName: string; description: string; score: number }> {
  if (query.length > MAX_SKILL_SEARCH_QUERY_LENGTH) throw new SkillCatalogError([{ code: "QUERY_TOO_LONG", message: `skill search queries are limited to ${MAX_SKILL_SEARCH_QUERY_LENGTH} characters` }]);
  if (options.runtime && (!isCurrentManifest(manifest) || !options.artifactKey || options.artifactKey !== manifest.artifactKey)) throw new SkillCatalogError([{ code: "STALE_ARTIFACT", message: "runtime search requires the current exact launch-bound artifact" }]);
  const currentCatalogHash = createHash("sha256").update(stable(catalog.map(x => ({ identity:x.identity, hash:x.contentHash })).sort((a,b)=>a.identity.localeCompare(b.identity)))).digest("hex");
  if (options.runtime && currentCatalogHash !== manifest.catalogHash) throw new SkillCatalogError([{ code: "STALE_ARTIFACT", message: "canonical skill content no longer matches the launch-bound artifact" }]);
  const limit = Math.max(0, Math.min(MAX_SKILL_SEARCH_RESULTS, options.limit ?? MAX_SKILL_SEARCH_RESULTS)); const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean); const source = new Map(catalog.map(x => [x.identity, x]));
  return manifest.entries.filter((entry) => (entry.exposure === "full" || entry.exposure === "name-only") && entry.permissions.modelInvocation).flatMap(entry => {
    const skill = source.get(entry.identity); if (!skill) return [];
    const haystack = `${skill.identity} ${skill.description} ${skill.triggers ?? ""}`.toLowerCase();
    const score = terms.reduce((n,t) => n + (haystack.includes(t) ? (skill.identity.includes(t) ? 3 : 1) : 0), 0);
    return [{ identity: skill.identity, publicName: entry.publicName, description: skill.description, score }];
  }).filter(x => terms.length === 0 || x.score > 0).sort((a,b) => b.score-a.score || a.identity.localeCompare(b.identity)).slice(0, limit);
}

export function modelSearchSkills(manifest: ResolvedManifest, catalog: readonly CanonicalSkill[], query: string, options: { artifactKey: string; limit?: number }): Array<{ identity: string; publicName: string; description: string; score: number }> {
  return searchSkills(manifest, catalog, query, { runtime: true, artifactKey: options.artifactKey, ...(options.limit === undefined ? {} : { limit: options.limit }) });
}

export function humanSearchSkills(manifest: ResolvedManifest, catalog: readonly CanonicalSkill[], query: string, options: { limit?: number } = {}): Array<{ identity: string; publicName: string; description: string; score: number }> {
  if (query.length > MAX_HUMAN_SKILL_SEARCH_QUERY_LENGTH) throw new SkillCatalogError([{ code: "QUERY_TOO_LONG", message: `human skill search queries are limited to ${MAX_HUMAN_SKILL_SEARCH_QUERY_LENGTH} characters` }]);
  const limit = Math.max(0, Math.min(MAX_HUMAN_SKILL_SEARCH_RESULTS, options.limit ?? MAX_HUMAN_SKILL_SEARCH_RESULTS));
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const source = new Map(catalog.map((skill) => [skill.identity, skill]));
  return manifest.entries.filter((entry) => entry.permissions.humanInvocation).flatMap((entry) => {
    const skill = source.get(entry.identity); if (!skill) return [];
    const haystack = `${skill.identity} ${skill.description} ${skill.triggers ?? ""}`.toLowerCase();
    const score = terms.reduce((total, term) => total + (haystack.includes(term) ? (skill.identity.includes(term) ? 3 : 1) : 0), 0);
    return [{ identity: skill.identity, publicName: entry.publicName, description: skill.description, score }];
  }).filter((result) => terms.length === 0 || result.score > 0)
    .sort((left, right) => right.score - left.score || left.identity.localeCompare(right.identity)).slice(0, limit);
}

export interface HumanSkillName { identity: string; publicName: string }

export function humanListSkills(manifest: ResolvedManifest): HumanSkillName[] {
  return manifest.entries.filter((entry) => entry.permissions.humanInvocation)
    .map(({ identity, publicName }) => ({ identity, publicName }))
    .sort((left, right) => left.identity.localeCompare(right.identity));
}

export function humanCompleteSkills(manifest: ResolvedManifest, prefix: string): string[] {
  const normalized = prefix.toLowerCase();
  return humanListSkills(manifest).map((entry) => entry.publicName).filter((name) => name.toLowerCase().startsWith(normalized));
}

export function humanSkillDetail(manifest: ResolvedManifest, catalog: readonly CanonicalSkill[], identity: string): { identity: string; publicName: string; description: string } | undefined {
  const entry = manifest.entries.find((candidate) => candidate.identity === identity && candidate.permissions.humanInvocation);
  const skill = catalog.find((candidate) => candidate.identity === identity);
  return entry && skill ? { identity, publicName: entry.publicName, description: skill.description } : undefined;
}

export function initialModelContext(manifest: ResolvedManifest): Array<{ identity: string; publicName: string; description?: string; triggers?: string }> {
  return manifest.entries.filter((entry) => (entry.exposure === "full" || entry.exposure === "name-only") && entry.permissions.modelInvocation).map((entry) => ({
    identity: entry.identity,
    publicName: entry.publicName,
    ...(entry.exposure === "full" && entry.description ? { description: entry.description } : {}),
    ...(entry.exposure === "full" && entry.triggers ? { triggers: entry.triggers } : {}),
  }));
}

function catalogError(code: string, message: string): never {
  throw new SkillCatalogError([{ code, message }]);
}

export type SkillInvocation = "model" | "human-explicit";
export interface LoadedSkillBody {
  identity: string; body: string; wrappedBody: string;
  provenance: { artifactKey: string; contentHash: string; invocation: SkillInvocation; runtime: Runtime; sourcePath: string };
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

type SkillBodyRequestBase = {
  canonicalRoot: string; manifest: ResolvedManifest; artifactKey: string; runtime: Runtime; identity: string;
};
export type SkillBodyRequest = SkillBodyRequestBase & { invocation: SkillInvocation };

export async function loadSkillBody(request: SkillBodyRequest): Promise<LoadedSkillBody> {
  if (!isCurrentManifest(request.manifest) || request.artifactKey !== request.manifest.artifactKey) catalogError("STALE_ARTIFACT", "skill loading requires the current exact launch-bound artifact");
  if (request.runtime !== request.manifest.runtime) catalogError("SKILL_RUNTIME_MISMATCH", "requested runtime does not match the launch-bound manifest");
  const entry = request.manifest.entries.find((candidate) => candidate.identity === request.identity);
  if (!entry) catalogError("SKILL_NOT_IN_MANIFEST", `skill '${request.identity}' is not a member of the launch-bound manifest`);
  const compatible = request.runtime === "claude" ? entry.compatibility.claude : entry.compatibility.pi;
  if (!compatible) catalogError("SKILL_RUNTIME_INCOMPATIBLE", `skill '${request.identity}' is incompatible with ${request.runtime}`);
  if (request.invocation !== "model" && request.invocation !== "human-explicit") {
    catalogError("SKILL_INVOCATION_INVALID", "skill invocation must be model or human-explicit");
  }
  const invocation = request.invocation;
  const permitted = invocation === "model"
    ? (entry.exposure === "full" || entry.exposure === "name-only") && entry.permissions.modelInvocation
    : entry.permissions.humanInvocation;
  if (!permitted) catalogError("SKILL_INVOCATION_DENIED", `skill '${request.identity}' does not permit ${invocation} loading`);
  const expectedSourcePath = path.join(request.canonicalRoot, entry.identity, "SKILL.md");
  let currentPath: string;
  try { currentPath = await contained(request.canonicalRoot, entry.source.path); }
  catch { return catalogError("SKILL_PATH_INVALID", `skill '${request.identity}' is outside its canonical root`); }
  if (entry.source.kind !== "canonical" || !samePath(entry.source.path, expectedSourcePath)) {
    catalogError("SKILL_PROVENANCE_MISMATCH", `skill '${request.identity}' source does not match its canonical identity path`);
  }
  if (!samePath(currentPath, entry.source.realPath)) catalogError("SKILL_PATH_STALE", `skill '${request.identity}' no longer resolves to its manifest path`);
  const text = await readFile(currentPath, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_SKILL_BODY_BYTES) catalogError("SKILL_BODY_TOO_LARGE", `skill files are limited to ${MAX_SKILL_BODY_BYTES} bytes`);
  const contentHash = createHash("sha256").update(text).digest("hex");
  if (contentHash !== entry.source.contentHash) catalogError("SKILL_CONTENT_STALE", `skill '${request.identity}' content no longer matches the launch-bound manifest`);
  const body = frontmatter(text).body;
  const provenance = { artifactKey: request.manifest.artifactKey, contentHash, invocation, runtime: request.runtime, sourcePath: entry.source.path };
  const wrappedBody = `<!-- mpx-skill identity=${entry.identity} origin=${invocation} runtime=${request.runtime} artifact=${request.manifest.artifactKey} hash=${contentHash} -->\n${body}<!-- /mpx-skill -->`;
  return { identity: entry.identity, body, wrappedBody, provenance };
}
