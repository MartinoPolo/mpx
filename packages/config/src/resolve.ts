import { isPathWithinRoot, MpxError } from "@mpx/core";
import { realpath } from "node:fs/promises";
import type {
  ContentScopeClassification, CwdClassification, ExposureConfig, ProjectConfig,
  ProvenanceEntry, ResolvedConfig, UserConfig,
} from "./types.js";
import { sortProvenance } from "./provenance.js";
import { resolveEffectiveSkillPacks } from "./skill-packs.js";

export interface KnownLaunchCwdClassification {
  domain: string;
  contentScope: string;
}

function isMissingRealpathError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function classifyRoots<T extends "domain" | "contentScope">(
  cwd: string,
  groups: Record<string, readonly string[]>,
  field: T,
): Promise<(T extends "domain" ? CwdClassification : ContentScopeClassification)> {
  const canonicalCwd = await realpath(cwd);
  const matches: Array<{ name: string; root: string }> = [];
  for (const [name, roots] of Object.entries(groups).sort(([left], [right]) => left.localeCompare(right))) {
    for (const configuredRoot of roots) {
      try {
        const canonicalRoot = await realpath(configuredRoot);
        const platform = /^[A-Za-z]:[\\/]/u.test(canonicalCwd) || /^[A-Za-z]:[\\/]/u.test(canonicalRoot) ? "win32" : process.platform;
        if (isPathWithinRoot(canonicalCwd, canonicalRoot, { platform })) matches.push({ name, root: canonicalRoot });
      } catch (error) {
        if (!isMissingRealpathError(error)) throw error;
      }
    }
  }
  matches.sort((left, right) => right.root.length - left.root.length || left.name.localeCompare(right.name) || left.root.localeCompare(right.root));
  const best = matches[0];
  if (!best) return { status: "unknown" } as T extends "domain" ? CwdClassification : ContentScopeClassification;
  return (field === "domain"
    ? { status: "known", domain: best.name, root: best.root }
    : { status: "known", contentScope: best.name, root: best.root }) as T extends "domain" ? CwdClassification : ContentScopeClassification;
}

export function classifyCwd(cwd: string, userConfig: UserConfig): Promise<CwdClassification> {
  return classifyRoots(cwd, userConfig.domains, "domain");
}

export function classifyContentScope(cwd: string, userConfig: UserConfig): Promise<ContentScopeClassification> {
  return classifyRoots(cwd, Object.fromEntries(Object.entries(userConfig.contentScopes).map(([name, scope]) => [name, scope.roots])), "contentScope");
}

function safeErrnoCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && code ? code : "UNKNOWN";
}

export async function resolveKnownLaunchCwdClassification(cwd: string, userConfig: UserConfig): Promise<KnownLaunchCwdClassification> {
  try {
    const [cwdClassification, contentClassification] = await Promise.all([classifyCwd(cwd, userConfig), classifyContentScope(cwd, userConfig)]);
    if (cwdClassification.status === "unknown" || contentClassification.status === "unknown") {
      throw new MpxError({
        code: "CWD_CLASSIFICATION_UNKNOWN",
        message: "The launch CWD must have known domain and content classifications.",
        remediation: "Add explicit domain and content-scope roots or choose a known CWD.",
      });
    }
    return { domain: cwdClassification.domain, contentScope: contentClassification.contentScope };
  } catch (error) {
    if (error instanceof MpxError) throw error;
    throw new MpxError({
      code: "CWD_CLASSIFICATION_FAILED",
      message: "The launch CWD could not be canonically classified.",
      remediation: "Check filesystem access and configured roots, then relaunch.",
      details: { errno: safeErrnoCode(error) },
    });
  }
}

export async function resolveConfig(projectConfig: ProjectConfig, userConfig: UserConfig, cwd: string): Promise<ResolvedConfig> {
  const [cwdClassification, contentClassification] = await Promise.all([classifyCwd(cwd, userConfig), classifyContentScope(cwd, userConfig)]);
  if (cwdClassification.status === "unknown") throw new MpxError({ code: "CWD_CLASSIFICATION_UNKNOWN", message: "The launch CWD is outside every configured domain.", remediation: "Add an explicit domain root or choose a known CWD." });
  if (contentClassification.status === "unknown") throw new MpxError({ code: "CONTENT_SCOPE_UNKNOWN", message: "The launch CWD does not select a content scope.", remediation: "Add a content-scope root or select one explicitly at launch." });
  const contentScope = userConfig.contentScopes[contentClassification.contentScope]!;
  const projectOverride = userConfig.projects?.[projectConfig.project.id];
  const provenance: ProvenanceEntry[] = [];
  const mark = (pointer: string, source: ProvenanceEntry["source"]): void => { provenance.push({ pointer, source }); };

  const project = structuredClone(projectConfig);
  if (!project.issues) { project.issues = { provider: "none" }; mark("/project/issues", "default"); }
  if (!project.tooling) { project.tooling = { packageManager: "auto" }; mark("/project/tooling", "default"); }

  const skillPacks = resolveEffectiveSkillPacks({ contentScopeSkillPacks: contentScope.skillPacks, projectSkillPacks: projectOverride?.skillPacks });
  mark("/contentScope/skillPacks", projectOverride?.skillPacks ? "user-project" : contentScope.skillPacks ? "user-content-scope" : "default");
  const skillExposure: ExposureConfig = structuredClone(contentScope.skillExposure ?? {});
  if (contentScope.skillExposure) mark("/contentScope/skillExposure", "user-content-scope");
  const projectSkillExposure = projectOverride?.skillExposure ? structuredClone(projectOverride.skillExposure) : undefined;
  if (projectSkillExposure) mark("/contentScope/projectSkillExposure", "user-project");

  return {
    project,
    cwdClassification,
    contentScope: {
      name: contentClassification.contentScope,
      root: contentClassification.root,
      skillPacks: [...skillPacks],
      skillExposure,
      ...(projectSkillExposure ? { projectSkillExposure } : {}),
    },
    provenance: sortProvenance(provenance),
  };
}
