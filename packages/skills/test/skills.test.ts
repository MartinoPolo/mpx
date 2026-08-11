import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { doctor, inventoryCanonical, inventoryProjectSkills, resolveManifest, searchSkills, SkillCatalogError, type CanonicalSkill, type Exposure } from "../src/index.js";

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

  it("projects discovery metadata and invocation permissions for every exposure", async () => {
    const skills = await catalog();
    const resolve = (exposure: Exposure) => resolveManifest(skills, {
      runtime: "claude", scope: "work", enabledPacks: ["core"],
      projectExposure: { skills: { review: exposure } }, mappingVersion: "1",
    }).entries[0];
    expect(resolve("full")).toMatchObject({ description: "Review source safely", triggers: "code inspection", permissions: { userInvocation: true, modelInvocation: true } });
    const nameOnly = resolve("name-only");
    expect(nameOnly).toMatchObject({ permissions: { userInvocation: true, modelInvocation: true } });
    expect(nameOnly).not.toHaveProperty("description");
    expect(nameOnly).not.toHaveProperty("triggers");
    const explicitOnly = resolve("explicit-only");
    expect(explicitOnly).toMatchObject({ permissions: { userInvocation: true, modelInvocation: false } });
    expect(explicitOnly).not.toHaveProperty("description");
    expect(explicitOnly).not.toHaveProperty("triggers");
    expect(resolve("off")).toBeUndefined();
  });

  it("applies exposure precedence and excludes disabled packs", async () => {
    const skills = await catalog("explicit-only");
    const base = { runtime: "pi" as const, scope: "work", enabledPacks: ["core"] as const, mappingVersion: "1" };
    expect(resolveManifest(skills, { ...base, scopeExposure: { default: "full", skills: { review: "name-only" } } }).entries[0]?.exposure).toBe("name-only");
    expect(resolveManifest(skills, { ...base, scopeExposure: { skills: { review: "full" } }, projectExposure: { default: "name-only" } }).entries[0]?.exposure).toBe("name-only");
    expect(resolveManifest(skills, { ...base, scopeExposure: { default: "full" }, projectExposure: { default: "name-only", skills: { review: "explicit-only" } } }).entries[0]?.exposure).toBe("explicit-only");
    expect(resolveManifest(skills, { ...base, enabledPacks: [] }).entries).toEqual([]);
  });

  it("bounds valid runtime searches and rejects changed canonical content", async () => {
    const seed = (await catalog("name-only"))[0]!;
    const skills: CanonicalSkill[] = Array.from({ length: 25 }, (_, index) => ({ ...seed, identity: `review-${index}`, description: `Review source ${index}`, contentHash: `${index}`.padStart(64, "0") }));
    const manifest = resolveManifest(skills, { runtime: "pi", scope: "work", enabledPacks: ["core"], mappingVersion: "1" });
    expect(searchSkills(manifest, skills, "review", { runtime: true, artifactKey: manifest.artifactKey, limit: 99 })).toHaveLength(20);
    expect(() => searchSkills(manifest, [{ ...skills[0]!, contentHash: "changed" }, ...skills.slice(1)], "review", { runtime: true, artifactKey: manifest.artifactKey })).toThrowError(/no longer matches/);
    expect(() => searchSkills(manifest, skills, "x".repeat(201))).toThrowError(/limited/);
  });

  it("validates project skill exposure and namespace boundaries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-project-")); roots.push(root);
    const skillRoot = path.join(root, ".agents", "skills", "deploy");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: deploy\ndescription: Deploy safely\ndisable-model-invocation: true\nmetadata:\n  mpx:\n    projectExposure: explicit-only\n---\n");
    const inventory = await inventoryProjectSkills(root);
    expect(inventory.diagnostics).toEqual([]);
    expect(inventory.skills[0]).toMatchObject({ identity: "deploy", projectExposure: "explicit-only" });
    expect(doctor([], inventory)).toEqual([]);
    await writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: deploy\ndescription: Deploy safely\nmetadata:\n  mpx:\n    projectExposure: explicit-only\n---\n");
    expect((await inventoryProjectSkills(root)).diagnostics[0]?.code).toBe("PROJECT_SKILL_INVALID");
  });

  it("rejects malicious YAML aliases and canonical runtime overrides", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-skills-")); roots.push(root); await mkdir(path.join(root, "bad"));
    await writeFile(path.join(root, "bad", "SKILL.md"), "---\nname: bad\ndescription: *secret\nmetadata:\n  mpx:\n    skillPacks: [core]\n    defaultExposure: full\n---\n");
    await expect(inventoryCanonical(root)).rejects.toThrow(SkillCatalogError);
    await writeFile(path.join(root, "bad", "SKILL.md"), "---\nname: bad\ndescription: Bad\ndisable-model-invocation: true\nmetadata:\n  mpx:\n    skillPacks: [core]\n    defaultExposure: full\n---\n");
    await expect(inventoryCanonical(root)).rejects.toThrow(/unknown frontmatter key/);
  });
});
