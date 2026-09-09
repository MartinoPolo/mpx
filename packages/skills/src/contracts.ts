import { createHash } from 'node:crypto';
import type {
  ResolvedSkillManifest,
  ResolvedSkillSelection,
  RuntimeBinding,
  RuntimeSkillArtifactReference,
} from '@mpx/runtime-contracts';

export const SKILL_PACKS = ['development', 'personal'] as const;
export const EXPOSURES = ['full', 'name-only', 'explicit-only'] as const;
/** @public Runtime capability vocabulary consumed by config packages. */
export const SKILL_CAPABILITIES = ['read', 'search', 'shell', 'write', 'delegate'] as const;

export type SkillPack = (typeof SKILL_PACKS)[number];
export type Exposure = (typeof EXPOSURES)[number];
/** @public Emitted declaration consumed by compiler packages. */
export type SkillCapability = (typeof SKILL_CAPABILITIES)[number];
export type { ResolvedSkillSelection } from '@mpx/runtime-contracts';

export function resolveEffectiveSkillPacks(
  selectedPacks: readonly SkillPack[],
  identityAllowedPacks: readonly SkillPack[],
): SkillPack[] {
  if (selectedPacks.length === 0) {
    throw new Error('selected skill packs must contain at least one pack');
  }
  if (identityAllowedPacks.length === 0) {
    throw new Error('identity allowed skill packs must contain at least one pack');
  }
  const unsupported = [...selectedPacks, ...identityAllowedPacks].find(
    (pack) => !SKILL_PACKS.includes(pack),
  );
  if (unsupported) {
    throw new Error(`unsupported skill pack '${unsupported}'`);
  }
  const allowed = new Set(identityAllowedPacks);
  const unallowed = selectedPacks.find((pack) => !allowed.has(pack));
  if (unallowed) {
    throw new Error(`selected skill pack '${unallowed}' is not allowed by the identity`);
  }
  return [...new Set(selectedPacks)].sort();
}

export type Runtime = 'claude' | 'pi';

export type SkillInvocation = 'model' | 'human-explicit';

export interface SkillBodyProvenance {
  artifactKey: string;
  contentHash: string;
  invocation: SkillInvocation;
  runtime: Runtime;
  sourcePath: string;
}

export interface Diagnostic {
  code: string;
  message: string;
  path?: string;
}
export class SkillCatalogError extends Error {
  constructor(public readonly diagnostics: readonly Diagnostic[]) {
    super(
      diagnostics
        .map((item) => `${item.code}${item.path ? ` [${item.path}]` : ''}: ${item.message}`)
        .join('\n'),
    );
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
  author?: string;
  version?: string;
  category?: string;
  skillPacks: SkillPack[];
  defaultExposure: Exposure;
  sourcePath: string;
  realPath: string;
  contentHash: string;
}
/** @public Emitted declaration consumed by application packages. */
export interface ProjectSkill {
  identity: string;
  description: string;
  projectExposure: Exposure;
  disableModelInvocation: boolean;
  sourcePath: string;
  realPath: string;
  contentHash: string;
  directoryHash: string;
  projectRoot: string;
  realProjectRoot: string;
}
/** @public Emitted declaration consumed by application and compiler packages. */
export type CatalogSkill = CanonicalSkill | ProjectSkill;
export interface ResolveOptions {
  repositoryId: string;
  projectId?: string;
  identity: string;
  selection: ResolvedSkillSelection;
  /** Public command-name mapping. It is resolution input and therefore manifest-key material. */
  mapping?: Readonly<Record<string, string>>;
}
/** @public Emitted declaration consumed by application packages. */
export type ResolvedManifest = ResolvedSkillManifest;

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
/** @public Emitted declaration consumed by application and runtime adapter packages. */
export interface RuntimeSkillArtifact {
  schemaVersion: 5;
  runtime: Runtime;
  manifestKey: string;
  reference: RuntimeSkillArtifactReference;
  entries: RuntimeSkillEntry[];
}

export interface SkillProjectionFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}
export interface SkillProjectionDisclosure {
  readonly identity: string;
  readonly publicName: string;
  readonly description?: string;
  readonly triggers?: string;
}
export interface SkillProjectionPlanEntry {
  readonly identity: string;
  readonly publicName: string;
  readonly exposure: Exposure;
  readonly canonicalDescription: string;
  readonly argumentHint?: string;
  readonly capabilities?: readonly SkillCapability[];
  readonly author?: string;
  readonly version?: string;
  readonly category?: string;
  readonly permissions: Readonly<{ humanInvocation: boolean; modelInvocation: boolean }>;
  readonly source: Readonly<{
    kind: 'canonical' | 'project';
    provenancePath: string;
    contentHash: string;
    directoryHash?: string;
  }>;
  readonly initialContext?: SkillProjectionDisclosure;
  readonly humanContext?: SkillProjectionDisclosure;
  readonly modelSearchContext?: SkillProjectionDisclosure;
  readonly body: string;
  readonly wrappedBodies: Readonly<Partial<Record<SkillInvocation, string>>>;
  readonly provenances: Readonly<Partial<Record<SkillInvocation, SkillBodyProvenance>>>;
  readonly skillFile: SkillProjectionFile;
  readonly files: readonly SkillProjectionFile[];
}
/** @public Emitted declaration consumed by compiler and runtime adapter packages. */
export interface SkillProjectionPlan {
  readonly runtime: Runtime;
  readonly binding: RuntimeBinding;
  readonly manifestKey: string;
  readonly artifactReference: RuntimeSkillArtifactReference;
  readonly entries: readonly SkillProjectionPlanEntry[];
  /** Verified support files shared only by included managed project skills. */
  readonly projectSharedFiles?: readonly SkillProjectionFile[];
  readonly initialModelContext: readonly SkillProjectionDisclosure[];
  readonly humanContext: readonly SkillProjectionDisclosure[];
  readonly modelSearchContext: readonly SkillProjectionDisclosure[];
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
