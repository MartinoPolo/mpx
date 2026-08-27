export * from "./lifecycle.js";
export * from "./node-lifecycle-adapters.js";
export * from "./worktree-include.js";
export * from "./node-worktree-include-adapters.js";
export * from "./preparation-engine.js";
export * from "./node-preparation-adapters.js";
export * from "./trusted-executable.js";

/** Provider-neutral workspace policy used by parallel conversation branches. */
export function resolveConversationWorkspaceSelection(input: {
  readonly selection: "default" | "isolated" | "shared";
  readonly intent: "read" | "modify";
  readonly riskAcknowledged: boolean;
}): { readonly selection: "isolated" | "shared"; readonly sharing: "isolated" | "shared"; readonly provision: "new-worktree" | "current-checkout" } {
  const selection = input.selection === "default"
    ? (input.intent === "modify" ? "isolated" : "shared")
    : input.selection;
  if (selection === "shared" && input.intent === "modify" && !input.riskAcknowledged) {
    throw new MpxError({
      code: "SESSION_BRANCH_SHARED_RISK_UNACKNOWLEDGED",
      message: "A modifying parallel session may share the current checkout only after explicit risk acknowledgement.",
      retryable: false,
    });
  }
  return selection === "isolated"
    ? { selection, sharing: "isolated", provision: "new-worktree" }
    : { selection, sharing: "shared", provision: "current-checkout" };
}

import path from "node:path";
import { assertValid, parseStrictJson, validateProject, type ProjectConfig } from "@mpx/config";
import { isPathWithinRoot, MpxError } from "@mpx/core";

/** Executes Git directly with an argv vector. Implementations must not invoke a shell. */
export interface GitAdapter {
  run(args: readonly string[], cwd: string): Promise<Buffer>;
}

/** The filesystem boundary used by worktree discovery and user-local state. */
export interface FileSystemAdapter {
  realpath(value: string): Promise<string>;
  readText(file: string): Promise<string>;
  writeText(file: string, content: string): Promise<void>;
  mkdir(directory: string): Promise<void>;
  exists(value: string): Promise<boolean>;
}

export interface RepositoryContext {
  /** Canonical checkout from which the caller invoked the operation. */
  currentRoot?: string;
  mainRoot: string;
  commonGitDirectory: string;
  configPath: string;
  config: ProjectConfig;
}

function worktreeError(code: string, message: string): MpxError {
  return new MpxError({ code, message, retryable: false });
}

/** Resolves every checkout through Git's common directory and requires project config at the main root. */
export async function resolveRepository(
  cwd: string,
  dependencies: { git: GitAdapter; fs: FileSystemAdapter },
): Promise<RepositoryContext> {
  let commonOutput: Buffer;
  try {
    commonOutput = await dependencies.git.run(["rev-parse", "--git-common-dir"], cwd);
  } catch {
    throw worktreeError("WORKTREE_NOT_GIT_REPOSITORY", "The current directory is not in a Git repository.");
  }
  const reported = commonOutput.toString("utf8").replace(/[\0\r\n]+$/u, "");
  if (reported.length === 0) throw worktreeError("WORKTREE_COMMON_DIR_INVALID", "Git returned an empty common directory.");
  const commonCandidate = path.isAbsolute(reported) ? reported : path.resolve(cwd, reported);
  let commonGitDirectory: string;
  try {
    commonGitDirectory = await dependencies.fs.realpath(commonCandidate);
  } catch {
    throw worktreeError("WORKTREE_COMMON_DIR_INVALID", "The Git common directory could not be resolved.");
  }
  if (path.basename(commonGitDirectory).toLowerCase() !== ".git") {
    throw worktreeError("WORKTREE_COMMON_DIR_INVALID", "The Git common directory does not identify a main checkout.");
  }
  const mainRoot = await dependencies.fs.realpath(path.dirname(commonGitDirectory));
  const configPath = path.join(mainRoot, "mpxconfig.json");
  let config: ProjectConfig;
  try {
    const parsed = parseStrictJson(await dependencies.fs.readText(configPath));
    assertValid(validateProject, parsed);
    config = parsed as unknown as ProjectConfig;
  } catch {
    throw worktreeError("WORKTREE_PROJECT_CONFIG_INVALID", "A valid mpxconfig.json is required at the canonical main checkout root.");
  }
  let currentRoot: string | undefined;
  try {
    const topReported = (await dependencies.git.run(["rev-parse", "--show-toplevel"], cwd)).toString("utf8").replace(/[\0\r\n]+$/u, "");
    if (topReported.length > 0) {
      const topCandidate = path.isAbsolute(topReported) ? topReported : path.resolve(cwd, topReported);
      const canonicalTop = await dependencies.fs.realpath(topCandidate);
      if (canonicalTop !== commonGitDirectory) currentRoot = canonicalTop;
    }
  } catch { /* Fall back for injected discovery adapters that only implement common-dir lookup. */ }
  if (currentRoot === undefined) {
    try { currentRoot = await dependencies.fs.realpath(cwd); } catch { /* Some injected discovery fixtures do not materialize their caller path. */ }
  }
  return { ...(currentRoot === undefined ? {} : { currentRoot }), mainRoot, commonGitDirectory, configPath, config };
}

