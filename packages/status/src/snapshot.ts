import { readFile } from "node:fs/promises";
import type {
  PortResolutionState,
  StatusDiagnosticSeverity,
  StatusDiagnosticV1,
  StatusServiceV1,
  StatusSnapshotV1,
} from "./provider.js";

export class StatusSnapshotValidationError extends Error {
  readonly code = "STATUS_SNAPSHOT_INVALID";

  constructor(message: string, options?: ErrorOptions) {
    super(`Invalid status snapshot: ${message}`, options);
    this.name = "StatusSnapshotValidationError";
  }
}

function fail(path: string, expected: string): never {
  throw new StatusSnapshotValidationError(`${path} must be ${expected}.`);
}

function objectAt(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "an object");
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record);
  const unknown = actualKeys.find((key) => !keys.includes(key));
  if (unknown !== undefined) fail(`${path}.${unknown}`, "a recognized field");
  const missing = keys.find((key) => !Object.hasOwn(record, key));
  if (missing !== undefined) fail(`${path}.${missing}`, "present");
  return record;
}

const CONTROL_CHARACTERS = /[\0-\x1F\x7F-\x9F]/u;
function stringAt(value: unknown, path: string, maximumLength = 512): string {
  if (typeof value !== "string" || value.length > maximumLength || CONTROL_CHARACTERS.test(value)) fail(path, `a safe string of at most ${maximumLength} characters`);
  return value;
}
function identifierAt(value: unknown, path: string): string {
  const identifier = stringAt(value, path, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(identifier)) fail(path, "a bounded service identifier");
  return identifier;
}

function nullableStringAt(value: unknown, path: string, maximumLength = 512): string | null {
  return value === null ? null : stringAt(value, path, maximumLength);
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "a boolean");
  return value;
}

function enumAt<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(path, `one of ${allowed.join(", ")}`);
  return value as T;
}

