import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConvergenceManifest,
  classifySourcePath,
  compareConvergenceManifests,
  mergeReviewedDecisions,
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
  await mkdir(path.join(root, "sessions", "nested"), { recursive: true });
  await mkdir(path.join(root, "auth", "nested"), { recursive: true });
  await mkdir(path.join(root, "cache", "nested"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "original\n");
  await writeFile(path.join(root, "settings.json"), "{}\n");
  await writeFile(path.join(root, "sessions", "nested", "private.json"), "session-secret\n");
  await writeFile(path.join(root, "auth", "nested", "private.json"), "auth-secret\n");
  await writeFile(path.join(root, "cache", "nested", "private.json"), "cache-secret\n");
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
    expect(classifySourcePath("claude", ".vscode/settings.json")).toMatchObject({ completion: "planned", disposition: "unclassified", plannedDisposition: "Claude-specific" });
  });

  it("traverses tracked, dirty, untracked, and pruned dependency paths without reading private state", async () => {
    const root = await fixture();
    try {
      const manifest = await buildConvergenceManifest({ sources: [{ id: "pi", root, symbolicRoot: "${MPX_PROJECTS}/mpx-pi" }] });
      expect(manifest.schemaVersion).toBe(2);
      expect(manifest.sources[0]).toMatchObject({ commit: git(root, "rev-parse", "HEAD"), dirty: true });
      expect(manifest.entries.find(entry => entry.path === "README.md")).toMatchObject({ state: "modified", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u), completion: "planned", disposition: "unclassified" });
      expect(manifest.entries.find(entry => entry.path === "new.ts")).toMatchObject({ state: "untracked", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(manifest.entries.find(entry => entry.path === "extensions/node_modules")).toMatchObject({ disposition: "excluded", reason: "dependency-store", traversal: "pruned" });
      for (const privateRoot of ["sessions", "auth", "cache"]) {
        expect(manifest.entries.find(entry => entry.path === privateRoot)).toMatchObject({ disposition: "excluded", reason: "private-account-state", traversal: "pruned", sha256: null });
        expect(manifest.entries.some(entry => entry.path.startsWith(`${privateRoot}/`))).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps snapshot verification usable while the Phase F1 completion gate fails", async () => {
    const root = await fixture();
    try {
      const manifest = await buildConvergenceManifest({ sources: [{ id: "pi", root, symbolicRoot: "${MPX_PROJECTS}/mpx-pi" }] });
      expect(validateConvergenceManifest(manifest, { gate: false })).toEqual([]);
      expect(validateConvergenceManifest(manifest).map(item => item.code)).toContain("CONVERGENCE_INCOMPLETE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed evidence instead of accepting arbitrary nonempty objects", () => {
    const manifest = {
      schemaVersion: 2,
      sources: [{ id: "pi", symbolicRoot: "${MPX_PROJECTS}/mpx-pi", commit: "a".repeat(40), dirty: false }],
      entries: [{
        source: "pi", path: "a.ts", kind: "file", state: "tracked", sha256: "b".repeat(64),
        completion: "completed", disposition: "Pi-specific", destination: "runtimes/pi/a.ts", adaptation: "adapter",
        evidence: [{ arbitrary: "nonempty" }],
      }],
    };
    expect(validateConvergenceManifest(manifest).map(item => item.code)).toContain("CONVERGENCE_EVIDENCE_INVALID");
  });

  it("rejects evidence bound to a different source snapshot", () => {
    const hash = "b".repeat(64);
    const manifest = {
      schemaVersion: 2,
      sources: [{ id: "pi", symbolicRoot: "${MPX_PROJECTS}/mpx-pi", commit: "a".repeat(40), dirty: false }],
      entries: [{
        source: "pi", path: "a.ts", kind: "file", state: "tracked", sha256: hash,
        completion: "planned", disposition: "unclassified", plannedDisposition: "Pi-specific", plannedDestination: "runtimes/pi/convergence/a.ts", destination: null, adaptation: "adapter",
        evidence: [{ schemaVersion: 1, kind: "source-snapshot", sourceSnapshot: { source: "pi", path: "other.ts", sha256: hash }, sha256: hash, reference: "pi:a.ts@commit", verification: "captured" }],
      }],
    };
    expect(validateConvergenceManifest(manifest, { gate: false }).map(item => item.code)).toContain("CONVERGENCE_EVIDENCE_INVALID");
  });

  it("does not count synthetic destinations or source snapshot hashes as completion evidence", () => {
    const hash = "b".repeat(64);
    const manifest = {
      schemaVersion: 2,
      sources: [{ id: "pi", symbolicRoot: "${MPX_PROJECTS}/mpx-pi", commit: "a".repeat(40), dirty: false }],
      entries: [{
        source: "pi", path: "a.ts", kind: "file", state: "tracked", sha256: hash,
        completion: "completed", disposition: "canonicalized", destination: "content/skills/_convergence/a.ts", adaptation: "adapter",
        evidence: [{ schemaVersion: 1, kind: "source-snapshot", sourceSnapshot: { source: "pi", path: "a.ts", sha256: hash }, sha256: hash, reference: "pi:a.ts@commit", verification: "captured" }],
      }],
    };
    expect(validateConvergenceManifest(manifest).map(item => item.code)).toEqual(expect.arrayContaining([
      "CONVERGENCE_DECISION_INCOMPLETE", "CONVERGENCE_COMPLETION_EVIDENCE_MISSING",
    ]));
  });

  it("requires finalized retirement reasons and an explicit absence of active readers", () => {
    const hash = "b".repeat(64);
    const snapshot = { schemaVersion: 1, kind: "source-snapshot", sourceSnapshot: { source: "pi", path: "old.ts", sha256: hash }, sha256: hash, reference: "pi:old.ts@commit", verification: "captured" };
    const base = { schemaVersion: 2, sources: [{ id: "pi", symbolicRoot: "${MPX_PROJECTS}/mpx-pi", commit: "a".repeat(40), dirty: false }] };
    const entry = { source: "pi", path: "old.ts", state: "tracked", sha256: hash, completion: "completed", disposition: "retired", destination: null, adaptation: "removed", evidence: [snapshot] };
    expect(validateConvergenceManifest({ ...base, entries: [entry] }).map(item => item.code)).toContain("CONVERGENCE_RETIREMENT_INCOMPLETE");
    expect(validateConvergenceManifest({ ...base, entries: [{ ...entry, reason: "superseded", activeReader: null }] })).toEqual([]);
  });

  it("rejects unclassified active inputs and classifications without evidence", () => {
    const hash = "b".repeat(64);
    const base = { schemaVersion: 2, sources: [{ id: "pi", symbolicRoot: "${MPX_PROJECTS}/mpx-pi", commit: "a".repeat(40), dirty: false }], entries: [] };
    const snapshot = { schemaVersion: 1, kind: "source-snapshot", sourceSnapshot: { source: "pi", path: "a.ts", sha256: hash }, sha256: hash, reference: "pi:a.ts@commit", verification: "captured" };
    expect(validateConvergenceManifest({ ...base, entries: [{ source: "pi", path: "a.ts", state: "tracked", sha256: hash, completion: "completed", disposition: "unclassified", destination: null, adaptation: "none", evidence: [snapshot] }] }).map(item => item.code)).toContain("CONVERGENCE_UNCLASSIFIED");
    expect(validateConvergenceManifest({ ...base, entries: [{ source: "pi", path: "a.ts", state: "tracked", sha256: hash, completion: "completed", disposition: "Pi-specific", destination: "runtimes/pi/a.ts", adaptation: "adapter", evidence: [] }] }).map(item => item.code)).toContain("CONVERGENCE_EVIDENCE_MISSING");
    expect(validateConvergenceManifest({ ...base, entries: [{ source: "pi", path: "a.ts", state: "tracked", sha256: hash, completion: "completed", disposition: "Pi-specific", destination: null, adaptation: "adapter", evidence: [snapshot] }] }).map(item => item.code)).toContain("CONVERGENCE_DECISION_INCOMPLETE");
  });

  it("preserves reviewed decisions when regenerating an unchanged source snapshot", async () => {
    const root = await fixture();
    try {
      const captured = await buildConvergenceManifest({ sources: [{ id: "pi", root, symbolicRoot: "${MPX_PROJECTS}/mpx-pi" }] });
      const reviewed = structuredClone(captured);
      const entry = reviewed.entries.find(item => item.disposition !== "excluded");
      Object.assign(entry, { completion: "completed", disposition: "retired", destination: null, adaptation: "removed", reason: "superseded", activeReader: null });
      delete entry.plannedDisposition;
      delete entry.plannedDestination;
      expect(mergeReviewedDecisions(captured, reviewed).entries.find(item => item.path === entry.path)).toMatchObject({ completion: "completed", disposition: "retired", reason: "superseded" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("compares source snapshots without treating reviewed decisions as source drift", async () => {
    const root = await fixture();
    try {
      const captured = await buildConvergenceManifest({ sources: [{ id: "pi", root, symbolicRoot: "${MPX_PROJECTS}/mpx-pi" }] });
      const reviewed = structuredClone(captured);
      const entry = reviewed.entries.find(item => item.disposition !== "excluded");
      entry.completion = "completed";
      entry.disposition = "retired";
      entry.destination = null;
      entry.adaptation = "superseded-by-canonical-runtime";
      entry.reason = "no-active-reader";
      delete entry.plannedDisposition;
      delete entry.plannedDestination;
      expect(compareConvergenceManifests(reviewed, captured)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