export interface DeriveWorktreePathOptions {
  platform?: NodeJS.Platform;
  occupiedPaths?: readonly string[];
}

function assertSafeBranch(branch: string, implementation: typeof path.posix | typeof path.win32): string[] {
  if (branch.length === 0 || branch.trim() !== branch || path.posix.isAbsolute(branch) || path.win32.isAbsolute(branch) || branch.includes("\\")) {
    throw worktreeError("WORKTREE_BRANCH_INVALID", "Branch name must be a non-empty relative slash-separated path.");
  }
  const segments = branch.split("/");
  const invalid = segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." ||
    /[\u0000-\u0020\u007f~^:?*[\]]/u.test(segment) || segment.includes("..") || segment.endsWith(".") || segment.endsWith(".lock") || segment.startsWith("-") || segment.includes("@{"));
  if (invalid || branch === "@" || implementation.isAbsolute(branch)) {
    throw worktreeError("WORKTREE_BRANCH_INVALID", "Branch name contains an unsafe path or Git ref component.");
  }
  return segments;
}

/** Derives only paths under the repository's dedicated sibling worktree root. */
export function deriveWorktreePath(mainRoot: string, branch: string, options: DeriveWorktreePathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const implementation = platform === "win32" ? path.win32 : path.posix;
  const normalizedMain = implementation.resolve(mainRoot);
  const repositoryName = implementation.basename(normalizedMain);
  if (repositoryName.length === 0) throw worktreeError("WORKTREE_MAIN_ROOT_INVALID", "The main checkout root has no repository name.");
  const root = implementation.join(implementation.dirname(normalizedMain), `${repositoryName}.worktrees`);
  const result = implementation.join(root, ...assertSafeBranch(branch, implementation));
  if (!isPathWithinRoot(result, root, { platform })) throw worktreeError("WORKTREE_PATH_ESCAPE", "Derived worktree path escapes its repository root.");
  const canonicalComparison = (value: string) => platform === "win32" ? implementation.resolve(value).toLowerCase() : implementation.resolve(value);
  if (options.occupiedPaths?.some((entry) => canonicalComparison(entry) === canonicalComparison(result))) {
    throw worktreeError("WORKTREE_PATH_CONFLICT", "The derived worktree path is already in use.");
  }
  return result;
}

export interface ResolveBaseBranchOptions {
  explicit?: string;
  configured?: string;
  discoverRemoteHead: () => Promise<string | undefined>;
}

