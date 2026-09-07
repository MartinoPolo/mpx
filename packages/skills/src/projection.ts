import { createHash } from 'node:crypto';
import path from 'node:path';
import type { RuntimeBinding, RuntimeSkillArtifactReferenceV4 } from '@mpx/runtime-contracts';
import {
  catalogError,
  stable,
  type CatalogSkill,
  type Exposure,
  type SkillCapability,
  type ResolvedManifest,
  type Runtime,
  type RuntimeSkillArtifact,
} from './contracts.js';
import { validateArtifact, verifyRuntimeSkillArtifact } from './artifact.js';
import { directoryDigest, enumerateSkillDirectory } from './inventory.js';
import { loadSkillBody, type LoadedSkillBody, type SkillInvocation } from './loader.js';
import { rankSearchCandidates } from './search-ranking.js';
import { MAX_SKILL_SEARCH_QUERY_LENGTH, MAX_SKILL_SEARCH_RESULTS } from './search.js';

export interface HumanSkillName {
  identity: string;
  publicName: string;
}
export function humanListSkills(artifact: RuntimeSkillArtifact): HumanSkillName[] {
  validateArtifact(artifact);
  return artifact.entries
    .filter((x) => x.permissions.humanInvocation)
    .map(({ identity, publicName }) => ({ identity, publicName }))
    .sort((a, b) => a.identity.localeCompare(b.identity));
}
export function humanCompleteSkills(artifact: RuntimeSkillArtifact, prefix: string): string[] {
  const normalized = prefix.toLowerCase();
  return humanListSkills(artifact)
    .map((x) => x.publicName)
    .filter((x) => x.toLowerCase().startsWith(normalized));
}
export function humanSkillDetail(
  artifact: RuntimeSkillArtifact,
  catalog: readonly CatalogSkill[],
  identity: string,
): { identity: string; publicName: string; description: string } | undefined {
  validateArtifact(artifact, catalog);
  const entry = artifact.entries.find(
    (x) => x.identity === identity && x.permissions.humanInvocation,
  );
  const skill = catalog.find((x) => x.identity === identity);
  return entry && skill
    ? { identity, publicName: entry.publicName, description: skill.description }
    : undefined;
}
export function initialModelContext(
  artifact: RuntimeSkillArtifact,
): Array<{ identity: string; publicName: string; description?: string; triggers?: string }> {
  validateArtifact(artifact);
  return artifact.entries
    .filter((x) => x.permissions.modelInvocation)
    .map((x) => ({
      identity: x.identity,
      publicName: x.publicName,
      ...(x.exposure === 'full' && x.description ? { description: x.description } : {}),
      ...(x.exposure === 'full' && x.triggers ? { triggers: x.triggers } : {}),
    }));
}

export interface SkillProjectionPlanInput {
  readonly manifest: ResolvedManifest;
  readonly artifact: RuntimeSkillArtifact;
  readonly catalog: readonly CatalogSkill[];
  readonly canonicalRoot: string;
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
  readonly provenances: Readonly<Partial<Record<SkillInvocation, LoadedSkillBody['provenance']>>>;
  readonly skillFile: SkillProjectionFile;
  readonly files: readonly SkillProjectionFile[];
}
export interface SkillProjectionPlan {
  readonly runtime: Runtime;
  readonly binding: RuntimeBinding;
  readonly manifestKey: string;
  readonly artifactReference: RuntimeSkillArtifactReferenceV4;
  readonly entries: readonly SkillProjectionPlanEntry[];
  readonly initialModelContext: readonly SkillProjectionDisclosure[];
  readonly humanContext: readonly SkillProjectionDisclosure[];
  readonly modelSearchContext: readonly SkillProjectionDisclosure[];
}
export interface SkillProjectionBodyRequest {
  readonly identity: string;
  readonly invocation: SkillInvocation;
}
export interface ModelSearchSkillProjectionOptions {
  readonly artifactKey: string;
  readonly limit?: number;
}
export interface SkillProjectionSearchResult {
  readonly identity: string;
  readonly publicName: string;
  readonly description: string;
  readonly score: number;
}

const verifiedPlans = new WeakMap<object, { digest: string; toJSON: () => never }>();
const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

