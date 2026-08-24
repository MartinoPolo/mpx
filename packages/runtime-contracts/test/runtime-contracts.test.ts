import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RuntimeContractError,
  createResolvedSkillManifestV4,
  parseResolvedSkillManifestV4,
  createRuntimeContextV1,
  createRuntimeSkillArtifactReferenceV4,
  parseRuntimeContextV1,
  publishRuntimeArtifact,
  revalidateRuntimeArtifact,
  validateRuntimeContext,
  type RuntimeProjectionBuilder,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function root(prefix: string): Promise<string> { const value = await mkdtemp(path.join(tmpdir(), prefix)); roots.push(value); return value; }

const decisions = [{
  identity: "review",
  included: true,
  exclusionReasons: [],
  exposure: "name-only" as const,
  permissions: { humanInvocation: true, modelInvocation: true },
  metadataHash: "meta",
  sourceHash: "source",
}];
const binding = { projectId: "project-1", repositoryId: "repo-1", contentScope: "work" };

describe("runtime-neutral v4 contracts", () => {
  it("shares one body-free, path-free manifest key across runtime projections", () => {
    const manifest = createResolvedSkillManifestV4({ binding, decisions });
    const claude = createRuntimeSkillArtifactReferenceV4({ runtime: "claude", manifestKey: manifest.manifestKey, artifactKey: "a", fileMapHash: "f" });
    const pi = createRuntimeSkillArtifactReferenceV4({ runtime: "pi", manifestKey: manifest.manifestKey, artifactKey: "b", fileMapHash: "g" });
    expect(manifest.schemaVersion).toBe(4);
    expect(claude.schemaVersion).toBe(4);
    expect(pi.manifestKey).toBe(claude.manifestKey);
    expect(JSON.stringify(manifest)).not.toMatch(/body|[A-Z]:\\|realPath|absolutePath/u);
    expect(manifest.decisions[0]).toMatchObject({ included: true, exclusionReasons: [], exposure: "name-only", permissions: { humanInvocation: true, modelInvocation: true }, metadataHash: "meta", sourceHash: "source" });
    expect(parseResolvedSkillManifestV4(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    expect(() => parseResolvedSkillManifestV4({ ...manifest, schemaVersion: 3 })).toThrowError(/UNKNOWN_SCHEMA_VERSION/u);
  });

  it("publishes strict portable JSON schemas for both v4 contracts", async () => {
    const schemaRoot = fileURLToPath(new URL("../../skills/schemas/", import.meta.url));
    const manifestSchema = JSON.parse(await readFile(path.join(schemaRoot, "resolved-skill-manifest-v4.schema.json"), "utf8")) as Record<string, any>;
    const artifactSchema = JSON.parse(await readFile(path.join(schemaRoot, "runtime-skill-artifact-reference-v4.schema.json"), "utf8")) as Record<string, any>;
    expect(manifestSchema.properties.schemaVersion.const).toBe(4);
    expect(manifestSchema.additionalProperties).toBe(false);
    expect(manifestSchema.properties.decisions.items.properties).not.toHaveProperty("body");
    expect(artifactSchema.properties.schemaVersion.const).toBe(4);
    expect(artifactSchema.additionalProperties).toBe(false);
  });

  it("binds runtime context and fails closed on unknown versions and fields", () => {
    const manifest = createResolvedSkillManifestV4({ binding, decisions });
    const artifact = createRuntimeSkillArtifactReferenceV4({ runtime: "pi", manifestKey: manifest.manifestKey, artifactKey: "artifact", fileMapHash: "map" });
    const context = createRuntimeContextV1({ launchKey: "launch", launchDescriptor: { reference: "launch.json", digest: "digest" }, manifestKey: manifest.manifestKey, runtimeArtifact: artifact, binding });
    expect(parseRuntimeContextV1(JSON.parse(JSON.stringify(context)))).toEqual(context);
    expect(() => parseRuntimeContextV1({ ...context, schemaVersion: 2 })).toThrowError(RuntimeContractError);
    expect(() => parseRuntimeContextV1({ ...context, surprise: true })).toThrowError(/UNKNOWN_FIELD/u);
    expect(() => createRuntimeContextV1({ ...context, manifestKey: "different" })).toThrowError(/BINDING_MISMATCH/u);
  });

  it("exposes projection builders and executor injection without runtime imports", async () => {
    const builder: RuntimeProjectionBuilder<{ names: string[] }> = {
      runtime: "pi",
      project: async (manifest, executor) => executor({ names: manifest.decisions.filter((item) => item.included).map((item) => item.identity) }),
    };
    const manifest = createResolvedSkillManifestV4({ binding, decisions });
    await expect(builder.project(manifest, async (projection) => projection)).resolves.toEqual({ names: ["review"] });
  });
});

describe("immutable runtime artifact publication", () => {
  it("publishes a deterministic sorted file map atomically and exactly reuses it", async () => {
    const source = await root("mpx-publish-source-"); const artifactsRoot = await root("mpx-publish-dest-");
    await mkdir(path.join(source, "nested")); await writeFile(path.join(source, "z.txt"), "z"); await writeFile(path.join(source, "nested", "a.txt"), "a");
    const first = await publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, runtime: "pi", manifestKey: "manifest" });
    const second = await publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, runtime: "pi", manifestKey: "manifest" });
    expect(second).toEqual({ ...first, reused: true });
    expect(first.fileMap.map((entry) => entry.path)).toEqual(["nested/a.txt", "z.txt"]);
    expect((await readdirNames(artifactsRoot))).toEqual([first.reference.artifactKey]);
    await expect(revalidateRuntimeArtifact(first.directory, first.reference)).resolves.toMatchObject({ valid: true });
  });

  it("rejects source symlinks and partial, symlinked, or mismatched destinations", async () => {
    const outside = await root("mpx-publish-outside-"); await writeFile(path.join(outside, "secret"), "secret");
    const source = await root("mpx-publish-source-"); const artifactsRoot = await root("mpx-publish-dest-");
    await symlink(path.join(outside, "secret"), path.join(source, "escape"), "file");
    await expect(publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, runtime: "pi", manifestKey: "manifest" })).rejects.toMatchObject({ code: "SOURCE_SYMLINK" });

    await rm(path.join(source, "escape")); await writeFile(path.join(source, "ok"), "ok");
    const published = await publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, runtime: "pi", manifestKey: "manifest" });
    await writeFile(path.join(published.directory, "ok"), "altered");
    await expect(publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, runtime: "pi", manifestKey: "manifest" })).rejects.toMatchObject({ code: "ARTIFACT_MISMATCH" });
    await expect(revalidateRuntimeArtifact(published.directory, published.reference)).resolves.toMatchObject({ valid: false });
  });
});

