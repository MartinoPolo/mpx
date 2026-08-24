import { describe, expect, it } from "vitest";
import { createSkillArtifactReference, isValidSkillArtifactReference, SKILL_ARTIFACT_SCHEMA_VERSION, type SkillArtifactReference } from "./skill-artifact.js";

const facts = {
  runtime: "pi" as const,
  identity: "work",
  skillPolicy: "clean",
  contentScope: "work",
  projectId: null,
  catalogHash: "a".repeat(64),
  enabledPacks: ["core"],
  skillPolicyConfig: { skillExposure: { default: "explicit-only" } },
  contentScopeExposure: null,
  projectExposure: null,
};

describe("skill artifact references", () => {
  it("invalidates references from the previous artifact schema", () => {
    const current = createSkillArtifactReference(facts);
    expect(current.schemaVersion).toBe(SKILL_ARTIFACT_SCHEMA_VERSION);
    expect(isValidSkillArtifactReference(current)).toBe(true);
    const old = { ...current, schemaVersion: 1 } as unknown as SkillArtifactReference;
    expect(isValidSkillArtifactReference(old)).toBe(false);
  });
});
