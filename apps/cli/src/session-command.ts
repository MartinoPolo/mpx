import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { LifecycleEventDirectoryConsumer, LegacySessionImporter, SessionError, SessionService, SessionStore, planResume, stableDigest, verifyResumeConfirmation, type BranchRequestV1, type ConversationBranchService, type IdentityV1, type ResumeDependencies, type ResumePlanV1, type RuntimeDiscovery, type SessionListFilter, type SessionProcessInspector, type SessionRecordV1, type WorkflowStatus } from "@mpx/sessions";
import type { Diagnostic } from "@mpx/core";

export interface SessionCommandInput {
  readonly action: string | undefined;
  readonly args: readonly string[];
  readonly options: ReadonlyMap<string, string | boolean | string[]>;
}
export interface SessionCommandContext {
  readonly store: SessionStore;
  resolveIdentity(name: string): Promise<IdentityV1>;
  readonly discoveries?: () => Promise<readonly { scanner: RuntimeDiscovery; context?: { identity: IdentityV1; nativeBindingRef: string; runtime: "claude" | "pi" } }[]>;
  readonly processInspector?: SessionProcessInspector;
  readonly resumeDependencies?: (record: SessionRecordV1) => Promise<ResumeDependencies>;
  readonly executeResume?: (plan: ResumePlanV1) => Promise<unknown>;
  readonly branchService?: Pick<ConversationBranchService, "plan" | "apply">;
  readonly terminalExecutable?: string;
  /** Installed scheduler observation only; granting authority remains a Phase I responsibility. */
  readonly scheduledCaptureAuthority?: { inspect(): Promise<Readonly<{ installed: boolean; authorityDigest: string | null }>> };
}
export interface SessionCommandResult { readonly data: unknown; readonly warnings: readonly Diagnostic[] }

const text = (input: SessionCommandInput, name: string): string | undefined => {
  const value = input.options.get(name);
  return typeof value === "string" ? value : undefined;
};
const repeated = (input: SessionCommandInput, name: string): string[] => {
  const value = input.options.get(name);
  return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
};
const usage = (message: string): never => { throw new SessionError("SESSION_USAGE_ERROR", message); };
function runtimeOption(input: SessionCommandInput): "claude" | "pi" | undefined {
  const runtime = text(input, "runtime");
  if (runtime !== undefined && runtime !== "claude" && runtime !== "pi") usage("--runtime must be claude or pi");
  return runtime as "claude" | "pi" | undefined;
}
async function requiredIdentity(input: SessionCommandInput, context: SessionCommandContext, action: string): Promise<IdentityV1> {
  const name = text(input, "identity");
  if (!name) usage(`session ${action} requires --identity`);
  return context.resolveIdentity(name as string);
}
const confirmationOption = (input: SessionCommandInput): string | undefined => text(input, "confirm-plan");
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
function requiredSafeText(input: SessionCommandInput, name: string): string {
  const candidate = text(input, name);
  if (candidate === undefined) throw new SessionError("SESSION_USAGE_ERROR", `--${name} is required`);
  const value: string = candidate;
  if (value.length === 0) usage(`--${name} is required`);
  if (value.length > 512) usage(`--${name} must be at most 512 characters`);
  if (CONTROL.test(value) || value !== value.normalize("NFC")) usage(`--${name} contains invalid characters`);
  return value;
}
async function consumePending(context: SessionCommandContext, service: SessionService): Promise<number> {
  const consumer = new LifecycleEventDirectoryConsumer(context.store, service);
  let consumed = 0;
  for (const bindingId of await context.store.listLifecycleBindingIds()) consumed += await consumer.consume(bindingId);
  return consumed;
}
async function filter(input: SessionCommandInput, context: SessionCommandContext): Promise<SessionListFilter> {
  const runtime = runtimeOption(input);
  const state = text(input, "state");
  const states = ["active", "paused", "unfinished", "needs-review", "completed", "abandoned", "unknown"] as const;
  if (state !== undefined && !states.includes(state as typeof states[number])) usage("--state is invalid");
  const status = text(input, "status");
  if (status !== undefined && !["unfinished", "needs-review", "completed", "abandoned", "paused"].includes(status)) usage("--status is invalid");
  if (state !== undefined && status !== undefined) usage("--state and --status cannot be combined");
  const identityName = text(input, "identity");
  return {
    ...(runtime ? { runtime: runtime as "claude" | "pi" } : {}),
    ...(state === "active" || state === "unknown" ? { liveness: state } : {}),
    ...(state !== undefined && state !== "active" && state !== "unknown" ? { workflowStatus: state as WorkflowStatus } : {}),
    ...(status ? { workflowStatus: status as WorkflowStatus } : {}),
    ...(identityName ? { identity: await context.resolveIdentity(identityName) } : {}),
  };
}
function limit(input: SessionCommandInput): number | undefined {
  const raw = text(input, "limit");
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) usage("--limit must be an integer from 1 to 10000");
  return value;
}
function mapping(values: readonly string[], label: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const value of values) {
    const at = value.indexOf("=");
    if (at < 1 || at === value.length - 1) usage(`${label} requires SOURCE=TARGET`);
    result.set(value.slice(0, at), value.slice(at + 1));
  }
  return result;
}