describe("runtime context validation", () => {
  it("detects altered launch, artifact, and file-map bindings", async () => {
    const source = await root("mpx-validation-source-"); const artifactsRoot = await root("mpx-validation-dest-"); await writeFile(path.join(source, "file"), "value");
    const published = await publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, runtime: "pi", manifestKey: "manifest" });
    const context = createRuntimeContextV1({ launchKey: "launch", launchDescriptor: { reference: "launch.json", digest: "expected" }, manifestKey: "manifest", runtimeArtifact: published.reference, binding });
    await writeFile(path.join(published.directory, "file"), "changed");
    const result = await validateRuntimeContext({ context, expectedLaunch: { launchKey: "other", descriptorDigest: "changed" }, expectedManifestKey: "other-manifest", currentBinding: binding, artifactDirectory: published.directory });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(["LAUNCH_BINDING_CHANGED", "MANIFEST_BINDING_CHANGED", "ARTIFACT_FILE_MAP_CHANGED"]));
  });

  it("emits restart-required diagnostics when project or content scope changes", async () => {
    const manifest = createResolvedSkillManifestV4({ binding, decisions });
    const artifact = createRuntimeSkillArtifactReferenceV4({ runtime: "claude", manifestKey: manifest.manifestKey, artifactKey: "a", fileMapHash: "f" });
    const context = createRuntimeContextV1({ launchKey: "launch", launchDescriptor: { reference: "launch.json", digest: "digest" }, manifestKey: manifest.manifestKey, runtimeArtifact: artifact, binding });
    const result = await validateRuntimeContext({ context, expectedLaunch: { launchKey: "launch", descriptorDigest: "digest" }, expectedManifestKey: manifest.manifestKey, currentBinding: { ...binding, projectId: "project-2", contentScope: "personal" } });
    expect(result.diagnostics.filter((item) => item.restartRequired).map((item) => item.code)).toEqual(["PROJECT_CHANGED", "CONTENT_SCOPE_CHANGED"]);
  });
});

async function readdirNames(directory: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(directory)).sort();
}