function digestPlan(value: unknown): string {
  const portable = (item: unknown): unknown => {
    if (item instanceof Uint8Array) {
      return { $bytes: Buffer.from(item).toString('hex') };
    }
    if (Array.isArray(item)) {
      return item.map(portable);
    }
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, portable(child)]));
    }
    return item;
  };
  return sha256(stable(portable(value)));
}
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Builds an in-memory, provider-neutral snapshot after strict manifest/artifact/source verification. */
export async function createSkillProjectionPlan(
  input: SkillProjectionPlanInput,
): Promise<SkillProjectionPlan> {
  const mapping = Object.fromEntries(
    input.artifact.entries.map((entry) => [entry.identity, entry.publicName]),
  );
  verifyRuntimeSkillArtifact(input.artifact, input.manifest, input.catalog, {
    runtime: input.artifact.runtime,
    mapping,
  });
  const catalog = new Map(input.catalog.map((skill) => [skill.identity, skill]));
  const entries: SkillProjectionPlanEntry[] = [];
  for (const artifactEntry of input.artifact.entries) {
    if (artifactEntry.exposure === 'off') {
      catalogError('STALE_ARTIFACT', 'projection plans cannot contain excluded skills');
    }
    const skill = catalog.get(artifactEntry.identity)!;
    const invocation: SkillInvocation = artifactEntry.permissions.modelInvocation
      ? 'model'
      : 'human-explicit';
    const primary = await loadSkillBody({
      canonicalRoot: input.canonicalRoot,
      manifest: input.manifest,
      artifact: input.artifact,
      runtime: input.artifact.runtime,
      identity: artifactEntry.identity,
      invocation,
    });
    let directoryFiles;
    try {
      directoryFiles = await enumerateSkillDirectory(path.dirname(artifactEntry.source.path));
    } catch {
      return catalogError(
        'SKILL_PATH_INVALID',
        `skill '${artifactEntry.identity}' directory is not inventory-safe`,
      );
    }
    const skillFiles = directoryFiles.filter(
      (file) => path.posix.basename(file.relativePath) === 'SKILL.md',
    );
    if (skillFiles.length !== 1 || skillFiles[0]?.relativePath !== 'SKILL.md') {
      catalogError(
        'SKILL_PATH_INVALID',
        `skill '${artifactEntry.identity}' must contain one source SKILL.md`,
      );
    }
    if (sha256(skillFiles[0]!.bytes) !== artifactEntry.source.contentHash) {
      catalogError(
        'SKILL_CONTENT_STALE',
        `skill '${artifactEntry.identity}' content no longer matches the artifact`,
      );
    }
    if (
      artifactEntry.source.kind === 'project' &&
      directoryDigest(directoryFiles) !== artifactEntry.source.directoryHash
    ) {
      catalogError(
        'SKILL_DIRECTORY_STALE',
        `skill '${artifactEntry.identity}' directory no longer matches the artifact`,
      );
    }
    const loaded = new Map<SkillInvocation, LoadedSkillBody>([[invocation, primary]]);
    for (const candidate of ['model', 'human-explicit'] as const) {
      const allowed =
        candidate === 'model'
          ? artifactEntry.permissions.modelInvocation
          : artifactEntry.permissions.humanInvocation;
      if (allowed && !loaded.has(candidate)) {
        loaded.set(
          candidate,
          await loadSkillBody({
            canonicalRoot: input.canonicalRoot,
            manifest: input.manifest,
            artifact: input.artifact,
            runtime: input.artifact.runtime,
            identity: artifactEntry.identity,
            invocation: candidate,
          }),
        );
      }
    }
    const humanDisclosure = {
      identity: artifactEntry.identity,
      publicName: artifactEntry.publicName,
      description: skill.description,
    };
    const modelSearchDisclosure = {
      ...humanDisclosure,
      ...('triggers' in skill && skill.triggers ? { triggers: skill.triggers } : {}),
    };
    const initial = artifactEntry.permissions.modelInvocation
      ? {
          identity: artifactEntry.identity,
          publicName: artifactEntry.publicName,
          ...(artifactEntry.exposure === 'full' ? { description: skill.description } : {}),
          ...(artifactEntry.exposure === 'full' && 'triggers' in skill && skill.triggers
            ? { triggers: skill.triggers }
            : {}),
        }
      : undefined;
    const file = (relativePath: string, bytes: Uint8Array): SkillProjectionFile => ({
      relativePath,
      bytes: Uint8Array.from(bytes),
      sha256: sha256(bytes),
    });
    entries.push({
      identity: artifactEntry.identity,
      publicName: artifactEntry.publicName,
      exposure: artifactEntry.exposure,
      canonicalDescription: skill.description,
      ...('argumentHint' in skill && skill.argumentHint
        ? { argumentHint: skill.argumentHint }
        : {}),
      ...('capabilities' in skill && skill.capabilities
        ? { capabilities: [...skill.capabilities] }
        : {}),
      ...('author' in skill && skill.author ? { author: skill.author } : {}),
      ...('version' in skill && skill.version ? { version: skill.version } : {}),
      ...('category' in skill && skill.category ? { category: skill.category } : {}),
      permissions: { ...artifactEntry.permissions },
      source: {
        kind: artifactEntry.source.kind,
        provenancePath: primary.provenance.sourcePath,
        contentHash: artifactEntry.source.contentHash,
        ...(artifactEntry.source.kind === 'project'
          ? { directoryHash: artifactEntry.source.directoryHash }
          : {}),
      },
      ...(initial ? { initialContext: initial } : {}),
      ...(artifactEntry.permissions.humanInvocation ? { humanContext: humanDisclosure } : {}),
      ...(artifactEntry.permissions.modelInvocation
        ? { modelSearchContext: modelSearchDisclosure }
        : {}),
      body: primary.body,
      wrappedBodies: Object.fromEntries(
        [...loaded].map(([key, value]) => [key, value.wrappedBody]),
      ),
      provenances: Object.fromEntries(
        [...loaded].map(([key, value]) => [key, clone(value.provenance)]),
      ),
      skillFile: file('SKILL.md', skillFiles[0]!.bytes),
      files: directoryFiles
        .filter((x) => x.relativePath !== 'SKILL.md')
        .map((x) => file(x.relativePath, x.bytes)),
    });
  }
  entries.sort((a, b) => a.identity.localeCompare(b.identity));
  const plan: SkillProjectionPlan = {
    runtime: input.artifact.runtime,
    binding: clone(input.manifest.binding),
    manifestKey: input.artifact.manifestKey,
    artifactReference: clone(input.artifact.reference),
    entries,
    initialModelContext: entries.flatMap((entry) =>
      entry.initialContext ? [entry.initialContext] : [],
    ),
    humanContext: entries.flatMap((entry) => (entry.humanContext ? [entry.humanContext] : [])),
    modelSearchContext: entries.flatMap((entry) =>
      entry.modelSearchContext ? [entry.modelSearchContext] : [],
    ),
  };
  const toJSON = (): never => {
    throw new TypeError('SkillProjectionPlan is a process-local capability');
  };
  Object.defineProperty(plan, 'toJSON', { enumerable: false, configurable: false, value: toJSON });
  verifiedPlans.set(plan, { digest: digestPlan(plan), toJSON });
  return plan;
}

