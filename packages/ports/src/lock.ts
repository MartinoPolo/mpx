import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { MpxError, parseStrictJson, type JsonValue } from "@mpx/core";

export interface ProcessInspection { alive: boolean; startFingerprint?: string }
export type ProcessInspector = (pid: number) => ProcessInspection | Promise<ProcessInspection>;
interface LockOwner {
  version: 1;
  token: string;
  pid: number;
  processStartFingerprint: string;
  acquiredAt: number;
  heartbeatAt: number;
}
export interface LockOptions {
  now?: () => number;
  inspectProcess?: ProcessInspector;
  /** @deprecated Prefer inspectProcess, which also protects against PID reuse. */
  isProcessAlive?: (pid: number) => boolean;
  timeoutMs?: number;
  retryMs?: number;
  heartbeatMs?: number;
  emptyOwnerGraceMs?: number;
  token?: () => string;
}

const POWERSHELL_PROCESS_START = "& { param([int]$ProcessId) $p = Get-Process -Id $ProcessId -ErrorAction Stop; [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks) }";
const delay = async (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const aliveWithoutFingerprint = (pid: number): ProcessInspection => {
  try { process.kill(pid, 0); return { alive: true }; }
  catch (error) { return { alive: (error as NodeJS.ErrnoException).code === "EPERM" }; }
};
const linuxFingerprint = (text: string): string | undefined => {
  const fieldsAfterCommand = text.slice(text.lastIndexOf(") ") + 2).trim().split(/\s+/);
  const startTicks = fieldsAfterCommand[19];
  return startTicks ? `linux:${startTicks}` : undefined;
};

/** Inspect a process without shell interpolation; an unavailable fingerprint is never evidence that a live process is stale. */
export async function inspectProcess(pid: number): Promise<ProcessInspection> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { alive: false };
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_PROCESS_START, String(pid)], { windowsHide: true }, (error, stdout) => {
        const fingerprint = stdout.trim();
        if (!error && fingerprint) resolve({ alive: true, startFingerprint: `windows:${fingerprint}` });
        else resolve(aliveWithoutFingerprint(pid));
      });
    });
  }
  if (process.platform === "linux") {
    try {
      const startFingerprint = linuxFingerprint(await readFile(`/proc/${pid}/stat`, "utf8"));
      return startFingerprint ? { alive: true, startFingerprint } : { alive: true };
    } catch { return aliveWithoutFingerprint(pid); }
  }
  return aliveWithoutFingerprint(pid);
}

/** Synchronous counterpart for callers that cannot suspend while inspecting a process. */
export function inspectProcessSync(pid: number): ProcessInspection {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { alive: false };
  if (process.platform === "win32") {
    try {
      const fingerprint = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_PROCESS_START, String(pid)], { encoding: "utf8", windowsHide: true }).trim();
      return fingerprint ? { alive: true, startFingerprint: `windows:${fingerprint}` } : aliveWithoutFingerprint(pid);
    } catch { return aliveWithoutFingerprint(pid); }
  }
  if (process.platform === "linux") {
    try {
      const startFingerprint = linuxFingerprint(readFileSync(`/proc/${pid}/stat`, "utf8"));
      return startFingerprint ? { alive: true, startFingerprint } : { alive: true };
    } catch { return aliveWithoutFingerprint(pid); }
  }
  return aliveWithoutFingerprint(pid);
}

function isObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseOwner(text: string): LockOwner | undefined {
  const value = parseStrictJson(text);
  if (!isObject(value) || value.version !== 1 || typeof value.token !== "string" || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.processStartFingerprint !== "string" || value.processStartFingerprint.length === 0 || typeof value.acquiredAt !== "number" || !Number.isFinite(value.acquiredAt) || typeof value.heartbeatAt !== "number" || !Number.isFinite(value.heartbeatAt)) return undefined;
  return value as unknown as LockOwner;
}

export class InterprocessLock {
  readonly lockPath: string;
  private readonly options: Required<Omit<LockOptions, "isProcessAlive">>;
  constructor(stateRoot: string, options: LockOptions = {}) {
    this.lockPath = path.join(stateRoot, "ports-registry.lock");
    const processInspector: ProcessInspector = options.inspectProcess ?? (options.isProcessAlive ? (pid) => ({ alive: options.isProcessAlive!(pid) }) : inspectProcess);
    this.options = { now: options.now ?? Date.now, inspectProcess: processInspector, timeoutMs: options.timeoutMs ?? 10_000, retryMs: options.retryMs ?? 20, heartbeatMs: options.heartbeatMs ?? 1_000, emptyOwnerGraceMs: options.emptyOwnerGraceMs ?? 2_000, token: options.token ?? randomUUID };
  }

