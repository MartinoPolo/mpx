import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRuntimeSkillArtifact,
  inventoryCanonical,
  resolveManifest,
  type ResolveOptions,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-v4-")); roots.push(root);
  for (const [name, pack] of [["alpha", "core"], ["beta", "work"]] as const) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} secret description\ntriggers: /mpx:${name} text\nmetadata:\n  mpx:\n    skillPacks: [${pack}]\n    defaultExposure: name-only\n---\n${name.toUpperCase()} BODY\n`);
  }
  return { root, catalog: await inventoryCanonical(root) };
}

function options(overrides: Partial<ResolveOptions> = {}): ResolveOptions {
  return {
    repositoryId: "repo-a", projectId: "project-a", contentScope: "work", identity: "work",
    skillPolicy: "developer", skillPolicyConfig: { skillExposure: { default: "name-only", skills: { alpha: "off" } } },
    enabledPacks: ["core"], mapping: { alpha: "/mpx:alpha" }, ...overrides,
  };
}

describe("runtime-neutral resolved skill manifest v4", () => {
  it("records included, off, and pack-excluded decisions without paths, metadata, or bodies", async () => {
    const { catalog } = await fixture();
    const manifest = resolveManifest(catalog, options());
    expect(manifest.schemaVersion).toBe(4);
    expect(manifest.decisions.map((decision) => ({ identity: decision.identity, included: decision.included, exposure: decision.exposure, reasons: decision.exclusionReasons }))).toEqual([
      { identity: "alpha", included: false, exposure: "off", reasons: ["off"] },
      { identity: "beta", included: false, exposure: "name-only", reasons: ["pack-excluded"] },
    ]);
    expect(JSON.stringify(manifest)).not.toMatch(/secret description|BODY|sourcePath|realPath|[A-Z]:\\/u);
  });

  it("is order-stable and changes for every resolution input", async () => {
    const { catalog } = await fixture();
    const base = resolveManifest(catalog, options());
    expect(resolveManifest([...catalog].reverse(), options()).manifestKey).toBe(base.manifestKey);
    const variants: ResolveOptions[] = [
      options({ repositoryId: "repo-b" }), options({ projectId: "project-b" }), options({ contentScope: "personal" }),
      options({ identity: "personal" }), options({ skillPolicy: "clean" }), options({ enabledPacks: ["core", "work"] }),
      options({ mapping: { alpha: "/custom:alpha" } }),
    ];
    for (const variant of variants) expect(resolveManifest(catalog, variant).manifestKey).not.toBe(base.manifestKey);
    expect(resolveManifest([{ ...catalog[0]!, contentHash: "changed" }, catalog[1]!], options()).manifestKey).not.toBe(base.manifestKey);
  });

  it("creates separate Claude and Pi references sharing the runtime-neutral manifest key", async () => {
    const { catalog } = await fixture();
    const manifest = resolveManifest(catalog, options({ skillPolicyConfig: { skillExposure: { default: "name-only" } } }));
    const claude = createRuntimeSkillArtifact(manifest, catalog, { runtime: "claude" });
    const pi = createRuntimeSkillArtifact(manifest, catalog, { runtime: "pi" });
    expect(claude.reference).toMatchObject({ schemaVersion: 4, runtime: "claude", manifestKey: manifest.manifestKey });
    expect(pi.reference).toMatchObject({ schemaVersion: 4, runtime: "pi", manifestKey: manifest.manifestKey });
    expect(claude.reference.artifactKey).not.toBe(pi.reference.artifactKey);
  });
});
