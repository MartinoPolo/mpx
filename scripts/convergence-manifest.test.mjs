import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConvergenceManifest,
  classifySourcePath,
  compareConvergenceManifests,
  validateConvergenceManifest,
} from "./convergence-manifest.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-convergence-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  await mkdir(path.join(root, "extensions", "node_modules"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "original\n");
  await writeFile(path.join(root, "settings.json"), "{}\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  await writeFile(path.join(root, "README.md"), "dirty\n");
  await writeFile(path.join(root, "new.ts"), "export {};\n");
  await writeFile(path.join(root, "extensions", "node_modules", "dep.js"), "dependency\n");
  return root;
}

describe("Phase F1 convergence manifest", () => {
  it("excludes only explicit non-source classes with reasons", () => {
    expect(classifySourcePath("pi", "extensions/subagents/node_modules/pkg/index.js")).toMatchObject({ disposition: "excluded", reason: "dependency-store" });
    expect(classifySourcePath("claude", ".claude/settings.local.json")).toMatchObject({ disposition: "excluded", reason: "private-account-state" });
    expect(classifySourcePath("pi", "nul")).toMatchObject({ disposition: "excluded", reason: "accidental-filesystem-artifact" });
    expect(classifySourcePath("claude", ".vscode/settings.json")).toMatchObject({ disposition: "Claude-specific" });
  });

  it("traverses tracked, dirty, untracked, and pruned dependency paths without reading private state", async () => {
    const root = await fixture();
    try {
      const manifest = await buildConvergenceManifest({ sources: [{ id: "pi", root, symbolicRoot: "${MPX_PROJECTS}/mpx-pi" }] });
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.sources[0]).toMatchObject({ commit: git(root, "rev-parse", "HEAD"), dirty: true });
      expect(manifest.entries.find(entry => entry.path === "README.md")).toMatchObject({ state: "modified", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(manifest.entries.find(entry => entry.path === "new.ts")).toMatchObject({ state: "untracked", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(manifest.entries.find(entry => entry.path === "extensions/node_modules")).toMatchObject({ disposition: "excluded", reason: "dependency-store", traversal: "pruned" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unclassified active inputs and classifications without evidence", () => {
    const base = { schemaVersion: 1, sources: [{ id: "pi", symbolicRoot: "${MPX_PROJECTS}/mpx-pi", commit: "a".repeat(40), dirty: false }], entries: [] };
    expect(validateConvergenceManifest({ ...base, entries: [{ source: "pi", path: "a.ts", state: "tracked", sha256: "b".repeat(64), disposition: "unclassified", destination: null, adaptation: "none", evidence: [] }] }).map(item => item.code)).toContain("CONVERGENCE_UNCLASSIFIED");
    expect(validateConvergenceManifest({ ...base, entries: [{ source: "pi", path: "a.ts", state: "tracked", sha256: "b".repeat(64), disposition: "Pi-specific", destination: "runtimes/pi/a.ts", adaptation: "adapter", evidence: [] }] }).map(item => item.code)).toContain("CONVERGENCE_EVIDENCE_MISSING");
    expect(validateConvergenceManifest({ ...base, entries: [{ source: "pi", path: "a.ts", state: "tracked", sha256: "b".repeat(64), disposition: "Pi-specific", evidence: [{ type: "test", status: "captured", reference: "fixture" }] }] }).map(item => item.code)).toContain("CONVERGENCE_DECISION_INCOMPLETE");
  });

  it("detects source commit, status, path, and content drift", async () => {
    const root = await fixture();
    try {
      const before = await buildConvergenceManifest({ sources: [{ id: "pi", root, symbolicRoot: "${MPX_PROJECTS}/mpx-pi" }] });
      await writeFile(path.join(root, "new.ts"), "export const drift = true;\n");
      const after = await buildConvergenceManifest({ sources: [{ id: "pi", root, symbolicRoot: "${MPX_PROJECTS}/mpx-pi" }] });
      expect(compareConvergenceManifests(before, after)).toEqual([expect.objectContaining({ code: "CONVERGENCE_SOURCE_DRIFT", file: "pi:new.ts" })]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
