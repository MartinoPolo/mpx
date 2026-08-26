export * from "./immutable-core.js";
export * from "./transaction.js";
export * from "./windows-integration.js";
export * from "./orchestration.js";
export * from "./runtime-registration.js";

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { MpxError, parseStrictJson } from "@mpx/core";
import type {
  ScheduledTaskAdapter,
  ScheduledTaskInspection,
  ScheduledTaskSpec,
} from "@mpx/windows";

export const INSTALLER_PROTOCOL_VERSION = 1 as const;
export const SESSION_CAPTURE_COMPONENT = "session-capture" as const;
export const SESSION_CAPTURE_TASK_PATH = "\\MPX\\" as const;
export const SESSION_CAPTURE_TASK_NAME = "Session Capture" as const;
const SESSION_CAPTURE_CADENCE_MINUTES = 10;

type ComponentId = typeof SESSION_CAPTURE_COMPONENT;

export interface InstalledRunnerEvidence {
  path: string;
  sha256: string;
  version: string;
}
export interface InstallPlan {
  schemaVersion: 1;
  kind: "install";
  componentId: ComponentId;
  task: ScheduledTaskSpec;
  taskSpecDigest: string;
  runner: InstalledRunnerEvidence;
  confirmationDigest: string;
}
export interface UninstallPlan {
  schemaVersion: 1;
  kind: "uninstall";
  componentId: ComponentId;
  taskSpecDigest: string;
  confirmationDigest: string;
}
export interface OwnershipReceipt {
  schemaVersion: 1;
  componentId: ComponentId;
  taskSpecDigest: string;
  runner: InstalledRunnerEvidence;
  installedAt: string;
}
export interface ComponentVerification {
  schemaVersion: 1;
  componentId: ComponentId;
  installed: boolean;
  healthy: boolean;
  issues: readonly string[];
  receipt?: OwnershipReceipt;
  task?: ScheduledTaskInspection;
}
export interface RunnerFileVerifier {
  verify(evidence: InstalledRunnerEvidence): Promise<InstalledRunnerEvidence>;
}
/** Phase-I trust seam: implementations attest immutable installed-file authority. */
export interface ImmutableRunnerAuthority {
  verifyInstalled(evidence: InstalledRunnerEvidence): Promise<InstalledRunnerEvidence>;
}
export interface ReceiptStore {
  read(componentId: string): Promise<OwnershipReceipt | undefined>;
  write(receipt: OwnershipReceipt): Promise<void>;
  remove(componentId: string): Promise<void>;
  transaction<T>(componentId: string, action: () => Promise<T>): Promise<T>;
}

function error(code: string, message: string): never {
  throw new MpxError({ code, message });
}
function stable(value: unknown): string {
  return JSON.stringify(value, (_, current) =>
    current && typeof current === "object" && !Array.isArray(current)
      ? Object.fromEntries(
          Object.entries(current).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : current,
  );
}
function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}
function evidenceValid(value: InstalledRunnerEvidence): boolean {
  return (
    path.win32.isAbsolute(value.path) &&
    /^[a-f0-9]{64}$/iu.test(value.sha256) &&
    value.version.length > 0
  );
}
function normalize(value: string): string {
  return path.win32
    .normalize(value)
    .replace(/[\\]+$/u, " ")
    .trim()
    .toLowerCase();
}
function within(file: string, root: string): boolean {
  const candidate = normalize(file);
  const parent = normalize(root);
  return candidate === parent || candidate.startsWith(`${parent}\\`);
}
function taskComparable(task: ScheduledTaskSpec | ScheduledTaskInspection) {
  return {
    taskPath: task.taskPath,
    taskName: task.taskName,
    action: {
      executable: path.win32.normalize(task.action.executable),
      argv: [...task.action.argv],
    },
    principal: task.principal,
    trigger: task.trigger,
    settings: task.settings,
  };
}
export function scheduledTaskSpecDigest(task: ScheduledTaskSpec): string {
  return digest(taskComparable(task));
}

export class NodeRunnerFileVerifier implements RunnerFileVerifier {
  constructor(private readonly prohibitedRoots: readonly string[] = []) {}

