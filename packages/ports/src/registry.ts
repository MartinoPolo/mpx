import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { MpxError, parseStrictJson, type JsonValue } from "@mpx/core";
import { InterprocessLock, type LockOptions } from "./lock.js";

export interface PortClaim { port: number; exclusive: boolean }
export interface LeaseRecord {
  leaseId: string; projectId: string; repositoryId: string; worktreeId: string; worktreePath: string;
  role: "main" | "linked"; slot: number; configHash: string; services: Record<string, number>;
  claims: PortClaim[]; updatedAt: number; branch?: string; gitAdminPath?: string; commonGitPath?: string;
}
export interface RegistryState { schemaVersion: 1; leases: LeaseRecord[]; lastReconciledAt?: number }
export const emptyRegistry = (): RegistryState => ({ schemaVersion: 1, leases: [] });

function invalid(): never { throw new MpxError({ code: "PORT_REGISTRY_INVALID", message: "The port registry is malformed or has an unsupported version." }); }
function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> { return typeof value === "object" && value !== null && !Array.isArray(value); }
const hashPattern = /^[0-9a-f]{64}$/u;
const nonEmpty = (value: JsonValue | undefined): value is string => typeof value === "string" && value.length > 0;
function validate(value: JsonValue): RegistryState {
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.leases) || Object.keys(value).some((key) => !["schemaVersion", "leases", "lastReconciledAt"].includes(key))) invalid();
  if (value.lastReconciledAt !== undefined && (typeof value.lastReconciledAt !== "number" || !Number.isFinite(value.lastReconciledAt) || value.lastReconciledAt < 0)) invalid();
  const leaseIds = new Set<string>();
  const worktreeIdentities = new Set<string>();
  const mainIdentities = new Set<string>();
  const claimed = new Map<number, boolean>();
  for (const lease of value.leases) {
    if (!isObject(lease)) invalid();
    const required = ["leaseId", "projectId", "repositoryId", "worktreeId", "worktreePath", "role", "slot", "configHash", "services", "claims", "updatedAt"];
    if (required.some((key) => !(key in lease)) || Object.keys(lease).some((key) => ![...required, "branch", "gitAdminPath", "commonGitPath"].includes(key))) invalid();
    if (!nonEmpty(lease.leaseId) || !nonEmpty(lease.projectId) || !nonEmpty(lease.repositoryId) || !nonEmpty(lease.worktreeId) || !nonEmpty(lease.worktreePath) || !["main", "linked"].includes(String(lease.role)) || typeof lease.slot !== "number" || !Number.isSafeInteger(lease.slot) || lease.slot < 0 || typeof lease.configHash !== "string" || lease.configHash.length === 0 || !hashPattern.test(lease.configHash) || !isObject(lease.services) || !Array.isArray(lease.claims) || typeof lease.updatedAt !== "number" || !Number.isFinite(lease.updatedAt) || lease.updatedAt < 0) invalid();
    if ((lease.branch !== undefined && !nonEmpty(lease.branch)) || (lease.gitAdminPath !== undefined && !nonEmpty(lease.gitAdminPath)) || (lease.commonGitPath !== undefined && !nonEmpty(lease.commonGitPath))) invalid();
    if (leaseIds.has(lease.leaseId)) invalid();
    leaseIds.add(lease.leaseId);
    const worktreeIdentity = `${lease.repositoryId}\u0000${lease.worktreeId}`;
    if (worktreeIdentities.has(worktreeIdentity)) invalid();
    worktreeIdentities.add(worktreeIdentity);
    if (lease.role === "main") {
      const mainIdentity = `${lease.repositoryId}\u0000${lease.projectId}`;
      if (mainIdentities.has(mainIdentity)) invalid();
      mainIdentities.add(mainIdentity);
    }
    const servicePorts = new Set<number>();
    for (const [name, port] of Object.entries(lease.services as Record<string, JsonValue>)) {
      if (name.length === 0 || typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) invalid();
      servicePorts.add(port);
    }
    for (const claim of lease.claims) {
      if (!isObject(claim) || Object.keys(claim).sort().join(",") !== "exclusive,port" || typeof claim.port !== "number" || !Number.isSafeInteger(claim.port) || claim.port < 1 || claim.port > 65_535 || typeof claim.exclusive !== "boolean" || !servicePorts.has(claim.port)) invalid();
      const prior = claimed.get(claim.port);
      if (prior !== undefined && (prior || claim.exclusive)) invalid();
      claimed.set(claim.port, claim.exclusive);
    }
  }
  const validatedLeases = value.leases as unknown as LeaseRecord[];
  for (const lease of validatedLeases) {
    if (lease.role !== "linked") continue;
    const matchingMains = validatedLeases.filter((candidate) => candidate.role === "main" && candidate.repositoryId === lease.repositoryId && candidate.projectId === lease.projectId && candidate.configHash === lease.configHash);
    if (matchingMains.length !== 1) invalid();
  }
  return value as unknown as RegistryState;
}
function sorted(state: RegistryState): RegistryState {
  return { ...state, leases: [...state.leases].sort((a, b) => a.leaseId.localeCompare(b.leaseId)).map((lease) => ({ ...lease, services: Object.fromEntries(Object.entries(lease.services).sort(([a], [b]) => a.localeCompare(b))), claims: [...lease.claims].sort((a, b) => a.port - b.port) })) };
}

export class RegistryStore {
  readonly filePath: string;
  private readonly lock: InterprocessLock;
  constructor(readonly stateRoot: string, options: LockOptions = {}) { this.filePath = path.join(stateRoot, "ports-registry.json"); this.lock = new InterprocessLock(stateRoot, options); }
  async read(): Promise<RegistryState> {
    try { return sorted(validate(parseStrictJson(await readFile(this.filePath, "utf8")))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry(); if (error instanceof MpxError) throw error; throw new MpxError({ code: "PORT_REGISTRY_INVALID", message: "The port registry cannot be read.", details: { cause: String(error) } }); }
  }
  async write(state: RegistryState): Promise<void> {
    const valid = sorted(validate(state as unknown as JsonValue)); await mkdir(this.stateRoot, { recursive: true });
    const temporary = path.join(this.stateRoot, `.ports-registry.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(valid, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.filePath);
  }
  async transaction<T>(operation: (state: RegistryState) => T | Promise<T>): Promise<T> {
    const release = await this.lock.acquire();
    try { const state = await this.read(); const result = await operation(state); await this.write(state); return result; }
    finally { await release(); }
  }
  async rebuildTransaction<T>(builder: () => Promise<{ state: RegistryState; result: T }>): Promise<T> {
    const release = await this.lock.acquire();
    try { const { state, result } = await builder(); await this.write(state); return result; }
    finally { await release(); }
  }
  async rebuild(state: RegistryState): Promise<void> {
    const release = await this.lock.acquire();
    try { await this.write(state); }
    finally { await release(); }
  }
}
