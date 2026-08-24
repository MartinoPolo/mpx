import { existsSync, openSync, closeSync, fstatSync, readFileSync } from "node:fs";
import path from "node:path";

export type HookAction = "allow" | "block";
export interface HookDecision { readonly action: HookAction; readonly code?: string; readonly message?: string }
export class RuntimeHookError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = "RuntimeHookError"; }
}

const MAX_COMMAND = 32_768;
const GENERATED_DIRECTORIES = new Set(["node_modules", "dist", "build", "out", ".next", ".svelte-kit", ".nuxt", "coverage", ".cache", "tmp", ".turbo", ".parcel-cache", ".output", "__pycache__", ".pytest_cache", ".mypy_cache", "target"]);
function block(code: string, reason: string, command?: string): HookDecision {
  return { action: "block", code, message: command === undefined ? reason : `Blocked: ${reason}.\nRun manually only after review: ${command.trim()}` };
}
function boundedCommand(command: string): HookDecision | undefined {
  if (typeof command !== "string") return block("INVALID_INPUT", "command must be a string");
  if (command.length > MAX_COMMAND) return block("INPUT_TOO_LARGE", `command exceeds ${MAX_COMMAND} characters`);
  return undefined;
}
function unquote(token: string): string { return token.replace(/^["']|["']$/g, ""); }

/** Pure command classification. Adapters decide how a block is presented to a runtime. */
export function classifyDangerousCommand(command: string): HookDecision {
  const invalid = boundedCommand(command); if (invalid) return invalid;
  const value = command.trim();
  for (const match of value.matchAll(/(?:^|[;&|()]|\s)rm\s+([^;&|\n]+)/g)) {
    const tokens = (match[1] ?? "").trim().split(/\s+/);
    const hasRecursive = tokens.some((token) => /^-[A-Za-z]*r[A-Za-z]*$/.test(token) || token === "--recursive");
    const hasForce = tokens.some((token) => /^-[A-Za-z]*f[A-Za-z]*$/.test(token) || token === "--force");
    if (hasRecursive && hasForce) {
      let separator = false;
      const targets = tokens.filter((token) => { if (token === "--") { separator = true; return false; } return separator || !token.startsWith("-"); }).map(unquote);
      if (targets.length === 0) return block("DANGEROUS_RECURSIVE_DELETE", "recursive forced deletion has no constrained target", command);
      for (const target of targets) {
        const normalized = target.replace(/[\\/]+$/u, "");
        const broad = normalized === "" || ["/", "~", ".", "..", "*"].includes(target) || target.startsWith("~/") || target.startsWith("../") || path.win32.isAbsolute(target) || path.posix.isAbsolute(target);
        const single = !target.includes("/") && !target.includes("\\");
        if (broad || (single && !GENERATED_DIRECTORIES.has(target))) return block("DANGEROUS_RECURSIVE_DELETE", "broad recursive deletion is not allowed", command);
      }
    }
  }
  if (/\brmdir\s+\/s\b/i.test(value)) return block("WINDOWS_RECURSIVE_DELETE", "Windows recursive deletion is not allowed", command);
  if (/\bdel\b(?=[^\n]*\/f)(?=[^\n]*\/q)(?=[^\n]*\/s)/i.test(value)) return block("WINDOWS_RECURSIVE_DELETE", "Windows forced recursive deletion is not allowed", command);
  if (/\bchmod\s+(?:-R\s+)?(?:777|000)\s+[\/~.]/.test(value)) return block("DANGEROUS_PERMISSIONS", "broad permission destruction is not allowed", command);
  if (/\bmkfs(?:\.[\w-]+)?\b/.test(value)) return block("DISK_FORMAT", "filesystem formatting is not allowed", command);
  if (/\bdd\b(?=[^\n]*\bif=\/dev\/(?:zero|random|urandom)\b)(?=[^\n]*\bof=\/dev\/)/.test(value) || />\s*\/dev\/(?:sd[a-z]|nvme\d)/.test(value)) return block("DEVICE_OVERWRITE", "device overwrite is not allowed", command);
  if (/:\(\)\s*\{.*:\|:.*\}/.test(value)) return block("FORK_BOMB", "fork bombs are not allowed", command);
  if (/\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/i.test(value)) return block("DESTRUCTIVE_SQL", "destructive SQL is not allowed", command);
  if (/\bgit\s+push\b(?=[^\n;&|]*(?:-f\b|--force\b))(?![^\n;&|]*--force-with-lease\b)[^\n;&|]*(?:(?:origin|upstream)\s+)?(?:main|master)\b/.test(value)) return block("PROTECTED_FORCE_PUSH", "force push to a protected branch is not allowed", command);
  if (/\bgit\s+clean\s+-(?=[A-Za-z]*f)(?=[A-Za-z]*d)(?=[A-Za-z]*x)[A-Za-z]+/.test(value)) return block("DESTRUCTIVE_GIT_CLEAN", "git clean of ignored files is not allowed", command);
  if (/\bsetx\b[^\n]*\bPATH\b/i.test(value) || /SetEnvironmentVariable\s*\(\s*["']PATH["']/i.test(value) || /\breg\s+add\b[^\n]*\\Environment\b(?=[^\n]*\bPATH\b)/i.test(value)) return block("PERSISTENT_PATH_CHANGE", "persistent PATH modification is not allowed", command);
  return { action: "allow" };
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export interface PackagePolicyDecision extends HookDecision { readonly replacement?: string; readonly warnings: readonly string[] }
export function evaluatePackagePolicy(command: string, manager: PackageManager | null): PackagePolicyDecision {
  const invalid = boundedCommand(command); if (invalid) return { ...invalid, warnings: [] };
  const warnings: string[] = [];
  const primary = command.trim().split(/\s+/u)[0] ?? "";
  if (manager && (["npm", "pnpm", "yarn", "bun"] as string[]).includes(primary) && primary !== manager) return { action: "block", code: "WRONG_PACKAGE_MANAGER", message: `This project uses ${manager}; use it instead of ${primary}.`, replacement: manager, warnings };
  if (manager === "bun" && /(?:^|\s)npx\s/.test(command)) return { action: "block", code: "WRONG_PACKAGE_RUNNER", message: "This project uses bunx instead of npx.", replacement: "bunx", warnings };
  if (manager && /(?:^|[;&|]\s*|\s)npx\s+tsc(?:\s|$)/.test(command)) return { action: "block", code: "DIRECT_TSC", message: `Use '${manager} run typecheck' or the project's check script.`, replacement: `${manager} run typecheck`, warnings };
  // Pipeline commands use these tools for stream processing rather than as a
  // substitute for runtime-native file/search capabilities.
  const standalone = command.includes("|") ? "" : command.trim();
  if (/^(?:grep|rg)\s|(?:&&|;)\s*(?:grep|rg)\s/.test(standalone)) warnings.push("Consider using the Grep capability instead of a shell search tool.");
  if (/^(?:cat|head|tail)\s|(?:&&|;)\s*(?:cat|head|tail)\s/.test(standalone)) warnings.push("Consider using the Read capability instead of a shell file reader.");
  if (/^find\s|(?:&&|;)\s*find\s/.test(standalone)) warnings.push("Consider using the file Glob capability instead of shell find.");
  return { action: "allow", warnings };
}

const SECRET_PATTERNS = [
  ["AWS Access Key", /AKIA[0-9A-Z]{16}/], ["GitHub PAT", /ghp_[a-zA-Z0-9]{36}/], ["GitHub OAuth", /gho_[a-zA-Z0-9]{36}/],
  ["Private Key", /-----BEGIN[A-Z ]*PRIVATE KEY-----/], ["Slack Token", /xox[bpors]-[a-zA-Z0-9-]+/],
  ["Generic Secret", /\b(?:password|secret|api_key|apikey|auth_token)\b\s*[:=]\s*["']?[^"'\s]{8,}["']?/i],
] as const;
export interface SecretFinding { readonly name: string; readonly file: string }
export function scanAddedSecrets(diff: string, filename: string): SecretFinding[] {
  if (diff.length > 1_000_000) throw new RuntimeHookError("INPUT_TOO_LARGE", "staged diff exceeds 1000000 characters");
  if (filename.length > 4_096) throw new RuntimeHookError("INPUT_TOO_LARGE", "filename is too long");
  const findings: SecretFinding[] = [];
  for (const line of diff.split("\n")) if (line.startsWith("+") && !line.startsWith("+++")) for (const [name, pattern] of SECRET_PATTERNS) if (pattern.test(line)) { findings.push({ name, file: filename }); break; }
  return findings;
}
export function shouldScanStagedFile(filename: string): boolean { return ![/\.lock$/, /lock\.json$/, /lock\.yaml$/, /\.lockb$/, /\.env\.(?:example|sample|template)$/, /\.(?:test|spec)\.[jt]sx?$/].some((pattern) => pattern.test(filename)); }
export function extractCommitMessage(command: string): string | null {
  if (command.length > MAX_COMMAND) return null;
  const heredoc = command.match(/(?:\$\(cat\s+)?<<-?["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*\n([\s\S]*?)\n\1/u); if (heredoc) return (heredoc[2] ?? "").split("\n")[0]?.trim() || null;
  return command.match(/-m\s+"([^"]+)"/)?.[1] ?? command.match(/-m\s+\$?'([^']+)'/)?.[1] ?? null;
}
export function validateCommitFormat(message: string): { readonly valid: boolean; readonly warnings: readonly string[] } {
  const first = message.split("\n")[0] ?? ""; const valid = /^(?:feat|fix|refactor|chore|docs|style|test|perf|ci|build|revert)(?:\(.+\))?: .+/.test(first); const warnings: string[] = [];
  if (!valid) warnings.push("Warning: commit message does not match conventional format: type(scope): description");
  if (first.length > 72) warnings.push(`Warning: commit message first line is ${first.length} chars (recommended max 72)`);
  return { valid, warnings };
}
export type Toolchain = "vite-plus" | "biome" | "classic";
export type Framework = "svelte" | "next" | null;
export function selectPreCommitCheck(input: { readonly toolchain: Toolchain; readonly scripts: Readonly<Record<string, string>>; readonly framework: Framework }): string | null {
  const names = input.toolchain === "vite-plus" ? ["check:all", "check-all"] : [];
  names.push(...(input.framework === "svelte" ? ["check", "typecheck", "type-check"] : ["typecheck", "type-check", "check", "check:types", "tsc"]));
  return names.find((name) => Boolean(input.scripts[name])) ?? null;
}

export interface FallowGateInput { readonly command: string; readonly minimumVersion: string; readonly runner?: { readonly description: string; readonly version: string }; readonly audit?: { readonly status: number; readonly stdout: string; readonly stderr: string } }
export interface FallowDecision extends HookDecision { readonly warning?: string; readonly auditOutput?: string }
function semverCompare(a: string, b: string): number { const av = a.split(".").slice(0, 3).map(Number), bv = b.split(".").slice(0, 3).map(Number); for (let i = 0; i < 3; i++) { const delta = (av[i] || 0) - (bv[i] || 0); if (delta) return delta < 0 ? -1 : 1; } return 0; }
export function evaluateFallowGate(input: FallowGateInput): FallowDecision {
  const invalid = boundedCommand(input.command); if (invalid) return invalid;
  if (!/(^|[\s;|&()])git\s+(?:commit|push)(?:\s|$)/.test(input.command)) return { action: "allow" };
  if (!input.runner) return { action: "allow", code: "FALLOW_UNAVAILABLE", warning: "fallow-gate: fallow binary not found; skipping." };
  if (input.minimumVersion && input.runner.version && semverCompare(input.runner.version, input.minimumVersion) < 0) return block("FALLOW_VERSION_TOO_OLD", `${input.runner.description} is fallow ${input.runner.version}, below required ${input.minimumVersion}`);
  if (!input.audit) return { action: "allow", code: "FALLOW_RUNTIME_ERROR", warning: "fallow-gate: audit result unavailable; skipping." };
  type AuditPayload = { verdict?: unknown; error?: unknown; message?: unknown };
  let parsed: AuditPayload | null = null; try { parsed = JSON.parse(input.audit.stdout) as AuditPayload; } catch { /* visible fail-open below */ }
  if (parsed?.verdict === "fail") return { action: "block", code: "FALLOW_AUDIT_FAILED", message: `Blocked by ${input.runner.description}.`, auditOutput: input.audit.stdout };
  if (input.audit.status === 2 || parsed?.error === true) return { action: "allow", code: "FALLOW_RUNTIME_ERROR", warning: `fallow-gate: audit runtime error${typeof parsed?.message === "string" ? ` (${parsed.message})` : ""}; skipping.` };
  if (input.audit.status !== 0) return { action: "allow", code: "FALLOW_RUNTIME_ERROR", warning: `fallow-gate: audit exited ${input.audit.status}${input.audit.stderr ? ` (${input.audit.stderr.split("\n")[0]})` : ""}; skipping.` };
  return { action: "allow" };
}

export type PostCommandAssumption =
  | { readonly operation: "git-push"; readonly exitCode: number; readonly pullRequest: "exists" | "missing" | "unknown" }
  | { readonly operation: "package-install"; readonly exitCode: number; readonly stderr?: string }
  | { readonly operation: "pull-request-create"; readonly exitCode: number; readonly pullRequestUrl?: string };
export function extractPostCommandContext(input: PostCommandAssumption): string | null {
  if (input.operation === "git-push") return input.exitCode === 0 && input.pullRequest === "missing" ? "Pushed to remote. No pull request exists for this branch yet." : null;
  if (input.operation === "package-install") return /vulnerabilit(?:y|ies)/i.test((input.stderr ?? "").slice(0, 65_536)) ? "Package install detected vulnerabilities. Consider running the project audit policy." : null;
  if (input.exitCode !== 0 || !input.pullRequestUrl || input.pullRequestUrl.length > 2_048) return null;
  try { const url = new URL(input.pullRequestUrl); return url.protocol === "https:" ? `Pull request created: ${url.href}` : null; } catch { return null; }
}

export interface QualityInvocation { readonly executable: string; readonly args: readonly string[]; readonly reportFailure: boolean }
const ESLINT_CONFIGS = new Set([".eslintrc", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml", ".eslintrc.js", ".eslintrc.cjs", "eslint.config.js", "eslint.config.cjs", "eslint.config.mjs", "eslint.config.ts"]);
const PRETTIER_CONFIGS = new Set([".prettierrc", ".prettierrc.json", ".prettierrc.yml", ".prettierrc.yaml", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs"]);
export function planFileQuality(input: { readonly relativeFile: string; readonly toolchain: Toolchain; readonly runner: readonly [string, ...string[]]; readonly configs: readonly string[] }): QualityInvocation[] {
  if (input.relativeFile.length > 4_096 || path.isAbsolute(input.relativeFile) || /^[A-Za-z]:[\\/]/.test(input.relativeFile) || input.relativeFile.split(/[\\/]/).includes("..")) throw new RuntimeHookError("UNSAFE_PATH", "edited file must be a bounded project-relative path");
  const invoke = (tool: string, args: string[], reportFailure: boolean): QualityInvocation => ({ executable: input.runner[0], args: [...input.runner.slice(1), tool, ...args, input.relativeFile], reportFailure });
  const ext = path.extname(input.relativeFile).slice(1).toLowerCase(); const result: QualityInvocation[] = []; const eslint = input.configs.some((item) => ESLINT_CONFIGS.has(item)); const prettier = input.configs.some((item) => PRETTIER_CONFIGS.has(item));
  if (ext === "py") return input.configs.includes("pyproject:tool.ruff") || input.configs.includes("ruff.toml") || input.configs.includes(".ruff.toml") ? [invoke("ruff", ["format"], false), invoke("ruff", ["check", "--fix"], true)] : [];
  const js = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "svelte", "vue"]).has(ext); const data = new Set(["json", "jsonc", "css", "scss", "less", "html", "md", "yaml", "yml"]).has(ext);
  if (input.toolchain === "vite-plus" && (js || data)) { result.push(invoke("vp", ["fmt"], false)); if (js) { result.push(invoke("vp", ["lint", "--fix"], true)); if (eslint) result.push(invoke("eslint", ["--fix"], true)); } return result; }
  if (input.toolchain === "biome" && (js || ["json", "jsonc", "css"].includes(ext))) { result.push(invoke("biome", ["format", "--write"], false)); if (js) result.push(invoke("biome", ["lint", "--fix"], true)); return result; }
  if ((js || data) && prettier) result.push(invoke("prettier", ["--write"], false)); if (js && eslint) result.push(invoke("eslint", ["--fix"], true)); return result;
}

export interface ProjectEnvironment { readonly packageManager: PackageManager | null; readonly runner: readonly string[]; readonly toolchain: Toolchain; readonly framework: Framework; readonly python: boolean }
const LOCKFILES: readonly [string, PackageManager][] = [["bun.lockb", "bun"], ["bun.lock", "bun"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["package-lock.json", "npm"]];
export function detectProjectEnvironment(startDirectory: string): ProjectEnvironment {
  let current = path.resolve(startDirectory); let packageManager: PackageManager | null = null; let toolchain: Toolchain = "classic"; let framework: Framework = null; let python = false;
  for (let depth = 0; depth < 64; depth++) {
    if (!packageManager) packageManager = LOCKFILES.find(([name]) => existsSync(path.join(current, name)))?.[1] ?? null;
    if (toolchain === "classic") { const vp = path.join(current, "node_modules", ".bin", "vp"); if ([vp, `${vp}.cmd`, `${vp}.ps1`].some(existsSync)) toolchain = "vite-plus"; else if (["biome.json", "biome.jsonc"].some((name) => existsSync(path.join(current, name)))) toolchain = "biome"; }
    if (!framework) { if (["svelte.config.js", "svelte.config.ts"].some((name) => existsSync(path.join(current, name)))) framework = "svelte"; else if (["next.config.js", "next.config.mjs", "next.config.ts"].some((name) => existsSync(path.join(current, name)))) framework = "next"; }
    if (existsSync(path.join(current, "pyproject.toml"))) python = true;
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  const runners: Record<PackageManager, readonly string[]> = { bun: ["bunx"], pnpm: ["pnpm", "exec"], yarn: ["yarn", "exec"], npm: ["npx"] };
  return { packageManager, runner: packageManager ? runners[packageManager] : ["npx"], toolchain, framework, python };
}
export function buildCompactContext(environment: ProjectEnvironment): string[] {
  const lines: string[] = []; const pm = environment.packageManager;
  if (pm) { lines.push(`This project uses ${pm}. Use '${pm}' for all package commands.`); lines.push(`Do not use another package manager unless '${pm}' is that tool.`); }
  if (environment.toolchain === "vite-plus") lines.push("Toolchain: Vite Plus. Use vp check, vp fmt, vp lint, and vp test through the project runner."); else if (environment.toolchain === "biome") lines.push("Formatter/Linter: Biome.");
  if (pm) lines.push(`Run '${pm} run typecheck' or the project's check script before committing.`);
  if (environment.framework === "svelte") lines.push("Framework: Svelte/SvelteKit. Use svelte-check for Svelte diagnostics."); else if (environment.framework === "next") lines.push("Framework: Next.js.");
  if (environment.python) lines.push("Python project detected. Use ruff when configured.");
  lines.push("Git workflow: use conventional commit subjects: type(scope): description.", "Code quality: fix type and lint issues rather than suppressing them.", "Safety: dangerous destructive commands are blocked by policy."); return lines;
}
export function readCompactInstructions(sourcePaths: readonly string[], maxBytes = 65_536): string {
  if (sourcePaths.length > 32 || maxBytes < 1 || maxBytes > 1_048_576) return "";
  for (const source of sourcePaths) { let fd: number | undefined; try { fd = openSync(source, "r"); const stat = fstatSync(fd); if (!stat.isFile() || stat.size > maxBytes) continue; const text = readFileSync(fd, "utf8").trim(); if (text) return text; } catch { /* compaction must fail open */ } finally { if (fd !== undefined) closeSync(fd); } }
  return "";
}
