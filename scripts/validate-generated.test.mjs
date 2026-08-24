import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { repositoryFiles, validateFiles, validateGeneratedRepository, validateProvenance } from "./validate-generated.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const messages = (diagnostics) => diagnostics.map((item) => item.code);

function files(path, content) {
  return new Map([[path, content]]);
}

describe("generated repository validation", () => {
  it("reports generated Pi-agent projection drift", () => {
    expect(messages(validateFiles(files("runtimes/pi/runtime-pi/projection/agents/mpx-checker.md", "drift"), {
      generatedPiDiagnostics: ["mpx-checker.md"],
    }))).toContain("GENERATED_PI_DRIFT");
  });

  it.each(["/mp:ship", "/mp-gh:issue-view", "/kf:board"])("rejects active legacy public identity %s", (identity) => {
    expect(messages(validateFiles(files("content/skills/demo/SKILL.md", identity)))).toContain("LEGACY_PUBLIC_IDENTITY");
  });

  it("rejects doubled canonical public identities", () => {
    expect(messages(validateFiles(files("apps/cli/src/example.ts", 'const command = "/mpx:mpx-ship";')))).toContain("DOUBLED_MPX_IDENTITY");
  });

  it("rejects absolute legacy source-repository paths in active files", () => {
    expect(messages(validateFiles(files("content/skills/demo/SKILL.md", "C:\\_MP_projects\\mpx-claude-code\\plugins")))).toContain("LEGACY_SOURCE_PATH");
  });

  it("rejects Claude placeholders in canonical content but permits generated Claude adapter variables", () => {
    expect(messages(validateFiles(new Map([
      ["content/skills/demo/SKILL.md", "${CLAUDE_PLUGIN_ROOT}"],
      ["runtimes/claude/runtime-claude/src/index.ts", "${CLAUDE_PLUGIN_ROOT} ${CLAUDE_CONFIG_DIR}"],
    ])))).toEqual(["CLAUDE_PLACEHOLDER"]);
  });

  it("rejects legacy status-map and config readers in active runtimes", () => {
    expect(messages(validateFiles(files("runtimes/pi/runtime-pi/src/legacy.ts", 'readFile("status-map.json"); readFile("mp.config.json")')))).toEqual(expect.arrayContaining(["LEGACY_RUNTIME_READER"]));
  });

  it.each([".env", "runtime/session.json", "state/credentials.json", ".claude/runtime-state.json"])("rejects tracked private runtime state %s", (path) => {
    expect(messages(validateFiles(files(path, "secret"), { trackedFiles: [path] }))).toContain("TRACKED_PRIVATE_STATE");
  });

  it("rejects nested package-manager lockfiles", () => {
    expect(messages(validateFiles(files("packages/demo/pnpm-lock.yaml", "lockfileVersion: 9"), { trackedFiles: ["packages/demo/pnpm-lock.yaml"] }))).toContain("NESTED_LOCKFILE");
  });

  it("narrowly excludes historical documentation from active identity and path checks", () => {
    expect(validateFiles(files("docs/history/PI_MIGRATION.md", "/mp:ship C:\\_MP_projects\\mpx-pi"))).toEqual([]);
  });

  it("reports stable diagnostics when SOURCE_PROVENANCE.json is missing or malformed", async () => {
    await expect(validateGeneratedRepository({
      root: "C:/repo",
      names: ["apps/cli/src/main.ts"],
      tracked: ["apps/cli/src/main.ts"],
      files: new Map([["apps/cli/src/main.ts", "export {};\n"]]),
      generatedPiDiagnostics: [],
      readSource: async () => undefined,
    })).resolves.toMatchObject([
      expect.objectContaining({ code: "PROVENANCE_MANIFEST_MISSING", file: "docs/history/SOURCE_PROVENANCE.json" }),
    ]);

    await expect(validateGeneratedRepository({
      root: "C:/repo",
      names: ["docs/history/SOURCE_PROVENANCE.json"],
      tracked: ["docs/history/SOURCE_PROVENANCE.json"],
      files: new Map([["docs/history/SOURCE_PROVENANCE.json", "{not json" ]]),
      generatedPiDiagnostics: [],
      readSource: async () => undefined,
    })).resolves.toMatchObject([
      expect.objectContaining({ code: "PROVENANCE_MANIFEST_INVALID", file: "docs/history/SOURCE_PROVENANCE.json" }),
    ]);
  });

  it.each([
    { schemaVersion: 2, entries: [] },
    { schemaVersion: 1, entries: [null] },
    { schemaVersion: 1, entries: [[]] },
    { schemaVersion: 1, entries: [{ disposition: 4 }] },
  ])("returns a bounded invalid-manifest diagnostic for valid JSON malformed provenance %#", async manifest => {
    const diagnostics = await validateGeneratedRepository({
      root: "C:/repo", names: ["docs/history/SOURCE_PROVENANCE.json"], tracked: ["docs/history/SOURCE_PROVENANCE.json"],
      files: new Map([["docs/history/SOURCE_PROVENANCE.json", JSON.stringify(manifest)]]), generatedPiDiagnostics: [], readSource: async () => undefined,
    });
    expect(diagnostics).toEqual([expect.objectContaining({ code: "PROVENANCE_MANIFEST_INVALID" })]);
  });

  it("reports every enumerated textual read failure", async () => {
    const values = await repositoryFiles("C:/missing-repository", ["apps/a.ts", "apps/b.ts", "image.png"]);
    expect([...values.diagnostics]).toEqual([
      expect.objectContaining({ code: "FILE_READ_FAILED", file: "apps/a.ts" }),
      expect.objectContaining({ code: "FILE_READ_FAILED", file: "apps/b.ts" }),
    ]);
  });

  it("does not read live sibling sources during normal generated validation", async () => {
    const readSource = vi.fn(async () => { throw new Error("must not be called"); });
    const diagnostics = await validateGeneratedRepository({
      root: "C:/repo",
      names: ["docs/history/SOURCE_PROVENANCE.json", "content/a.txt"],
      tracked: ["docs/history/SOURCE_PROVENANCE.json", "content/a.txt"],
      files: new Map([
        ["docs/history/SOURCE_PROVENANCE.json", JSON.stringify({ schemaVersion: 1, symbolicRoots: { MPX_PROJECTS: "projects" }, entries: [{ source: "${MPX_PROJECTS}/source.txt", destination: "content/a.txt", originalSha256: sha("source"), destinationSha256: sha("current"), disposition: "imported-rewritten" }] })],
        ["content/a.txt", "current"],
      ]),
      readSource,
    });
    expect(diagnostics).toEqual([]);
    expect(readSource).not.toHaveBeenCalled();
  });

  it("reports destination mismatch without diagnosing source drift by default", async () => {
    const diagnostics = await validateGeneratedRepository({
      root: "C:/repo",
      names: ["docs/history/SOURCE_PROVENANCE.json", "content/a.txt"],
      tracked: ["docs/history/SOURCE_PROVENANCE.json", "content/a.txt"],
      files: new Map([
        ["docs/history/SOURCE_PROVENANCE.json", JSON.stringify({ schemaVersion: 1, symbolicRoots: { MPX_PROJECTS: "projects" }, entries: [{ source: "${MPX_PROJECTS}/source.txt", destination: "content/a.txt", originalSha256: sha("source"), destinationSha256: sha("expected"), disposition: "imported-rewritten" }] })],
        ["content/a.txt", "current"],
      ]),
      readSource: async () => undefined,
    });
    expect(messages(diagnostics)).toEqual(["PROVENANCE_DESTINATION_HASH_MISMATCH"]);
  });

  it("reports missing, invalid-disposition, and mismatched provenance entries only when source auditing is requested", async () => {
    const destination = "current";
    const diagnostics = await validateProvenance({
      rootFiles: new Map([["content/a.txt", destination]]),
      manifest: {
        symbolicRoots: { MPX_PROJECTS: "projects" },
        entries: [
          { source: "${MPX_PROJECTS}/source.txt", destination: "content/a.txt", originalSha256: sha("source"), destinationSha256: sha("wrong"), disposition: "invented" },
          { source: "${MPX_PROJECTS}/missing.txt", destination: "content/missing.txt", originalSha256: sha("missing"), destinationSha256: sha("missing"), disposition: "imported-rewritten" },
        ],
      },
      roots: { MPX_PROJECTS: "projects" },
      readSource: async (path) => path.endsWith("source.txt") ? "changed" : undefined,
      verifySources: true,
    });
    expect(messages(diagnostics)).toEqual(expect.arrayContaining([
      "PROVENANCE_DISPOSITION_INVALID", "PROVENANCE_SOURCE_HASH_MISMATCH", "PROVENANCE_DESTINATION_HASH_MISMATCH", "PROVENANCE_DESTINATION_MISSING", "PROVENANCE_SOURCE_MISSING",
    ]));
  });
});
