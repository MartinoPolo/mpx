import type { DiscoveredConfig, UserConfig } from '@mpx/config';
import {
  createSkillArtifactReference,
  sha256Canonical,
  type JsonValue,
  type SkillArtifactReference,
} from '@mpx/core';
import {
  createRuntimeSkillArtifact,
  resolveManifest,
  SkillCatalogError,
  type CanonicalSkill,
  type CatalogSkill,
  type ProjectSkill,
  type ResolveOptions,
  type ResolvedManifest,
  type Runtime,
  type RuntimeSkillArtifact,
} from '@mpx/skills';
import { resolveProjectSkillOptions } from './project-application-service.js';

export interface LaunchSkillResolutionInput {
  readonly userConfig: UserConfig;
  readonly project?: DiscoveredConfig;
  readonly repositoryId?: string;
  readonly canonicalRoot: string;
  readonly identity: string;
  readonly skillPolicy: string;
  readonly contentScope: string;
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
  const options = resolveProjectSkillOptions(input.userConfig, {
    identity: input.identity,
    skillPolicy: input.skillPolicy,
    contentScope: input.contentScope,
    repositoryId,
    ...(projectId ? { projectId } : {}),
  });
  const manifest = resolveManifest(catalog, options);
  const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: input.runtime });
  const skillArtifact = createSkillArtifactReference({
    runtime: input.runtime,
    identity: input.identity,
    skillPolicy: input.skillPolicy,
    contentScope: input.contentScope,
    projectId: projectId ?? null,
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
    enabledPacks: options.enabledPacks,
    skillPolicyConfig: options.skillPolicyConfig as unknown as JsonValue,
    contentScopeExposure: options.contentScopeExposure as unknown as JsonValue,
    projectExposure: (options.projectExposure ?? null) as unknown as JsonValue,
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