  async acquire(): Promise<() => Promise<void>> {
    await mkdir(path.dirname(this.lockPath), { recursive: true });
    const started = this.options.now();
    const ownInspection = await this.options.inspectProcess(process.pid);
    const ownFingerprint = ownInspection.startFingerprint ?? `unavailable:${process.pid}`;
    while (true) {
      const token = this.options.token();
      const candidate = `${this.lockPath}.candidate-${token}`;
      const now = this.options.now();
      const owner: LockOwner = { version: 1, token, pid: process.pid, processStartFingerprint: ownFingerprint, acquiredAt: now, heartbeatAt: now };
      let readyToRename = false;
      try {
        await mkdir(candidate);
        await writeFile(path.join(candidate, "owner.json"), JSON.stringify(owner), { encoding: "utf8", flag: "wx" });
        readyToRename = true;
        await rename(candidate, this.lockPath);
        let publishing = false;
        const timer = setInterval(() => {
          if (publishing) return;
          publishing = true;
          owner.heartbeatAt = this.options.now();
          void this.publishHeartbeat(owner).catch(() => { /* Liveness is still protected by the immutable owner fingerprint. */ }).finally(() => { publishing = false; });
        }, this.options.heartbeatMs);
        timer.unref();
        return async () => {
          clearInterval(timer);
          try {
            const current = parseOwner(await readFile(path.join(this.lockPath, "owner.json"), "utf8"));
            if (current?.token === token) await rm(this.lockPath, { recursive: true, force: true });
          } catch { /* A recovered lock must never be removed by an old owner. */ }
        };
      } catch (error) {
        await rm(candidate, { recursive: true, force: true });
        const code = (error as NodeJS.ErrnoException).code;
        const contentionError = readyToRename && ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(code ?? "");
        let lockExists = false;
        if (readyToRename) { try { await stat(this.lockPath); lockExists = true; } catch { /* The owner may have released between rename and inspection. */ } }
        if (!lockExists) {
          if (!contentionError) throw error;
          await delay(this.options.retryMs);
          continue;
        }
        if (await this.recoverIfStale()) continue;
        if (this.options.now() - started >= this.options.timeoutMs) throw new MpxError({ code: "PORT_LOCK_TIMEOUT", message: "Timed out waiting for the port registry lock.", retryable: true });
        await delay(this.options.retryMs);
      }
    }
  }

  private async publishHeartbeat(owner: LockOwner): Promise<void> {
    await writeFile(
      path.join(this.lockPath, "heartbeat.json"),
      JSON.stringify({ version: 1, token: owner.token, heartbeatAt: owner.heartbeatAt }),
      "utf8",
    );
  }

  private async recoverIfStale(): Promise<boolean> {
    const ownerPath = path.join(this.lockPath, "owner.json");
    let owner: LockOwner | undefined;
    try { owner = parseOwner(await readFile(ownerPath, "utf8")); }
    catch { owner = undefined; }

    if (owner) {
      const inspected = await this.options.inspectProcess(owner.pid);
      const ownerFingerprintUnavailable = owner.processStartFingerprint.startsWith("unavailable:");
      if (inspected.alive && (ownerFingerprintUnavailable || inspected.startFingerprint === undefined || inspected.startFingerprint === owner.processStartFingerprint)) return false;
      try {
        const heartbeat = await stat(path.join(this.lockPath, "heartbeat.json"));
        if (this.options.now() - heartbeat.mtimeMs < this.options.emptyOwnerGraceMs) return false;
      } catch {
        try {
          const ownerStatus = await stat(ownerPath);
          if (this.options.now() - ownerStatus.mtimeMs < this.options.emptyOwnerGraceMs) return false;
        } catch { return false; }
      }
    } else {
      try {
        let modifiedAt: number;
        try { modifiedAt = (await stat(ownerPath)).mtimeMs; }
        catch { modifiedAt = (await stat(this.lockPath)).mtimeMs; }
        if (this.options.now() - modifiedAt < this.options.emptyOwnerGraceMs) return false;
      } catch { return false; }
    }

    const recoveryPath = path.join(this.lockPath, ".recovery");
    try { await mkdir(recoveryPath); }
    catch { return false; }

    try {
      let currentOwner: LockOwner | undefined;
      try { currentOwner = parseOwner(await readFile(ownerPath, "utf8")); }
      catch { currentOwner = undefined; }
      if ((owner?.token ?? null) !== (currentOwner?.token ?? null)) return false;

      const quarantine = `${this.lockPath}.stale-${this.options.token()}`;
      await rename(this.lockPath, quarantine);
      await rm(quarantine, { recursive: true, force: true });
      return true;
    } catch { return false; }
    finally { await rm(recoveryPath, { recursive: true, force: true }).catch(() => undefined); }
  }
}
