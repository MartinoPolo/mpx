import { isPathWithinRoot } from "@mpx/core";
import { realpath } from "node:fs/promises";
import type {
  ExposureConfig,
  ProjectConfig,
  ProvenanceEntry,
  ResolvedConfig,
  UserConfig,
} from "./types.js";
import { sortProvenance } from "./provenance.js";

export async function classifyScope(
  cwd: string,
  userConfig: UserConfig,
): Promise<{ name: string; root?: string }> {
  const canonicalCwd = await realpath(cwd);
  let best: { name: string; root: string } | undefined;

  for (const [name, scope] of Object.entries(userConfig.scopes)) {
    for (const configuredRoot of scope.roots) {
      let canonicalRoot: string;
      try {
        canonicalRoot = await realpath(configuredRoot);
      } catch {
        continue;
      }
      if (
        isPathWithinRoot(canonicalCwd, canonicalRoot) &&
        (!best || canonicalRoot.length > best.root.length)
      ) {
        best = { name, root: canonicalRoot };
      }
    }
  }

  return best ?? { name: "core" };
}

export async function resolveConfig(
  projectConfig: ProjectConfig,
  userConfig: UserConfig,
  cwd: string,
): Promise<ResolvedConfig> {
  const found = await classifyScope(cwd, userConfig);
  const scope = userConfig.scopes[found.name];
  const projectOverride = userConfig.projects?.[projectConfig.project.id];
  const provenance: ProvenanceEntry[] = [];
  const mark = (pointer: string, source: ProvenanceEntry["source"]): void => {
    provenance.push({ pointer, source });
  };

  const project = structuredClone(projectConfig);
  if (!project.issues) {
    project.issues = { provider: "none" };
    mark("/project/issues", "default");
  }
  if (!project.tooling) {
    project.tooling = { packageManager: "auto" };
    mark("/project/tooling", "default");
  }

  const skillPacks = projectOverride?.skillPacks ?? scope?.skillPacks ?? ["core"];
  mark(
    "/scope/skillPacks",
    projectOverride?.skillPacks ? "user-project" : scope?.skillPacks ? "user-scope" : "default",
  );

  const skillExposure: ExposureConfig = structuredClone(scope?.skillExposure ?? {});
  if (scope?.skillExposure) mark("/scope/skillExposure", "user-scope");
  const projectSkillExposure = projectOverride?.skillExposure
    ? structuredClone(projectOverride.skillExposure)
    : undefined;
  if (projectSkillExposure) mark("/scope/projectSkillExposure", "user-project");

  const connections = {
    ...(scope?.connections ?? {}),
    ...(projectOverride?.connections ?? {}),
  };

  return {
    project,
    scope: {
      name: found.name,
      ...(found.root ? { root: found.root } : {}),
      skillPacks: [...skillPacks],
      skillExposure,
      ...(projectSkillExposure ? { projectSkillExposure } : {}),
      connections,
    },
    provenance: sortProvenance(provenance),
  };
}
