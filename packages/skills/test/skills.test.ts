import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inventoryCanonical, resolveManifest, searchSkills, SkillCatalogError, type Exposure } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
async function catalog(exposure: Exposure = "name-only") {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-skills-")); roots.push(root);
  await mkdir(path.join(root, "review"));
  await writeFile(path.join(root, "review", "SKILL.md"), `---\nname: review\ndescription: Review source safely\ntriggers: code inspection\nmetadata:\n  mpx:\n    skillPacks: [core]\n    defaultExposure: ${exposure}\n---\nSECRET BODY\n`);
  return inventoryCanonical(root);
}

describe("skill manifests", () => {
  it.each(["full", "name-only", "explicit-only", "off"] as const)("projects %s deterministically", async exposure => {
    const skills = await catalog();
    const manifest = resolveManifest(skills, { runtime: "pi", scope: "work", enabledPacks: ["core"], projectExposure: { skills: { review: exposure } }, mappingVersion: "1" });
    expect(JSON.stringify(manifest)).not.toContain("SECRET BODY");
    expect(manifest.entries.map(x => x.exposure)).toEqual(exposure === "off" ? [] : [exposure]);
    expect(resolveManifest(skills, { runtime: "pi", scope: "work", enabledPacks: ["core"], projectExposure: { skills: { review: exposure } }, mappingVersion: "1" })).toEqual(manifest);
  });

  it("hides non-model-invocable search and binds runtime searches", async () => {
    const skills = await catalog("explicit-only");
    const manifest = resolveManifest(skills, { runtime: "claude", scope: "neutral", enabledPacks: ["core"], mappingVersion: "1" });
    expect(searchSkills(manifest, skills, "review")).toEqual([]);
    expect(() => searchSkills(manifest, skills, "review", { runtime: true, artifactKey: "stale" })).toThrow(SkillCatalogError);
  });

  it("rejects malicious YAML aliases", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-skills-")); roots.push(root); await mkdir(path.join(root, "bad"));
    await writeFile(path.join(root, "bad", "SKILL.md"), "---\nname: bad\ndescription: *secret\nmetadata:\n  mpx:\n    skillPacks: [core]\n    defaultExposure: full\n---\n");
    await expect(inventoryCanonical(root)).rejects.toThrow(SkillCatalogError);
  });
});
