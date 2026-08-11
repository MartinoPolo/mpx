import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export const SKILL_PACKS = ["core", "work", "personal"] as const;
export const EXPOSURES = ["full", "name-only", "explicit-only", "off"] as const;
export type SkillPack = typeof SKILL_PACKS[number];
export type Exposure = typeof EXPOSURES[number];
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
  runtime: Runtime; scope: string; projectId?: string; enabledPacks: readonly SkillPack[];
  scopeExposure?: ExposureSettings; projectExposure?: ExposureSettings; mappingVersion: string;
}
export interface ManifestEntry {
  identity: string; publicName: string; packs: SkillPack[]; exposure: Exposure; exposureSource: string;
  description?: string; triggers?: string; source: { kind: "canonical"; path: string; realPath: string; contentHash: string };
  permissions: { userInvocation: boolean; modelInvocation: boolean };
  compatibility: { claude: boolean; pi: boolean; diagnostics: string[] };
}
export interface ResolvedManifest {
  schemaVersion: 1; artifactKey: string; catalogHash: string; runtime: Runtime; scope: string; projectId?: string;
  mappingVersion: string; entries: ManifestEntry[];
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
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`source escapes inventory root: ${candidate}`);
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
  const p = options.projectExposure, s = options.scopeExposure;
  if (p?.skills?.[skill.identity]) return { exposure: p.skills[skill.identity]!, source: "project skill override" };
  if (p?.default) return { exposure: p.default, source: "project default" };
  if (s?.skills?.[skill.identity]) return { exposure: s.skills[skill.identity]!, source: "scope skill override" };
  if (s?.default) return { exposure: s.default, source: "scope default" };
  return { exposure: skill.defaultExposure ?? "name-only", source: skill.defaultExposure ? "canonical default" : "fallback" };
}

function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`; return JSON.stringify(value); }

export function resolveManifest(catalog: readonly CanonicalSkill[], options: ResolveOptions): ResolvedManifest {
  const enabled = new Set(options.enabledPacks);
  const entries: ManifestEntry[] = catalog.filter(s => s.skillPacks.some(p => enabled.has(p))).map((skill): ManifestEntry => {
    const effective = effectiveExposure(skill, options);
    const exposure = effective.exposure;
    const visible = exposure === "full";
    return { identity: skill.identity, publicName: `/mpx:${skill.identity}`, packs: [...skill.skillPacks].sort(), exposure, exposureSource: effective.source,
      ...(visible ? { description: skill.description, ...(skill.triggers ? { triggers: skill.triggers } : {}) } : {}),
      source: { kind: "canonical", path: skill.sourcePath, realPath: skill.realPath, contentHash: skill.contentHash },
      permissions: { userInvocation: exposure !== "off", modelInvocation: exposure === "full" || exposure === "name-only" },
      compatibility: { claude: true, pi: true, diagnostics: [] } };
  }).filter(x => x.exposure !== "off").sort((a,b) => a.identity.localeCompare(b.identity));
  const catalogProjection = catalog.map(x => ({ identity:x.identity, hash:x.contentHash })).sort((a,b)=>a.identity.localeCompare(b.identity));
  const catalogHash = createHash("sha256").update(stable(catalogProjection)).digest("hex");
  const keyInput = { runtime: options.runtime, scope: options.scope, projectId: options.projectId ?? null, mappingVersion: options.mappingVersion, enabledPacks: [...options.enabledPacks].sort(), scopeExposure: options.scopeExposure ?? null, projectExposure: options.projectExposure ?? null, catalogHash };
  const base = { schemaVersion: 1 as const, artifactKey: createHash("sha256").update(stable(keyInput)).digest("hex"), catalogHash, runtime: options.runtime, scope: options.scope, mappingVersion: options.mappingVersion, entries };
  return options.projectId ? { ...base, projectId: options.projectId } : base;
}

export function explainSkill(skill: CanonicalSkill, options: ResolveOptions): { identity: string; included: boolean; exposure?: Exposure; source?: string } {
  const included = skill.skillPacks.some(p => options.enabledPacks.includes(p)); if (!included) return { identity: skill.identity, included: false };
  const result = effectiveExposure(skill, options); return { identity: skill.identity, included: true, exposure: result.exposure, source: result.source };
}

export function doctor(canonical: readonly CanonicalSkill[], project: { skills: ProjectSkill[]; diagnostics: Diagnostic[] }): Diagnostic[] {
  const diagnostics = [...project.diagnostics]; const ids = new Set(canonical.map(x => x.identity));
  for (const skill of project.skills) { if (ids.has(skill.identity)) diagnostics.push({ code: "SKILL_COLLISION", message: `${skill.identity} collides with /mpx:${skill.identity}`, path: skill.sourcePath }); if (skill.projectExposure === "full") diagnostics.push({ code: "PROJECT_SKILL_CONTEXT_COST", message: `${skill.identity} opts its description into initial context`, path: skill.sourcePath }); }
  return diagnostics.sort((a,b) => `${a.code}\0${a.path ?? ""}\0${a.message}`.localeCompare(`${b.code}\0${b.path ?? ""}\0${b.message}`));
}

export function searchSkills(manifest: ResolvedManifest, catalog: readonly CanonicalSkill[], query: string, options: { artifactKey?: string; runtime?: boolean; limit?: number } = {}): Array<{ identity: string; publicName: string; description: string; score: number }> {
  if (query.length > 200) throw new SkillCatalogError([{ code: "QUERY_TOO_LONG", message: "skill search queries are limited to 200 characters" }]);
  if (options.runtime && (!options.artifactKey || options.artifactKey !== manifest.artifactKey)) throw new SkillCatalogError([{ code: "STALE_ARTIFACT", message: "runtime search requires the exact launch-bound artifact key" }]);
  const currentCatalogHash = createHash("sha256").update(stable(catalog.map(x => ({ identity:x.identity, hash:x.contentHash })).sort((a,b)=>a.identity.localeCompare(b.identity)))).digest("hex");
  if (options.runtime && currentCatalogHash !== manifest.catalogHash) throw new SkillCatalogError([{ code: "STALE_ARTIFACT", message: "canonical skill content no longer matches the launch-bound artifact" }]);
  const limit = Math.max(0, Math.min(20, options.limit ?? 20)); const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean); const source = new Map(catalog.map(x => [x.identity, x]));
  return manifest.entries.filter(x => x.exposure === "full" || x.exposure === "name-only").map(entry => { const skill = source.get(entry.identity)!; const haystack = `${skill.identity} ${skill.description} ${skill.triggers ?? ""}`.toLowerCase(); const score = terms.reduce((n,t) => n + (haystack.includes(t) ? (skill.identity.includes(t) ? 3 : 1) : 0), 0); return { identity: skill.identity, publicName: entry.publicName, description: skill.description, score }; }).filter(x => terms.length === 0 || x.score > 0).sort((a,b) => b.score-a.score || a.identity.localeCompare(b.identity)).slice(0, limit);
}
