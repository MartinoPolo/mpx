import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEXT = /\.(?:c?js|mjs|ts|tsx|json|md|html|ya?ml|toml|ps1|bash|sh|py|txt)$/iu;
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|pnpm-lock\.yaml)$/iu;
const PRIVATE_STATE = /(?:^|\/)(?:\.env(?:\..+)?|[^/]*(?:credential|credentials|session|runtime-state)[^/]*)$/iu;
const ACTIVE_ROOT = /^(?:apps|content|packages|runtimes|scripts)\//u;
const IMPORTED = new Set(["imported-rewritten", "imported-non-normative-history"]);
const DISPOSITIONS = new Set([...IMPORTED, "deferred-inventory-only", "excluded"]);

const diagnostic = (code, file, message) => ({ code, file, message });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const normalized = (value) => value.replaceAll("\\", "/");

function isHistorical(file) {
  return file.startsWith("docs/history/");
}

function permitsClaudeVariable(file) {
  return file.startsWith("runtimes/claude/runtime-claude/");
}

export function validateFiles(files, options = {}) {
  const diagnostics = [];
  for (const name of options.generatedPiDiagnostics ?? []) {
    diagnostics.push(diagnostic("GENERATED_PI_DRIFT", `runtimes/pi/runtime-pi/projection/agents/${name}`, "generated Pi agent does not match canonical content"));
  }

  const tracked = new Set(options.trackedFiles ?? files.keys());
  for (const file of tracked) {
    const portable = normalized(file);
    if (LOCKFILE.test(portable) && portable !== "pnpm-lock.yaml") diagnostics.push(diagnostic("NESTED_LOCKFILE", portable, "only the root pnpm-lock.yaml is permitted"));
    if (PRIVATE_STATE.test(portable)) diagnostics.push(diagnostic("TRACKED_PRIVATE_STATE", portable, "credential, session, environment, and runtime-state files must not be tracked"));
  }

  for (const [rawFile, value] of files) {
    const file = normalized(rawFile);
    if (isHistorical(file) || file.endsWith(".test.mjs") || !ACTIVE_ROOT.test(file)) continue;
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
    if (/\/(?:mp|mp-gh|kf):[a-z0-9]/iu.test(text)) diagnostics.push(diagnostic("LEGACY_PUBLIC_IDENTITY", file, "active public identities must use /mpx:"));
    if (/\/mpx:mpx-[a-z0-9]/iu.test(text)) diagnostics.push(diagnostic("DOUBLED_MPX_IDENTITY", file, "canonical identities must not repeat the mpx prefix"));
    if (/(?:[A-Za-z]:[\\/](?:_MP_projects[\\/])?|\/(?:[A-Za-z][\\/])?_MP_projects[\\/])mpx-(?:claude-code|pi)(?:[\\/]|$)/iu.test(text)) diagnostics.push(diagnostic("LEGACY_SOURCE_PATH", file, "active files must not embed absolute legacy source-repository paths"));
    if (file.startsWith("content/") && /\$\{?CLAUDE_[A-Z0-9_]+\}?/u.test(text) && !permitsClaudeVariable(file)) diagnostics.push(diagnostic("CLAUDE_PLACEHOLDER", file, "canonical content must be runtime-neutral"));
    if (file.startsWith("runtimes/") && /(?:status-map\.json|mp\.config\.json|legacy[-_. ]?(?:status|config))/iu.test(text)) diagnostics.push(diagnostic("LEGACY_RUNTIME_READER", file, "active runtimes must consume current contracts only"));
  }
  return diagnostics;
}

function expandSource(source, roots) {
  return source.replace(/^\$\{([A-Z0-9_]+)\}/u, (_, name) => roots[name] ?? `\${${name}}`);
}

export async function validateProvenance({ rootFiles, manifest, roots, readSource, verifySources = false }) {
  const diagnostics = [];
  for (const [index, entry] of (manifest.entries ?? []).entries()) {
    const label = entry.destination ?? entry.source ?? `entry ${index}`;
    if (!DISPOSITIONS.has(entry.disposition)) diagnostics.push(diagnostic("PROVENANCE_DISPOSITION_INVALID", label, `unknown disposition '${entry.disposition}'`));
    const claimsImport = IMPORTED.has(entry.disposition) || entry.destination !== null;
    if (claimsImport) {
      if (!/^[a-f0-9]{64}$/u.test(entry.originalSha256 ?? "") || !/^[a-f0-9]{64}$/u.test(entry.destinationSha256 ?? "")) {
        diagnostics.push(diagnostic("PROVENANCE_HASH_MISSING", label, "imported entries require source and destination SHA-256 values"));
      }
      const destination = entry.destination ? rootFiles.get(normalized(entry.destination)) : undefined;
      if (destination === undefined) diagnostics.push(diagnostic("PROVENANCE_DESTINATION_MISSING", label, "provenance destination is absent"));
      else if (digest(destination) !== entry.destinationSha256) diagnostics.push(diagnostic("PROVENANCE_DESTINATION_HASH_MISMATCH", label, "destination no longer matches its recorded SHA-256"));
      if (verifySources) {
        const sourcePath = expandSource(entry.source ?? "", roots);
        const source = await readSource(sourcePath);
        if (source === undefined) diagnostics.push(diagnostic("PROVENANCE_SOURCE_MISSING", label, "provenance source is absent"));
        else if (digest(source) !== entry.originalSha256) diagnostics.push(diagnostic("PROVENANCE_SOURCE_HASH_MISMATCH", label, "source no longer matches its recorded SHA-256"));
      }
    } else if ((entry.disposition === "excluded" || entry.disposition === "deferred-inventory-only") && (entry.destination !== null || entry.destinationSha256 !== null)) {
      diagnostics.push(diagnostic("PROVENANCE_DISPOSITION_INVALID", label, "non-imported dispositions cannot claim a destination"));
    }
  }
  return diagnostics;
}

