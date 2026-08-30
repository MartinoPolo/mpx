import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { MpxError } from "@mpx/core";
import { canonicalJson, installerDigest, type InstallIntentV1 } from "./immutable-core.js";

const fail = (code: string, message: string): never => { throw new MpxError({ code, message }); };
const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const safeName = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
const safeText = (value: string): boolean => value.length > 0 && !/[\0\r\n]/u.test(value);

export type ExternalAction = "auth-login" | "repo-rename" | "export-import" | "git-remotes" | "obsidian-files" | "raycast-audit";
export type ActionClassification = "confirmation-required" | "manual-only";
export function classifyExternalAction(action: ExternalAction): ActionClassification {
  return action === "auth-login" || action === "repo-rename" || action === "export-import" ? "manual-only" : "confirmation-required";
}

export interface ExternalIntegrationAdapter<Request, Inspection, Plan, Verification> {
  inspect(request: Request): Promise<Inspection>;
  plan(inspection: Inspection): Promise<Plan>;
  verify(plan: Plan): Promise<Verification>;
}
export interface Confirmation { readonly required: true; readonly scope: string; readonly digest: string }
export interface FileSnapshot { readonly path: string; readonly encoding: "base64"; readonly bytes: string; readonly sha256: string | null }
export interface RollbackGuidance { readonly automatic: false; readonly snapshot: FileSnapshot; readonly steps: readonly string[] }

async function assertContainedRegular(rootValue: string, candidateValue: string, kind: "file" | "directory"): Promise<string> {
  const root = await realpath(rootValue).catch(() => fail("EXTERNAL_ROOT_INVALID", "Approved root is unavailable."));
  const lexicalRelative = path.relative(root, path.resolve(candidateValue));
  if (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) fail("EXTERNAL_PATH_ESCAPE", "Reviewed path escapes its approved root.");
  const candidate = await realpath(candidateValue).catch(() => fail("EXTERNAL_PATH_INVALID", "Reviewed path is unavailable."));
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail("EXTERNAL_PATH_ESCAPE", "Reviewed path escapes its approved root.");
  let cursor = root;
  for (const part of lexicalRelative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const entry = await lstat(cursor).catch(() => fail("EXTERNAL_PATH_INVALID", "Reviewed path is unavailable."));
    if (entry.isSymbolicLink()) fail("EXTERNAL_PATH_UNSAFE", "Reviewed paths must not contain symbolic links.");
  }
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || (kind === "file" ? !info.isFile() : !info.isDirectory())) fail("EXTERNAL_PATH_UNSAFE", "Reviewed path is not a regular owned resource.");
  return candidate;
}

export type GitRemoteProposal =
  | { readonly action: "add" | "set-url"; readonly remote: string; readonly url: string }
  | { readonly action: "rename"; readonly remote: string; readonly newName: string };
