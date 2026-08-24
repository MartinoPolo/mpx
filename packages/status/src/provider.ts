import path from "node:path";
import type { ProjectConfig } from "@mpx/config";
import { isPathWithinRoot } from "@mpx/core";
import type { LeaseFile, LeaseRecord, ListenerInfo } from "@mpx/ports";

export type PortResolutionState = "valid" | "missing" | "invalid" | "stale";
export type StatusDiagnosticSeverity = "info" | "warning" | "error";

export interface StatusDiagnosticV1 {
  code: string;
  severity: StatusDiagnosticSeverity;
  message: string;
  serviceId: string | null;
}
export interface StatusServiceV1 {
  id: string;
  mode: "managed" | "fixed-shared";
  scope: "checkout" | "project";
  protocol: "http" | "https" | "tcp";
  port: number | null;
  listening: boolean;
  conflict: "none" | "external" | "unknown";
  pid: number | null;
}
export interface StatusSnapshotV1 {
  schemaVersion: 1;
  project: { id: string; cwd: string };
  worktree: { id: string | null; path: string | null; role: "main" | "linked" | null; branch: string | null };
  portResolution: PortResolutionState;
  services: StatusServiceV1[];
  diagnostics: StatusDiagnosticV1[];
}
export interface StatusRequest {
  cwd: string;
  projectRoot?: string;
  config: ProjectConfig;
  configHash: string;
}
export interface ReadOnlyPortService {
  resolve(request: StatusRequest): Promise<LeaseFile>;
  list(): Promise<readonly LeaseRecord[]>;
  inspect(): Promise<readonly ListenerInfo[]>;
}
export interface StatusProviderDependencies { portService: ReadOnlyPortService }
export interface StatusProvider { snapshot(request: StatusRequest): Promise<StatusSnapshotV1> }

type Resolution = { state: PortResolutionState; lease: LeaseFile | null; diagnostic: StatusDiagnosticV1 | null };

