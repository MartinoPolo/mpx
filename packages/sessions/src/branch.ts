import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveConversationWorkspaceSelection } from "@mpx/worktrees";
import type { NativeSessionRefV1, RuntimeName } from "@mpx/runtime-contracts";
import { SessionError, stableDigest, type IdentityV1 } from "./schemas.js";

export interface BranchNativeIdentityV1 {
  readonly runtimeQualifiedId: string;
  readonly nativeSessionRef: NativeSessionRefV1;
}
export interface BranchRequestV1 {
  readonly schemaVersion: 1;
  readonly parent: BranchNativeIdentityV1;
  readonly child: { readonly runtimeQualifiedId: string; readonly runtime: RuntimeName };
  readonly launchIdentity: {
    readonly identity: IdentityV1;
    readonly rootDigest: string;
    readonly nativeBindingRef: string;
    readonly mode: string;
    readonly executor: "host" | "docker";
    readonly skillPolicy: string;
    readonly contentScope: string;
    readonly workspace: string;
    readonly networkPolicy: string;
    readonly grants: readonly { readonly resource: string; readonly access: string }[];
    readonly artifactKey: string;
    readonly manifestKey: string;
    readonly launchKey: string;
    readonly descriptorDigest: string;
  };
  readonly workspace: {
    readonly selection: "default" | "isolated" | "shared";
    readonly intent: "read" | "modify";
    readonly cwd: string;
    readonly projectRef: string | null;
    readonly repositoryRef: string | null;
    readonly worktreeRef: string | null;
    readonly branch: string | null;
  };
  readonly files: {
    readonly sharing: "isolated" | "shared";
    readonly collisionDisclosure: readonly string[];
    readonly duplicateWriterRiskAcknowledged: boolean;
  };
  readonly terminal: TerminalTabRequest;
}
export interface NativeBranchInvocation {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly nativeTarget: "runtime-created";
}
export interface TerminalTabRequest {
  readonly enabled: boolean;
  readonly executable?: string;
  readonly cwd?: string;
  readonly title?: string;
}
export interface TerminalTabPlan {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
}
export interface ConversationBranchPlanV1 {
  readonly schemaVersion: 1;
  readonly kind: "session-branch-plan";
  readonly parent: BranchRequestV1["parent"];
  readonly child: BranchRequestV1["child"];
  readonly launchIdentity: BranchRequestV1["launchIdentity"];
  readonly workspace: BranchRequestV1["workspace"] & {
    readonly selection: "isolated" | "shared";
    readonly sharing: "isolated" | "shared";
    readonly provision: "new-worktree" | "current-checkout";
    readonly collisionDisclosure: readonly string[];
  };
  readonly files: BranchRequestV1["files"];
  readonly terminal: TerminalTabRequest;
  readonly confirmationDigest: string;
}
export interface BranchRuntimeAdapter {
  plan(parent: BranchNativeIdentityV1, cwd: string, selectedRoot?: string): NativeBranchInvocation | Promise<NativeBranchInvocation>;
}
export interface BranchLifecycleEvent {
  readonly runtimeQualifiedId: string;
  readonly nativeSessionRef: NativeSessionRefV1;
}
export interface BranchChildProcess {
  /** Resolves only from the runtime lifecycle event, never from a guessed native ID. */
  readonly lifecycle: Promise<BranchLifecycleEvent>;
  readonly exited: Promise<unknown>;
}
export interface BranchArgvExecutionAdapter { launch(invocation: NativeBranchInvocation | TerminalTabPlan, plan: ConversationBranchPlanV1): Promise<BranchChildProcess> }
export interface BranchLineagePendingV1 {
  readonly pendingRuntimeQualifiedId: string;
  readonly parentRuntimeQualifiedId: string;
  readonly identity: IdentityV1;
  readonly nativeBindingRef: string;
  readonly cwd: string;
  readonly worktreeRef: string | null;
  readonly sharing: "isolated" | "shared";
  readonly collisionDisclosure: readonly string[];
  readonly writerLease: { readonly owner: string; readonly workspaceDigest: string } | null;
}
export interface BranchLineagePersistence {
  savePending(value: BranchLineagePendingV1): Promise<void>;
  finalize(pendingRuntimeQualifiedId: string, event: BranchLifecycleEvent): Promise<void>;
  fail(pendingRuntimeQualifiedId: string): Promise<void>;
}
export interface ConversationBranchDependencies {
  inspectWorkspace(input: BranchRequestV1["workspace"]): Promise<{ readonly exists: boolean; readonly collisionDisclosure: readonly string[] }>;
  createIsolatedWorktree(input: ConversationBranchPlanV1["workspace"]): Promise<{ readonly cwd: string; readonly worktreeRef: string }>;
  removeIsolatedWorktree?(workspace: { readonly cwd: string; readonly worktreeRef: string | null }): Promise<void>;
  readonly adapters: Readonly<Record<RuntimeName, BranchRuntimeAdapter>>;
  /** Revalidates recorded binding, identity root digest, and auth before any side effect. */
  validateNativeBinding?(plan: ConversationBranchPlanV1): Promise<string | undefined>;
  readonly runtime?: BranchArgvExecutionAdapter;
  readonly terminal?: BranchArgvExecutionAdapter;
  readonly lineage?: BranchLineagePersistence;
  admitExecutor?(input: BranchRequestV1["launchIdentity"]): Promise<boolean>;
}