export function verifySkillProjectionPlan(plan: SkillProjectionPlan): SkillProjectionPlan {
  const expected = verifiedPlans.get(plan as object);
  if (!expected) {
    catalogError(
      'SKILL_PROJECTION_PLAN_UNVERIFIED',
      'skill projection plan was not created in this process',
    );
  }
  if (
    (plan as SkillProjectionPlan & { toJSON?: unknown }).toJSON !== expected.toJSON ||
    digestPlan(plan) !== expected.digest
  ) {
    catalogError(
      'SKILL_PROJECTION_PLAN_CHANGED',
      'skill projection plan changed after verification',
    );
  }
  return plan;
}

export async function loadSkillProjectionBody(
  plan: SkillProjectionPlan,
  request: SkillProjectionBodyRequest,
): Promise<LoadedSkillBody> {
  verifySkillProjectionPlan(plan);
  const entry = plan.entries.find((candidate) => candidate.identity === request.identity);
  if (!entry) {
    catalogError(
      'SKILL_NOT_IN_ARTIFACT',
      `skill '${request.identity}' is excluded from the runtime artifact`,
    );
  }
  if (request.invocation !== 'model' && request.invocation !== 'human-explicit') {
    catalogError('SKILL_INVOCATION_INVALID', 'skill invocation must be model or human-explicit');
  }
  const allowed =
    request.invocation === 'model'
      ? entry.permissions.modelInvocation
      : entry.permissions.humanInvocation;
  if (!allowed) {
    catalogError(
      'SKILL_INVOCATION_DENIED',
      `skill '${request.identity}' does not permit ${request.invocation} loading`,
    );
  }
  return clone({
    identity: entry.identity,
    body: entry.body,
    wrappedBody: entry.wrappedBodies[request.invocation]!,
    provenance: entry.provenances[request.invocation]!,
  });
}

export function modelSearchSkillProjection(
  plan: SkillProjectionPlan,
  query: string,
  options: ModelSearchSkillProjectionOptions,
): SkillProjectionSearchResult[] {
  verifySkillProjectionPlan(plan);
  if (options.artifactKey !== plan.artifactReference.artifactKey) {
    catalogError('STALE_ARTIFACT', 'runtime operation requires the current exact v4 artifact');
  }
  if (query.length > MAX_SKILL_SEARCH_QUERY_LENGTH) {
    catalogError(
      'QUERY_TOO_LONG',
      `skill search queries are limited to ${MAX_SKILL_SEARCH_QUERY_LENGTH} characters`,
    );
  }
  return rankSearchCandidates(
    plan.modelSearchContext.map((item) => ({
      identity: item.identity,
      publicName: item.publicName,
      description: item.description ?? '',
      ...(item.triggers ? { triggers: item.triggers } : {}),
    })),
    query,
    options.limit,
    MAX_SKILL_SEARCH_RESULTS,
  );
}