function diagnostic(code: string, severity: StatusDiagnosticSeverity, message: string, serviceId: string | null = null): StatusDiagnosticV1 {
  return { code, severity, message, serviceId };
}
function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "PORT_RESOLUTION_FAILED";
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(code) ? code : "PORT_RESOLUTION_FAILED";
}
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "The port lease could not be resolved.";
  return message.replace(/[\0-\x1F\x7F-\x9F]+/gu, " ").trim().slice(0, 1_024);
}
function classify(error: unknown): Resolution {
  const code = errorCode(error);
  const details = JSON.stringify(typeof error === "object" && error !== null && "details" in error ? error.details : "");
  if (code === "PORT_LEASE_MISSING" || (code === "PORT_LEASE_INVALID" && /ENOENT|no such file/i.test(details))) {
    return { state: "missing", lease: null, diagnostic: diagnostic(code, "warning", errorText(error)) };
  }
  if (code === "PORT_LEASE_MISMATCH" || code === "PORT_LEASE_STALE" || code === "PORT_CONFIG_MISMATCH") {
    return { state: "stale", lease: null, diagnostic: diagnostic(code, "warning", errorText(error)) };
  }
  return { state: "invalid", lease: null, diagnostic: diagnostic(code, "error", errorText(error)) };
}
function normalized(value: string): string { return path.resolve(value).replace(/[\\/]+$/, "").toLowerCase(); }
function selectRecord(records: readonly LeaseRecord[], request: StatusRequest, lease: LeaseFile | null): LeaseRecord | null {
  const candidates = records.filter((record) => record.projectId === request.config.project.id && isPathWithinRoot(request.cwd, record.worktreePath));
  if (lease) {
    const authoritative = candidates.find((record) => record.leaseId === lease.leaseId && record.worktreeId === lease.worktreeId && record.configHash === request.configHash);
    if (authoritative) return authoritative;
  }
  return [...candidates].sort((a, b) => normalized(b.worktreePath).length - normalized(a.worktreePath).length || a.leaseId.localeCompare(b.leaseId))[0] ?? null;
}
function branchName(branch: string | undefined): string | null { return branch?.replace(/^refs\/heads\//, "") ?? null; }
function listenerConflict(listener: ListenerInfo | undefined, worktreePath: string | undefined): StatusServiceV1["conflict"] {
  if (!listener) return "none";
  if (listener.projectPath && worktreePath) return isPathWithinRoot(listener.projectPath, worktreePath) ? "none" : "external";
  return "unknown";
}
function compareListeners(left: ListenerInfo, right: ListenerInfo): number {
  return left.port - right.port
    || (left.pid ?? Number.MAX_SAFE_INTEGER) - (right.pid ?? Number.MAX_SAFE_INTEGER)
    || (left.projectPath ?? "").localeCompare(right.projectPath ?? "");
}

export class StatusSnapshotProvider implements StatusProvider {
  constructor(private readonly dependencies: StatusProviderDependencies) {}
  async snapshot(request: StatusRequest): Promise<StatusSnapshotV1> {
    let resolution: Resolution;
    try { resolution = { state: "valid", lease: await this.dependencies.portService.resolve(request), diagnostic: null }; }
    catch (error) { resolution = classify(error); }

    const diagnostics: StatusDiagnosticV1[] = resolution.diagnostic ? [resolution.diagnostic] : [];
    let records: readonly LeaseRecord[] = [];
    try { records = await this.dependencies.portService.list(); }
    catch (error) { diagnostics.push(diagnostic("PORT_LIST_FAILED", "error", errorText(error))); }
    const record = selectRecord(records, request, resolution.lease);
    if (resolution.state === "valid" && (!record || record.configHash !== request.configHash)) {
      const mismatch = diagnostic("PORT_LEASE_MISMATCH", "warning", "The resolved lease does not match the current registry record.");
      resolution = { state: "stale", lease: null, diagnostic: mismatch };
      diagnostics.push(mismatch);
    }

    let listeners: readonly ListenerInfo[] = [];
    if (resolution.state === "valid") {
      try { listeners = await this.dependencies.portService.inspect(); }
      catch (error) { diagnostics.push(diagnostic("PORT_INSPECTION_FAILED", "warning", errorText(error))); }
    }
    const listenerByPort = new Map<number, ListenerInfo>();
    for (const listener of [...listeners].sort(compareListeners)) {
      if (!listenerByPort.has(listener.port)) listenerByPort.set(listener.port, listener);
    }
    const configured = Object.entries(request.config.development?.services ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const services: StatusServiceV1[] = configured.map(([id, service]) => {
      const port = resolution.state === "valid" ? resolution.lease?.services[id] ?? null : null;
      const listener = port === null ? undefined : listenerByPort.get(port);
      const duplicateShared = port !== null && service.port.mode === "fixed-shared" && records.some((candidate) => candidate.leaseId !== record?.leaseId && candidate.claims.some((claim) => claim.port === port));
      const conflict = listenerConflict(listener, record?.worktreePath);
      if (conflict === "external") diagnostics.push(diagnostic("PORT_EXTERNAL_CONFLICT", "warning", `Port ${port} for service ${id} is occupied by an external listener.`, id));
      if (conflict === "unknown") diagnostics.push(diagnostic("PORT_LISTENER_OWNER_UNKNOWN", "warning", `Port ${port} for service ${id} has a listener whose ownership cannot be verified.`, id));
      if (duplicateShared) diagnostics.push(diagnostic("FIXED_SHARED_DUPLICATE", "warning", `Fixed-shared port ${port} for service ${id} has another registry claim.`, id));
      return { id, mode: service.port.mode, scope: service.scope, protocol: service.protocol ?? "tcp", port, listening: listener !== undefined, conflict, pid: listener?.pid ?? null };
    });
    diagnostics.sort((a, b) => a.code.localeCompare(b.code) || (a.serviceId ?? "").localeCompare(b.serviceId ?? "") || a.message.localeCompare(b.message));
    return {
      schemaVersion: 1,
      project: { id: request.config.project.id, cwd: request.cwd },
      worktree: { id: record?.worktreeId ?? null, path: record?.worktreePath ?? null, role: record?.role ?? null, branch: branchName(record?.branch) },
      portResolution: resolution.state,
      services,
      diagnostics,
    };
  }
}

export function createStatusProvider(dependencies: StatusProviderDependencies): StatusProvider { return new StatusSnapshotProvider(dependencies); }