const control = /[\u0000-\u001f\u007f-\u009f]/u;
function safeText(value: string, label: string, maximum = 4096): void {
  if (!value || value.length > maximum || control.test(value) || value !== value.normalize("NFC"))
    throw new SessionError("SESSION_BRANCH_INVALID", `${label} is invalid`);
}
function absolute(value: string, label: string): string {
  safeText(value, label);
  if (!path.isAbsolute(value)) throw new SessionError("SESSION_BRANCH_INVALID", `${label} must be absolute`);
  return path.normalize(value).replaceAll("\\", "/");
}
function validateRequest(input: BranchRequestV1): void {
  if (input.schemaVersion !== 1 || !/^[a-f0-9]{64}$/u.test(input.launchIdentity.rootDigest))
    throw new SessionError("SESSION_BRANCH_INVALID", "branch schema or root digest is invalid");
  safeText(input.parent.runtimeQualifiedId, "parent.runtimeQualifiedId");
  safeText(input.child.runtimeQualifiedId, "child.runtimeQualifiedId");
  if (!input.parent.runtimeQualifiedId.startsWith(`${input.child.runtime}:`) || !input.child.runtimeQualifiedId.startsWith(`${input.child.runtime}:`))
    throw new SessionError("SESSION_BRANCH_RUNTIME_MISMATCH", "parent and child native IDs must be qualified by the selected runtime");
  absolute(input.workspace.cwd, "workspace.cwd");
}

export class ConversationBranchService {
  constructor(private readonly dependencies: ConversationBranchDependencies, private readonly leases?: BranchLeaseStore) {}

  async plan(input: BranchRequestV1): Promise<ConversationBranchPlanV1> {
    validateRequest(input);
    if (input.launchIdentity.executor === "docker" && (!this.dependencies.admitExecutor || !await this.dependencies.admitExecutor(input.launchIdentity)))
      throw new SessionError("SESSION_BRANCH_EXECUTOR_NOT_ADMITTED", "Docker branching requires current explicit runtime admission");
    const inspected = await this.dependencies.inspectWorkspace(input.workspace);
    if (!inspected.exists) throw new SessionError("SESSION_BRANCH_WORKSPACE_MISSING", "The selected repository or worktree is missing or deleted");
    const policy = resolveConversationWorkspaceSelection({ selection: input.workspace.selection, intent: input.workspace.intent, riskAcknowledged: input.files.duplicateWriterRiskAcknowledged });
    if (input.files.sharing !== policy.sharing && input.workspace.selection !== "default")
      throw new SessionError("SESSION_BRANCH_DISCLOSURE_MISMATCH", "File sharing disclosure differs from the selected workspace");
    const collisionDisclosure = [...new Set([...input.files.collisionDisclosure, ...inspected.collisionDisclosure])].sort();
    const unsigned = {
      schemaVersion: 1 as const,
      kind: "session-branch-plan" as const,
      parent: input.parent,
      child: input.child,
      launchIdentity: input.launchIdentity,
      workspace: { ...input.workspace, ...policy, collisionDisclosure },
      files: { ...input.files, sharing: policy.sharing },
      terminal: input.terminal,
    };
    return { ...unsigned, confirmationDigest: stableDigest(unsigned) };
  }

