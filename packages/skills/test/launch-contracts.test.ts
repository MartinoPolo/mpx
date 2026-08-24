import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_HUMAN_SKILL_SEARCH_QUERY_LENGTH,
  MAX_HUMAN_SKILL_SEARCH_RESULTS,
  MAX_SKILL_BODY_BYTES,
  SKILL_MANIFEST_SCHEMA_VERSION,
  SkillCatalogError,
  humanCompleteSkills,
  humanListSkills,
  humanSearchSkills,
  humanSkillDetail,
  initialModelContext,
  inventoryCanonical,
  loadSkillBody,
  modelSearchSkills,
  resolveManifest,
  type Exposure,
  type ResolveOptions,
  type SkillBodyRequest,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(exposures: Record<string, Exposure>) {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-skills-contract-"));
  roots.push(root);
  for (const [name, exposure] of Object.entries(exposures)) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\ntriggers: ${name} trigger\nmetadata:\n  mpx:\n    skillPacks: [core]\n    defaultExposure: ${exposure}\n---\n${name.toUpperCase()} BODY\n`);
  }
  const catalog = await inventoryCanonical(root);
  const options: ResolveOptions = {
    runtime: "pi", identity: "work", skillPolicy: "developer",
    skillPolicyConfig: { skillExposure: { default: "name-only", skills: exposures } },
    contentScope: "work", projectId: "acme/repo", enabledPacks: ["core"],
  };
  return { root, catalog, manifest: resolveManifest(catalog, options) };
}

function code(error: unknown): string | undefined {
  return error instanceof SkillCatalogError ? error.diagnostics[0]?.code : undefined;
}
async function rejectedCode(run: () => unknown | Promise<unknown>): Promise<string | undefined> {
  try { await run(); } catch (error) { return code(error); }
  return undefined;
}

describe("four-state launch-bound skill contract", () => {
  it("projects only model and human permissions for the four authoritative states", async () => {
    const { manifest } = await fixture({ full: "full", named: "name-only", explicit: "explicit-only", disabled: "off" });
    expect(manifest.schemaVersion).toBe(SKILL_MANIFEST_SCHEMA_VERSION);
    expect(manifest.entries.map(({ identity, permissions, description }) => ({ identity, permissions, description }))).toEqual([
      { identity: "explicit", permissions: { humanInvocation: true, modelInvocation: false }, description: undefined },
      { identity: "full", permissions: { humanInvocation: true, modelInvocation: true }, description: "full description" },
      { identity: "named", permissions: { humanInvocation: true, modelInvocation: true }, description: undefined },
    ]);
    expect(Object.keys(manifest.entries[0]!.permissions).sort()).toEqual(["humanInvocation", "modelInvocation"]);
  });

  it("keeps clean explicit-only out of initial model metadata while retaining human discovery", async () => {
    const { catalog } = await fixture({ zebra: "full", alpha: "name-only", hidden: "off" });
    const manifest = resolveManifest(catalog, {
      runtime: "pi", identity: "work", skillPolicy: "clean",
      skillPolicyConfig: { skillExposure: { default: "explicit-only" } },
      contentScope: "work", enabledPacks: ["core"],
    });
    expect(initialModelContext(manifest)).toEqual([]);
    expect(humanListSkills(manifest)).toEqual([
      { identity: "alpha", publicName: "/mpx:alpha" },
      { identity: "zebra", publicName: "/mpx:zebra" },
    ]);
    expect(humanCompleteSkills(manifest, "/mpx:")).toEqual(["/mpx:alpha", "/mpx:zebra"]);
    expect(humanSearchSkills(manifest, catalog, "description").map(({ identity, description }) => ({ identity, description }))).toEqual([
      { identity: "alpha", description: "alpha description" },
      { identity: "zebra", description: "zebra description" },
    ]);
    expect(humanSkillDetail(manifest, catalog, "alpha")).toEqual({ identity: "alpha", publicName: "/mpx:alpha", description: "alpha description" });
  });

  it("keeps descriptions out of human list and completion and off absent everywhere", async () => {
    const { catalog, manifest } = await fixture({ full: "full", named: "name-only", explicit: "explicit-only", disabled: "off" });
    expect(JSON.stringify(humanListSkills(manifest))).not.toContain("description");
    expect(JSON.stringify(humanCompleteSkills(manifest, "/mpx:"))).not.toContain("description");
    expect(humanListSkills(manifest).map((item) => item.identity)).toEqual(["explicit", "full", "named"]);
    expect(humanSearchSkills(manifest, catalog, "disabled")).toEqual([]);
    expect(humanSkillDetail(manifest, catalog, "disabled")).toBeUndefined();
  });

  it("keeps model search artifact-bound and limited to full/name-only", async () => {
    const { catalog, manifest } = await fixture({ full: "full", named: "name-only", explicit: "explicit-only", disabled: "off" });
    expect(modelSearchSkills(manifest, catalog, "description", { artifactKey: manifest.artifactKey }).map((item) => item.identity)).toEqual(["full", "named"]);
    expect(() => modelSearchSkills(manifest, catalog, "description", { artifactKey: "stale" })).toThrowError(/STALE_ARTIFACT/u);
  });

  it("requires an actual human-explicit invocation for explicit-only", async () => {
    const { root, manifest } = await fixture({ explicit: "explicit-only" });
    expect(await rejectedCode(() => loadSkillBody({ canonicalRoot: root, manifest, artifactKey: manifest.artifactKey, runtime: "pi", identity: "explicit", invocation: "model" }))).toBe("SKILL_INVOCATION_DENIED");
    const loaded = await loadSkillBody({ canonicalRoot: root, manifest, artifactKey: manifest.artifactKey, runtime: "pi", identity: "explicit", invocation: "human-explicit" });
    expect(loaded.provenance.invocation).toBe("human-explicit");
  });

  it("loads full/name-only only for model and every non-off entry for human-explicit", async () => {
    const { root, manifest } = await fixture({ full: "full", named: "name-only", explicit: "explicit-only", disabled: "off" });
    for (const identity of ["full", "named"] as const) {
      expect((await loadSkillBody({ canonicalRoot: root, manifest, artifactKey: manifest.artifactKey, runtime: "pi", identity, invocation: "model" })).body).toBe(`${identity.toUpperCase()} BODY\n`);
    }
    expect(await rejectedCode(() => loadSkillBody({ canonicalRoot: root, manifest, artifactKey: manifest.artifactKey, runtime: "pi", identity: "explicit", invocation: "model" }))).toBe("SKILL_INVOCATION_DENIED");
    for (const identity of ["explicit", "full", "named"] as const) {
      expect((await loadSkillBody({ canonicalRoot: root, manifest, artifactKey: manifest.artifactKey, runtime: "pi", identity, invocation: "human-explicit" })).provenance.invocation).toBe("human-explicit");
    }
  });

  it("rejects invocations outside the two-state invocation contract", async () => {
    const { root, manifest } = await fixture({ explicit: "explicit-only" });
    const forged = { canonicalRoot: root, manifest, artifactKey: manifest.artifactKey, runtime: "pi", identity: "explicit", invocation: "legacy" } as unknown as SkillBodyRequest;
    expect(await rejectedCode(() => loadSkillBody(forged))).toBe("SKILL_INVOCATION_INVALID");
  });

  it("rejects manifests and artifact references from earlier schemas", async () => {
    const { root, catalog, manifest } = await fixture({ named: "name-only" });
    const stale = manifest as unknown as { schemaVersion: number; artifactReference: { schemaVersion: number } };
    stale.schemaVersion = 1;
    stale.artifactReference.schemaVersion = 1;
    expect(await rejectedCode(() => loadSkillBody({ canonicalRoot: root, manifest, artifactKey: manifest.artifactKey, runtime: "pi", identity: "named", invocation: "model" }))).toBe("STALE_ARTIFACT");
    expect(() => modelSearchSkills(manifest, catalog, "named", { artifactKey: manifest.artifactKey })).toThrowError(/STALE_ARTIFACT/u);
  });

  it("retains launch binding and validated lazy body loading", async () => {
    const { root, manifest } = await fixture({ named: "name-only", other: "name-only" });
    expect(await rejectedCode(() => loadSkillBody({ canonicalRoot: root, manifest, artifactKey: "stale", runtime: "pi", identity: "named", invocation: "model" }))).toBe("STALE_ARTIFACT");
    expect(await rejectedCode(() => loadSkillBody({ canonicalRoot: root, manifest, artifactKey: manifest.artifactKey, runtime: "claude", identity: "named", invocation: "model" }))).toBe("SKILL_RUNTIME_MISMATCH");
    manifest.entries.find((entry) => entry.identity === "named")!.source = { ...manifest.entries.find((entry) => entry.identity === "other")!.source };
    expect(await rejectedCode(() => loadSkillBody({ canonicalRoot: root, manifest, artifactKey: manifest.artifactKey, runtime: "pi", identity: "named", invocation: "model" }))).toBe("SKILL_PROVENANCE_MISMATCH");
  });

  it("rejects changed, escaped, and oversized canonical bodies", async () => {
    const changed = await fixture({ named: "name-only" });
    const file = path.join(changed.root, "named", "SKILL.md");
    await writeFile(file, (await readFile(file, "utf8")).replace("NAMED BODY", "CHANGED BODY"));
    expect(await rejectedCode(() => loadSkillBody({ canonicalRoot: changed.root, manifest: changed.manifest, artifactKey: changed.manifest.artifactKey, runtime: "pi", identity: "named", invocation: "model" }))).toBe("SKILL_CONTENT_STALE");

    const escaping = await fixture({ named: "name-only" });
    const outside = await mkdtemp(path.join(tmpdir(), "mpx-skills-outside-")); roots.push(outside);
    await writeFile(path.join(outside, "SKILL.md"), "outside");
    const link = path.join(escaping.root, "link");
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    escaping.manifest.entries[0]!.source.path = path.join(link, "SKILL.md");
    expect(await rejectedCode(() => loadSkillBody({ canonicalRoot: escaping.root, manifest: escaping.manifest, artifactKey: escaping.manifest.artifactKey, runtime: "pi", identity: "named", invocation: "model" }))).toBe("SKILL_PATH_INVALID");

    const oversized = await fixture({ named: "name-only" });
    await writeFile(path.join(oversized.root, "named", "SKILL.md"), "x".repeat(MAX_SKILL_BODY_BYTES + 1));
    expect(await rejectedCode(() => loadSkillBody({ canonicalRoot: oversized.root, manifest: oversized.manifest, artifactKey: oversized.manifest.artifactKey, runtime: "pi", identity: "named", invocation: "model" }))).toBe("SKILL_BODY_TOO_LARGE");
  });

  it("bounds human search independently", async () => {
    const exposures = Object.fromEntries(Array.from({ length: MAX_HUMAN_SKILL_SEARCH_RESULTS + 5 }, (_, index) => [`skill-${index}`, "explicit-only"] as const));
    const { catalog, manifest } = await fixture(exposures);
    expect(humanSearchSkills(manifest, catalog, "", { limit: 999 })).toHaveLength(MAX_HUMAN_SKILL_SEARCH_RESULTS);
    expect(() => humanSearchSkills(manifest, catalog, "x".repeat(MAX_HUMAN_SKILL_SEARCH_QUERY_LENGTH + 1))).toThrowError(/QUERY_TOO_LONG/u);
  });
});