function parseProvenanceManifest(value, file = "docs/history/SOURCE_PROVENANCE.json") {
  if (value === undefined) return { manifest: null, diagnostics: [diagnostic("PROVENANCE_MANIFEST_MISSING", file, "source provenance manifest is required")] };
  let manifest;
  try { manifest = JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : String(value)); }
  catch { return { manifest: null, diagnostics: [diagnostic("PROVENANCE_MANIFEST_INVALID", file, "source provenance manifest is not valid JSON")] }; }
  const validEntry = (entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry)
    && typeof entry.source === "string" && (entry.destination === null || typeof entry.destination === "string")
    && typeof entry.disposition === "string" && (entry.originalSha256 === null || typeof entry.originalSha256 === "string")
    && (entry.destinationSha256 === null || typeof entry.destinationSha256 === "string");
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest) || manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries) || !manifest.entries.every(validEntry) || (manifest.symbolicRoots !== undefined && (manifest.symbolicRoots === null || typeof manifest.symbolicRoots !== "object" || Array.isArray(manifest.symbolicRoots)))) {
    return { manifest: null, diagnostics: [diagnostic("PROVENANCE_MANIFEST_INVALID", file, "source provenance manifest must use schemaVersion 1 with structurally valid entries[] and optional symbolicRoots{}")] };
  }
  return { manifest, diagnostics: [] };
}

export async function validateGeneratedRepository({ root, names, tracked, files, generatedPiDiagnostics = [], readSource, verifySources = false }) {
  const diagnostics = validateFiles(files, { trackedFiles: tracked, generatedPiDiagnostics });
  const provenanceFile = "docs/history/SOURCE_PROVENANCE.json";
  const parsed = parseProvenanceManifest(files.get(provenanceFile), provenanceFile);
  diagnostics.push(...parsed.diagnostics);
  if (parsed.manifest) diagnostics.push(...await validateProvenance({
    rootFiles: files,
    manifest: parsed.manifest,
    roots: Object.fromEntries(Object.keys(parsed.manifest.symbolicRoots ?? {}).map((name) => [name, process.env[name]])),
    readSource,
    verifySources,
  }));
  return diagnostics;
}

export async function repositoryFiles(root, names) {
  const result = new Map();
  const diagnostics = [];
  await Promise.all(names.filter((name) => TEXT.test(name)).map(async (name) => {
    try { result.set(normalized(name), await readFile(path.join(root, name))); }
    catch { diagnostics.push(diagnostic("FILE_READ_FAILED", normalized(name), "enumerated textual file could not be read")); }
  }));
  diagnostics.sort((left, right) => left.file.localeCompare(right.file));
  Object.defineProperty(result, "diagnostics", { value: Object.freeze(diagnostics), enumerable: false });
  return result;
}

async function run() {
  const verifySources = process.argv.includes("--verify-sources");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const output = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root });
  const names = output.toString("utf8").split("\0").filter(Boolean);
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString("utf8").split("\0").filter(Boolean);
  const files = await repositoryFiles(root, names);

  const generated = spawnSync(process.execPath, [path.join(root, "runtimes/pi/runtime-pi/scripts/generate-agents.mjs"), "--check"], { cwd: root, encoding: "utf8" });
  const drift = generated.status === 0 ? [] : [generated.stderr.trim() || generated.stdout.trim() || "projection"];
  const diagnostics = [...files.diagnostics, ...await validateGeneratedRepository({
    root,
    names,
    tracked,
    files,
    generatedPiDiagnostics: drift,
    readSource: async (source) => { try { return await readFile(source); } catch { return undefined; } },
    verifySources,
  })];

  const parsed = parseProvenanceManifest(files.get("docs/history/SOURCE_PROVENANCE.json"));
  if (diagnostics.length) {
    for (const item of diagnostics) console.error(`${item.code}: ${item.file}: ${item.message}`);
    process.exitCode = 1;
  } else console.log(`Validated ${files.size} active/generated files and ${parsed.manifest.entries.length} provenance entries.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
