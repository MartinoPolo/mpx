import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCompactContext,
  classifyDangerousCommand,
  detectProjectEnvironment,
  evaluateFallowGate,
  evaluatePackagePolicy,
  extractCommitMessage,
  extractPostCommandContext,
  planFileQuality,
  readCompactInstructions,
  scanAddedSecrets,
  selectPreCommitCheck,
  validateCommitFormat,
} from "./index.js";

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "mpx-hooks-"));
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, contents);
  }
  return root;
}

describe("dangerous command classification", () => {
  it.each(["rm -rf /", "rm --recursive --force ..", "rm -rf src", "DROP TABLE users", "truncate table logs", "git push --force origin main", "mkfs.ext4 /dev/sda", "dd if=/dev/zero of=/dev/nvme0n1", "setx PATH %PATH%;C:\\bad", "reg add HKCU\\Environment /v PATH"])("blocks %s", (command) => expect(classifyDangerousCommand(command).action).toBe("block"));
  it.each(["rm -rf node_modules", "rm -rf src/obsolete", "git push --force-with-lease origin main", "setx JAVA_HOME C:\\java"])("allows constrained %s", (command) => expect(classifyDangerousCommand(command).action).toBe("allow"));
  it("fails closed on oversized command input", () => expect(classifyDangerousCommand("x".repeat(32_769))).toMatchObject({ action: "block", code: "INPUT_TOO_LARGE" }));
  it("does not let a second deletion target bypass the allowlist", () => expect(classifyDangerousCommand("rm -rf node_modules /").action).toBe("block"));
});

describe("package and tool policy", () => {
  it("blocks a wrong package manager and directs to the detected manager", () => expect(evaluatePackagePolicy("npm install", "pnpm")).toMatchObject({ action: "block", replacement: "pnpm" }));
  it("blocks npx tsc even in a compound command", () => expect(evaluatePackagePolicy("echo ok && npx tsc", "pnpm").action).toBe("block"));
  it("keeps built-in-tool preferences as warnings", () => expect(evaluatePackagePolicy("cd src && grep -r x .", "pnpm")).toMatchObject({ action: "allow", warnings: [expect.stringContaining("Grep")] }));
  it("does not warn for a pipeline consumer", () => expect(evaluatePackagePolicy("cat list | grep x", "pnpm").warnings).toEqual([]));
});

describe("pre-commit policy", () => {
  it("scans only added lines for known and generic secrets", () => expect(scanAddedSecrets(" password='not-added'\n+api_key='1234567890'", "app.ts")).toEqual([{ name: "Generic Secret", file: "app.ts" }]));
  it("bounds untrusted diff input and fails closed", () => expect(() => scanAddedSecrets("+" + "x".repeat(1_000_001), "app.ts")).toThrowError(expect.objectContaining({ code: "INPUT_TOO_LARGE" })));
  it("extracts quoted and heredoc commit subjects", () => expect(extractCommitMessage("git commit -m \"$(cat <<'EOF'\nfeat(ui): ship\n\nbody\nEOF\n)\"")).toBe("feat(ui): ship"));
  it("warns, but does not block, invalid or long conventional subjects", () => expect(validateCommitFormat("WIP " + "x".repeat(73))).toMatchObject({ valid: false, warnings: [expect.any(String), expect.any(String)] }));
  it("prefers check:all for vite-plus and Svelte check otherwise", () => {
    expect(selectPreCommitCheck({ toolchain: "vite-plus", scripts: { "check:all": "vp check", typecheck: "tsc" }, framework: null })).toBe("check:all");
    expect(selectPreCommitCheck({ toolchain: "classic", scripts: { check: "svelte-check", tsc: "tsc" }, framework: "svelte" })).toBe("check");
  });
});

