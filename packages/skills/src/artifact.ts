import {
  createRuntimeSkillArtifactReferenceV4,
  parseResolvedSkillManifestV4,
  parseRuntimeSkillArtifactReferenceV4,
  type ResolvedSkillDecisionV4,
  RuntimeContractError,
  type RuntimeSkillArtifactReferenceV4,
} from '@mpx/runtime-contracts';
import {
  catalogError,
  digest,
  stable,
  type CatalogSkill,
  type ResolvedManifest,
  type Runtime,
  type RuntimeSkillArtifact,
  type RuntimeSkillEntry,
} from './contracts.js';
import { isProjectSkill, skillSourceHash } from './inventory.js';

function artifactFileMap(entries: readonly RuntimeSkillEntry[]): unknown[] {
  return entries
    .map((entry) => ({
      identity: entry.identity,
      publicName: entry.publicName,
      packs: [...entry.packs].sort(),
      exposure: entry.exposure,
      metadataHash: entry.metadataHash,
      description: entry.description ?? null,
      triggers: entry.triggers ?? null,
      source:
        entry.source.kind === 'project'
          ? {
              kind: entry.source.kind,
              path: entry.source.path,
              realPath: entry.source.realPath,
              contentHash: entry.source.contentHash,
              directoryHash: entry.source.directoryHash,
              projectRoot: entry.source.projectRoot,
              realProjectRoot: entry.source.realProjectRoot,
            }
          : {
              kind: entry.source.kind,
              path: entry.source.path,
              realPath: entry.source.realPath,
              contentHash: entry.source.contentHash,
            },
      permissions: { ...entry.permissions },
    }))
    .sort((a, b) => a.identity.localeCompare(b.identity));
}

export function createRuntimeSkillArtifact(
  manifestValue: ResolvedManifest,
  catalog: readonly CatalogSkill[],
  options: {
    runtime: Runtime;
    mapping?: Readonly<Record<string, string>> | undefined;
  },
): RuntimeSkillArtifact {
  const manifest = parseResolvedSkillManifestV4(manifestValue);
  const source = new Map(catalog.map((skill) => [skill.identity, skill]));
  if (source.size !== manifest.decisions.length) {
    catalogError(
      'STALE_CATALOG',
      'skill catalog membership no longer matches the resolved manifest',
    );
  }
  for (const decision of manifest.decisions) {
    const skill = source.get(decision.identity);
    if (!skill || skillSourceHash(skill) !== decision.sourceHash) {
      catalogError(
        'STALE_CATALOG',
        `skill '${decision.identity}' no longer matches the resolved manifest`,
      );
    }
  }
  const entries = manifest.decisions
    .filter((decision) => decision.included)
    .map((decision): RuntimeSkillEntry =>
      runtimeEntry(source.get(decision.identity)!, decision, options.mapping ?? {}),
    )
    .sort((a, b) => a.identity.localeCompare(b.identity));
  const fileMapHash = digest(artifactFileMap(entries));
  const artifactKey = digest({
    schemaVersion: 4,
    runtime: options.runtime,
    manifestKey: manifest.manifestKey,
    fileMapHash,
  });
  const reference = createRuntimeSkillArtifactReferenceV4({
    runtime: options.runtime,
    manifestKey: manifest.manifestKey,
    artifactKey,
    fileMapHash,
  });
  const artifact: RuntimeSkillArtifact = {
    schemaVersion: 4,
    runtime: options.runtime,
    manifestKey: manifest.manifestKey,
    reference,
    entries,
  };
  return verifyRuntimeSkillArtifact(artifact, manifest, catalog, options);
}

