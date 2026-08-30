import type { JsonValue } from './json.js';
import { sha256Canonical } from './json.js';

export const SKILL_ARTIFACT_SCHEMA_VERSION = 3 as const;

export interface SkillArtifactFacts {
  readonly runtime: 'claude' | 'pi';
  readonly identity: string;
  readonly skillPolicy: string;
  readonly contentScope: string;
  readonly projectId: string | null;
  readonly catalogHash: string;
  readonly enabledPacks: readonly string[];
  readonly skillPolicyConfig: JsonValue;
  readonly contentScopeExposure: JsonValue;
  readonly projectExposure: JsonValue;
}

export interface SkillArtifactReference {
  readonly schemaVersion: typeof SKILL_ARTIFACT_SCHEMA_VERSION;
  readonly runtime: 'claude' | 'pi';
  readonly identity: string;
  readonly skillPolicy: string;
  readonly contentScope: string;
  readonly projectId: string | null;
  readonly catalogHash: string;
  readonly enabledPacks: readonly string[];
  readonly skillPolicyConfigHash: string;
  readonly contentScopeExposureHash: string;
  readonly projectExposureHash: string;
  readonly effectivePolicyHash: string;
  readonly artifactKey: string;
}

function policyTuple(
  reference: Omit<SkillArtifactReference, 'effectivePolicyHash' | 'artifactKey'>,
): JsonValue {
  return {
    schemaVersion: reference.schemaVersion,
    identity: reference.identity,
    skillPolicy: { name: reference.skillPolicy, declarationHash: reference.skillPolicyConfigHash },
    runtime: reference.runtime,
    contentScope: {
      name: reference.contentScope,
      enabledPacks: [...reference.enabledPacks],
      exposureHash: reference.contentScopeExposureHash,
    },
    project: { id: reference.projectId, exposureHash: reference.projectExposureHash },
  };
}

function artifactTuple(reference: Omit<SkillArtifactReference, 'artifactKey'>): JsonValue {
  return {
    schemaVersion: reference.schemaVersion,
    runtime: reference.runtime,
    identity: reference.identity,
    skillPolicy: reference.skillPolicy,
    contentScope: reference.contentScope,
    projectId: reference.projectId,
    catalogHash: reference.catalogHash,
    enabledPacks: [...reference.enabledPacks],
    skillPolicyConfigHash: reference.skillPolicyConfigHash,
    contentScopeExposureHash: reference.contentScopeExposureHash,
    projectExposureHash: reference.projectExposureHash,
    effectivePolicyHash: reference.effectivePolicyHash,
  };
}

export function createSkillArtifactReference(facts: SkillArtifactFacts): SkillArtifactReference {
  const base = {
    schemaVersion: SKILL_ARTIFACT_SCHEMA_VERSION,
    runtime: facts.runtime,
    identity: facts.identity,
    skillPolicy: facts.skillPolicy,
    contentScope: facts.contentScope,
    projectId: facts.projectId,
    catalogHash: facts.catalogHash,
    enabledPacks: [...facts.enabledPacks].sort(),
    skillPolicyConfigHash: sha256Canonical(facts.skillPolicyConfig),
    contentScopeExposureHash: sha256Canonical(facts.contentScopeExposure),
    projectExposureHash: sha256Canonical(facts.projectExposure),
  };
  const effectivePolicyHash = sha256Canonical(policyTuple(base));
  const withPolicy = { ...base, effectivePolicyHash };
  return { ...withPolicy, artifactKey: sha256Canonical(artifactTuple(withPolicy)) };
}

export function canonicalSkillArtifactReference(
  reference: SkillArtifactReference,
): SkillArtifactReference {
  return {
    schemaVersion: reference.schemaVersion,
    runtime: reference.runtime,
    identity: reference.identity,
    skillPolicy: reference.skillPolicy,
    contentScope: reference.contentScope,
    projectId: reference.projectId,
    catalogHash: reference.catalogHash,
    enabledPacks: [...reference.enabledPacks].sort(),
    skillPolicyConfigHash: reference.skillPolicyConfigHash,
    contentScopeExposureHash: reference.contentScopeExposureHash,
    projectExposureHash: reference.projectExposureHash,
    effectivePolicyHash: reference.effectivePolicyHash,
    artifactKey: reference.artifactKey,
  };
}

export function isValidSkillArtifactReference(reference: SkillArtifactReference): boolean {
  if (reference.schemaVersion !== SKILL_ARTIFACT_SCHEMA_VERSION) {
    return false;
  }
  const canonical = canonicalSkillArtifactReference(reference);
  const effectivePolicyHash = sha256Canonical(policyTuple(canonical));
  return (
    reference.effectivePolicyHash === effectivePolicyHash &&
    reference.artifactKey === sha256Canonical(artifactTuple(canonical))
  );
}