export async function executeSessionCommand(input: SessionCommandInput, context: SessionCommandContext): Promise<SessionCommandResult> {
  const service = new SessionService(context.store, undefined, context.processInspector);
  const actions = ["list", "show", "save", "resume", "branch", "mark", "handoff", "complete", "completion", "inbox", "reconcile"] as const;
  if (!input.action || !actions.includes(input.action as typeof actions[number])) usage(`session requires ${actions.join(", ")}`);
  const action = input.action as typeof actions[number];
  const read = ["list", "show", "save", "handoff", "complete", "completion", "inbox"].includes(action);
  if (read) await consumePending(context, service);
  if (action === "list") {
    if (input.args.length) usage("session list accepts no positional arguments");
    const records = (await service.list(await filter(input, context))).slice(0, limit(input));
    return { data: { schemaVersion: 1, kind: "session-list", records }, warnings: [] };
  }
  if (action === "show") {
    if (input.args.length !== 1) usage("session show requires one id");
    return { data: { schemaVersion: 1, kind: "session-show", record: await service.show(input.args[0]!) }, warnings: [] };
  }
  if (action === "handoff" || action === "complete" || action === "completion") {
    if (input.args.length !== 1) usage(`session ${action} requires one id`);
    const identity = await requiredIdentity(input, context, action);
    const runtime = runtimeOption(input);
    const disposition = text(input, "disposition");
    const allowed = action === "handoff" ? ["paused", "unfinished"] : ["paused", "unfinished", "completed"];
    if (!disposition || !allowed.includes(disposition)) usage(`--disposition must be ${allowed.join(", ")}`);
    const request = {
      identity,
      ...(runtime ? { runtime: runtime as "claude" | "pi" } : {}),
      summary: requiredSafeText(input, "summary"),
      nextAction: requiredSafeText(input, "next-action"),
      disposition: disposition as "paused" | "unfinished" | "completed",
    };
    const observation = action === "handoff"
      ? await service.handoff(input.args[0]!, { ...request, disposition: request.disposition as "paused" | "unfinished" })
      : await service.complete(input.args[0]!, request);
    return { data: observation, warnings: [] };
  }
  if (action === "mark") {
    if (input.args.length !== 2) usage("session mark requires <id> <status>");
    const status = input.args[1] as WorkflowStatus;
    if (!["unfinished", "needs-review", "completed", "abandoned", "paused"].includes(status)) usage("session mark status is invalid");
    const rawPriority = text(input, "priority");
    const priority = rawPriority === undefined ? undefined : Number(rawPriority);
    if (priority !== undefined && (!Number.isSafeInteger(priority) || priority < 0 || priority > 9)) usage("--priority must be from 0 to 9");
    const workflowOptions = {
      ...(priority === undefined ? {} : { priority }),
      ...(text(input, "next-action") === undefined ? {} : { nextAction: text(input, "next-action")! }),
      ...(text(input, "note") === undefined ? {} : { note: text(input, "note")! }),
      ...(text(input, "related-issue") === undefined ? {} : { relatedIssue: text(input, "related-issue")! }),
      ...(text(input, "related-review") === undefined ? {} : { relatedReview: text(input, "related-review")! }),
    };
    const record = await service.mark(input.args[0]!, status, workflowOptions);
    return { data: { schemaVersion: 1, kind: "session-mark", record }, warnings: [] };
  }
  if (action === "inbox") {
    if (input.args.length) usage("session inbox accepts no positional arguments");
    const selected = (await service.inbox()).filter(record => {
      const runtime = text(input, "runtime"), status = text(input, "status");
      return (!runtime || record.runtime === runtime) && (!status || record.workflow.status === status);
    }).slice(0, limit(input));
    return { data: { schemaVersion: 1, kind: "session-inbox", records: selected }, warnings: [] };
  }
  if (action === "save") {
    const all = input.options.get("all-active") === true;
    if (all && input.args.length) usage("--all-active cannot be combined with ids");
    if (!all && input.args.length === 0) usage("session save requires ids or --all-active");
    return { data: { schemaVersion: 1, kind: "session-capture", captures: await service.capture(all ? undefined : input.args) }, warnings: [] };
  }
  if (action === "reconcile") {
    if (input.args.length) usage("session reconcile accepts no positional arguments");
    const captureMode = text(input, "capture");
    if (captureMode !== undefined && captureMode !== "scheduled") usage("--capture must be scheduled");
    if (captureMode === "scheduled") {
      await context.scheduledCaptureAuthority?.inspect().catch(() => undefined);
      throw new SessionError("SESSION_SCHEDULED_CAPTURE_AUTHORITY_UNAVAILABLE", "Installed scheduled capture has no authority until Phase I enables its proof gate.");
    }
    const sources = repeated(input, "import-legacy");
    let legacy: unknown = null;
    if (sources.length) {
      const accounts = mapping(repeated(input, "map-account"), "--map-account");
      const roots = mapping(repeated(input, "map-pi-root"), "--map-pi-root");
      if (!accounts.size) usage("legacy import requires explicit --map-account mappings");
      const bindings = await context.store.listNativeBindings();
      const mappings: Record<string, { identity: IdentityV1; nativeBindingRef: string; nativeRoot?: string }> = {};
      for (const [source, identityName] of accounts) {
        const identity = await context.resolveIdentity(identityName);
        const runtime = source.startsWith("pi:") ? "pi" : "claude";
        const binding = bindings.find(item => item.runtime === runtime && item.identity.domain === identity.domain && item.identity.name === identity.name);
        if (!binding) throw new SessionError("LEGACY_MAPPING_REQUIRED", `Mapped ${runtime} identity has no native binding`);
        if (runtime === "pi") {
          const nativeRoot = roots.get(identityName);
          if (!nativeRoot) throw new SessionError("LEGACY_MAPPING_REQUIRED", "Mapped Pi source requires its identity's explicit --map-pi-root");
          mappings[source] = { identity, nativeBindingRef: binding.ref, nativeRoot };
        } else {
          mappings[source] = { identity, nativeBindingRef: binding.ref };
          mappings[`claude:${source}`] = mappings[source]!;
        }
      }
      if (![...accounts.keys()].some(key => key.startsWith("pi:")) && roots.size === 1) {
        const [identityName, nativeRoot] = [...roots.entries()][0]!;
        const identity = await context.resolveIdentity(identityName);
        const binding = bindings.find(item => item.runtime === "pi" && item.identity.domain === identity.domain && item.identity.name === identity.name);
        if (!binding) throw new SessionError("LEGACY_MAPPING_REQUIRED", "Mapped Pi identity has no native binding");
        mappings.pi = { identity, nativeBindingRef: binding.ref, nativeRoot };
      }
      const importFiles: string[] = [];
      for (const source of sources) {
        const info = await lstat(source);
        if (info.isSymbolicLink()) throw new SessionError("LEGACY_SOURCE_UNSAFE", "Legacy import source must not be a symlink.");
        if (info.isFile()) {
          importFiles.push(source);
        } else if (info.isDirectory()) {
          const names = (await readdir(source)).filter(name => name.endsWith(".json")).sort();
          if (names.length > 128) throw new SessionError("LEGACY_SOURCE_LIMIT", "Legacy registry directory contains too many entries.");
          const directoryMapping = mappings[`pi:${source}`];
          for (const name of names) {
            const file = path.join(source, name), entry = await lstat(file);
            if (entry.isSymbolicLink() || !entry.isFile()) throw new SessionError("LEGACY_SOURCE_UNSAFE", "Legacy registry entries must be regular files.");
            importFiles.push(file);
            if (directoryMapping) mappings[`pi:${file}`] = directoryMapping;
          }
        } else {
          throw new SessionError("LEGACY_SOURCE_UNSAFE", "Legacy import source must be a regular file or directory.");
        }
      }
      const importer = new LegacySessionImporter(context.store);
      const plan = await importer.planFiles(importFiles, mappings);
      const confirmation = confirmationOption(input);
      legacy = confirmation === undefined ? plan : await importer.import(plan, confirmation);
    }
    const bindingIds = await context.store.listLifecycleBindingIds();
    const discoveries = context.discoveries ? await context.discoveries() : [];
    const sourceDiagnostics: { runtime: "claude" | "pi"; identity: IdentityV1 | null; status: "available" | "unavailable" | "malformed"; diagnostic: string | null }[] = [];
    const instrumented = discoveries.map(item => ({ ...item, scanner: { runtime: item.scanner.runtime, scan: async () => {
      const result = await item.scanner.scan();
      sourceDiagnostics.push({ runtime: item.scanner.runtime, identity: item.context?.identity ?? null, status: result.status, diagnostic: result.diagnostic });
      return result;
    } } }));
    const observations = await service.reconcile(instrumented, bindingIds);
    const captures: never[] = [];
    const warnings: Diagnostic[] = sourceDiagnostics.filter(item => item.diagnostic !== null).map(item => ({ code: item.diagnostic!, message: "Runtime session discovery was unavailable or malformed.", severity: "warning" }));
    if (!context.discoveries) warnings.push({ code: "SESSION_DISCOVERY_UNAVAILABLE", message: "Runtime discovery scanners are not configured.", severity: "warning" });
    return { data: { schemaVersion: 1, kind: "session-reconcile", observations, diagnostics: sourceDiagnostics, captures, legacy }, warnings };
  }
  if (action === "branch") {
    if (input.args.length !== 1) usage("session branch requires one parent id");
    if (!context.branchService) throw new SessionError("SESSION_BRANCH_NOT_CONFIGURED", "Conversation branching is unavailable.");
    const parent = await service.show(input.args[0]!);
    if (parent.launch === null) throw new SessionError("SESSION_BRANCH_LAUNCH_UNBOUND", "The parent has no immutable launch identity.");
    const binding = await context.store.readNativeBinding(parent.nativeBindingRef);
    const selected = text(input, "workspace") ?? "default";
    if (!["default", "isolated", "shared"].includes(selected)) usage("--workspace must be default, isolated, or shared");
    const intent = text(input, "intent") ?? "modify";
    if (intent !== "read" && intent !== "modify") usage("--intent must be read or modify");
    const branch = text(input, "branch") ?? `mpx/session-${parent.recordId}`;
    const childId = `${parent.runtime}:pending-${stableDigest({ parent: parent.runtimeQualifiedId, branch }).slice(0, 24)}`;
    const terminalEnabled = input.options.get("terminal-tab") === true;
    const request: BranchRequestV1 = {
      schemaVersion: 1,
      parent: { runtimeQualifiedId: parent.runtimeQualifiedId, nativeSessionRef: parent.nativeSessionRef },
      child: { runtimeQualifiedId: childId, runtime: parent.runtime },
      launchIdentity: { identity: parent.identity, rootDigest: binding.recordedRootDigest, nativeBindingRef: binding.ref, mode: parent.launch.mode, executor: parent.launch.executor.kind },
      workspace: {
        selection: selected as "default" | "isolated" | "shared", intent: intent as "read" | "modify", cwd: parent.location.cwd,
        projectRef: parent.location.project, repositoryRef: parent.location.repository,
        worktreeRef: parent.location.worktree, branch,
      },
      files: {
        sharing: selected === "shared" ? "shared" : "isolated",
        collisionDisclosure: selected === "shared" ? ["concurrent changes share the current checkout"] : ["repository history and configured external services may still collide"],
        duplicateWriterRiskAcknowledged: input.options.get("acknowledge-shared-risk") === true,
      },
      terminal: terminalEnabled ? { enabled: true, ...(context.terminalExecutable ? { executable: context.terminalExecutable } : {}), title: text(input, "terminal-title") ?? `MPX ${childId}` } : { enabled: false },
    };
    const plan = await context.branchService.plan(request), confirmation = confirmationOption(input);
    if (!confirmation || input.options.get("dry-run") === true) return { data: plan, warnings: [] };
    const applied = await context.branchService.apply(plan, confirmation);
    return { data: { ...applied, writerLease: applied.writerLease === null ? null : { owner: applied.writerLease.owner, workspaceDigest: applied.writerLease.workspaceDigest } }, warnings: [] };
  }
  if (input.args.length !== 1) usage("session resume requires one id");
  if (!context.resumeDependencies) throw new SessionError("SESSION_RESUME_NOT_CONFIGURED", "Production resume dependencies are unavailable.");
  const record = await service.show(input.args[0]!);
  await planResume(context.store, record, await context.resumeDependencies(record));
  await consumePending(context, service);
  const current = await service.show(input.args[0]!);
  const replanned = await planResume(context.store, current, await context.resumeDependencies(current));
  const confirmation = confirmationOption(input);
  if (confirmation === undefined || input.options.get("dry-run") === true) return { data: replanned, warnings: [] };
  verifyResumeConfirmation(replanned, confirmation);
  if (!context.executeResume) throw new SessionError("SESSION_RESUME_EXECUTION_UNAVAILABLE", "Resume execution is unavailable.");
  return { data: { schemaVersion: 1, kind: "session-resume", result: await context.executeResume(replanned) }, warnings: [] };
}
