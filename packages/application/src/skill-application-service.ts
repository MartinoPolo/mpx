import type { DiscoveredConfig, UserConfig } from '@mpx/config';
import { MpxError } from '@mpx/core';
import {
  createRuntimeSkillArtifact,
  explainSkill,
  humanCompleteSkills,
  humanListSkills,
  humanSearchSkills,
  humanSkillDetail,
  resolveManifest,
  searchSkills,
  SkillCatalogError,
  type CanonicalSkill,
  type CatalogSkill,
  type ProjectSkill,
  type Runtime,
} from '@mpx/skills';
import type { ApplicationOperationResult } from './contracts.js';
import { resolveProjectSkillOptions } from './project-application-service.js';

export interface ProjectSkillInventory {
  readonly skills: readonly ProjectSkill[];
  readonly diagnostics: readonly { code: string; message: string; path?: string }[];
}
export interface SkillApplicationDependencies {
  inventoryCanonical(root: string): Promise<readonly CanonicalSkill[]>;
  inventoryProjectSkills(
    root: string,
    canonical: readonly CanonicalSkill[],
  ): Promise<ProjectSkillInventory>;
  discoverProjectConfig(cwd: string): Promise<DiscoveredConfig | undefined>;
  classifyCwd(cwd: string, user: UserConfig): Promise<{ domain: string; contentScope: string }>;
}
export type SkillApplicationAction = 'list' | 'search' | 'show' | 'explain' | 'complete';
export interface SkillApplicationRequest {
  readonly action: SkillApplicationAction;
  readonly cwd: string;
  readonly catalogRoot: string;
  readonly user: UserConfig;
  readonly identity: string;
  readonly runtime: Runtime;
  readonly skillPolicy: string;
  readonly contentScope?: string;
  readonly value?: string;
  readonly limit?: number;
  readonly artifactKey?: string;
}

export class SkillApplicationService {
  constructor(private readonly dependencies: SkillApplicationDependencies) {}
  // fallow-ignore-next-line unused-class-member -- public application API invoked through package consumers.
  assertConfiguredBindings(request: {
    user: UserConfig;
    identity?: string;
    skillPolicy?: string;
  }): void {
    if (request.identity !== undefined && !request.user.identities[request.identity]) {
      throw new MpxError({
        code: 'IDENTITY_UNKNOWN',
        message: `Unknown identity '${request.identity}'.`,
      });
    }
    if (request.skillPolicy !== undefined && !request.user.skillPolicies[request.skillPolicy]) {
      throw new MpxError({
        code: 'SKILL_POLICY_UNKNOWN',
        message: `Unknown skill policy '${request.skillPolicy}'.`,
      });
    }
  }
  // fallow-ignore-next-line unused-class-member -- public application API invoked through package consumers.
  async execute(request: SkillApplicationRequest): Promise<ApplicationOperationResult<unknown>> {
    this.assertConfiguredBindings({
      user: request.user,
      identity: request.identity,
      skillPolicy: request.skillPolicy,
    });
    const canonical = await this.dependencies.inventoryCanonical(request.catalogRoot);
    const found = await this.dependencies.discoverProjectConfig(request.cwd);
    const projectInventory = found
      ? await this.dependencies.inventoryProjectSkills(found.root, canonical)
      : { skills: [], diagnostics: [] };
    if (projectInventory.diagnostics.length) {
      throw new SkillCatalogError(projectInventory.diagnostics);
    }
    const catalog: CatalogSkill[] = [...canonical, ...projectInventory.skills].sort((a, b) =>
      a.identity.localeCompare(b.identity),
    );
    const classification = await this.dependencies.classifyCwd(request.cwd, request.user);
    const projectId = found?.config.project.id;
    const contentScope = request.contentScope ?? classification.contentScope;
    const options = resolveProjectSkillOptions(request.user, {
      identity: request.identity,
      skillPolicy: request.skillPolicy,
      contentScope,
      repositoryId: projectId ?? 'unbound/runtime',
      ...(projectId ? { projectId } : {}),
    });
    const manifest = resolveManifest(catalog, options);
    const runtimeArtifact = createRuntimeSkillArtifact(manifest, catalog, {
      runtime: request.runtime,
    });
    const artifact = {
      ...runtimeArtifact.reference,
      identity: request.identity,
      skillPolicy: request.skillPolicy,
      contentScope,
      projectId: projectId ?? null,
    };
    if (request.action === 'list') {
      const exposures = new Map(
        runtimeArtifact.entries.map((entry) => [entry.identity, entry.exposure]),
      );
      return {
        data: {
          artifact,
          manifest: {
            schemaVersion: manifest.schemaVersion,
            manifestKey: manifest.manifestKey,
            binding: manifest.binding,
          },
          skills: humanListSkills(runtimeArtifact).map((skill) => ({
            ...skill,
            exposure: exposures.get(skill.identity),
          })),
        },
      };
    }
    const value = request.value ?? '';
    if (request.action === 'complete') {
      return { data: { artifact, completions: humanCompleteSkills(runtimeArtifact, value) } };
    }
    const skill = catalog.find((item) => item.identity === value);
    const entry = runtimeArtifact.entries.find((item) => item.identity === value);
    if (request.action === 'show') {
      const detail = humanSkillDetail(runtimeArtifact, catalog, value);
      if (!detail || !skill || !entry) {
        throw new MpxError({
          code: 'SKILL_NOT_FOUND',
          message: `Skill '${value}' was not found in the launch-bound artifact.`,
        });
      }
      return {
        data: {
          artifact,
          skill: {
            ...detail,
            skillPacks: 'skillPacks' in skill ? skill.skillPacks : [],
            exposure: entry.exposure,
          },
        },
      };
    }
    if (request.action === 'explain') {
      if (!skill) {
        throw new MpxError({ code: 'SKILL_NOT_FOUND', message: `Skill '${value}' was not found.` });
      }
      return { data: { artifact, skill: explainSkill(skill, options) } };
    }
    const results =
      request.artifactKey === undefined
        ? humanSearchSkills(runtimeArtifact, catalog, value, { limit: request.limit ?? 20 })
        : searchSkills(runtimeArtifact, catalog, value, {
            limit: request.limit ?? 20,
            runtime: true,
            artifactKey: request.artifactKey,
          });
    return { data: { artifact, results } };
  }
}
export const createSkillApplicationService = (
  dependencies: SkillApplicationDependencies,
): SkillApplicationService => new SkillApplicationService(dependencies);