function tampered(reason: string, identity?: string): never {
  throw new RuntimeContractError(
    'RUNTIME_ARTIFACT_TAMPERED',
    'runtime artifact no longer matches its bound resolved manifest',
    { restartRequired: true, reason, ...(identity === undefined ? {} : { identity }) },
  );
}
function runtimeEntry(
  skill: CatalogSkill,
  decision: ResolvedSkillDecisionV4,
  mapping: Readonly<Record<string, string>>,
): RuntimeSkillEntry {
  const project = isProjectSkill(skill);
  return {
    identity: skill.identity,
    publicName:
      mapping[skill.identity] ?? (project ? `/${skill.identity}` : `/mpx:${skill.identity}`),
    packs: project ? [] : [...skill.skillPacks].sort(),
    exposure: decision.exposure,
    metadataHash: decision.metadataHash,
    ...(decision.exposure === 'full'
      ? {
          description: skill.description,
          ...(!project && skill.triggers ? { triggers: skill.triggers } : {}),
        }
      : {}),
    source: project
      ? {
          kind: 'project',
          path: skill.sourcePath,
          realPath: skill.realPath,
          contentHash: skill.contentHash,
          directoryHash: skill.directoryHash,
          projectRoot: skill.projectRoot,
          realProjectRoot: skill.realProjectRoot,
        }
      : {
          kind: 'canonical',
          path: skill.sourcePath,
          realPath: skill.realPath,
          contentHash: skill.contentHash,
        },
    permissions: { ...decision.permissions },
  };
}
function expectedRuntimeEntries(
  manifest: ResolvedManifest,
  catalog: readonly CatalogSkill[],
  mapping: Readonly<Record<string, string>>,
): RuntimeSkillEntry[] {
  const source = new Map<string, CatalogSkill>();
  for (const skill of catalog) {
    if (source.has(skill.identity)) {
      tampered('duplicate-catalog-identity', skill.identity);
    }
    source.set(skill.identity, skill);
  }
  if (source.size !== manifest.decisions.length) {
    tampered('catalog-membership');
  }
  const decisionIds = new Set<string>();
  const entries: RuntimeSkillEntry[] = [];
  for (const decision of manifest.decisions) {
    if (decisionIds.has(decision.identity)) {
      tampered('duplicate-manifest-decision', decision.identity);
    }
    decisionIds.add(decision.identity);
    const skill = source.get(decision.identity);
    if (!skill || skillSourceHash(skill) !== decision.sourceHash) {
      tampered('catalog-source-hash', decision.identity);
    }
    if (!decision.included) {
      continue;
    }
    if (
      decision.exposure === 'off' ||
      decision.exclusionReasons.includes('off') ||
      decision.exclusionReasons.includes('pack-excluded')
    ) {
      tampered('invalid-inclusion-decision', decision.identity);
    }
    entries.push(runtimeEntry(skill, decision, mapping));
  }
  return entries.sort((a, b) => a.identity.localeCompare(b.identity));
}
export function verifyRuntimeSkillArtifact(
  artifact: RuntimeSkillArtifact,
  manifestValue: ResolvedManifest,
  catalog: readonly CatalogSkill[],
  options: {
    runtime: Runtime;
    mapping?: Readonly<Record<string, string>> | undefined;
  },
): RuntimeSkillArtifact {
  let manifest: ResolvedManifest;
  try {
    manifest = parseResolvedSkillManifestV4(manifestValue);
  } catch {
    return tampered('manifest-invalid');
  }
  if (
    artifact.schemaVersion !== 4 ||
    artifact.runtime !== options.runtime ||
    artifact.manifestKey !== manifest.manifestKey
  ) {
    tampered('artifact-binding');
  }
  const expectedEntries = expectedRuntimeEntries(manifest, catalog, options.mapping ?? {});
  const expectedById = new Map(expectedEntries.map((entry) => [entry.identity, entry]));
  const actualIds = new Set<string>();
  for (const entry of artifact.entries) {
    if (actualIds.has(entry.identity)) {
      tampered('duplicate-entry', entry.identity);
    }
    actualIds.add(entry.identity);
    const expected = expectedById.get(entry.identity);
    if (!expected) {
      tampered('extra-or-excluded-entry', entry.identity);
    }
    for (const field of [
      'publicName',
      'packs',
      'exposure',
      'metadataHash',
      'description',
      'triggers',
      'source',
      'permissions',
    ] as const) {
      if (stable(entry[field]) !== stable(expected[field])) {
        tampered(`${field}-mismatch`, entry.identity);
      }
    }
  }
  for (const expected of expectedEntries) {
    if (!actualIds.has(expected.identity)) {
      tampered('missing-entry', expected.identity);
    }
  }
  if (
    artifact.entries.map((entry) => entry.identity).join('\0') !==
    expectedEntries.map((entry) => entry.identity).join('\0')
  ) {
    tampered('entry-order');
  }
  const fileMapHash = digest(artifactFileMap(expectedEntries));
  const expectedReference = createRuntimeSkillArtifactReferenceV4({
    runtime: options.runtime,
    manifestKey: manifest.manifestKey,
    fileMapHash,
    artifactKey: digest({
      schemaVersion: 4,
      runtime: options.runtime,
      manifestKey: manifest.manifestKey,
      fileMapHash,
    }),
  });
  let reference: RuntimeSkillArtifactReferenceV4;
  try {
    reference = parseRuntimeSkillArtifactReferenceV4(artifact.reference);
  } catch {
    return tampered('reference-invalid');
  }
  if (stable(reference) !== stable(expectedReference)) {
    tampered('file-map-binding');
  }
  return artifact;
}

export function validateArtifact(
  artifact: RuntimeSkillArtifact,
  catalog?: readonly CatalogSkill[],
  artifactKey?: string,
): RuntimeSkillArtifact {
  try {
    if (
      artifact.schemaVersion !== 4 ||
      artifact.manifestKey !== artifact.reference.manifestKey ||
      artifact.runtime !== artifact.reference.runtime
    ) {
      throw new Error('schema or binding mismatch');
    }
    const reference = parseRuntimeSkillArtifactReferenceV4(artifact.reference);
    const fileMapHash = digest(artifactFileMap(artifact.entries));
    const calculatedKey = digest({
      schemaVersion: 4,
      runtime: artifact.runtime,
      manifestKey: artifact.manifestKey,
      fileMapHash,
    });
    if (
      reference.fileMapHash !== fileMapHash ||
      reference.artifactKey !== calculatedKey ||
      (artifactKey !== undefined && artifactKey !== reference.artifactKey)
    ) {
      throw new Error('artifact hash mismatch');
    }
    if (catalog) {
      const source = new Map(catalog.map((skill) => [skill.identity, skill]));
      for (const entry of artifact.entries) {
        const skill = source.get(entry.identity);
        if (
          !skill ||
          skill.contentHash !== entry.source.contentHash ||
          (isProjectSkill(skill) &&
            (entry.source.kind !== 'project' || skill.directoryHash !== entry.source.directoryHash))
        ) {
          throw new Error('catalog hash mismatch');
        }
      }
    }
    return artifact;
  } catch {
    return catalogError(
      'STALE_ARTIFACT',
      'runtime operation requires the current exact v4 artifact',
    );
  }
}