describe("fallow gate", () => {
  it("blocks protected operations on an old binary", () => expect(evaluateFallowGate({ command: "git commit -m x", minimumVersion: "2.46.0", runner: { description: "fallow", version: "2.40.0" } })).toMatchObject({ action: "block", code: "FALLOW_VERSION_TOO_OLD" }));
  it("blocks an explicit fail verdict even if the process status is nonzero", () => expect(evaluateFallowGate({ command: "git push", minimumVersion: "2.46.0", runner: { description: "fallow", version: "2.48.0" }, audit: { status: 2, stdout: '{"verdict":"fail"}', stderr: "" } })).toMatchObject({ action: "block", code: "FALLOW_AUDIT_FAILED" }));
  it("fails open, visibly, for missing tools and malformed audit output", () => {
    expect(evaluateFallowGate({ command: "git commit", minimumVersion: "2.46.0" })).toMatchObject({ action: "allow", warning: expect.stringContaining("not found") });
    expect(evaluateFallowGate({ command: "git commit", minimumVersion: "2.46.0", runner: { description: "fallow", version: "2.48.0" }, audit: { status: 2, stdout: "not json", stderr: "" } })).toMatchObject({ action: "allow", code: "FALLOW_RUNTIME_ERROR" });
  });
  it("does not trigger on words that merely resemble git operations", () => expect(evaluateFallowGate({ command: "mygit commit", minimumVersion: "2.46.0" })).toEqual({ action: "allow" }));
});

describe("provider-neutral post-command context", () => {
  it("reports a missing PR only from an explicit MPX assumption", () => expect(extractPostCommandContext({ operation: "git-push", exitCode: 0, pullRequest: "missing" })).toBe("Pushed to remote. No pull request exists for this branch yet."));
  it("extracts a bounded provider-neutral created URL", () => expect(extractPostCommandContext({ operation: "pull-request-create", exitCode: 0, pullRequestUrl: "https://git.example.test/o/r/pulls/42" })).toBe("Pull request created: https://git.example.test/o/r/pulls/42"));
  it("reports package vulnerabilities", () => expect(extractPostCommandContext({ operation: "package-install", exitCode: 0, stderr: "found 3 vulnerabilities" })).toContain("vulnerabilities"));
});

describe("format and lint dispatch", () => {
  it("returns argv, never shell text, for vite-plus with eslint gap rules", () => expect(planFileQuality({ relativeFile: "src/a file.ts", toolchain: "vite-plus", runner: ["pnpm", "exec"], configs: ["eslint.config.js"] })).toEqual([
    { executable: "pnpm", args: ["exec", "vp", "fmt", "src/a file.ts"], reportFailure: false },
    { executable: "pnpm", args: ["exec", "vp", "lint", "--fix", "src/a file.ts"], reportFailure: true },
    { executable: "pnpm", args: ["exec", "eslint", "--fix", "src/a file.ts"], reportFailure: true },
  ]));
  it("rejects absolute and traversal file paths", () => expect(() => planFileQuality({ relativeFile: "../secret.ts", toolchain: "classic", runner: ["npx"], configs: [] })).toThrowError(expect.objectContaining({ code: "UNSAFE_PATH" })));
  it("dispatches configured ruff for Python", () => expect(planFileQuality({ relativeFile: "app.py", toolchain: "classic", runner: ["npx"], configs: ["pyproject:tool.ruff"] })).toHaveLength(2));
});

describe("compact instructions and context", () => {
  it("selects the first non-empty compact instructions with a byte bound", () => {
    const root = project({ "empty.md": "  ", "fallback.md": "Keep decisions." });
    expect(readCompactInstructions([path.join(root, "empty.md"), path.join(root, "fallback.md")])).toBe("Keep decisions.");
    writeFileSync(path.join(root, "huge.md"), "x".repeat(65_537));
    expect(readCompactInstructions([path.join(root, "huge.md")])).toBe("");
  });
  it("detects nearest package manager, toolchain, and framework for reinjection", () => {
    const root = project({ "pnpm-lock.yaml": "", "biome.json": "{}", "svelte.config.js": "", "pyproject.toml": "[tool.ruff]", "packages/app/package.json": "{}" });
    const env = detectProjectEnvironment(path.join(root, "packages/app"));
    expect(env).toMatchObject({ packageManager: "pnpm", toolchain: "biome", framework: "svelte", python: true });
    expect(buildCompactContext(env).join("\n")).toContain("Use 'pnpm' for all package commands.");
  });
});