  async verify(evidence: InstalledRunnerEvidence): Promise<InstalledRunnerEvidence> {
    if (!evidenceValid(evidence))
      error("INSTALL_RUNNER_UNAVAILABLE", "Installed runner evidence is invalid.");
    if (this.prohibitedRoots.some((root) => root && within(evidence.path, root)))
      error(
        "INSTALL_RUNNER_UNAVAILABLE",
        "Runner is in a mutable or source location.",
      );
    const info = await lstat(evidence.path).catch(() =>
      error("INSTALL_RUNNER_UNAVAILABLE", "Installed runner is unavailable."),
    );
    if (!info.isFile() || info.isSymbolicLink())
      error(
        "INSTALL_RUNNER_UNAVAILABLE",
        "Runner must be a regular non-symlink file.",
      );
    const actual = createHash("sha256")
      .update(await readFile(evidence.path))
      .digest("hex");
    if (actual.toLowerCase() !== evidence.sha256.toLowerCase())
      error("INSTALL_RUNNER_STALE", "Installed runner hash changed.");
    return { ...evidence, path: path.win32.normalize(evidence.path), sha256: actual };
  }
}

export class MemoryReceiptStore implements ReceiptStore {
  private value: OwnershipReceipt | undefined;
  private readonly pending = new Map<string, Promise<void>>();

  async read(componentId: string): Promise<OwnershipReceipt | undefined> {
    return this.value?.componentId === componentId
      ? structuredClone(this.value)
      : undefined;
  }
  async write(receipt: OwnershipReceipt): Promise<void> {
    this.value = structuredClone(receipt);
  }
  async remove(componentId: string): Promise<void> {
    if (this.value?.componentId === componentId) this.value = undefined;
  }
  async transaction<T>(componentId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(componentId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => turn);
    this.pending.set(componentId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.pending.get(componentId) === tail) this.pending.delete(componentId);
    }
  }
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const missing = (failure: unknown): boolean =>
  (failure as NodeJS.ErrnoException).code === "ENOENT";

export interface NodeReceiptStoreOptions {
  readonly now?: () => number;
  readonly staleInitializationMilliseconds?: number;
  readonly afterLockInitializerCreated?: (lock: string, token: string) => Promise<void>;
}
export class NodeReceiptStore implements ReceiptStore {
  private readonly now: () => number;
  private readonly staleInitializationMilliseconds: number;
  constructor(
    private readonly directory: string,
    private readonly lockWaitMilliseconds = 5_000,
    private readonly options: NodeReceiptStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.staleInitializationMilliseconds = options.staleInitializationMilliseconds ?? 30_000;
  }