  async apply(plan: ConversationBranchPlanV1, confirmationDigest: string): Promise<{
    readonly schemaVersion: 1;
    readonly kind: "session-branch-apply";
    readonly invocation: NativeBranchInvocation;
    readonly terminal: TerminalTabPlan | null;
    readonly workspace: { readonly cwd: string; readonly worktreeRef: string | null };
    readonly writerLease: BranchWriterLease | null;
    readonly child?: BranchLifecycleEvent;
  }> {
    const { confirmationDigest: ignored, ...unsigned } = plan;
    void ignored;
    if (plan.confirmationDigest !== confirmationDigest || stableDigest(unsigned) !== confirmationDigest)
      throw new SessionError("SESSION_BRANCH_CONFIRMATION_MISMATCH", "branch plan confirmation digest does not match");
    // Binding/auth validation deliberately precedes worktree, lease, terminal, and process effects.
    const validatedRoot = await this.dependencies.validateNativeBinding?.(plan);
    if (plan.launchIdentity.executor === "docker" && (!this.dependencies.admitExecutor || !await this.dependencies.admitExecutor(plan.launchIdentity)))
      throw new SessionError("SESSION_BRANCH_EXECUTOR_NOT_ADMITTED", "Docker branching requires current explicit runtime admission");
    if (this.dependencies.lineage && !this.dependencies.runtime) throw new SessionError("SESSION_BRANCH_RUNTIME_UNAVAILABLE", "Native branch execution is unavailable");
    if (plan.terminal.enabled && this.dependencies.lineage && !this.dependencies.terminal) throw new SessionError("SESSION_BRANCH_TERMINAL_UNAVAILABLE", "Windows Terminal execution is unavailable");
    let workspace = { cwd: plan.workspace.cwd, worktreeRef: plan.workspace.worktreeRef };
    let createdWorktree = false, writerLease: BranchWriterLease | null = null, launched = false;
    try {
      if (plan.workspace.provision === "new-worktree") { workspace = await this.dependencies.createIsolatedWorktree(plan.workspace); createdWorktree = true; }
      if (plan.workspace.intent === "modify") {
        if (!this.leases) throw new SessionError("SESSION_BRANCH_LEASE_UNAVAILABLE", "duplicate-writer prevention is unavailable");
        writerLease = await this.leases.acquire(workspace.cwd, plan.child.runtimeQualifiedId);
      }
      const invocation = await this.dependencies.adapters[plan.child.runtime].plan(plan.parent, workspace.cwd, validatedRoot);
      const terminal = planWindowsTerminalTab(plan.terminal, invocation);
      if (!this.dependencies.runtime || !this.dependencies.lineage) return { schemaVersion: 1, kind: "session-branch-apply", invocation, terminal, workspace, writerLease };
      const pending: BranchLineagePendingV1 = {
        pendingRuntimeQualifiedId: plan.child.runtimeQualifiedId,
        parentRuntimeQualifiedId: plan.parent.runtimeQualifiedId,
        identity: plan.launchIdentity.identity,
        nativeBindingRef: plan.launchIdentity.nativeBindingRef,
        cwd: workspace.cwd,
        worktreeRef: workspace.worktreeRef,
        sharing: plan.workspace.sharing,
        collisionDisclosure: plan.workspace.collisionDisclosure,
        writerLease: writerLease && { owner: writerLease.owner, workspaceDigest: writerLease.workspaceDigest },
      };
      await this.dependencies.lineage.savePending(pending);
      const executor = terminal ? this.dependencies.terminal : this.dependencies.runtime;
      if (!executor) throw new SessionError("SESSION_BRANCH_TERMINAL_UNAVAILABLE", "Windows Terminal execution is unavailable");
      const childProcess = await executor.launch(terminal ?? invocation, plan); launched = true;
      void childProcess.exited.finally(() => writerLease?.release()).catch(() => undefined);
      const child = await childProcess.lifecycle;
      if (!child.runtimeQualifiedId.startsWith(`${plan.child.runtime}:`)) throw new SessionError("SESSION_BRANCH_LIFECYCLE_MISMATCH", "Child lifecycle event has the wrong runtime");
      await this.dependencies.lineage.finalize(plan.child.runtimeQualifiedId, child);
      return { schemaVersion: 1, kind: "session-branch-apply", invocation, terminal, workspace, writerLease, child };
    } catch (error) {
      try { await this.dependencies.lineage?.fail(plan.child.runtimeQualifiedId); } catch { /* preserve the launch failure */ }
      if (!launched) await writerLease?.release();
      try { if (createdWorktree && !launched) await this.dependencies.removeIsolatedWorktree?.(workspace); } catch { /* preserve the launch failure */ }
      throw error;
    }
  }
}

