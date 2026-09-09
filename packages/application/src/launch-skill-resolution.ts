import type { DiscoveredConfig } from '@mpx/config';
import {
  createSkillArtifactReference,
  sha256Canonical,
  type JsonValue,
  type SkillArtifactReference,
} from '@mpx/core';
import { createRuntimeSkillArtifact, resolveManifest, SkillCatalogError } from '@mpx/skills';
import type {
  CanonicalSkill,
  CatalogSkill,
  ProjectSkill,
  ResolveOptions,
  ResolvedManifest,
  ResolvedSkillSelection,
  Runtime,
  RuntimeSkillArtifact,
} from '@mpx/skills/contracts';

export interface LaunchSkillResolutionInput {
  readonly project?: DiscoveredConfig;
  readonly repositoryId?: string;
  readonly canonicalRoot: string;
  readonly identity: string;
  readonly selection: ResolvedSkillSelection;
  readonly runtime: Runtime;
}

export interface LaunchSkillResolutionDependencies {
  inventoryCanonical(root: string): Promise<readonly CanonicalSkill[]>;
  inventoryProjectSkills(
    root: string,
    canonical: readonly CanonicalSkill[],
  ): Promise<{
    readonly skills: readonly ProjectSkill[];
    readonly diagnostics: readonly { code: string; message: string; path?: string }[];
  }>;
}

export interface LaunchSkillResolution {
  readonly projectId?: string;
  readonly repositoryId: string;
  readonly catalog: readonly CatalogSkill[];
  readonly options: ResolveOptions;
  readonly manifest: ResolvedManifest;
  readonly artifact: RuntimeSkillArtifact;
  readonly skillArtifact: SkillArtifactReference;
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      immutable(nested);
    }
    Object.freeze(value);
  }
  return value;
}

export async function resolveLaunchSkills(
  input: LaunchSkillResolutionInput,
  dependencies: LaunchSkillResolutionDependencies,
): Promise<LaunchSkillResolution> {
  const canonical = await dependencies.inventoryCanonical(input.canonicalRoot);
  const projectInventory = input.project
    ? await dependencies.inventoryProjectSkills(input.project.root, canonical)
    : { skills: [], diagnostics: [] };
  if (projectInventory.diagnostics.length) {
    throw new SkillCatalogError(projectInventory.diagnostics);
  }
  const catalog = [...canonical, ...projectInventory.skills].sort((left, right) =>
    left.identity.localeCompare(right.identity),
  );
  const projectId = input.project?.config.project.id;
  const repositoryId = input.repositoryId ?? projectId ?? 'unbound/runtime';
  const options: ResolveOptions = {
    repositoryId,
    ...(projectId ? { projectId } : {}),
    identity: input.identity,
    selection: input.selection,
  };
  const manifest = resolveManifest(catalog, options);
  const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: input.runtime });
  const skillArtifact = createSkillArtifactReference({
    runtime: input.runtime,
    identity: input.identity,
    projectId: projectId ?? null,
    repositoryId,
    catalogHash: sha256Canonical(
      catalog.map((skill) => ({
        identity: skill.identity,
        contentHash: skill.contentHash,
        ...('directoryHash' in skill
          ? {
              origin: 'project',
              directoryHash: skill.directoryHash,
              realPath: skill.realPath,
              realProjectRoot: skill.realProjectRoot,
            }
          : { origin: 'canonical' }),
      })) as unknown as JsonValue,
    ),
    selection: input.selection,
  });
  return immutable(
    structuredClone({
      ...(projectId ? { projectId } : {}),
      repositoryId,
      catalog,
      options,
      manifest,
      artifact,
      skillArtifact,
    }),
  );
}
