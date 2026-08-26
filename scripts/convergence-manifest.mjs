import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

const HASH = /^[a-f0-9]{64}$/u;
const ACTIVE_DISPOSITIONS = new Set(["canonicalized", "Claude-specific", "Pi-specific", "externalized", "retired"]);
const EVIDENCE_KINDS = new Set(["source-snapshot", "exclusion-rule", "behavior-test", "generated-artifact"]);
const COMPLETION_EVIDENCE_KINDS = new Set(["behavior-test", "generated-artifact"]);
const SYNTHETIC_DESTINATION = /(?:^|\/)(?:_convergence|convergence)(?:\/|$)/u;
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
function evidence(kind, entry, reference, verification, evidenceHash = entry.sha256 ?? entry.headSha256 ?? null) {
  const snapshotHash = entry.sha256 ?? entry.headSha256 ?? null;
  return {
    schemaVersion: 1,
    kind,
    sourceSnapshot: { source: entry.source, path: entry.path, sha256: snapshotHash },
    sha256: evidenceHash,
    reference,
    verification,
  };
}

function exclusion(relative, isDirectory = false) {
  const name = portable(relative);
  const segments = name.split("/");
  if (/(?:^|\/)(?:settings\.local\.json|auth(?:\.json)?|credentials?(?:\.[^/]*)?|sessions?|history|trust|runtime-state|\.cache|cache)(?:\/|$)/iu.test(name)
    || /(?:^|\/)\.env(?:\..+)?$/iu.test(name)) {
    return { disposition: "excluded", reason: "private-account-state", destination: null, adaptation: "none", ...(isDirectory ? { traversal: "pruned" } : {}) };
  }
  const pruned = segments.find(segment => PRUNED_SEGMENTS.has(segment));
  if (pruned) return { disposition: "excluded", reason: PRUNED_SEGMENTS.get(pruned), destination: null, adaptation: "none", ...(isDirectory ? { traversal: "pruned" } : {}) };
  if (/^\.claude\/worktrees(?:\/|$)/u.test(name)) return { disposition: "excluded", reason: "generated-worktree-state", destination: null, adaptation: "none", ...(isDirectory ? { traversal: "pruned" } : {}) };
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
    return { completion: "planned", disposition: "unclassified", plannedDisposition: "retired", plannedDestination: null, destination: null, adaptation: "retain-attributed-history" };
  }
  if (sourceId === "claude") {
    if (/^(?:plugins\/(?:mp|gh)\/skills|local\/skills)(?:\/|$)/u.test(name)) {
      return { completion: "planned", disposition: "unclassified", plannedDisposition: "canonicalized", plannedDestination: `content/skills/_convergence/${name}`, destination: null, adaptation: "generalize-provider-and-runtime-contracts" };
    }
    if (/^(?:instructions|rules|rules-per-project)(?:\/|$)/u.test(name)) {
      return { completion: "planned", disposition: "unclassified", plannedDisposition: "canonicalized", plannedDestination: `content/instructions/_convergence/${name}`, destination: null, adaptation: "preserve-scope-and-project-targeting" };
    }
    return { completion: "planned", disposition: "unclassified", plannedDisposition: "Claude-specific", plannedDestination: `runtimes/claude/convergence/${name}`, destination: null, adaptation: "preserve-harness-specific-surface" };
  }
  if (/^skills(?:\/|$)/u.test(name)) {
    return { completion: "planned", disposition: "unclassified", plannedDisposition: "canonicalized", plannedDestination: `content/skills/_convergence/pi/${name}`, destination: null, adaptation: "merge-with-canonical-skill" };
  }
  if (/^agents(?:\/|$)/u.test(name)) {
    return { completion: "planned", disposition: "unclassified", plannedDisposition: "canonicalized", plannedDestination: `content/agents/_convergence/${name}`, destination: null, adaptation: "merge-agent-intent-and-generate-runtime-projection" };
  }
  return { completion: "planned", disposition: "unclassified", plannedDisposition: "Pi-specific", plannedDestination: `runtimes/pi/convergence/${name}`, destination: null, adaptation: "preserve-harness-specific-surface" };
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
  const prunedRoots = new Set();

  async function walk(directory, prefix = "") {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const relative = portable(prefix ? `${prefix}/${item.name}` : item.name);
      const initial = classifySourcePath(source.id, relative, { isDirectory: item.isDirectory() });
      if (item.isDirectory() && initial.disposition === "excluded" && initial.traversal === "pruned") {
        prunedRoots.add(relative);
        const entry = { source: source.id, path: relative, kind: "directory", state: "ignored", sha256: null, completion: "excluded", ...initial };
        entry.evidence = [evidence("exclusion-rule", entry, initial.reason, "verified", null)];
        entries.set(relative, entry);
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
      entry.completion ??= classification.disposition === "excluded" ? "excluded" : "planned";
      entry.evidence = classification.disposition === "excluded"
        ? [evidence("exclusion-rule", entry, classification.reason, "verified", null)]
        : [evidence("source-snapshot", entry, `${source.id}:${relative}@${commit}`, "captured")];
      if (changed.has(relative) && tracked.has(relative)) {
        try { entry.headSha256 = sha256(runGit(root, ["show", `${commit}:${relative}`], null)); } catch { entry.headSha256 = null; }
      }
      entries.set(relative, entry);
    }
  }
  await walk(root);

  for (const relative of tracked) {
    if (entries.has(relative) || [...prunedRoots].some(root => relative.startsWith(`${root}/`))) continue;
    const baseHash = sha256(runGit(root, ["show", `${commit}:${relative}`], null));
    const classification = classifySourcePath(source.id, relative, { sha256: baseHash });
    const entry = { source: source.id, path: relative, kind: "file", state: "deleted", sha256: null, headSha256: baseHash, ...classification };
    entry.completion ??= classification.disposition === "excluded" ? "excluded" : "planned";
    entry.evidence = classification.disposition === "excluded"
      ? [evidence("exclusion-rule", entry, classification.reason, "verified", null)]
      : [evidence("source-snapshot", entry, `${source.id}:${relative}@${commit}`, "captured")];
    entries.set(relative, entry);
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
    schemaVersion: 2,
    generatedFor: "Phase F1 source convergence",
    sources: inventories.map(item => item.source),
    entries: inventories.flatMap(item => item.entries).sort((a, b) => `${a.source}:${a.path}`.localeCompare(`${b.source}:${b.path}`, "en")),
  };
}

