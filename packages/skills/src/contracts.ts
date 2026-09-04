import { createHash } from 'node:crypto';
import type {
  ResolvedSkillManifestV4,
  RuntimeSkillArtifactReferenceV4,
} from '@mpx/runtime-contracts';

export const SKILL_PACKS = ['core', 'work', 'personal'] as const;
export const EXPOSURES = ['full', 'name-only', 'explicit-only', 'off'] as const;
export const SKILL_CAPABILITIES = ['read', 'search', 'shell', 'write', 'delegate'] as const;

export type SkillPack = (typeof SKILL_PACKS)[number];
export type Exposure = (typeof EXPOSURES)[number];
export type SkillCapability = (typeof SKILL_CAPABILITIES)[number];

export interface ExposureConfig {
  default?: Exposure;
  skills?: Record<string, Exposure>;
}

export interface SkillPolicyConfig {
  skillPacks?: SkillPack[];
  skillExposure: ExposureConfig & { default: Exposure };
}

export interface EffectiveSkillPackOptions {
  readonly contentScopeSkillPacks?: readonly SkillPack[] | undefined;
  readonly projectSkillPacks?: readonly SkillPack[] | undefined;
  readonly skillPolicySkillPacks?: readonly SkillPack[] | undefined;
}

export function resolveEffectiveSkillPacks(options: EffectiveSkillPackOptions): SkillPack[] {
  const selectedPacks = options.projectSkillPacks ?? options.contentScopeSkillPacks ?? ['core'];
  const allowedPacks = options.skillPolicySkillPacks
    ? new Set(options.skillPolicySkillPacks)
    : undefined;
  return [
    ...new Set(selectedPacks.filter((pack) => !allowedPacks || allowedPacks.has(pack))),
  ].sort();
}

export type Runtime = 'claude' | 'pi';

export interface Diagnostic {
  code: string;
  message: string;
  path?: string;
}
export class SkillCatalogError extends Error {
  constructor(public readonly diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map((item) => `${item.code}: ${item.message}`).join('\n'));
    this.name = 'SkillCatalogError';
  }
}
export interface CanonicalSkill {
  identity: string;
  schemaVersion: 1;
  contentVersion?: 1;
  description: string;
  triggers?: string;
  argumentHint?: string;
  capabilities?: SkillCapability[];
  skillPacks: SkillPack[];
  defaultExposure: Exposure;
  sourcePath: string;
  realPath: string;
  contentHash: string;
}
export interface ProjectSkill {
  identity: string;
  description: string;
  projectExposure: 'full' | 'explicit-only';
  disableModelInvocation: boolean;
  sourcePath: string;
  realPath: string;
  contentHash: string;
  directoryHash: string;
  projectRoot: string;
  realProjectRoot: string;
}
export type CatalogSkill = CanonicalSkill | ProjectSkill;
export type ExposureSettings = ExposureConfig;
export interface ResolveOptions {
  repositoryId: string;
  contentScope: string;
  projectId?: string;
  enabledPacks: readonly SkillPack[];
  identity: string;
  skillPolicy: string;
  skillPolicyConfig: SkillPolicyConfig;
  contentScopeExposure?: ExposureSettings;
  projectExposure?: ExposureSettings;
  /** Public command-name mapping. It is resolution input and therefore manifest-key material. */
  mapping?: Readonly<Record<string, string>>;
}
export const SKILL_MANIFEST_SCHEMA_VERSION = 4 as const;
export type ResolvedManifest = ResolvedSkillManifestV4;

export interface RuntimeSkillEntry {
  identity: string;
  publicName: string;
  packs: SkillPack[];
  exposure: Exposure;
  metadataHash: string;
  description?: string;
  triggers?: string;
  source:
    | { kind: 'canonical'; path: string; realPath: string; contentHash: string }
    | {
        kind: 'project';
        path: string;
        realPath: string;
        contentHash: string;
        directoryHash: string;
        projectRoot: string;
        realProjectRoot: string;
      };
  permissions: { humanInvocation: boolean; modelInvocation: boolean };
}
export interface RuntimeSkillArtifact {
  schemaVersion: 4;
  runtime: Runtime;
  manifestKey: string;
  reference: RuntimeSkillArtifactReferenceV4;
  entries: RuntimeSkillEntry[];
}

export function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export function catalogError(code: string, message: string): never {
  throw new SkillCatalogError([{ code, message }]);
}