export interface GitRemoteRequest { readonly repository: string; readonly proposals: readonly GitRemoteProposal[] }
export interface GitRemoteInspection { readonly repository: string; readonly proposals: readonly GitRemoteProposal[]; readonly remotes: readonly string[]; readonly config: FileSnapshot }
export interface GitCommandPort { run(cwd: string, argv: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> }
export interface GitRemotePlan {
  readonly kind: "git-remotes"; readonly classification: "confirmation-required"; readonly repository: string;
  readonly commands: readonly { executable: "git"; cwd: string; argv: readonly string[] }[];
  readonly preservedRemotes: readonly string[]; readonly expectedRemotes: readonly { remote: string; url: string; direction: "fetch" | "push" }[]; readonly confirmation: Confirmation; readonly rollback: RollbackGuidance;
}
function normalizedRemoteLines(stdout: string): { remote: string; url: string; direction: "fetch" | "push" }[] {
  const lines: { remote: string; url: string; direction: "fetch" | "push" }[] = [];
  for (const line of stdout.split(/\r?\n/u).filter(Boolean)) { const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/u.exec(line.trim()); if (match && safeName(match[1]!)) lines.push({ remote: match[1]!, url: match[2]!, direction: match[3]! as "fetch" | "push" }); }
  return lines.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}
export class GitRemotePlanningAdapter implements ExternalIntegrationAdapter<GitRemoteRequest, GitRemoteInspection, GitRemotePlan, { healthy: boolean; issues: readonly string[] }> {
  constructor(private readonly options: { readonly allowedRoots: readonly string[]; readonly git: GitCommandPort }) {}
  async inspect(request: GitRemoteRequest): Promise<GitRemoteInspection> {
    if (!path.isAbsolute(request.repository) || request.proposals.length === 0) fail("GIT_REPOSITORY_INVALID", "Repository and proposals are required.");
    const roots = await Promise.all(this.options.allowedRoots.map(root => realpath(root).catch(() => "")));
    const requestedInfo = await lstat(request.repository).catch(() => fail("GIT_REPOSITORY_INVALID", "Repository is unavailable."));
    if (requestedInfo.isSymbolicLink()) fail("EXTERNAL_PATH_UNSAFE", "Repository must not be a symbolic link.");
    const repository = await realpath(request.repository).catch(() => fail("GIT_REPOSITORY_INVALID", "Repository is unavailable."));
    if (!roots.some(root => root && !path.relative(root, repository).startsWith("..") && !path.isAbsolute(path.relative(root, repository)))) fail("EXTERNAL_PATH_ESCAPE", "Repository is outside approved roots.");
    await assertContainedRegular(repository, repository, "directory");
    const configPath = await assertContainedRegular(repository, path.join(repository, ".git", "config"), "file");
    for (const proposal of request.proposals) {
      if (!safeName(proposal.remote) || (proposal.action === "rename" ? !safeName(proposal.newName) : !safeText(proposal.url))) fail("GIT_PROPOSAL_INVALID", "Remote proposal contains unsafe data.");
    }
    const result = await this.options.git.run(repository, ["remote", "-v"]);
    if (result.exitCode !== 0) fail("GIT_INSPECTION_FAILED", "git remote inspection failed.");
    const remotes = [...new Set(normalizedRemoteLines(result.stdout).map(item => item.remote))].sort();
    const bytes = await readFile(configPath);
    return { repository, proposals: request.proposals, remotes, config: { path: configPath, encoding: "base64", bytes: bytes.toString("base64"), sha256: digest(bytes) } };
  }
  async plan(inspection: GitRemoteInspection): Promise<GitRemotePlan> {
    const commands = [...inspection.proposals].map(proposal => ({ executable: "git" as const, cwd: inspection.repository, argv: proposal.action === "rename" ? ["remote", "rename", proposal.remote, proposal.newName] : ["remote", proposal.action, proposal.remote, proposal.url] })).sort((a, b) => a.argv.join("\0").localeCompare(b.argv.join("\0")));
    const confirmationDigest = installerDigest({ repository: inspection.repository, config: inspection.config.sha256, commands });
    const initial = Buffer.from(inspection.config.bytes, "base64").toString("utf8");
    const configured = [...initial.matchAll(/\[remote "([^"]+)"\]\s*\n\s*url = ([^\r\n]+)/gu)].flatMap(match => [{ remote: match[1]!, url: match[2]!, direction: "fetch" as const }, { remote: match[1]!, url: match[2]!, direction: "push" as const }]);
    for (const proposal of inspection.proposals) {
      if (proposal.action === "rename") { for (const item of configured) if (item.remote === proposal.remote) item.remote = proposal.newName; continue; }
      const existing = configured.filter(item => item.remote === proposal.remote);
      if (proposal.action === "add" && existing.length === 0) configured.push({ remote: proposal.remote, url: proposal.url, direction: "fetch" }, { remote: proposal.remote, url: proposal.url, direction: "push" });
      else for (const item of existing) item.url = proposal.url;
    }
    const expectedRemotes = configured.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
    return { kind: "git-remotes", classification: "confirmation-required", repository: inspection.repository, commands, preservedRemotes: inspection.remotes, expectedRemotes, confirmation: { required: true, scope: inspection.repository, digest: confirmationDigest }, rollback: { automatic: false, snapshot: inspection.config, steps: ["Do not delete any pre-existing remote.", "Restore .git/config from the byte snapshot after confirming repository scope.", "Run git remote -v in this repository and compare with the reviewed plan."] } };
  }
  async verify(plan: GitRemotePlan): Promise<{ healthy: boolean; issues: readonly string[] }> {
    const roots = await Promise.all(this.options.allowedRoots.map(root => realpath(root).catch(() => "")));
    const requestedInfo = await lstat(plan.repository).catch(() => fail("GIT_REPOSITORY_INVALID", "Repository is unavailable."));
    if (requestedInfo.isSymbolicLink()) fail("EXTERNAL_PATH_UNSAFE", "Repository must not be a symbolic link.");
    const repository = await realpath(plan.repository).catch(() => fail("GIT_REPOSITORY_INVALID", "Repository is unavailable."));
    if (!roots.some(root => root && !path.relative(root, repository).startsWith("..") && !path.isAbsolute(path.relative(root, repository)))) fail("EXTERNAL_PATH_ESCAPE", "Repository is outside approved roots.");
    await assertContainedRegular(repository, repository, "directory");
    await assertContainedRegular(repository, path.join(repository, ".git", "config"), "file");
    const result = await this.options.git.run(repository, ["remote", "-v"]); if (result.exitCode !== 0) return { healthy: false, issues: ["git-remote-inspection-failed"] }; const healthy = canonicalJson(normalizedRemoteLines(result.stdout)) === canonicalJson(plan.expectedRemotes); return { healthy, issues: healthy ? [] : ["git-remote-drift"] };
  }
}

export type ObsidianChange =
  | { readonly action: "write"; readonly path: string; readonly content: string; readonly purpose: "backlinks" | "query" | "css" }
  | { readonly action: "rename"; readonly path: string; readonly destination: string };
export interface ObsidianRequest { readonly reviewedFiles: readonly string[]; readonly changes: readonly ObsidianChange[] }
export interface ObsidianInspection { readonly vault: string; readonly subtree: string; readonly reviewedFiles: readonly string[]; readonly changes: readonly ObsidianChange[]; readonly snapshots: readonly FileSnapshot[] }
export interface ObsidianPlan { readonly kind: "obsidian"; readonly classification: "confirmation-required"; readonly subtree: string; readonly reviewedFiles: readonly string[]; readonly expectedFiles: readonly { path: string; sha256: string | null }[]; readonly operations: readonly ObsidianChange[]; readonly confirmation: Confirmation; readonly rollback: { automatic: false; readonly snapshots: readonly FileSnapshot[]; readonly steps: readonly string[] } }
function safeRelative(value: string): boolean { const normalized = path.posix.normalize(value); return Boolean(value) && !value.includes("\\") && !value.includes("\0") && normalized === value && normalized !== ".." && !normalized.startsWith("../") && !path.posix.isAbsolute(value); }
export class ObsidianPlanningAdapter implements ExternalIntegrationAdapter<ObsidianRequest, ObsidianInspection, ObsidianPlan, { healthy: boolean; issues: readonly string[] }> {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}
  async inspect(request: ObsidianRequest): Promise<ObsidianInspection> {
    const vaultValue = this.environment.MPX_OBSIDIAN_VAULT ?? fail("OBSIDIAN_VAULT_UNAVAILABLE", "MPX_OBSIDIAN_VAULT is required.");
    if (!path.isAbsolute(vaultValue)) fail("OBSIDIAN_VAULT_UNAVAILABLE", "MPX_OBSIDIAN_VAULT must be absolute.");
    const vault = await realpath(vaultValue).catch(() => fail("OBSIDIAN_VAULT_UNAVAILABLE", "Obsidian vault is unavailable."));
    const subtree = await assertContainedRegular(vault, path.join(vault, "MPX"), "directory");
    const reviewedFiles = [...request.reviewedFiles]; if (new Set(reviewedFiles).size !== reviewedFiles.length || reviewedFiles.some(file => !safeRelative(file))) fail("OBSIDIAN_REVIEW_INVALID", "Reviewed file list must be unique safe relative paths.");
    const permitted = new Set(reviewedFiles); const touched = request.changes.flatMap(change => change.action === "rename" ? [change.path, change.destination] : [change.path]);
    if (touched.some(file => !permitted.has(file))) fail("OBSIDIAN_UNREVIEWED_FILE", "Every touched file must appear in the exact reviewed file list.");
    const snapshots: FileSnapshot[] = [];
    for (const relative of reviewedFiles) {
      const candidate = path.join(subtree, ...relative.split("/"));
      try { const file = await assertContainedRegular(subtree, candidate, "file"), bytes = await readFile(file); snapshots.push({ path: relative, encoding: "base64", bytes: bytes.toString("base64"), sha256: digest(bytes) }); }
      catch (failure) { if ((failure as { code?: string }).code !== "EXTERNAL_PATH_INVALID") throw failure; snapshots.push({ path: relative, encoding: "base64", bytes: "", sha256: null }); }
    }
    return { vault, subtree, reviewedFiles, changes: request.changes, snapshots };
  }
  async plan(inspection: ObsidianInspection): Promise<ObsidianPlan> {
    const operations = [...inspection.changes].sort((a, b) => a.path.localeCompare(b.path));
    const contents = new Map(inspection.snapshots.map(snapshot => [snapshot.path, snapshot.sha256 === null ? null : Buffer.from(snapshot.bytes, "base64")] as const));
    for (const operation of operations) { if (operation.action === "write") contents.set(operation.path, Buffer.from(operation.content)); else { const body = contents.get(operation.path) ?? null; contents.set(operation.path, null); contents.set(operation.destination, body); } }
    const expectedFiles = inspection.reviewedFiles.map(file => { const body = contents.get(file) ?? null; return { path: file, sha256: body === null ? null : digest(body) }; });
    return { kind: "obsidian", classification: "confirmation-required", subtree: inspection.subtree, reviewedFiles: inspection.reviewedFiles, expectedFiles, operations, confirmation: { required: true, scope: inspection.subtree, digest: installerDigest({ snapshots: inspection.snapshots, operations }) }, rollback: { automatic: false, snapshots: inspection.snapshots, steps: ["Apply all reviewed writes and renames as one atomic batch.", "On any failure restore every reviewed path from its byte snapshot and remove paths whose snapshot is absent.", "Re-open only the reviewed files to verify backlinks, queries, CSS and rename targets."] } };
  }
  async verify(plan: ObsidianPlan): Promise<{ healthy: boolean; issues: readonly string[] }> {
    const vaultValue = this.environment.MPX_OBSIDIAN_VAULT ?? fail("OBSIDIAN_VAULT_UNAVAILABLE", "MPX_OBSIDIAN_VAULT is required.");
    if (!path.isAbsolute(vaultValue)) fail("OBSIDIAN_VAULT_UNAVAILABLE", "MPX_OBSIDIAN_VAULT must be absolute.");
    const vault = await realpath(vaultValue).catch(() => fail("OBSIDIAN_VAULT_UNAVAILABLE", "Obsidian vault is unavailable."));
    const subtree = await assertContainedRegular(vault, path.join(vault, "MPX"), "directory");
    if (path.resolve(plan.subtree) !== subtree) fail("EXTERNAL_PATH_ESCAPE", "Obsidian plan subtree is not the configured canonical MPX subtree.");
    const issues: string[] = [];
    for (const expected of plan.expectedFiles) { const candidate = path.join(subtree, ...expected.path.split("/")); let actual: string | null = null; try { const file = await assertContainedRegular(subtree, candidate, "file"); actual = digest(await readFile(file)); } catch (failure) { if ((failure as { code?: string }).code !== "EXTERNAL_PATH_INVALID") throw failure; } if (actual !== expected.sha256) issues.push(`obsidian-file-drift:${expected.path}`); }
    return { healthy: issues.length === 0, issues };
  }
}

export interface RaycastDerivative { readonly encrypted: true; readonly items: readonly { readonly id: string; readonly category: string; readonly command: string }[] }
export interface RaycastInspection { readonly derivativeDigest: string; readonly encrypted: true; readonly items: RaycastDerivative["items"] }
export interface RaycastPlan { readonly kind: "raycast"; readonly classification: "manual-only"; readonly automaticImport: false; readonly encrypted: true; readonly items: RaycastDerivative["items"]; readonly instructions: readonly string[]; readonly confirmation: Confirmation; readonly rollback: { automatic: false; readonly steps: readonly string[] } }
export class RaycastPlanningAdapter implements ExternalIntegrationAdapter<RaycastDerivative, RaycastInspection, RaycastPlan, { healthy: boolean; issues: readonly string[] }> {
  async inspect(value: RaycastDerivative): Promise<RaycastInspection> {
    if (!value || value.encrypted !== true || !Array.isArray(value.items) || Object.keys(value).sort().join() !== "encrypted,items") fail("RAYCAST_DERIVATIVE_INVALID", "Only an encrypted user-supplied derivative may be audited.");
    const items = value.items.map(item => {
      if (!item || Object.keys(item).sort().join() !== "category,command,id" || !safeText(item.id) || !safeText(item.category) || !safeText(item.command)) fail("RAYCAST_DERIVATIVE_INVALID", "Derivative item is invalid or contains unrelated fields.");
      return { id: item.id, category: item.category, command: item.command };
    });
    if (new Set(items.map(item => item.id)).size !== items.length) fail("RAYCAST_DERIVATIVE_INVALID", "Raycast IDs must be unique.");
    return { derivativeDigest: installerDigest({ encrypted: true, items }), encrypted: true, items };
  }
  async plan(inspection: RaycastInspection): Promise<RaycastPlan> {
    return { kind: "raycast", classification: "manual-only", automaticImport: false, encrypted: true, items: inspection.items, instructions: ["Review IDs and categories in this encrypted derivative.", "Import manually in Raycast; MPX never invokes import.", "Create a fresh encrypted post-export derivative and run verification."], confirmation: { required: true, scope: "user-supplied-raycast-derivative", digest: inspection.derivativeDigest }, rollback: { automatic: false, steps: ["Use Raycast's manual restore/export workflow.", "Do not provide credentials or unrelated private settings to MPX."] } };
  }
  async verify(plan: RaycastPlan, postExport?: RaycastDerivative): Promise<{ healthy: boolean; issues: readonly string[] }> {
    if (!postExport) return { healthy: false, issues: ["post-export-required"] };
    let inspected: RaycastInspection; try { inspected = await this.inspect(postExport); } catch { return { healthy: false, issues: ["post-export-invalid"] }; }
    const expected = plan.items.map(item => ({ id: item.id, category: item.category }));
    const actual = inspected.items.map(item => ({ id: item.id, category: item.category }));
    const healthy = canonicalJson(actual) === canonicalJson(expected);
    return { healthy, issues: healthy ? [] : ["raycast-id-category-drift"] };
  }
}

export interface ExternalIntegrationIntentEntry { readonly id: string; readonly adapter: "git-remotes" | "obsidian" | "raycast"; readonly classification: ActionClassification }
export function validateExternalIntegrationIntent(intent: InstallIntentV1): void {
  const entries = intent.externalIntegrations ?? [];
  if (new Set(entries.map(entry => entry.id)).size !== entries.length || entries.some((entry, index) => !safeName(entry.id) || index > 0 && entries[index - 1]!.id.localeCompare(entry.id) >= 0)) fail("INSTALL_SCHEMA_INVALID", "External integration intents must be unique and sorted.");
}