  private file(componentId: string): string {
    if (componentId !== SESSION_CAPTURE_COMPONENT)
      error("INSTALL_COMPONENT_UNSUPPORTED", "Unsupported component.");
    return path.join(this.directory, `${componentId}.json`);
  }
  private async owner(lock: string): Promise<{ pid: number; token: string } | undefined> {
    try {
      const value = parseStrictJson(await readFile(path.join(lock, "owner.json"), "utf8"));
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof (value as { pid?: unknown }).pid !== "number" ||
        typeof (value as { token?: unknown }).token !== "string"
      )
        return undefined;
      return value as { pid: number; token: string };
    } catch (failure) {
      if (missing(failure)) return undefined;
      return undefined;
    }
  }
  private processIsLive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (failure) {
      return (failure as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  private initializer(lock: string, token: string): string {
    return path.join(lock, `initializer-${token}.json`);
  }
  private async ownsInitializer(lock: string, token: string): Promise<boolean> {
    try {
      const value = parseStrictJson(await readFile(this.initializer(lock, token), "utf8"));
      return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { token?: unknown }).token === token);
    } catch { return false; }
  }
  private async removeInitializingLock(lock: string, token: string): Promise<void> {
    const marker = this.initializer(lock, token), claim = path.join(lock, `.initializer-claimed-${token}`);
    try { await rename(marker, claim); } catch { return; }
    const tombstone = `${lock}.initialization-failed-${token}`;
    try { await rename(lock, tombstone); }
    catch (failure) { if (!missing(failure)) throw failure; return; }
    await rm(tombstone, { recursive: true, force: true });
  }
  private async removeOrphanedInitialization(lock: string): Promise<boolean> {
    let names: string[], ageSource = lock;
    try { names = await readdir(lock); } catch { return false; }
    const markers = names.filter(name => /^initializer-[0-9a-f-]+\.json$/u.test(name));
    if (markers.length > 1) return false;
    if (markers.length === 1) ageSource = path.join(lock, markers[0]!);
    let info;
    try { info = await stat(ageSource); } catch { return false; }
    if (this.now() - info.mtimeMs <= this.staleInitializationMilliseconds) return false;
    const claim = path.join(lock, ".orphan-initialization-claim");
    try {
      if (markers.length === 1) await rename(ageSource, claim);
      else await writeFile(claim, "", { flag: "wx", mode: 0o600 });
    } catch { return false; }
    const tombstone = `${lock}.orphan-${randomUUID()}`;
    try { await rename(lock, tombstone); }
    catch (failure) { if (missing(failure)) return false; throw failure; }
    await rm(tombstone, { recursive: true, force: true });
    return true;
  }
  private async removeOwnedLock(lock: string, token: string): Promise<void> {
    if ((await this.owner(lock))?.token !== token) return;
    const tombstone = `${lock}.released-${token}`;
    try {
      await rename(lock, tombstone);
    } catch (failure) {
      if (missing(failure) || (failure as NodeJS.ErrnoException).code === "EEXIST") return;
      throw failure;
    }
    await rm(tombstone, { recursive: true, force: true });
  }
  private async removeDeadOwnerLock(
    lock: string,
    owner: { pid: number; token: string },
  ): Promise<boolean> {
    if (this.processIsLive(owner.pid)) return false;
    if ((await this.owner(lock))?.token !== owner.token) return false;
    const tombstone = `${lock}.dead-${owner.token}-${randomUUID()}`;
    try {
      await rename(lock, tombstone);
    } catch (failure) {
      if (missing(failure) || (failure as NodeJS.ErrnoException).code === "EEXIST")
        return false;
      throw failure;
    }
    await rm(tombstone, { recursive: true, force: true });
    return true;
  }
  async transaction<T>(componentId: string, action: () => Promise<T>): Promise<T> {
    const file = this.file(componentId);
    const lock = `${file}.operation.lock`;
    await mkdir(path.dirname(file), { recursive: true });
    const deadline = this.now() + this.lockWaitMilliseconds;
    const token = randomUUID();
    while (true) {
      try {
        await mkdir(lock);
        try {
          const marker = this.initializer(lock, token);
          await writeFile(marker, JSON.stringify({ token }), { encoding: "utf8", mode: 0o600, flag: "wx" });
          await this.options.afterLockInitializerCreated?.(lock, token);
          if (!await this.ownsInitializer(lock, token))
            error("INSTALL_LOCK_OWNERSHIP_LOST", "Component ownership lock initialization was superseded.");
          await writeFile(
            path.join(lock, "owner.json"),
            JSON.stringify({ pid: process.pid, token }),
            { encoding: "utf8", mode: 0o600, flag: "wx" },
          );
          await rm(marker);
        } catch (failure) {
          await this.removeInitializingLock(lock, token);
          throw failure;
        }
        break;
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "EEXIST") throw failure;
        const currentOwner = await this.owner(lock);
        if (currentOwner && (await this.removeDeadOwnerLock(lock, currentOwner)))
          continue;
        if (!currentOwner && await this.removeOrphanedInitialization(lock)) continue;
        if (this.now() >= deadline)
          error("INSTALL_LOCK_TIMEOUT", "Timed out waiting for component ownership lock.");
        await wait(10);
      }
    }
    try {
      return await action();
    } finally {
      await this.removeOwnedLock(lock, token);
    }
  }
  async read(componentId: string): Promise<OwnershipReceipt | undefined> {
    try {
      return parseOwnershipReceipt(
        parseStrictJson(await readFile(this.file(componentId), "utf8")),
      );
    } catch (failure) {
      if (missing(failure)) return undefined;
      if (failure instanceof MpxError) throw failure;
      error("INSTALL_RECEIPT_INVALID", "Ownership receipt is invalid.");
    }
  }
  async write(receipt: OwnershipReceipt): Promise<void> {
    const file = this.file(receipt.componentId);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(receipt), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporary, 0o600);
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  async remove(componentId: string): Promise<void> {
    await rm(this.file(componentId), { force: true });
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    error("INSTALL_SCHEMA_INVALID", "Invalid protocol object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== [...keys].sort().join())
    error("INSTALL_SCHEMA_INVALID", "Unknown or missing protocol field.");
  return record;
}
export function parseOwnershipReceipt(value: unknown): OwnershipReceipt {
  const receipt = exactRecord(value, [
    "schemaVersion",
    "componentId",
    "taskSpecDigest",
    "runner",
    "installedAt",
  ]);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.componentId !== SESSION_CAPTURE_COMPONENT ||
    typeof receipt.taskSpecDigest !== "string" ||
    typeof receipt.installedAt !== "string"
  )
    error("INSTALL_RECEIPT_INVALID", "Ownership receipt is invalid.");
  const runner = exactRecord(receipt.runner, ["path", "sha256", "version"]) as unknown as InstalledRunnerEvidence;
  if (!evidenceValid(runner))
    error("INSTALL_RECEIPT_INVALID", "Ownership receipt is invalid.");
  return receipt as unknown as OwnershipReceipt;
}

