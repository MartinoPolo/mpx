import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { repositoryFiles, validateCanonicalScriptSyntax, validateFiles, validateGeneratedRepository, validateProvenance, validateSharedInstructionLinks } from "./validate-generated.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const messages = (diagnostics) => diagnostics.map((item) => item.code);

function files(path, content) {
  return new Map([[path, content]]);
}

describe("generated repository validation", () => {
  it("rejects broken relative links in shared instructions", () => {
    const diagnostics = validateSharedInstructionLinks(new Map([
      ["content/instructions/shared/A.md", "See [missing](MISSING.md)."],
      ["content/instructions/shared/B.md", "See [present](A.md#section)."],
    ]));
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "SHARED_INSTRUCTION_LINK_MISSING", file: "content/instructions/shared/A.md" }),
    ]);
  });

  it("keeps the canonical shared-instruction inventory complete", async () => {
    const root = path.resolve(import.meta.dirname, "../content/instructions/shared");
    expect(new Set(await readdir(root))).toEqual(new Set([
      "AUTHORING.md", "BOARD_CONVENTION.md", "deep-modules.md", "DESIGN_PIPELINE.md",
      "DOCUMENTATION_STRATEGY.md", "EXECUTOR_CONTRACT.md", "EXPLORATION.md",
      "GIT_COMMIT_WORKFLOW.md", "interface-design.md", "ISSUE_TRACKER.md",
      "PLAYWRIGHT_TESTING.md", "PROJECT_DOC_TEMPLATES.md", "REVIEWER_PROTOCOL.md",
      "SENTRY.md", "SUBAGENT_PROTOCOL.md", "WRITING_FOR_AGENTS.md",
    ]));
  });

  it("keeps current shared-instruction relative links closed", async () => {
    const root = path.resolve(import.meta.dirname, "..");
    const directory = path.join(root, "content/instructions/shared");
    const names = await readdir(directory);
    const current = new Map(await Promise.all(names.map(async name => [
      `content/instructions/shared/${name}`,
      await readFile(path.join(directory, name), "utf8"),
    ])));
    expect(validateSharedInstructionLinks(current)).toEqual([]);
  });

  it.each([
    "Run `gh issue view 42`.",
    "Read `plugins/mp/skills/shared/AUTHORING.md`.",
    "Resolve `${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs`.",
  ])("rejects forbidden legacy CLI, path, or placeholder in shared instructions: %s", content => {
    expect(messages(validateFiles(files("content/instructions/shared/LEGACY.md", content))))
      .toContain("SHARED_INSTRUCTION_LEGACY_REFERENCE");
  });

  it("detects a malformed canonical support script at a newly nested path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mpx-canonical-script-"));
    const relative = "content/skills/example/scripts/new/nested support/broken file.mjs";
    try {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), "export const broken = ;\n");
      expect(validateCanonicalScriptSyntax(root, [relative])).toEqual([
        expect.objectContaining({ code: "CANONICAL_SCRIPT_SYNTAX", file: relative }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recursively syntax-checks every current canonical JavaScript support script", async () => {
    const root = path.resolve(import.meta.dirname, "..");
    const content = path.join(root, "content");
    const entries = await readdir(content, { recursive: true, withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && /\.(?:c?js|mjs)$/u.test(entry.name))
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
    expect(names).toHaveLength(8);
    expect(validateCanonicalScriptSyntax(root, names)).toEqual([]);
  });

  it("reports generated Pi-agent projection drift", () => {
    expect(messages(validateFiles(files("runtimes/pi/runtime-pi/projection/agents/mpx-checker.md", "drift"), {
      generatedPiDiagnostics: ["mpx-checker.md"],
    }))).toContain("GENERATED_PI_DRIFT");
  });

  it.each(["/mp:ship", "/mp-gh:issue-view", "/kf:board"])("rejects active legacy public identity %s", (identity) => {
    expect(messages(validateFiles(files("content/skills/demo/SKILL.md", identity)))).toContain("LEGACY_PUBLIC_IDENTITY");
  });

  it("rejects the configured-path corruption marker even when content otherwise validates", () => {
    const marker = ["<configured", "path>"].join("-");
    expect(messages(validateFiles(files("content/skills/demo/SKILL.md", `valid${marker}content`)))).toContain("CONFIGURED_PATH_MARKER");
  });

  it("rejects the configured-path corruption marker when its provenance destination hash matches", async () => {
    const marker = ["<configured", "path>"].join("-");
    const content = `corrupt${marker}content`;
    const manifest = { schemaVersion: 1, entries: [{
      source: "C:/source.md", destination: "content/a.md", originalSha256: sha("source"),
      destinationSha256: sha(content), disposition: "imported-rewritten",
    }] };
    const diagnostics = await validateGeneratedRepository({
      root: "C:/repo",
      names: ["docs/history/SOURCE_PROVENANCE.json", "content/a.md"],
      tracked: ["docs/history/SOURCE_PROVENANCE.json", "content/a.md"],
      files: new Map([
        ["docs/history/SOURCE_PROVENANCE.json", JSON.stringify(manifest)],
        ["content/a.md", content],
      ]),
      readSource: async () => undefined,
    });
    expect(messages(diagnostics)).toEqual(["CONFIGURED_PATH_MARKER"]);
  });

  it.each([
    "docs/history/archive.md",
    "packages/demo/dist/generated.md",
    "content/demo/node_modules/dependency.md",
  ])("allows the configured-path marker only in explicit generated/history path %s", (file) => {
    const marker = ["<configured", "path>"].join("-");
    expect(validateFiles(files(file, marker))).toEqual([]);
  });

  it("rejects doubled canonical public identities", () => {
    expect(messages(validateFiles(files("apps/cli/src/example.ts", 'const command = "/mpx:mpx-ship";')))).toContain("DOUBLED_MPX_IDENTITY");
  });

  it("rejects absolute legacy source-repository paths in active files", () => {
    expect(messages(validateFiles(files("content/skills/demo/SKILL.md", "C:\\_MP_projects\\mpx-claude-code\\plugins")))).toContain("LEGACY_SOURCE_PATH");
  });

  it.each([
    "import '../../../mpx-pi/extensions/footer.ts'",
    "readFile('~/.codex/skills/review.md')",
    "require('mpx-claude-code/plugins/mp')",
  ])("rejects active dependencies on a legacy runtime root: %s", dependency => {
    expect(messages(validateFiles(files("runtimes/pi/runtime-pi/src/dependency.ts", dependency)))).toContain("LEGACY_SOURCE_DEPENDENCY");
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

  it("rejects stale Claude checkpoint and full status-revalidation claims in active compatibility docs", () => {
    expect(messages(validateFiles(new Map([
      ["runtimes/claude/runtime-claude/COMPATIBILITY.md", "PostToolUse revalidates the integrity checkpoint."],
      ["docs/RUNTIME_ADAPTERS.md", "The status adapter revalidates the full projection."],
    ])))).toEqual(expect.arrayContaining([
      "STALE_CLAUDE_POST_TOOL_CHECKPOINT",
      "STALE_CLAUDE_FULL_STATUS_REVALIDATION",
    ]));
  });

  it("does not ban legitimate PostToolUse or historical status prose", () => {
    expect(validateFiles(new Map([
      ["docs/LAUNCH.md", "PostToolUse remains available for unrelated telemetry."],
      ["docs/history/PHASE_F_DRAFT.md", "The status adapter revalidates the full projection."],
    ]))).toEqual([]);
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

  it("does not read an enumerated textual file larger than the per-file bound", async () => {
    const read = vi.fn();
    const close = vi.fn();
    const values = await repositoryFiles("C:/repo", ["content/large.md"], {
      maxFileBytes: 8,
      open: async () => ({ stat: async () => ({ isFile: () => true, size: 9, dev: 1, ino: 1 }), read, close }),
    });
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect([...values.diagnostics]).toEqual([
      expect.objectContaining({ code: "FILE_TOO_LARGE", file: "content/large.md" }),
    ]);
  });

  it("does not read an enumerated textual non-regular file", async () => {
    const read = vi.fn();
    const close = vi.fn();
    const values = await repositoryFiles("C:/repo", ["content/unsafe.md"], {
      open: async () => ({ stat: async () => ({ isFile: () => false, size: 1, dev: 1, ino: 1 }), read, close }),
    });
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect([...values.diagnostics]).toEqual([
      expect.objectContaining({ code: "FILE_READ_FAILED", file: "content/unsafe.md" }),
    ]);
  });

  it.each(["growth", "replacement"])("rejects deterministic file %s during a handle-bound read", async failure => {
    const content = Buffer.from("safe");
    let reads = 0;
    const close = vi.fn();
    const values = await repositoryFiles("C:/repo", ["content/racing.md"], {
      open: async () => ({
        stat: async () => ({ isFile: () => true, size: content.length, dev: 1, ino: 10 }),
        read: async (buffer, offset, length) => {
          reads += 1;
          if (reads === 1) {
            content.copy(buffer, offset, 0, length);
            return { bytesRead: length, buffer };
          }
          return { bytesRead: failure === "growth" ? 1 : 0, buffer };
        },
        close,
      }),
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: content.length, dev: 1, ino: failure === "replacement" ? 11 : 10 }),
    });
    expect(close).toHaveBeenCalledOnce();
    expect([...values.diagnostics]).toEqual([
      expect.objectContaining({ code: "FILE_READ_FAILED", file: "content/racing.md" }),
    ]);
  });

  it("bounds textual file reads to deterministic worker concurrency", async () => {
    let active = 0;
    let peak = 0;
    const names = Array.from({ length: 8 }, (_, index) => `content/${index}.md`);
    const values = await repositoryFiles("C:/repo", names, {
      concurrency: 2,
      open: async () => ({
        stat: async () => ({ isFile: () => true, size: 1, dev: 1, ino: 1 }),
        read: async (buffer, _offset, _length, position) => {
          if (position === 1) return { bytesRead: 0, buffer };
          active += 1;
          peak = Math.max(peak, active);
          await new Promise(resolve => setTimeout(resolve, 5));
          active -= 1;
          buffer[0] = 120;
          return { bytesRead: 1, buffer };
        },
        close: async () => {},
      }),
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 1, dev: 1, ino: 1 }),
    });
    expect(values.size).toBe(names.length);
    expect(peak).toBe(2);
  });

  it("caps injected textual file concurrency at the documented worker limit", async () => {
    let active = 0;
    let peak = 0;
    const names = Array.from({ length: 16 }, (_, index) => `content/capped-${index}.md`);
    await repositoryFiles("C:/repo", names, {
      concurrency: 100,
      open: async () => ({
        stat: async () => ({ isFile: () => true, size: 1, dev: 1, ino: 1 }),
        read: async (buffer, _offset, _length, position) => {
          if (position === 1) return { bytesRead: 0, buffer };
          active += 1;
          peak = Math.max(peak, active);
          await new Promise(resolve => setTimeout(resolve, 5));
          active -= 1;
          buffer[0] = 120;
          return { bytesRead: 1, buffer };
        },
        close: async () => {},
      }),
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 1, dev: 1, ino: 1 }),
    });
    expect(peak).toBe(8);
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

  it("rejects CRLF bytes in a provenance-managed text destination even when its hash matches", async () => {
    const destination = Buffer.from("checkout\r\nbytes\r\n");
    const diagnostics = await validateProvenance({
      rootFiles: new Map([["content/a.txt", destination]]),
      manifest: { entries: [{ source: "source", destination: "content/a.txt", originalSha256: sha("source"), destinationSha256: sha(destination), disposition: "imported-rewritten" }] },
      roots: {}, readSource: async () => undefined,
      destinationAttributes: new Map([["content/a.txt", { text: "auto", eol: "lf" }]]),
    });
    expect(messages(diagnostics)).toEqual(["PROVENANCE_DESTINATION_NOT_LF"]);
  });

  it("requires LF Git attribute coverage for every provenance-managed text destination", async () => {
    const destination = Buffer.from("canonical\n");
    const diagnostics = await validateProvenance({
      rootFiles: new Map([["content/a.txt", destination]]),
      manifest: { entries: [{ source: "source", destination: "content/a.txt", originalSha256: sha("source"), destinationSha256: sha(destination), disposition: "imported-rewritten" }] },
      roots: {}, readSource: async () => undefined,
      destinationAttributes: new Map(),
    });
    expect(messages(diagnostics)).toEqual(["PROVENANCE_DESTINATION_ATTRIBUTE_MISSING"]);
  });

  it("requires imported dispositions to provide a destination and both hashes", async () => {
    const diagnostics = await validateProvenance({
      rootFiles: new Map(),
      manifest: { entries: [{ source: "source", destination: null, originalSha256: null, destinationSha256: null, disposition: "imported-rewritten" }] },
      roots: {}, readSource: async () => undefined,
    });
    expect(messages(diagnostics)).toEqual(["PROVENANCE_HASH_MISSING", "PROVENANCE_DESTINATION_MISSING"]);
  });

  it.each(["excluded", "deferred-inventory-only"])("requires null destination facts for %s provenance", async disposition => {
    const diagnostics = await validateProvenance({
      rootFiles: new Map(),
      manifest: { entries: [{ source: "source", destination: "content/claimed.md", originalSha256: null, destinationSha256: sha("claimed"), disposition }] },
      roots: {}, readSource: async () => undefined,
    });
    expect(messages(diagnostics)).toEqual(["PROVENANCE_DISPOSITION_INVALID"]);
  });

  it("reports invalid dispositions and missing imported provenance only when source auditing is requested", async () => {
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
      "PROVENANCE_DISPOSITION_INVALID", "PROVENANCE_DESTINATION_MISSING", "PROVENANCE_SOURCE_MISSING",
    ]));
    expect(messages(diagnostics)).not.toEqual(expect.arrayContaining([
      "PROVENANCE_SOURCE_HASH_MISMATCH", "PROVENANCE_DESTINATION_HASH_MISMATCH",
    ]));
  });
});
