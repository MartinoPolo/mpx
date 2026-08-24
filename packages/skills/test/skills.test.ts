import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { doctor, initialModelContext, inventoryCanonical, inventoryProjectSkills, resolveManifest, searchSkills, SkillCatalogError, type CanonicalSkill, type Exposure, type ResolveOptions } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
async function catalog(exposure: Exposure = "name-only") {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-skills-")); roots.push(root);
  await mkdir(path.join(root, "review"));
  await writeFile(path.join(root, "review", "SKILL.md"), `---\nname: review\ndescription: Review source safely\ntriggers: code inspection\nmetadata:\n  mpx:\n    skillPacks: [core]\n    defaultExposure: ${exposure}\n---\nSECRET BODY\n`);
  return inventoryCanonical(root);
}

describe("skill manifests", () => {
  it("applies the validated skill policy after catalog inputs and narrows packs", async () => {
    const seed = (await catalog("full"))[0]!;
    const skills: CanonicalSkill[] = [
      seed,
      { ...seed, identity: "personal-note", skillPacks: ["personal"] },
      { ...seed, identity: "work-review", skillPacks: ["work"] },
    ];
    const base = {
      runtime: "pi" as const, identity: "work", skillPolicy: "clean",
      contentScope: "work", enabledPacks: ["core", "personal", "work"] as const,
      contentScopeExposure: { default: "full" as const }, projectExposure: { default: "full" as const },
    };
    const clean = resolveManifest(skills, { ...base, skillPolicyConfig: { skillExposure: { default: "explicit-only" } } });
    expect(clean.entries.map((entry) => [entry.identity, entry.exposure])).toEqual([
      ["personal-note", "explicit-only"], ["review", "explicit-only"], ["work-review", "explicit-only"],
    ]);
    expect(initialModelContext(clean)).toEqual([]);

    const developer = resolveManifest(skills, { ...base, skillPolicy: "developer", skillPolicyConfig: { skillPacks: ["core", "work"], skillExposure: { default: "name-only", skills: { review: "full" } } } });
    const assistant = resolveManifest(skills, { ...base, skillPolicy: "personal-assistant", skillPolicyConfig: { skillPacks: ["core", "personal"], skillExposure: { default: "explicit-only", skills: { "personal-note": "full" } } } });
    expect(developer.entries.map((entry) => [entry.identity, entry.exposure])).toEqual([["review", "full"], ["work-review", "name-only"]]);
    expect(assistant.entries.map((entry) => [entry.identity, entry.exposure])).toEqual([["personal-note", "full"], ["review", "explicit-only"]]);
    expect(developer.artifactKey).not.toBe(assistant.artifactKey);
    expect(resolveManifest(skills, { ...base, skillPolicyConfig: { skillExposure: { default: "explicit-only", skills: { review: "off" } } } }).artifactKey).not.toBe(clean.artifactKey);
  });
  it.each(["full", "name-only", "explicit-only", "off"] as const)("projects %s deterministically", async exposure => {
    const skills = await catalog();
    const manifest = resolveManifest(skills, { runtime: "pi", identity: "work", skillPolicy: "developer", skillPolicyConfig: { skillExposure: { default: "name-only", skills: { review: exposure } } }, contentScope: "work", enabledPacks: ["core"], projectExposure: { skills: { review: exposure } } });
    expect(JSON.stringify(manifest)).not.toContain("SECRET BODY");
    expect(manifest.entries.map(x => x.exposure)).toEqual(exposure === "off" ? [] : [exposure]);
    expect(resolveManifest(skills, { runtime: "pi", identity: "work", skillPolicy: "developer", skillPolicyConfig: { skillExposure: { default: "name-only", skills: { review: exposure } } }, contentScope: "work", enabledPacks: ["core"], projectExposure: { skills: { review: exposure } } })).toEqual(manifest);
  });

  it("hides non-model-invocable search and binds runtime searches", async () => {
    const skills = await catalog("explicit-only");
    const manifest = resolveManifest(skills, { runtime: "claude", identity: "work", skillPolicy: "developer", skillPolicyConfig: { skillExposure: { default: "explicit-only" } }, contentScope: "neutral", enabledPacks: ["core"] });
    expect(searchSkills(manifest, skills, "review")).toEqual([]);
    expect(() => searchSkills(manifest, skills, "review", { runtime: true, artifactKey: "stale" })).toThrow(SkillCatalogError);
  });

  it("projects discovery metadata and invocation permissions for every exposure", async () => {
    const skills = await catalog();
    const resolve = (exposure: Exposure) => resolveManifest(skills, {
      runtime: "claude", identity: "work", skillPolicy: "developer", skillPolicyConfig: { skillExposure: { default: "name-only", skills: { review: exposure } } }, contentScope: "work", enabledPacks: ["core"],
      projectExposure: { skills: { review: exposure } },
    }).entries[0];
    expect(resolve("full")).toMatchObject({ description: "Review source safely", triggers: "code inspection", permissions: { humanInvocation: true, modelInvocation: true } });
    const nameOnly = resolve("name-only");
    expect(nameOnly).toMatchObject({ permissions: { humanInvocation: true, modelInvocation: true } });
    expect(nameOnly).not.toHaveProperty("description");
    expect(nameOnly).not.toHaveProperty("triggers");
    const explicitOnly = resolve("explicit-only");
    expect(explicitOnly).toMatchObject({ permissions: { humanInvocation: true, modelInvocation: false } });
    expect(explicitOnly).not.toHaveProperty("description");
    expect(explicitOnly).not.toHaveProperty("triggers");
    expect(resolve("off")).toBeUndefined();
  });

  it("applies exposure precedence and excludes disabled packs", async () => {
    const skills = await catalog("explicit-only");
    const base = { runtime: "pi" as const, identity: "work", skillPolicy: "developer", skillPolicyConfig: { skillExposure: { default: "name-only" } }, contentScope: "work", enabledPacks: ["core"] as const };
    expect(resolveManifest(skills, { ...base, contentScopeExposure: { default: "full", skills: { review: "off" } } }).entries).toEqual([]);
    expect(resolveManifest(skills, { ...base, contentScopeExposure: { skills: { review: "full" } }, projectExposure: { default: "off" } }).entries).toEqual([]);
    expect(resolveManifest(skills, { ...base, skillPolicyConfig: { skillExposure: { default: "name-only", skills: { review: "explicit-only" } } }, contentScopeExposure: { default: "full" }, projectExposure: { default: "off", skills: { review: "full" } } }).entries[0]?.exposure).toBe("explicit-only");
    expect(resolveManifest(skills, { ...base, enabledPacks: [] }).entries).toEqual([]);
  });

  it("bounds valid runtime searches and rejects changed canonical content", async () => {
    const seed = (await catalog("name-only"))[0]!;
    const skills: CanonicalSkill[] = Array.from({ length: 25 }, (_, index) => ({ ...seed, identity: `review-${index}`, description: `Review source ${index}`, contentHash: `${index}`.padStart(64, "0") }));
    const manifest = resolveManifest(skills, { runtime: "pi", identity: "work", skillPolicy: "developer", skillPolicyConfig: { skillExposure: { default: "name-only" } }, contentScope: "work", enabledPacks: ["core"] });
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
