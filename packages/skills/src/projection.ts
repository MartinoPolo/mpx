import { isPathWithinRoot } from '@mpx/core';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  catalogError,
  stable,
  type CatalogSkill,
  type ResolvedManifest,
  type RuntimeSkillArtifact,
  type SkillInvocation,
  type SkillProjectionFile,
  type SkillProjectionPlan,
  type SkillProjectionPlanEntry,
} from './contracts.js';
import { validateArtifact, verifyRuntimeSkillArtifact } from './artifact.js';
import { skillResolutionKey } from './identity.js';
import { directoryDigest, enumerateSkillDirectory } from './inventory.js';
import { loadSkillBody, type LoadedSkillBody } from './loader.js';
import { rankSearchCandidates } from './search-ranking.js';
import { MAX_SKILL_SEARCH_QUERY_LENGTH, MAX_SKILL_SEARCH_RESULTS } from './search.js';

export function humanSkillDetail(
  artifact: RuntimeSkillArtifact,
  catalog: readonly CatalogSkill[],
  identity: string,
): { identity: string; publicName: string; description: string } | undefined {
  validateArtifact(artifact, catalog);
  const entry = artifact.entries.find(
    (x) => x.identity === identity && x.permissions.humanInvocation,
  );
  const skill = catalog.find((candidate) => skillResolutionKey(candidate) === identity);
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

const samePath = (left: string, right: string): boolean => {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
};

type ProjectArtifactEntry = RuntimeSkillArtifact['entries'][number] & {
  source: Extract<RuntimeSkillArtifact['entries'][number]['source'], { kind: 'project' }>;
};

type DirectorySnapshot = Readonly<{
  path: string;
  stat: Awaited<ReturnType<typeof lstat>>;
  real: string;
}>;

function sameFileIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.isDirectory() === right.isDirectory() &&
    left.isSymbolicLink() === right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

async function snapshotProjectSharedFiles(
  projectEntries: readonly ProjectArtifactEntry[],
): Promise<readonly SkillProjectionFile[] | undefined> {
  if (!projectEntries.length) {
    return undefined;
  }
  const first = projectEntries[0]!.source;
  if (
    projectEntries.some(
      (entry) =>
        !samePath(entry.source.projectRoot, first.projectRoot) ||
        !samePath(entry.source.realProjectRoot, first.realProjectRoot),
    )
  ) {
    return catalogError(
      'SKILL_PATH_INVALID',
      'included project skills must share one verified project root',
    );
  }
  const ancestors = [
    first.projectRoot,
    path.join(first.projectRoot, '.agents'),
    path.join(first.projectRoot, '.agents', 'skills'),
  ];
  const sharedRoot = path.join(ancestors[2]!, 'shared');
  try {
    await lstat(sharedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    return catalogError('SKILL_PATH_INVALID', 'project shared support is not inventory-safe');
  }
  try {
    const directories = [...ancestors, sharedRoot];
    const snapshots: DirectorySnapshot[] = [];
    for (const candidate of directories) {
      const before = await lstat(candidate);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw new Error('unsafe project shared directory');
      }
      const real = await realpath(candidate);
      const after = await lstat(candidate);
      if (!sameFileIdentity(before, after)) {
        throw new Error('unsafe project shared directory');
      }
      snapshots.push({ path: candidate, stat: after, real });
    }
    const currentProjectRoot = snapshots[0]!.real;
    if (
      !samePath(currentProjectRoot, first.realProjectRoot) ||
      snapshots.slice(1).some((snapshot) => !isPathWithinRoot(snapshot.real, currentProjectRoot))
    ) {
      throw new Error('unsafe project shared directory');
    }
    const files = await enumerateSkillDirectory(sharedRoot);
    for (const snapshot of snapshots) {
      const [current, currentReal] = await Promise.all([
        lstat(snapshot.path),
        realpath(snapshot.path),
      ]);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        !sameFileIdentity(snapshot.stat, current) ||
        !samePath(snapshot.real, currentReal)
      ) {
        throw new Error('unsafe project shared directory');
      }
    }
    if (files.some((file) => path.posix.basename(file.relativePath).toLowerCase() === 'skill.md')) {
      return catalogError(
        'SKILL_PATH_INVALID',
        'project shared support cannot contain a SKILL.md entry',
      );
    }
    return files.map((file) => ({
      relativePath: file.relativePath,
      bytes: Uint8Array.from(file.bytes),
      sha256: sha256(file.bytes),
    }));
  } catch (error) {
    if (error instanceof Error && error.name === 'SkillCatalogError') {
      throw error;
    }
    return catalogError('SKILL_PATH_INVALID', 'project shared support is not inventory-safe');
  }
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
  const catalog = new Map(input.catalog.map((skill) => [skillResolutionKey(skill), skill]));
  const entries: SkillProjectionPlanEntry[] = [];
  for (const artifactEntry of input.artifact.entries) {
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
      identity: artifactEntry.identity,
      publicName: artifactEntry.publicName,
      ...(artifactEntry.exposure === 'full' ? { description: skill.description } : {}),
      ...(artifactEntry.exposure === 'full' && 'triggers' in skill && skill.triggers
        ? { triggers: skill.triggers }
        : {}),
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
  const projectSharedFiles = await snapshotProjectSharedFiles(
    input.artifact.entries.filter(
      (entry): entry is ProjectArtifactEntry => entry.source.kind === 'project',
    ),
  );
  const plan: SkillProjectionPlan = {
    runtime: input.artifact.runtime,
    binding: clone(input.manifest.binding),
    manifestKey: input.artifact.manifestKey,
    artifactReference: clone(input.artifact.reference),
    entries,
    ...(projectSharedFiles ? { projectSharedFiles } : {}),
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
    catalogError('STALE_ARTIFACT', 'runtime operation requires the current exact v5 artifact');
  }
  if (query.length > MAX_SKILL_SEARCH_QUERY_LENGTH) {
    catalogError(
      'QUERY_TOO_LONG',
      `skill search queries are limited to ${MAX_SKILL_SEARCH_QUERY_LENGTH} characters`,
    );
  }
  const searchable = plan.entries.filter((entry) => entry.modelSearchContext);
  const exposure = new Map(searchable.map((entry) => [entry.identity, entry.exposure]));
  return rankSearchCandidates(
    searchable.map((entry) => ({
      identity: entry.identity,
      publicName: entry.publicName,
      description: entry.canonicalDescription,
      ...(entry.modelSearchContext?.triggers
        ? { triggers: entry.modelSearchContext.triggers }
        : {}),
    })),
    query,
    options.limit,
    MAX_SKILL_SEARCH_RESULTS,
  ).map((result) =>
    exposure.get(result.identity) === 'full' ? result : { ...result, description: '' },
  );
}
