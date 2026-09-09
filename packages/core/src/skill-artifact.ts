import path from 'node:path';
import type { JsonValue } from './json.js';
import { sha256Canonical } from './json.js';

export const SKILL_ARTIFACT_SCHEMA_VERSION = 4 as const;

export type SkillArtifactPack = 'development' | 'personal';

export interface SkillArtifactSelection {
  readonly location: { readonly name: string; readonly canonicalRoot: string };
  readonly packs: readonly SkillArtifactPack[];
  readonly source: 'project' | 'user-project' | 'user-location';
}

export interface SkillArtifactFacts {
  readonly runtime: 'claude' | 'pi';
  readonly identity: string;
  readonly projectId: string | null;
  readonly repositoryId: string;
  readonly catalogHash: string;
  readonly selection: SkillArtifactSelection;
}

export interface SkillArtifactReference {
  readonly schemaVersion: typeof SKILL_ARTIFACT_SCHEMA_VERSION;
  readonly runtime: 'claude' | 'pi';
  readonly identity: string;
  readonly projectId: string | null;
  readonly repositoryId: string;
  readonly catalogHash: string;
  readonly location: { readonly name: string; readonly canonicalRoot: string };
  readonly packs: readonly SkillArtifactPack[];
  readonly selectionSource: SkillArtifactSelection['source'];
  readonly selectionHash: string;
  readonly artifactKey: string;
}

function selectionTuple(
  reference: Pick<
    SkillArtifactReference,
    'identity' | 'projectId' | 'repositoryId' | 'location' | 'packs' | 'selectionSource'
  >,
): JsonValue {
  return {
    identity: reference.identity,
    projectId: reference.projectId,
    repositoryId: reference.repositoryId,
    location: reference.location,
    packs: [...reference.packs],
    source: reference.selectionSource,
  };
}

function artifactTuple(reference: Omit<SkillArtifactReference, 'artifactKey'>): JsonValue {
  return {
    schemaVersion: reference.schemaVersion,
    runtime: reference.runtime,
    identity: reference.identity,
    projectId: reference.projectId,
    repositoryId: reference.repositoryId,
    catalogHash: reference.catalogHash,
    location: reference.location,
    packs: [...reference.packs],
    selectionSource: reference.selectionSource,
    selectionHash: reference.selectionHash,
  };
}

export function createSkillArtifactReference(facts: SkillArtifactFacts): SkillArtifactReference {
  if (
    facts.selection.packs.length === 0 ||
    new Set(facts.selection.packs).size !== facts.selection.packs.length ||
    facts.selection.packs.some((pack) => pack !== 'development' && pack !== 'personal')
  ) {
    throw new Error('skill artifact selection contains invalid packs');
  }
  const base = {
    schemaVersion: SKILL_ARTIFACT_SCHEMA_VERSION,
    runtime: facts.runtime,
    identity: facts.identity,
    projectId: facts.projectId,
    repositoryId: facts.repositoryId,
    catalogHash: facts.catalogHash,
    location: { ...facts.selection.location },
    packs: [...facts.selection.packs].sort(),
    selectionSource: facts.selection.source,
  };
  const withSelection = { ...base, selectionHash: sha256Canonical(selectionTuple(base)) };
  return { ...withSelection, artifactKey: sha256Canonical(artifactTuple(withSelection)) };
}

export function canonicalSkillArtifactReference(
  reference: SkillArtifactReference,
): SkillArtifactReference {
  return {
    schemaVersion: reference.schemaVersion,
    runtime: reference.runtime,
    identity: reference.identity,
    projectId: reference.projectId,
    repositoryId: reference.repositoryId,
    catalogHash: reference.catalogHash,
    location: { ...reference.location },
    packs: [...reference.packs].sort(),
    selectionSource: reference.selectionSource,
    selectionHash: reference.selectionHash,
    artifactKey: reference.artifactKey,
  };
}

const referenceKeys = [
  'schemaVersion',
  'runtime',
  'identity',
  'projectId',
  'repositoryId',
  'catalogHash',
  'location',
  'packs',
  'selectionSource',
  'selectionHash',
  'artifactKey',
] as const;
const locationKeys = ['name', 'canonicalRoot'] as const;
const digestPattern = /^[a-f0-9]{64}$/u;
const labelPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const projectIdPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u;

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

export function isValidSkillArtifactReference(
  reference: unknown,
): reference is SkillArtifactReference {
  if (!isExactRecord(reference, referenceKeys)) {
    return false;
  }
  const location = reference.location;
  if (
    !isExactRecord(location, locationKeys) ||
    !isBoundedText(location.name, 64) ||
    !labelPattern.test(location.name) ||
    !isBoundedText(location.canonicalRoot, 4096) ||
    (!path.win32.isAbsolute(location.canonicalRoot) &&
      !path.posix.isAbsolute(location.canonicalRoot)) ||
    reference.schemaVersion !== SKILL_ARTIFACT_SCHEMA_VERSION ||
    (reference.runtime !== 'claude' && reference.runtime !== 'pi') ||
    !isBoundedText(reference.identity, 64) ||
    !labelPattern.test(reference.identity) ||
    (reference.projectId !== null &&
      (!isBoundedText(reference.projectId, 129) || !projectIdPattern.test(reference.projectId))) ||
    !isBoundedText(reference.repositoryId, 129) ||
    (reference.repositoryId !== 'unbound' && !projectIdPattern.test(reference.repositoryId)) ||
    typeof reference.catalogHash !== 'string' ||
    !digestPattern.test(reference.catalogHash) ||
    !['project', 'user-project', 'user-location'].includes(reference.selectionSource as string) ||
    typeof reference.selectionHash !== 'string' ||
    !digestPattern.test(reference.selectionHash) ||
    typeof reference.artifactKey !== 'string' ||
    !digestPattern.test(reference.artifactKey)
  ) {
    return false;
  }
  const packs = reference.packs;
  if (
    !Array.isArray(packs) ||
    packs.length === 0 ||
    packs.length > 2 ||
    new Set(packs).size !== packs.length ||
    packs.some((pack) => pack !== 'development' && pack !== 'personal') ||
    packs.some((pack, index) => index > 0 && packs[index - 1]! > pack)
  ) {
    return false;
  }
  const typed = reference as unknown as SkillArtifactReference;
  return (
    typed.selectionHash === sha256Canonical(selectionTuple(typed)) &&
    typed.artifactKey === sha256Canonical(artifactTuple(typed))
  );
}