function validateEvidence(entry, item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return "evidence must be an object";
  const keys = Object.keys(item).sort().join(",");
  if (keys !== "kind,reference,schemaVersion,sha256,sourceSnapshot,verification") return "evidence fields are invalid";
  if (item.schemaVersion !== 1 || !EVIDENCE_KINDS.has(item.kind) || typeof item.reference !== "string" || item.reference.length === 0) return "evidence version, kind, or reference is invalid";
  const verification = { "source-snapshot": "captured", "exclusion-rule": "verified", "behavior-test": "passed", "generated-artifact": "verified" }[item.kind];
  if (item.verification !== verification || (item.sha256 !== null && !HASH.test(item.sha256 ?? ""))) return "evidence hash or verification is invalid";
  const snapshot = item.sourceSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || Object.keys(snapshot).sort().join(",") !== "path,sha256,source") return "evidence source snapshot is invalid";
  const expectedHash = entry.sha256 ?? entry.headSha256 ?? null;
  if (snapshot.source !== entry.source || snapshot.path !== entry.path || snapshot.sha256 !== expectedHash) return "evidence is not bound to this source snapshot";
  if (item.kind === "source-snapshot" && item.sha256 !== expectedHash) return "source snapshot evidence hash does not match";
  if (item.kind === "exclusion-rule" && item.sha256 !== null) return "exclusion evidence must not contain a content hash";
  if (COMPLETION_EVIDENCE_KINDS.has(item.kind) && !HASH.test(item.sha256 ?? "")) return "completion evidence requires a SHA-256";
  return null;
}

