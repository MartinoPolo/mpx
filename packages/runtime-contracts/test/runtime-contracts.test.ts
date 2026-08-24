import { afterEach, describe, expect, it, vi } from "vitest";

const fsCalls = vi.hoisted(() => ({ watchedRoot: "", sourceReads: 0, sourceListings: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: actual.readFile,
    open: async (file: any, ...args: any[]) => {
      if (fsCalls.watchedRoot && path.dirname(String(file)) === fsCalls.watchedRoot) fsCalls.sourceReads += 1;
      return (actual.open as any)(file, ...args);
    },
    opendir: async (directory: any, ...args: any[]) => {
      if (fsCalls.watchedRoot && String(directory) === fsCalls.watchedRoot) fsCalls.sourceListings += 1;
      return (actual.opendir as any)(directory, ...args);
    },
  };
});
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
const launchBinding = (launchKey = "launch") => ({ launchKey, descriptorDigest: "descriptor", runtimeArtifactKey: "skills", runtime: "pi" as const, manifestKey: "manifest" });

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
    const first = await publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, launchBinding: launchBinding() });
    const second = await publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, launchBinding: launchBinding() });
    expect(second).toEqual({ ...first, reused: true });
    expect(first.fileMap.map((entry) => entry.path)).toEqual(["nested/a.txt", "z.txt"]);
    expect((await readdirNames(artifactsRoot))).toEqual([first.reference.projectionKey]);
    await expect(revalidateRuntimeArtifact(first.directory, first.reference)).resolves.toMatchObject({ valid: true });
  });

  it("rejects source symlinks and partial, symlinked, or mismatched destinations", async () => {
    const outside = await root("mpx-publish-outside-"); await writeFile(path.join(outside, "secret"), "secret");
    const source = await root("mpx-publish-source-"); const artifactsRoot = await root("mpx-publish-dest-");
    await symlink(path.join(outside, "secret"), path.join(source, "escape"), "file");
    await expect(publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, launchBinding: launchBinding() })).rejects.toMatchObject({ code: "SOURCE_SYMLINK" });

    await rm(path.join(source, "escape")); await writeFile(path.join(source, "ok"), "ok");
    const published = await publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, launchBinding: launchBinding() });
    await writeFile(path.join(published.directory, "ok"), "altered");
    await expect(publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, launchBinding: launchBinding() })).rejects.toMatchObject({ code: "ARTIFACT_MISMATCH" });
    await expect(revalidateRuntimeArtifact(published.directory, published.reference)).resolves.toMatchObject({ valid: false });
  });

  it("binds projection identity to the full launch while keeping paths private", async () => {
    const source = await root("mpx-launch-source-"); const artifactsRoot = await root("mpx-launch-dest-"); await writeFile(path.join(source, "same"), "bytes");
    const first = await publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, launchBinding: launchBinding("launch-a") });
    const second = await publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, launchBinding: launchBinding("launch-b") });
    expect(first.reference.launchBinding).toEqual(launchBinding("launch-a"));
    expect(first.reference.projectionKey).not.toBe(second.reference.projectionKey);
    expect(first.directory).not.toBe(second.directory);
    expect(JSON.stringify(first.reference)).not.toContain(source);
  });

  it("rejects reuse when stored launch metadata does not match", async () => {
    const source = await root("mpx-reuse-source-"); const artifactsRoot = await root("mpx-reuse-dest-"); await writeFile(path.join(source, "file"), "value");
    const published = await publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, launchBinding: launchBinding() });
    const metadataPath = path.join(published.directory, ".mpx-runtime-artifact.json");
    const stored = JSON.parse(await readFile(metadataPath, "utf8")); stored.reference.launchBinding.launchKey = "wrong"; await writeFile(metadataPath, JSON.stringify(stored));
    await expect(publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, launchBinding: launchBinding() })).rejects.toMatchObject({ code: "ARTIFACT_MISMATCH" });
  });

  it.each([
    ["MAX_FILE_COUNT", { maxFileCount: 1, maxFileBytes: 10, maxAggregateBytes: 10 }],
    ["MAX_FILE_BYTES", { maxFileCount: 2, maxFileBytes: 0, maxAggregateBytes: 10 }],
    ["MAX_AGGREGATE_BYTES", { maxFileCount: 2, maxFileBytes: 10, maxAggregateBytes: 1 }],
  ])("enforces %s from lstat inventory before reading file contents", async (code, inventoryLimits) => {
    const source = await root("mpx-limits-source-"); const artifactsRoot = await root("mpx-limits-dest-"); await writeFile(path.join(source, "a"), "a"); await writeFile(path.join(source, "b"), "b");
    fsCalls.watchedRoot = source; fsCalls.sourceReads = 0;
    await expect(publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, launchBinding: launchBinding(), inventoryLimits })).rejects.toMatchObject({ code });
    expect(fsCalls.sourceReads).toBe(0);
    fsCalls.watchedRoot = "";
  });

  it("creates one source inventory and reuses its bytes for hashing and copying", async () => {
    const source = await root("mpx-inventory-source-"); const artifactsRoot = await root("mpx-inventory-dest-"); await writeFile(path.join(source, "file"), "value");
    fsCalls.watchedRoot = source; fsCalls.sourceReads = 0; fsCalls.sourceListings = 0;
    await publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, launchBinding: launchBinding() });
    expect({ reads: fsCalls.sourceReads, listings: fsCalls.sourceListings }).toEqual({ reads: 1, listings: 1 });
    fsCalls.watchedRoot = "";
  });

  it.each([
    ["MAX_DIRECTORY_COUNT", { maxDirectoryCount: 1, maxDepth: 4 }, ["a", "b"]],
    ["MAX_DEPTH", { maxDirectoryCount: 4, maxDepth: 1 }, ["a", "a/b"]],
  ])("enforces %s before descending through wide or deep trees", async (code, bounds, directories) => {
    const source = await root("mpx-tree-limits-source-"); const artifactsRoot = await root("mpx-tree-limits-dest-");
    for (const directory of directories) await mkdir(path.join(source, directory), { recursive: true });
    await expect(publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, launchBinding: launchBinding(), inventoryLimits: { maxFileCount: 1, maxFileBytes: 1, maxAggregateBytes: 1, ...bounds } })).rejects.toMatchObject({ code });
  });

  it("rejects oversized metadata before parsing or scanning artifact files", async () => {
    const source = await root("mpx-metadata-large-source-"); const artifactsRoot = await root("mpx-metadata-large-dest-"); await writeFile(path.join(source, "file"), "value");
    const published = await publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, launchBinding: launchBinding() });
    await writeFile(path.join(published.directory, ".mpx-runtime-artifact.json"), Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    fsCalls.watchedRoot = published.directory; fsCalls.sourceListings = 0;
    await expect(revalidateRuntimeArtifact(published.directory, published.reference)).resolves.toMatchObject({ valid: false });
    expect(fsCalls.sourceListings).toBe(0); fsCalls.watchedRoot = "";
  });

  it.each([
    (stored: any) => { stored.extra = true; },
    (stored: any) => { stored.reference.extra = true; },
    (stored: any) => { stored.fileMap[0].extra = true; },
    (stored: any) => { stored.fileMap.push({ ...stored.fileMap[0] }); },
    (stored: any) => { stored.fileMap[0].path = "../escape"; },
    (stored: any) => { stored.fileMap[0].sha256 = "not-a-hash"; },
    (stored: any) => { stored.fileMap[0].bytes = -1; },
  ])("strictly rejects malformed, duplicate, or unsafe metadata", async mutate => {
    const source = await root("mpx-metadata-invalid-source-"); const artifactsRoot = await root("mpx-metadata-invalid-dest-"); await writeFile(path.join(source, "file"), "value");
    const published = await publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, launchBinding: launchBinding() });
    const metadataPath = path.join(published.directory, ".mpx-runtime-artifact.json"); const stored = JSON.parse(await readFile(metadataPath, "utf8")); mutate(stored); await writeFile(metadataPath, JSON.stringify(stored));
    fsCalls.watchedRoot = published.directory; fsCalls.sourceListings = 0;
    await expect(revalidateRuntimeArtifact(published.directory, published.reference)).resolves.toMatchObject({ valid: false });
    expect(fsCalls.sourceListings).toBe(0); fsCalls.watchedRoot = "";
  });
});

describe("runtime context validation", () => {
  it("detects altered launch, artifact, and file-map bindings", async () => {
    const source = await root("mpx-validation-source-"); const artifactsRoot = await root("mpx-validation-dest-"); await writeFile(path.join(source, "file"), "value");
    const published = await publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, launchBinding: launchBinding() });
    const runtimeArtifact = createRuntimeSkillArtifactReferenceV4({ runtime: "pi", manifestKey: "manifest", artifactKey: "skills", fileMapHash: "skill-map" });
    const context = createRuntimeContextV1({ launchKey: "launch", launchDescriptor: { reference: "launch.json", digest: "expected" }, manifestKey: "manifest", runtimeArtifact, binding });
    await writeFile(path.join(published.directory, "file"), "changed");
    const result = await validateRuntimeContext({ context, expectedLaunch: { launchKey: "other", descriptorDigest: "changed" }, expectedManifestKey: "other-manifest", currentBinding: binding, artifactDirectory: published.directory, expectedPublishedArtifact: published.reference });
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