function nullableIntegerAt(value: unknown, path: string, minimum: number, maximum: number): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(path, `null or an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function parseService(value: unknown, index: number): StatusServiceV1 {
  const path = `services[${index}]`;
  const service = objectAt(value, path, ["id", "mode", "scope", "protocol", "port", "listening", "conflict", "pid"]);
  return {
    id: identifierAt(service.id, `${path}.id`),
    mode: enumAt(service.mode, `${path}.mode`, ["managed", "fixed-shared"]),
    scope: enumAt(service.scope, `${path}.scope`, ["checkout", "project"]),
    protocol: enumAt(service.protocol, `${path}.protocol`, ["http", "https", "tcp"]),
    port: nullableIntegerAt(service.port, `${path}.port`, 1, 65_535),
    listening: booleanAt(service.listening, `${path}.listening`),
    conflict: enumAt(service.conflict, `${path}.conflict`, ["none", "external", "unknown"]),
    pid: nullableIntegerAt(service.pid, `${path}.pid`, 1, Number.MAX_SAFE_INTEGER),
  };
}

function parseDiagnostic(value: unknown, index: number): StatusDiagnosticV1 {
  const path = `diagnostics[${index}]`;
  const diagnostic = objectAt(value, path, ["code", "severity", "message", "serviceId"]);
  return {
    code: identifierAt(diagnostic.code, `${path}.code`),
    severity: enumAt<StatusDiagnosticSeverity>(diagnostic.severity, `${path}.severity`, ["info", "warning", "error"]),
    message: stringAt(diagnostic.message, `${path}.message`, 1_024),
    serviceId: diagnostic.serviceId === null ? null : identifierAt(diagnostic.serviceId, `${path}.serviceId`),
  };
}

/** Strictly validates and copies an untrusted version-one status snapshot. */
export function parseStatusSnapshotV1(value: unknown): StatusSnapshotV1 {
  const snapshot = objectAt(value, "status snapshot", ["schemaVersion", "project", "worktree", "portResolution", "services", "diagnostics"]);
  if (snapshot.schemaVersion !== 1) fail("schemaVersion", "the supported version 1");
  const project = objectAt(snapshot.project, "project", ["id", "cwd"]);
  const worktree = objectAt(snapshot.worktree, "worktree", ["id", "path", "role", "branch"]);
  if (!Array.isArray(snapshot.services) || snapshot.services.length > 256) fail("services", "a bounded array");
  if (!Array.isArray(snapshot.diagnostics) || snapshot.diagnostics.length > 256) fail("diagnostics", "a bounded array");

  const services = snapshot.services.map(parseService);
  const ids = new Set<string>();
  for (const service of services) {
    if (ids.has(service.id)) fail("services", "an array with unique service ids");
    ids.add(service.id);
  }

  return {
    schemaVersion: 1,
    project: { id: stringAt(project.id, "project.id", 256), cwd: stringAt(project.cwd, "project.cwd", 4_096) },
    worktree: {
      id: nullableStringAt(worktree.id, "worktree.id", 256),
      path: nullableStringAt(worktree.path, "worktree.path", 4_096),
      role: worktree.role === null ? null : enumAt<"main" | "linked">(worktree.role, "worktree.role", ["main", "linked"]),
      branch: nullableStringAt(worktree.branch, "worktree.branch", 512),
    },
    portResolution: enumAt<PortResolutionState>(snapshot.portResolution, "portResolution", ["valid", "missing", "invalid", "stale"]),
    services,
    diagnostics: snapshot.diagnostics.map(parseDiagnostic),
  };
}

/** Parses JSON and applies strict StatusSnapshotV1 validation. */
export function parseStatusSnapshotV1Json(text: string): StatusSnapshotV1 {
  try {
    return parseStatusSnapshotV1(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof StatusSnapshotValidationError) throw error;
    throw new StatusSnapshotValidationError("file is not valid JSON.", { cause: error });
  }
}

export interface RuntimeStatusSnapshotReader {
  read(): Promise<StatusSnapshotV1>;
}

/** Adapts any asynchronous, read-only snapshot source for runtime polling. */
export function createRuntimeStatusSnapshotReader(source: () => Promise<unknown>): RuntimeStatusSnapshotReader {
  return { async read() { return parseStatusSnapshotV1(await source()); } };
}

/** Reads only the explicitly named snapshot file, without allocation or repair. */
export async function readStatusSnapshotV1(snapshotPath: string): Promise<StatusSnapshotV1> {
  return parseStatusSnapshotV1Json(await readFile(snapshotPath, "utf8"));
}

export function createStatusSnapshotFileReader(snapshotPath: string): RuntimeStatusSnapshotReader {
  return { async read() { return readStatusSnapshotV1(snapshotPath); } };
}

export interface StatusRefreshClock { schedule(callback: () => Promise<void>, intervalMs: number): () => void }
export interface StatusSnapshotRefreshController {
  current(): StatusSnapshotV1 | undefined;
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
}
const systemStatusRefreshClock: StatusRefreshClock = {
  schedule(callback, intervalMs) {
    const timer = setInterval(() => { void callback(); }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};
/** Polls a validated read-only source off the synchronous render path. */
export function createStatusSnapshotRefreshController(reader: RuntimeStatusSnapshotReader, clock: StatusRefreshClock = systemStatusRefreshClock, intervalMs = 1_000): StatusSnapshotRefreshController {
  let snapshot: StatusSnapshotV1 | undefined;
  let cancel: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  const refresh = async (): Promise<void> => {
    if (pending) return pending;
    pending = reader.read().then((next) => { snapshot = next; }).finally(() => { pending = undefined; });
    return pending;
  };
  return {
    current: () => snapshot,
    refresh,
    start() { if (!cancel) cancel = clock.schedule(async () => { await refresh().catch(() => undefined); }, intervalMs); },
    stop() { cancel?.(); cancel = undefined; },
  };
}
