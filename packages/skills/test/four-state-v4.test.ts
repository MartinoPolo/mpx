import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SkillCatalogError, createRuntimeSkillArtifact, humanCompleteSkills, humanListSkills, humanSearchSkills,
  initialModelContext, inventoryCanonical, loadSkillBody, modelSearchSkills, resolveManifest,
  type Exposure,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(exposures: Record<string, Exposure>) {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-four-v4-")); roots.push(root);
  for (const [name, exposure] of Object.entries(exposures)) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} discoverable description\ntriggers: prose says /mpx:${name}\nmetadata:\n  mpx:\n    skillPacks: [core]\n    defaultExposure: ${exposure}\n---\n${name.toUpperCase()} BODY\n`);
  }
  const catalog = await inventoryCanonical(root);
  const manifest = resolveManifest(catalog, { repositoryId: "repo", projectId: "project", contentScope: "work", identity: "work", skillPolicy: "developer", skillPolicyConfig: { skillExposure: { default: "name-only", skills: exposures } }, enabledPacks: ["core"] });
  const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: "pi" });
  return { root, catalog, manifest, artifact };
}

function errorCode(error: unknown): string | undefined { return error instanceof SkillCatalogError ? error.diagnostics[0]?.code : undefined; }

describe("four-state v4 policy", () => {
  it("enforces exact discovery and lazy-load surfaces while slash prose remains inert", async () => {
    const value = await fixture({ full: "full", named: "name-only", explicit: "explicit-only", disabled: "off" });
    expect(initialModelContext(value.artifact)).toEqual([
      { identity: "full", publicName: "/mpx:full", description: "full discoverable description", triggers: "prose says /mpx:full" },
      { identity: "named", publicName: "/mpx:named" },
    ]);
    expect(modelSearchSkills(value.artifact, value.catalog, "description", { artifactKey: value.artifact.reference.artifactKey }).map((x) => x.identity)).toEqual(["full", "named"]);
    expect(humanListSkills(value.artifact).map((x) => x.identity)).toEqual(["explicit", "full", "named"]);
    expect(humanSearchSkills(value.artifact, value.catalog, "explicit").map((x) => x.identity)).toEqual(["explicit"]);
    expect(humanCompleteSkills(value.artifact, "/mpx:")).toEqual(["/mpx:explicit", "/mpx:full", "/mpx:named"]);
    await expect(loadSkillBody({ canonicalRoot: value.root, manifest: value.manifest, artifact: value.artifact, runtime: "pi", identity: "explicit", invocation: "model" })).rejects.toSatisfy((error: unknown) => errorCode(error) === "SKILL_INVOCATION_DENIED");
    expect((await loadSkillBody({ canonicalRoot: value.root, manifest: value.manifest, artifact: value.artifact, runtime: "pi", identity: "explicit", invocation: "human-explicit" })).body).toBe("EXPLICIT BODY\n");
    await expect(loadSkillBody({ canonicalRoot: value.root, manifest: value.manifest, artifact: value.artifact, runtime: "pi", identity: "disabled", invocation: "human-explicit" })).rejects.toSatisfy((error: unknown) => errorCode(error) === "SKILL_NOT_IN_ARTIFACT");
    expect(humanSearchSkills(value.artifact, value.catalog, "/mpx:disabled")).toEqual([]);
  });

  it("rejects v3, stale hashes, runtime mismatches, and excluded requests", async () => {
    const value = await fixture({ named: "name-only", excluded: "name-only" });
    const stale = structuredClone(value.artifact) as typeof value.artifact & { schemaVersion: number };
    stale.schemaVersion = 3;
    expect(() => modelSearchSkills(stale, value.catalog, "named", { artifactKey: stale.reference.artifactKey })).toThrowError(/STALE_ARTIFACT/u);
    await writeFile(path.join(value.root, "named", "SKILL.md"), "changed");
    await expect(loadSkillBody({ canonicalRoot: value.root, manifest: value.manifest, artifact: value.artifact, runtime: "pi", identity: "named", invocation: "model" })).rejects.toSatisfy((error: unknown) => errorCode(error) === "SKILL_CONTENT_STALE");
    await expect(loadSkillBody({ canonicalRoot: value.root, manifest: value.manifest, artifact: value.artifact, runtime: "claude", identity: "named", invocation: "model" })).rejects.toSatisfy((error: unknown) => errorCode(error) === "SKILL_RUNTIME_MISMATCH");
    const excludedManifest = resolveManifest(value.catalog, { repositoryId: "repo", contentScope: "work", identity: "work", skillPolicy: "developer", skillPolicyConfig: { skillExposure: { default: "name-only" } }, enabledPacks: [] });
    const excludedArtifact = createRuntimeSkillArtifact(excludedManifest, value.catalog, { runtime: "pi" });
    await expect(loadSkillBody({ canonicalRoot: value.root, manifest: excludedManifest, artifact: excludedArtifact, runtime: "pi", identity: "excluded", invocation: "human-explicit" })).rejects.toSatisfy((error: unknown) => errorCode(error) === "SKILL_NOT_IN_ARTIFACT");
  });
});
