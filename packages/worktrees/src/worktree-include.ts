import path from "node:path";
import { createHash } from "node:crypto";
import { isPathWithinRoot, MpxError, type JsonValue } from "@mpx/core";

const MAX_INCLUDE_BYTES = 64 * 1024;
const MAX_MATCHES = 1_000;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

function includeError(code: string, message: string, details?: JsonValue): MpxError {
  return new MpxError(details === undefined
    ? { code, message, retryable: false }
    : { code, message, retryable: false, details });
}

/** Parses the repository-local include file as Git-ignore rules, rejecting path-bearing rules that could escape a checkout. */
export function parseWorktreeInclude(content: string): string[] {
  const patterns: string[] = [];
  for (const raw of content.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    if (raw.length === 0 || raw.startsWith("#")) continue;
    const pattern = raw.startsWith("!") ? raw.slice(1) : raw;
    const validationPattern = /^\\[!#]/u.test(pattern) ? pattern.slice(1) : pattern;
    const normalized = validationPattern.replace(/\\/gu, "/");
    const components = normalized.split("/");
    if (/[\0\r]/u.test(raw) || path.posix.isAbsolute(validationPattern) || path.win32.isAbsolute(validationPattern) || components.includes("..")) {
      throw includeError("WORKTREE_INCLUDE_PATTERN_UNSAFE", "The .worktreeinclude file contains an absolute or traversing pattern.");
    }
    patterns.push(raw);
  }
  return patterns;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface WorktreeIncludeGitAdapter {
  /** Executes Git directly with this argv vector. Shell invocation is forbidden. */
  run(args: readonly string[], cwd: string): Promise<Buffer>;
}

export interface WorktreeIncludeFileInfo {
  isFile: boolean;
  isSymbolicLink: boolean;
  /** True for any Windows reparse point, including links and junctions. */
  isReparsePoint?: boolean;
  size: number;
}

export interface WorktreeIncludeFileSystemAdapter {
  readFile(file: string): Promise<Buffer>;
  lstat(file: string): Promise<WorktreeIncludeFileInfo>;
  mkdir?(directory: string): Promise<void>;
  writeFileExclusive?(file: string, content: Buffer): Promise<void>;
  exists?(file: string): Promise<boolean>;
}

/** Canonicalizes existing roots/files and must resolve links, junctions, and reparse points. */
export interface WorktreeIncludeCanonicalizationAdapter {
  resolve(value: string): Promise<string>;
}

export interface WorktreeIncludeDependencies {
  git: WorktreeIncludeGitAdapter;
  fs: WorktreeIncludeFileSystemAdapter;
  canonical: WorktreeIncludeCanonicalizationAdapter;
}

export interface WorktreeIncludePlanInput {
  repositoryId: string;
  sourceRoot: string;
  mainRoot: string;
  destinationRoot: string;
}

export interface WorktreeIncludeMatch {
  path: string;
  from: "source" | "main";
  size: number;
  sha256: string;
}

export interface WorktreeIncludePlan {
  repositoryId: string;
  sourceRoot: string;
  mainRoot: string;
  destinationRoot: string;
  includeFileSha256: string;
  manifestSha256: string;
  approval: string;
  matches: readonly WorktreeIncludeMatch[];
  totalBytes: number;
}

function implementationFor(value: string): typeof path.posix | typeof path.win32 {
  return /^[A-Za-z]:[\\/]|^\\\\/u.test(value) ? path.win32 : path.posix;
}

function join(root: string, relative: string): string {
  return implementationFor(root).join(root, ...relative.split("/"));
}

function assertSafeGitPath(value: string): void {
  const normalized = value.replace(/\\/gu, "/");
  if (value.length === 0 || value.includes("\0") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || normalized.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw includeError("WORKTREE_INCLUDE_MATCH_UNSAFE", "Git returned an unsafe include path.");
  }
}

async function canonicalRoot(value: string, dependencies: WorktreeIncludeDependencies): Promise<string> {
  try { return await dependencies.canonical.resolve(value); }
  catch { throw includeError("WORKTREE_INCLUDE_ROOT_INVALID", "An include root could not be canonicalized."); }
}

function within(candidate: string, root: string): boolean {
  const platform = implementationFor(root) === path.win32 ? "win32" : "linux";
  return isPathWithinRoot(candidate, root, { platform });
}

function sameCanonicalPath(left: string, right: string): boolean {
  const implementation = implementationFor(right);
  const normalize = (value: string) => {
    const result = implementation.resolve(value);
    return implementation === path.win32 ? result.toLowerCase() : result;
  };
  return normalize(left) === normalize(right);
}

async function enumerate(root: string, includeFile: string, dependencies: WorktreeIncludeDependencies): Promise<string[]> {
  const output = await dependencies.git.run(["ls-files", "--others", "--ignored", `--exclude-from=${includeFile}`, "-z", "--"], root);
  if (output.length > MAX_GIT_OUTPUT_BYTES) throw includeError("WORKTREE_INCLUDE_RESULT_TOO_LARGE", "Git returned too much include metadata.");
  const values = output.toString("utf8").split("\0").filter(Boolean);
  if (values.length > MAX_MATCHES) throw includeError("WORKTREE_INCLUDE_RESULT_TOO_LARGE", "Too many files match .worktreeinclude.");
  for (const value of values) assertSafeGitPath(value);
  return values;
}

/** Produces a content-bound copy plan without returning file contents. */
export async function planWorktreeIncludes(input: WorktreeIncludePlanInput, dependencies: WorktreeIncludeDependencies): Promise<WorktreeIncludePlan> {
  const [sourceRoot, mainRoot, destinationRoot] = await Promise.all([
    canonicalRoot(input.sourceRoot, dependencies), canonicalRoot(input.mainRoot, dependencies), canonicalRoot(input.destinationRoot, dependencies),
  ]);
  const includeFile = join(mainRoot, ".worktreeinclude");
  const includeInfo = await dependencies.fs.lstat(includeFile);
  if (!includeInfo.isFile || includeInfo.isSymbolicLink || includeInfo.isReparsePoint) {
    throw includeError("WORKTREE_INCLUDE_LINK_REFUSED", "The .worktreeinclude file must be a regular file, not a link or reparse point.");
  }
  const canonicalIncludeFile = await dependencies.canonical.resolve(includeFile);
  if (!within(canonicalIncludeFile, mainRoot)) throw includeError("WORKTREE_INCLUDE_FILE_ESCAPE", "The .worktreeinclude file resolves outside the main checkout.");
  if (!sameCanonicalPath(canonicalIncludeFile, includeFile)) throw includeError("WORKTREE_INCLUDE_LINK_REFUSED", "The .worktreeinclude file resolves through a link or reparse point.");
  const content = await dependencies.fs.readFile(canonicalIncludeFile);
  if (content.length > MAX_INCLUDE_BYTES) throw includeError("WORKTREE_INCLUDE_FILE_TOO_LARGE", "The .worktreeinclude file is too large.");
  parseWorktreeInclude(content.toString("utf8"));

  const [sourceMatches, mainMatches] = await Promise.all([
    enumerate(sourceRoot, canonicalIncludeFile, dependencies), enumerate(mainRoot, canonicalIncludeFile, dependencies),
  ]);
  const selected = new Map<string, "source" | "main">();
  for (const relative of mainMatches) selected.set(relative, "main");
  for (const relative of sourceMatches) selected.set(relative, "source");

  const matches: WorktreeIncludeMatch[] = [];
  for (const [relative, from] of [...selected].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const allowedRoot = from === "source" ? sourceRoot : mainRoot;
    const candidate = join(allowedRoot, relative);
    const info = await dependencies.fs.lstat(candidate);
    if (!info.isFile || info.isSymbolicLink || info.isReparsePoint) throw includeError("WORKTREE_INCLUDE_LINK_REFUSED", "Include matches must be regular files, not links or reparse points.");
    const canonical = await dependencies.canonical.resolve(candidate);
    if (!within(canonical, allowedRoot)) throw includeError("WORKTREE_INCLUDE_SOURCE_ESCAPE", "An include match resolves outside its allowed checkout root.");
    if (!sameCanonicalPath(canonical, candidate)) throw includeError("WORKTREE_INCLUDE_LINK_REFUSED", "An include match resolves through a link or reparse point.");
    const bytes = await dependencies.fs.readFile(canonical);
    matches.push({ path: relative, from, size: bytes.length, sha256: sha256(bytes) });
  }
  const includeFileSha256 = sha256(content);
  const manifestSha256 = sha256(JSON.stringify(matches));
  const binding = sha256(JSON.stringify({ repositoryId: input.repositoryId, sourceRoot, mainRoot, destinationRoot, includeFileSha256, manifestSha256 }));
  return {
    repositoryId: input.repositoryId, sourceRoot, mainRoot, destinationRoot, includeFileSha256, manifestSha256,
    approval: `APPROVE WORKTREE INCLUDE COPY ${binding}`,
    matches,
    totalBytes: matches.reduce((sum, match) => sum + match.size, 0),
  };
}

export interface WorktreeIncludeCopyResult {
  copiedCount: number;
  totalBytes: number;
  manifestSha256: string;
}

function samePlan(left: WorktreeIncludePlan, right: WorktreeIncludePlan): boolean {
  return left.repositoryId === right.repositoryId && left.sourceRoot === right.sourceRoot && left.mainRoot === right.mainRoot &&
    left.destinationRoot === right.destinationRoot && left.includeFileSha256 === right.includeFileSha256 &&
    left.manifestSha256 === right.manifestSha256 && left.approval === right.approval;
}

/** Revalidates an approved plan and copies it without following links or overwriting tracked/existing destination files. */
export async function executeWorktreeIncludePlan(
  plan: WorktreeIncludePlan,
  exactHumanApproval: string,
  dependencies: WorktreeIncludeDependencies,
  allowExistingRecovery = false,
): Promise<WorktreeIncludeCopyResult> {
  if (!exactHumanApproval || exactHumanApproval !== plan.approval) {
    throw includeError("WORKTREE_INCLUDE_APPROVAL_REQUIRED", "Exact human approval for this secret-bearing copy plan is required.", { expectedApproval: plan.approval });
  }
  const fresh = await planWorktreeIncludes({
    repositoryId: plan.repositoryId,
    sourceRoot: plan.sourceRoot,
    mainRoot: plan.mainRoot,
    destinationRoot: plan.destinationRoot,
  }, dependencies);
  if (!samePlan(plan, fresh)) {
    throw includeError("WORKTREE_INCLUDE_APPROVAL_STALE", "The approved include plan is stale and must be reviewed again.", { expectedApproval: fresh.approval });
  }
  if (!dependencies.fs.mkdir || !dependencies.fs.writeFileExclusive || !dependencies.fs.exists) {
    throw includeError("WORKTREE_INCLUDE_ADAPTER_INCOMPLETE", "The filesystem adapter does not support safe copying.");
  }

  for (const match of fresh.matches) {
    const sourceRoot = match.from === "source" ? fresh.sourceRoot : fresh.mainRoot;
    const source = join(sourceRoot, match.path);
    const sourceInfo = await dependencies.fs.lstat(source);
    if (!sourceInfo.isFile || sourceInfo.isSymbolicLink || sourceInfo.isReparsePoint) {
      throw includeError("WORKTREE_INCLUDE_LINK_REFUSED", "An include source became a link or reparse point.");
    }
    const canonicalSource = await dependencies.canonical.resolve(source);
    if (!within(canonicalSource, sourceRoot)) throw includeError("WORKTREE_INCLUDE_SOURCE_ESCAPE", "An include source escaped its allowed checkout root.");
    if (!sameCanonicalPath(canonicalSource, source)) throw includeError("WORKTREE_INCLUDE_LINK_REFUSED", "An include source resolves through a link or reparse point.");
    const bytes = await dependencies.fs.readFile(canonicalSource);
    if (sha256(bytes) !== match.sha256) throw includeError("WORKTREE_INCLUDE_APPROVAL_STALE", "An include source changed after approval.");

    const destination = join(fresh.destinationRoot, match.path);
    const parent = implementationFor(destination).dirname(destination);
    await dependencies.fs.mkdir(parent);
    const canonicalParent = await dependencies.canonical.resolve(parent);
    if (!within(canonicalParent, fresh.destinationRoot)) throw includeError("WORKTREE_INCLUDE_DESTINATION_ESCAPE", "An include destination resolves outside the destination checkout.");
    if (!sameCanonicalPath(canonicalParent, parent)) throw includeError("WORKTREE_INCLUDE_LINK_REFUSED", "An include destination resolves through a link, junction, or reparse point.");
    const canonicalDestination = join(canonicalParent, implementationFor(destination).basename(destination));
    if (!within(canonicalDestination, fresh.destinationRoot)) throw includeError("WORKTREE_INCLUDE_DESTINATION_ESCAPE", "An include destination escapes the destination checkout.");

    const trackedOutput = await dependencies.git.run(["ls-files", "-z", "--", match.path], fresh.destinationRoot);
    if (trackedOutput.length > 0) throw includeError("WORKTREE_INCLUDE_TRACKED_DESTINATION", "A tracked destination file must never be overwritten.");
    if (await dependencies.fs.exists(canonicalDestination)) {
      if (!allowExistingRecovery) throw includeError("WORKTREE_INCLUDE_DESTINATION_MISMATCH", "An existing destination requires durable interrupted-copy recovery evidence.");
      const destinationInfo = await dependencies.fs.lstat(canonicalDestination);
      if (!destinationInfo.isFile || destinationInfo.isSymbolicLink || destinationInfo.isReparsePoint || destinationInfo.size !== match.size) {
        throw includeError("WORKTREE_INCLUDE_DESTINATION_MISMATCH", "An existing destination is not the exact approved regular file.");
      }
      const resolvedDestination = await dependencies.canonical.resolve(canonicalDestination);
      if (!within(resolvedDestination, fresh.destinationRoot) || !sameCanonicalPath(resolvedDestination, canonicalDestination)) {
        throw includeError("WORKTREE_INCLUDE_DESTINATION_MISMATCH", "An existing destination does not remain within the approved checkout.");
      }
      const existingBytes = await dependencies.fs.readFile(resolvedDestination);
      if (existingBytes.length !== match.size || sha256(existingBytes) !== match.sha256) {
        throw includeError("WORKTREE_INCLUDE_DESTINATION_MISMATCH", "An existing destination differs from the exact approved content.");
      }
      continue;
    }
    await dependencies.fs.writeFileExclusive(canonicalDestination, bytes);
  }
  return { copiedCount: fresh.matches.length, totalBytes: fresh.totalBytes, manifestSha256: fresh.manifestSha256 };
}