export function validateConvergenceManifest(manifest, options = {}) {
  const gate = options.gate ?? true;
  const diagnostics = [];
  const add = (code, file, message) => diagnostics.push({ code, file, message });
  if (!manifest || manifest.schemaVersion !== 2 || !Array.isArray(manifest.sources) || !Array.isArray(manifest.entries)) {
    return [{ code: "CONVERGENCE_MANIFEST_INVALID", file: "docs/history/CONVERGENCE_MANIFEST.json", message: "manifest must use schemaVersion 2 with sources[] and entries[]" }];
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
    if (entry.sha256 !== null && !HASH.test(entry.sha256 ?? "")) add("CONVERGENCE_HASH_INVALID", file, "current hash must be SHA-256 or null");
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) add("CONVERGENCE_EVIDENCE_MISSING", file, "every input requires versioned evidence");
    else for (const item of entry.evidence) {
      const message = validateEvidence(entry, item);
      if (message) add("CONVERGENCE_EVIDENCE_INVALID", file, message);
    }

    if (entry.disposition === "excluded") {
      if (entry.completion !== "excluded" || typeof entry.reason !== "string" || entry.reason.length === 0 || entry.destination !== null) add("CONVERGENCE_EXCLUSION_INVALID", file, "excluded input requires excluded completion, a reason, and null destination");
      continue;
    }
    if (!["planned", "completed", "reviewed"].includes(entry.completion)) add("CONVERGENCE_COMPLETION_INVALID", file, "active input requires an explicit planned, reviewed, or completed state");
    if (entry.completion === "reviewed") {
      if (entry.phase !== "Phase I" || !ACTIVE_DISPOSITIONS.has(entry.disposition) || entry.destination !== null || typeof entry.adaptation !== "string" || !entry.adaptation.trim() || typeof entry.rationale !== "string" || !entry.rationale.trim()) add("CONVERGENCE_PHASE_REVIEW_INVALID", file, "reviewed drift requires a Phase I disposition, rationale, adaptation, and null destination");
      continue;
    }
    if (gate && entry.completion !== "completed") {
      add("CONVERGENCE_INCOMPLETE", file, "active input has not completed semantic mapping");
      continue;
    }
    if (!gate && entry.completion === "planned") {
      if (!ACTIVE_DISPOSITIONS.has(entry.plannedDisposition) || (entry.plannedDestination !== null && typeof entry.plannedDestination !== "string") || typeof entry.adaptation !== "string" || entry.adaptation.length === 0) add("CONVERGENCE_PLAN_INVALID", file, "planned input requires a proposed disposition, destination, and adaptation");
      continue;
    }
    if (entry.disposition === "unclassified" || !ACTIVE_DISPOSITIONS.has(entry.disposition)) add("CONVERGENCE_UNCLASSIFIED", file, "active input has no accepted disposition");
    const needsDestination = ["canonicalized", "Claude-specific", "Pi-specific", "externalized"].includes(entry.disposition);
    if (typeof entry.adaptation !== "string" || entry.adaptation.length === 0 || (needsDestination && (typeof entry.destination !== "string" || SYNTHETIC_DESTINATION.test(entry.destination)))) add("CONVERGENCE_DECISION_INCOMPLETE", file, "completed classification requires a real destination and adaptation facts");
    if (entry.disposition === "retired" && (typeof entry.reason !== "string" || entry.reason.length === 0 || entry.destination !== null || entry.activeReader !== null)) add("CONVERGENCE_RETIREMENT_INCOMPLETE", file, "retirement requires a reason, null destination, and explicit null active reader");
    if (needsDestination && !entry.evidence.some(item => COMPLETION_EVIDENCE_KINDS.has(item?.kind))) add("CONVERGENCE_COMPLETION_EVIDENCE_MISSING", file, "completed active input requires behavior-test or generated-artifact evidence");
  }
  return diagnostics;
}

function comparableEntry(entry) {
  return JSON.stringify({
    kind: entry.kind,
    state: entry.state,
    sha256: entry.sha256,
    headSha256: entry.headSha256 ?? null,
    traversal: entry.traversal ?? null,
  });
}

export function mergeReviewedDecisions(generated, reviewed) {
  const prior = new Map((reviewed?.entries ?? []).map(entry => [`${entry.source}:${entry.path}`, entry]));
  return {
    ...generated,
    entries: generated.entries.map(entry => {
      const previous = prior.get(`${entry.source}:${entry.path}`);
      return previous && comparableEntry(previous) === comparableEntry(entry) ? previous : entry;
    }),
  };
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