export interface BranchLineageRecordV1 extends BranchLineagePendingV1 {
  readonly schemaVersion: 1;
  readonly status: "pending" | "active" | "failed";
  readonly actual: BranchLifecycleEvent | null;
}
/** Durable, atomic branch lineage state. The pending key remains stable when the native child ID arrives. */
export class BranchLineageStore implements BranchLineagePersistence {
  constructor(private readonly root: string) {}
  private file(pendingId: string): string { safeText(pendingId, "lineage.pendingId", 512); return path.join(this.root, `${Buffer.from(pendingId).toString("base64url")}.json`); }
  private async atomic(file: string, value: BranchLineageRecordV1): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    try { await rename(temporary, file); } catch (error) { await rm(temporary, { force: true }); throw error; }
  }
  async savePending(value: BranchLineagePendingV1): Promise<void> {
    absolute(value.cwd, "lineage.cwd"); safeText(value.nativeBindingRef, "lineage.nativeBindingRef", 512);
    await this.atomic(this.file(value.pendingRuntimeQualifiedId), { schemaVersion: 1, ...value, collisionDisclosure: [...value.collisionDisclosure], status: "pending", actual: null });
  }
  async read(pendingId: string): Promise<BranchLineageRecordV1> {
    const value = JSON.parse(await readFile(this.file(pendingId), "utf8")) as BranchLineageRecordV1;
    if (value.schemaVersion !== 1 || value.pendingRuntimeQualifiedId !== pendingId || !["pending", "active", "failed"].includes(value.status)) throw new SessionError("SESSION_BRANCH_LINEAGE_INVALID", "branch lineage state is invalid");
    return value;
  }
  async finalize(pendingId: string, event: BranchLifecycleEvent): Promise<void> {
    const current = await this.read(pendingId);
    if (current.status !== "pending" || current.actual !== null) throw new SessionError("SESSION_BRANCH_LINEAGE_CONFLICT", "branch lineage was already finalized");
    safeText(event.runtimeQualifiedId, "lineage.actualId", 512);
    await this.atomic(this.file(pendingId), { ...current, status: "active", actual: event });
  }
  async fail(pendingId: string): Promise<void> {
    try { const current = await this.read(pendingId); if (current.status === "pending") await this.atomic(this.file(pendingId), { ...current, status: "failed" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export interface BranchWriterLease { readonly owner: string; readonly workspaceDigest: string; release(): Promise<void> }
export class BranchLeaseStore {
  constructor(private readonly root: string) {}
  private lease(owner: string, workspaceDigest: string, token: string): BranchWriterLease {
    const directory = path.join(this.root, `${workspaceDigest}.writer`);
    return { owner, workspaceDigest, release: async () => {
      try { const current = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8")) as { token?: unknown; owner?: unknown }; if (current.token === token && current.owner === owner) await rm(directory, { recursive: true, force: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    } };
  }
  async restore(workspaceDigest: string, owner: string): Promise<BranchWriterLease> {
    if (!/^[a-f0-9]{64}$/u.test(workspaceDigest)) throw new SessionError("SESSION_BRANCH_LEASE_INVALID", "writer lease digest is invalid");
    safeText(owner, "lease.owner", 512);
    try {
      const current = JSON.parse(await readFile(path.join(this.root, `${workspaceDigest}.writer`, "owner.json"), "utf8")) as { token?: unknown; owner?: unknown };
      if (current.owner !== owner || typeof current.token !== "string") throw new Error();
      return this.lease(owner, workspaceDigest, current.token);
    } catch { throw new SessionError("SESSION_BRANCH_LEASE_NOT_FOUND", "durable writer lease was not found"); }
  }
  async acquire(workspace: string, owner: string): Promise<BranchWriterLease> {
    absolute(workspace, "lease.workspace"); safeText(owner, "lease.owner", 512);
    const workspaceDigest = stableDigest({ workspace: path.normalize(workspace).toLowerCase() }), directory = path.join(this.root, `${workspaceDigest}.writer`), token = randomUUID();
    await mkdir(this.root, { recursive: true });
    try { await mkdir(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SessionError("SESSION_BRANCH_DUPLICATE_WRITER", "The selected workspace already has a branch writer");
      throw error;
    }
    try { await writeFile(path.join(directory, "owner.json"), JSON.stringify({ owner, token }), { flag: "wx" }); }
    catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    return this.lease(owner, workspaceDigest, token);
  }
}

export function createClaudeBranchAdapter(executable: string): BranchRuntimeAdapter {
  const trusted = absolute(executable, "claude.executable");
  return { plan(parent, cwd) {
    if (parent.nativeSessionRef.kind !== "native-id") throw new SessionError("SESSION_BRANCH_CLAUDE_TARGET_INVALID", "Claude branching requires a native session ID");
    return { executable: trusted, argv: ["--resume", parent.nativeSessionRef.value, "--fork-session"], cwd: absolute(cwd, "claude.cwd"), nativeTarget: "runtime-created" };
  } };
}
function within(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }
export function createPiBranchAdapter(executable: string): BranchRuntimeAdapter {
  const trusted = absolute(executable, "pi.executable");
  return { async plan(parent, cwd, selectedRoot) {
    if (!selectedRoot || parent.nativeSessionRef.kind !== "root-relative-file") throw new SessionError("SESSION_BRANCH_PI_TARGET_INVALID", "Pi branching requires a root-relative source in the selected root");
    const relative = parent.nativeSessionRef.value;
    if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === "..")) throw new SessionError("SESSION_BRANCH_PI_TARGET_INVALID", "Pi source path is unsafe");
    let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const rootNamed = await lstat(selectedRoot); if (!rootNamed.isDirectory() || rootNamed.isSymbolicLink()) throw new Error("unsafe root");
      const root = await realpath(selectedRoot), candidate = path.join(root, ...relative.split("/"));
      fileHandle = await open(candidate, "r");
      const opened = await fileHandle.stat(), named = await lstat(candidate), resolved = await realpath(candidate);
      if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino || !within(root, resolved)) throw new Error("unsafe target");
      const source = path.normalize(resolved).replaceAll("\\", "/");
      return { executable: trusted, argv: ["--fork", source], cwd: absolute(cwd, "pi.cwd"), nativeTarget: "runtime-created" };
    } catch { throw new SessionError("SESSION_BRANCH_PI_TARGET_INVALID", "Pi source is missing, unsafe, cross-root, or identity-unstable"); }
    finally { await fileHandle?.close().catch(() => undefined); }
  } };
}

export function planWindowsTerminalTab(request: TerminalTabRequest, invocation: NativeBranchInvocation): TerminalTabPlan | null {
  if (!request.enabled) return null;
  if (!request.executable || !request.title) throw new SessionError("SESSION_BRANCH_TERMINAL_INVALID", "enabled terminal tab requires executable and title");
  safeText(request.title, "terminal.title", 128);
  const cwd = absolute(invocation.cwd, "invocation.cwd");
  if (request.cwd !== undefined && absolute(request.cwd, "terminal.cwd") !== cwd) throw new SessionError("SESSION_BRANCH_TERMINAL_INVALID", "terminal cwd differs from branch invocation cwd");
  return { executable: absolute(request.executable, "terminal.executable"), argv: ["new-tab", "--title", request.title, "--startingDirectory", cwd, "--", invocation.executable, ...invocation.argv], cwd };
}