export interface InstallerServiceOptions {
  tasks: ScheduledTaskAdapter;
  store: ReceiptStore;
  files?: RunnerFileVerifier;
  authority?: ImmutableRunnerAuthority;
  currentUser: string;
  cwd?: string;
  prohibitedRoots?: readonly string[];
  now?: () => Date;
}

export class InstallerService {
  private readonly now: () => Date;
  private readonly forbidden: readonly string[];

  constructor(private readonly options: InstallerServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.forbidden = [
      options.cwd ?? process.cwd(),
      ...(options.prohibitedRoots ?? []),
      process.env.MPX_PROJECTS,
      process.env.MPX_WORK,
      process.env.MPX_CLONED,
    ].filter((value): value is string => Boolean(value));
  }
  private component(componentId: string): asserts componentId is ComponentId {
    if (componentId !== SESSION_CAPTURE_COMPONENT)
      error("INSTALL_COMPONENT_UNSUPPORTED", "Only session-capture is supported.");
  }
  private async runner(evidence: InstalledRunnerEvidence): Promise<InstalledRunnerEvidence> {
    const authority = this.options.authority;
    if (
      !evidenceValid(evidence) ||
      this.forbidden.some((root) => within(evidence.path, root)) ||
      !authority
    )
      error(
        "INSTALL_RUNNER_UNAVAILABLE",
        "Immutable installed runner authority is unavailable.",
      );
    const actual = await authority.verifyInstalled(evidence);
    if (stable(actual) !== stable(evidence))
      error("INSTALL_RUNNER_STALE", "Runner evidence is stale.");
    return actual;
  }
  private spec(evidence: InstalledRunnerEvidence): ScheduledTaskSpec {
    return {
      taskPath: SESSION_CAPTURE_TASK_PATH,
      taskName: SESSION_CAPTURE_TASK_NAME,
      action: {
        executable: evidence.path,
        argv: ["session", "reconcile", "--capture", "scheduled", "--json"],
      },
      principal: {
        userId: this.options.currentUser,
        logonType: "InteractiveToken",
        runLevel: "LeastPrivilege",
      },
      trigger: { cadenceMinutes: SESSION_CAPTURE_CADENCE_MINUTES },
      settings: {
        startWhenAvailable: true,
        multipleInstances: "IgnoreNew",
        executionTimeLimitSeconds: 300,
        hidden: true,
        enabled: true,
      },
    };
  }
  async plan(input: {
    componentId: string;
    runner: InstalledRunnerEvidence;
  }): Promise<InstallPlan> {
    this.component(input.componentId);
    if (!this.options.tasks.available)
      error("INSTALL_CAPABILITY_UNAVAILABLE", "Scheduled tasks are unavailable.");
    const runner = await this.runner(input.runner);
    const task = this.spec(runner);
    const taskSpecDigest = scheduledTaskSpecDigest(task);
    const base = {
      schemaVersion: 1 as const,
      kind: "install" as const,
      componentId: SESSION_CAPTURE_COMPONENT,
      task,
      taskSpecDigest,
      runner,
    };
    return { ...base, confirmationDigest: digest(base) };
  }
  async apply(plan: InstallPlan, confirmationDigest: string): Promise<OwnershipReceipt> {
    this.component(plan.componentId);
    const base = {
      schemaVersion: plan.schemaVersion,
      kind: plan.kind,
      componentId: plan.componentId,
      task: plan.task,
      taskSpecDigest: plan.taskSpecDigest,
      runner: plan.runner,
    };
    if (
      confirmationDigest !== plan.confirmationDigest ||
      digest(base) !== plan.confirmationDigest
    )
      error("INSTALL_CONFIRMATION_MISMATCH", "Exact plan confirmation is required.");
    const runner = await this.runner(plan.runner);
    const expected = this.spec(runner);
    if (
      scheduledTaskSpecDigest(expected) !== plan.taskSpecDigest ||
      stable(taskComparable(expected)) !== stable(taskComparable(plan.task))
    )
      error("INSTALL_PLAN_STALE", "Install plan is stale.");

    return this.options.store.transaction(plan.componentId, async () => {
      const existing = await this.options.tasks.inspect(
        SESSION_CAPTURE_TASK_PATH,
        SESSION_CAPTURE_TASK_NAME,
      );
      const receipt = await this.options.store.read(plan.componentId);
      if (
        existing &&
        (receipt?.taskSpecDigest !== plan.taskSpecDigest ||
          stable(taskComparable(existing)) !== stable(taskComparable(expected)))
      )
        error(
          "INSTALL_FOREIGN_TASK",
          "Refusing to overwrite a foreign or drifted task.",
        );
      if (receipt && receipt.taskSpecDigest !== plan.taskSpecDigest)
        error("INSTALL_OWNERSHIP_MISMATCH", "Ownership receipt does not match.");
      const next: OwnershipReceipt = receipt ?? {
        schemaVersion: 1,
        componentId: SESSION_CAPTURE_COMPONENT,
        taskSpecDigest: plan.taskSpecDigest,
        runner,
        installedAt: this.now().toISOString(),
      };
      // Receipt-before-install keeps a failed task creation safely retryable.
      if (!receipt) await this.options.store.write(next);
      if (!existing) await this.options.tasks.install(expected);
      return next;
    });
  }
  async verify(componentId: string): Promise<ComponentVerification> {
    this.component(componentId);
    if (!this.options.tasks.available)
      error("INSTALL_CAPABILITY_UNAVAILABLE", "Scheduled tasks are unavailable.");
    const [task, receipt] = await Promise.all([
      this.options.tasks.inspect(SESSION_CAPTURE_TASK_PATH, SESSION_CAPTURE_TASK_NAME),
      this.options.store.read(componentId),
    ]);
    const issues: string[] = [];
    if (!receipt) issues.push("receipt-missing");
    if (!task) issues.push("task-missing");
    if (task && receipt && scheduledTaskSpecDigest(task) !== receipt.taskSpecDigest)
      issues.push("task-drift");
    if (task && task.lastRunAt === undefined) issues.push("task-never-ran");
    if (task?.lastRunAt !== undefined) {
      const lastRunAt = Date.parse(task.lastRunAt);
      const now = this.now().getTime();
      const allowedDistance = SESSION_CAPTURE_CADENCE_MINUTES * 2 * 60_000;
      if (!Number.isFinite(lastRunAt) || now - lastRunAt > allowedDistance || lastRunAt - now > allowedDistance)
        issues.push("task-last-run-stale");
    }
    if (task?.lastResult !== undefined && task.lastResult !== 0)
      issues.push("task-last-run-failed");
    if (receipt) {
      try {
        await this.runner(receipt.runner);
      } catch (failure) {
        if ((failure as { code?: unknown }).code === "INSTALL_RUNNER_UNAVAILABLE")
          throw failure;
        issues.push("runner-drift");
      }
    }
    return {
      schemaVersion: 1,
      componentId: SESSION_CAPTURE_COMPONENT,
      installed: Boolean(task && receipt),
      healthy: issues.length === 0,
      issues,
      ...(receipt ? { receipt } : {}),
      ...(task ? { task } : {}),
    };
  }
  async planUninstall(componentId: string): Promise<UninstallPlan> {
    this.component(componentId);
    const receipt = await this.options.store.read(componentId);
    if (!receipt) error("INSTALL_NOT_OWNED", "No owned installation exists.");
    const base = {
      schemaVersion: 1 as const,
      kind: "uninstall" as const,
      componentId: SESSION_CAPTURE_COMPONENT,
      taskSpecDigest: receipt.taskSpecDigest,
    };
    return { ...base, confirmationDigest: digest(base) };
  }
  async uninstall(plan: UninstallPlan, confirmation: string): Promise<void> {
    this.component(plan.componentId);
    const base = {
      schemaVersion: plan.schemaVersion,
      kind: plan.kind,
      componentId: plan.componentId,
      taskSpecDigest: plan.taskSpecDigest,
    };
    if (confirmation !== plan.confirmationDigest || digest(base) !== confirmation)
      error(
        "INSTALL_CONFIRMATION_MISMATCH",
        "Exact uninstall confirmation is required.",
      );

    await this.options.store.transaction(plan.componentId, async () => {
      const receipt = await this.options.store.read(plan.componentId);
      const task = await this.options.tasks.inspect(
        SESSION_CAPTURE_TASK_PATH,
        SESSION_CAPTURE_TASK_NAME,
      );
      if (!receipt || receipt.taskSpecDigest !== plan.taskSpecDigest)
        error("INSTALL_NOT_OWNED", "Ownership does not match.");
      if (task && scheduledTaskSpecDigest(task) !== receipt.taskSpecDigest)
        error(
          "INSTALL_FOREIGN_TASK",
          "Refusing to remove a foreign or drifted task.",
        );
      if (task)
        await this.options.tasks.remove(
          SESSION_CAPTURE_TASK_PATH,
          SESSION_CAPTURE_TASK_NAME,
        );
      await this.options.store.remove(plan.componentId);
    });
  }
}