function usableBase(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Resolves base precedence without a conventional-branch fallback. */
export async function resolveBaseBranch(options: ResolveBaseBranchOptions): Promise<string> {
  const explicit = usableBase(options.explicit);
  if (explicit) return explicit;
  const configured = usableBase(options.configured);
  if (configured) return configured;
  const discovered = usableBase(await options.discoverRemoteHead());
  if (discovered) return discovered;
  throw worktreeError("WORKTREE_BASE_UNRESOLVED", "No base branch was supplied, configured, or discoverable from remote HEAD.");
}

/** Discovers a remote's default branch with direct Git argv execution. */
export async function discoverRemoteHead(git: GitAdapter, cwd: string, remote: string): Promise<string | undefined> {
  if (!remote || /[\u0000\r\n]/u.test(remote)) throw worktreeError("WORKTREE_REMOTE_INVALID", "Remote name is invalid.");
  try {
    const reference = (await git.run(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`], cwd)).toString("utf8").trim();
    const prefix = `refs/remotes/${remote}/`;
    return reference.startsWith(prefix) && reference.length > prefix.length ? reference.slice(prefix.length) : undefined;
  } catch {
    return undefined;
  }
}

export interface BranchTemplateTokens {
  author?: string;
  issue?: string;
  slug?: string;
}

function slugify(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}

/** Extracts a provider-neutral issue token from branch path components, left to right. */
export function extractBranchIssue(branch: string): string | undefined {
  for (const component of branch.split("/")) {
    const keyed = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]*-[0-9]+)(?=$|[^A-Za-z0-9])/u.exec(component)?.[1];
    if (keyed) return keyed.toUpperCase();
    const numeric = /(?:^|[^0-9])([0-9]+)(?=$|[^0-9])/u.exec(component)?.[1];
    if (numeric) return numeric;
  }
  return undefined;
}

/** Expands the constrained branch template; missing and unknown tokens are errors. */
export function expandBranchTemplate(template: string, tokens: BranchTemplateTokens): string {
  if (template.length === 0) throw worktreeError("WORKTREE_TEMPLATE_INVALID", "Branch template is empty.");
  const supplied: Record<keyof BranchTemplateTokens, string | undefined> = {
    author: tokens.author === undefined ? undefined : slugify(tokens.author),
    issue: tokens.issue,
    slug: tokens.slug === undefined ? undefined : slugify(tokens.slug),
  };
  const output = template.replace(/\{([^{}]+)\}/gu, (_match, token: string) => {
    if (token !== "author" && token !== "issue" && token !== "slug") {
      throw worktreeError("WORKTREE_TEMPLATE_TOKEN_UNKNOWN", `Unknown branch template token: ${token}.`);
    }
    const value = supplied[token];
    if (!value) throw worktreeError("WORKTREE_TEMPLATE_TOKEN_MISSING", `Branch template token ${token} was not supplied.`);
    return value;
  });
  if (/[{}]/u.test(output)) throw worktreeError("WORKTREE_TEMPLATE_INVALID", "Branch template contains malformed tokens.");
  return output;
}

/** Obtains the inventory using Git's NUL-delimited machine format. */
export async function listWorktrees(git: GitAdapter, cwd: string): Promise<WorktreeInventoryEntry[]> {
  return parseWorktreePorcelainZ(await git.run(["worktree", "list", "--porcelain", "-z"], cwd));
}

export interface WorktreeInventoryEntry {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  locked: boolean | string;
  prunable: boolean | string;
}

/** Parses `git worktree list --porcelain -z` records without whitespace tokenization. */
export function parseWorktreePorcelainZ(output: Buffer | string): WorktreeInventoryEntry[] {
  const fields = (typeof output === "string" ? output : output.toString("utf8")).split("\0");
  const result: WorktreeInventoryEntry[] = [];
  let current: WorktreeInventoryEntry | undefined;
  const publish = () => { if (current) result.push(current); current = undefined; };
  for (const field of fields) {
    if (field === "") { publish(); continue; }
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? "" : field.slice(separator + 1);
    if (key === "worktree") {
      publish();
      current = { path: value, detached: false, locked: false, prunable: false };
    } else if (current) {
      if (key === "HEAD") current.head = value;
      else if (key === "branch") current.branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
      else if (key === "detached") current.detached = true;
      else if (key === "locked") current.locked = value || true;
      else if (key === "prunable") current.prunable = value || true;
    }
  }
  publish();
  return result;
}

export interface RepositoryLock {
  acquire(repositoryKey: string): Promise<() => Promise<void>>;
}

/** Serializes a lifecycle critical section through a repository-scoped injected lock. */
export async function withRepositoryLock<T>(lock: RepositoryLock, repositoryKey: string, operation: () => Promise<T>): Promise<T> {
  const release = await lock.acquire(repositoryKey);
  try { return await operation(); }
  finally { await release(); }
}

export interface WorktreeMruStore {
  get(repository: string): Promise<string | undefined>;
  set(repository: string, worktreePath: string): Promise<void>;
}

interface MruDocument {
  schemaVersion: 1;
  owner: "mpx";
  repositories: Record<string, string>;
}

function isMruDocument(value: unknown): value is MruDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<MruDocument>;
  return candidate.schemaVersion === 1 && candidate.owner === "mpx" && typeof candidate.repositories === "object" && candidate.repositories !== null && !Array.isArray(candidate.repositories) &&
    Object.values(candidate.repositories).every((entry) => typeof entry === "string");
}

/** Persists only the versioned MPX-owned MRU document at a caller-selected user-local path. */
export class FileMruStore implements WorktreeMruStore {
  constructor(private readonly stateFile: string, private readonly fs: FileSystemAdapter) {}

  async get(repository: string): Promise<string | undefined> {
    return (await this.read()).repositories[repository];
  }

  async set(repository: string, worktreePath: string): Promise<void> {
    const document = await this.read();
    document.repositories[repository] = worktreePath;
    await this.fs.mkdir(path.dirname(this.stateFile));
    await this.fs.writeText(this.stateFile, `${JSON.stringify(document)}\n`);
  }

  private async read(): Promise<MruDocument> {
    if (!await this.fs.exists(this.stateFile)) return { schemaVersion: 1, owner: "mpx", repositories: {} };
    let parsed: unknown;
    try { parsed = parseStrictJson(await this.fs.readText(this.stateFile)); }
    catch { throw worktreeError("WORKTREE_MRU_INVALID", "The MPX worktree MRU store is invalid."); }
    if (!isMruDocument(parsed)) throw worktreeError("WORKTREE_MRU_INVALID", "The worktree MRU store is not an MPX-owned document.");
    return parsed;
  }
}

export interface SelectWorktreeOptions {
  repository: string;
  path?: string;
  inventory: readonly WorktreeInventoryEntry[];
  store: WorktreeMruStore;
  platform?: NodeJS.Platform;
}

/** Selects only an explicitly supplied path; MRU is recorded but never used as an implicit selector. */
export async function selectWorktree(options: SelectWorktreeOptions): Promise<WorktreeInventoryEntry> {
  if (!options.path) throw worktreeError("WORKTREE_PATH_REQUIRED", "Worktree selection requires an explicit path.");
  const platform = options.platform ?? process.platform;
  const normalize = (value: string) => {
    const implementation = platform === "win32" ? path.win32 : path.posix;
    const resolved = implementation.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const selected = options.inventory.find((entry) => normalize(entry.path) === normalize(options.path!));
  if (!selected) throw worktreeError("WORKTREE_PATH_NOT_FOUND", "The selected path is not in the Git worktree inventory.");
  await options.store.set(options.repository, selected.path);
  return selected;
}
