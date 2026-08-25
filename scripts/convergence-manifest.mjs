import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

const HASH = /^[a-f0-9]{64}$/u;
const ACTIVE_DISPOSITIONS = new Set(["canonicalized", "Claude-specific", "Pi-specific", "externalized", "retired"]);
const PRUNED_SEGMENTS = new Map([
  [".git", "git-administration"],
  ["node_modules", "dependency-store"],
  [".pnpm", "dependency-store"],
  ["dist", "generated-build-output"],
  ["build", "generated-build-output"],
  ["coverage", "generated-test-output"],
  [".cache", "generated-cache"],
  [".vite", "generated-cache"],
  [".turbo", "generated-cache"],
  ["__pycache__", "generated-cache"],
]);

const portable = value => value.replaceAll("\\", "/").replace(/^\.\//u, "");
const sha256 = value => createHash("sha256").update(value).digest("hex");
const runGit = (root, args, encoding = "utf8") => execFileSync("git", args, { cwd: root, encoding, windowsHide: true });
const evidence = reference => [{ type: "source-snapshot", status: "captured", reference }];

function exclusion(relative, isDirectory = false) {
  const name = portable(relative);
  const segments = name.split("/");
  const pruned = segments.find(segment => PRUNED_SEGMENTS.has(segment));
  if (pruned) return { disposition: "excluded", reason: PRUNED_SEGMENTS.get(pruned), destination: null, adaptation: "none", ...(isDirectory ? { traversal: "pruned" } : {}) };
  if (/^\.claude\/worktrees(?:\/|$)/u.test(name)) return { disposition: "excluded", reason: "generated-worktree-state", destination: null, adaptation: "none", ...(isDirectory ? { traversal: "pruned" } : {}) };
  if (/(?:^|\/)(?:settings\.local\.json|auth\.json|credentials?(?:\.[^/]*)?|sessions?|history|trust|runtime-state)(?:\/|$)/iu.test(name)
    || /(?:^|\/)\.env(?:\..+)?$/iu.test(name)) {
    return { disposition: "excluded", reason: "private-account-state", destination: null, adaptation: "none", ...(isDirectory ? { traversal: "pruned" } : {}) };
  }
  if (/^(?:nul|con|prn|aux|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(name) || /(?:^|\/)HANDOFF\.md$/u.test(name)) {
    return { disposition: "excluded", reason: "accidental-filesystem-artifact", destination: null, adaptation: "none" };
  }
  if (/\.tsbuildinfo$/iu.test(name)) return { disposition: "excluded", reason: "generated-build-output", destination: null, adaptation: "none" };
  return null;
}

export function classifySourcePath(sourceId, relative, options = {}) {
  const name = portable(relative);
  const excluded = exclusion(name, options.isDirectory);
  if (excluded) return excluded;
  if (/^(?:deprecated|scripts\/retired)(?:\/|$)/u.test(name)) {
    return { disposition: "retired", destination: null, adaptation: "retain-attributed-history", evidence: evidence(options.sha256 ?? "path-classification") };
  }
  if (sourceId === "claude") {
    if (/^(?:plugins\/(?:mp|gh)\/skills|local\/skills)(?:\/|$)/u.test(name)) {
      return { disposition: "canonicalized", destination: `content/skills/_convergence/${name}`, adaptation: "generalize-provider-and-runtime-contracts", evidence: evidence(options.sha256 ?? "path-classification") };
    }
    if (/^(?:instructions|rules|rules-per-project)(?:\/|$)/u.test(name)) {
      return { disposition: "canonicalized", destination: `content/instructions/_convergence/${name}`, adaptation: "preserve-scope-and-project-targeting", evidence: evidence(options.sha256 ?? "path-classification") };
    }
    return { disposition: "Claude-specific", destination: `runtimes/claude/convergence/${name}`, adaptation: "preserve-harness-specific-surface", evidence: evidence(options.sha256 ?? "path-classification") };
  }
  if (/^skills(?:\/|$)/u.test(name)) {
    return { disposition: "canonicalized", destination: `content/skills/_convergence/pi/${name}`, adaptation: "merge-with-canonical-skill", evidence: evidence(options.sha256 ?? "path-classification") };
  }
  if (/^agents(?:\/|$)/u.test(name)) {
    return { disposition: "canonicalized", destination: `content/agents/_convergence/${name}`, adaptation: "merge-agent-intent-and-generate-runtime-projection", evidence: evidence(options.sha256 ?? "path-classification") };
  }
  return { disposition: "Pi-specific", destination: `runtimes/pi/convergence/${name}`, adaptation: "preserve-harness-specific-surface", evidence: evidence(options.sha256 ?? "path-classification") };
}

async function hashPath(file) {
  const stats = await lstat(file);
  if (stats.isSymbolicLink()) return sha256(`symlink:${await readlink(file)}`);
  if (!stats.isFile()) return null;
  return sha256(await readFile(file));
}

function nulList(buffer) {
  return buffer.toString("utf8").split("\0").filter(Boolean).map(portable);
}

async function sourceInventory(source) {
  const root = path.resolve(source.root);
  const commit = runGit(root, ["rev-parse", "HEAD"]).trim();
  const tracked = new Set(nulList(runGit(root, ["ls-files", "-z"], null)));
  const untracked = new Set(nulList(runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"], null)));
  const changed = new Set([
    ...nulList(runGit(root, ["diff", "--name-only", "-z", "HEAD"], null)),
    ...nulList(runGit(root, ["diff", "--cached", "--name-only", "-z"], null)),
  ]);
  const entries = new Map();

  async function walk(directory, prefix = "") {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const relative = portable(prefix ? `${prefix}/${item.name}` : item.name);
      const initial = classifySourcePath(source.id, relative, { isDirectory: item.isDirectory() });
      if (item.isDirectory() && initial.disposition === "excluded" && initial.traversal === "pruned") {
        entries.set(relative, { source: source.id, path: relative, kind: "directory", state: "ignored", sha256: null, ...initial, evidence: [{ type: "exclusion-rule", status: "verified", reference: initial.reason }] });
        continue;
      }
      if (item.isDirectory()) {
        await walk(path.join(directory, item.name), relative);
        continue;
      }
      const currentHash = initial.reason === "private-account-state" ? null : await hashPath(path.join(directory, item.name));
      const state = tracked.has(relative) ? (changed.has(relative) ? "modified" : "tracked") : untracked.has(relative) ? "untracked" : "ignored";
      const classification = classifySourcePath(source.id, relative, { sha256: currentHash ?? initial.reason });
      const entry = { source: source.id, path: relative, kind: item.isSymbolicLink() ? "symlink" : "file", state, sha256: currentHash, ...classification };
      if (classification.disposition === "excluded") entry.evidence = [{ type: "exclusion-rule", status: "verified", reference: classification.reason }];
      if (changed.has(relative) && tracked.has(relative)) {
        try { entry.headSha256 = sha256(runGit(root, ["show", `${commit}:${relative}`], null)); } catch { entry.headSha256 = null; }
      }
      entries.set(relative, entry);
    }
  }
  await walk(root);

  for (const relative of tracked) {
    if (entries.has(relative)) continue;
    const baseHash = sha256(runGit(root, ["show", `${commit}:${relative}`], null));
    const classification = classifySourcePath(source.id, relative, { sha256: baseHash });
    entries.set(relative, { source: source.id, path: relative, kind: "file", state: "deleted", sha256: null, headSha256: baseHash, ...classification });
  }

  return {
    source: { id: source.id, symbolicRoot: source.symbolicRoot, commit, dirty: changed.size > 0 || untracked.size > 0 },
    entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path, "en")),
  };
}

export async function buildConvergenceManifest({ sources }) {
  const inventories = [];
  for (const source of sources) inventories.push(await sourceInventory(source));
  return {
    schemaVersion: 1,
    generatedFor: "Phase F1 source convergence",
    sources: inventories.map(item => item.source),
    entries: inventories.flatMap(item => item.entries).sort((a, b) => `${a.source}:${a.path}`.localeCompare(`${b.source}:${b.path}`, "en")),
  };
}

export function validateConvergenceManifest(manifest) {
  const diagnostics = [];
  const add = (code, file, message) => diagnostics.push({ code, file, message });
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.sources) || !Array.isArray(manifest.entries)) {
    return [{ code: "CONVERGENCE_MANIFEST_INVALID", file: "docs/history/CONVERGENCE_MANIFEST.json", message: "manifest must use schemaVersion 1 with sources[] and entries[]" }];
  }
  const sourceIds = new Set();
  for (const source of manifest.sources) {
    if (!source || typeof source.id !== "string" || sourceIds.has(source.id) || typeof source.symbolicRoot !== "string" || !/^[a-f0-9]{40}$/u.test(source.commit ?? "") || typeof source.dirty !== "boolean") add("CONVERGENCE_SOURCE_INVALID", source?.id ?? "source", "source metadata is invalid or duplicated");
    else sourceIds.add(source.id);
  }
  const paths = new Set();
  for (const entry of manifest.entries) {
    const file = `${entry?.source ?? "?"}:${entry?.path ?? "?"}`;
    if (!entry || !sourceIds.has(entry.source) || typeof entry.path !== "string" || entry.path.startsWith("/") || entry.path.includes("\\") || paths.has(file)) {
      add("CONVERGENCE_ENTRY_INVALID", file, "entry source/path is invalid or duplicated");
      continue;
    }
    paths.add(file);
    if (entry.disposition === "unclassified" || (!ACTIVE_DISPOSITIONS.has(entry.disposition) && entry.disposition !== "excluded")) add("CONVERGENCE_UNCLASSIFIED", file, "active input has no accepted disposition");
    if (entry.disposition === "excluded") {
      if (typeof entry.reason !== "string" || entry.reason.length === 0 || entry.destination !== null) add("CONVERGENCE_EXCLUSION_INVALID", file, "excluded input requires a reason and null destination");
    } else {
      if (typeof entry.adaptation !== "string" || entry.adaptation.length === 0 || (entry.destination !== null && typeof entry.destination !== "string") || (["canonicalized", "Claude-specific", "Pi-specific", "externalized"].includes(entry.disposition) && typeof entry.destination !== "string")) add("CONVERGENCE_DECISION_INCOMPLETE", file, "classification requires destination and adaptation facts");
      if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) add("CONVERGENCE_EVIDENCE_MISSING", file, "classified input requires evidence");
    }
    if (entry.sha256 !== null && !HASH.test(entry.sha256 ?? "")) add("CONVERGENCE_HASH_INVALID", file, "current hash must be SHA-256 or null");
  }
  return diagnostics;
}

function comparableEntry(entry) {
  return JSON.stringify({ state: entry.state, sha256: entry.sha256, headSha256: entry.headSha256 ?? null, disposition: entry.disposition, reason: entry.reason ?? null });
}

export function compareConvergenceManifests(expected, actual) {
  const diagnostics = [];
  const expectedSources = new Map(expected.sources.map(source => [source.id, source]));
  for (const source of actual.sources) {
    const previous = expectedSources.get(source.id);
    if (!previous || previous.commit !== source.commit || previous.dirty !== source.dirty) diagnostics.push({ code: "CONVERGENCE_SOURCE_DRIFT", file: source.id, message: "source commit or dirty state changed" });
  }
  const current = new Map(actual.entries.map(entry => [`${entry.source}:${entry.path}`, entry]));
  const prior = new Map(expected.entries.map(entry => [`${entry.source}:${entry.path}`, entry]));
  for (const key of new Set([...prior.keys(), ...current.keys()])) {
    if (!prior.has(key) || !current.has(key) || comparableEntry(prior.get(key)) !== comparableEntry(current.get(key))) diagnostics.push({ code: "CONVERGENCE_SOURCE_DRIFT", file: key, message: "source path, state, or content changed" });
  }
  return diagnostics;
}
