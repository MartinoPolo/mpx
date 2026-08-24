import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PortService, RegistryStore, type GitWorktreeAdapter, type PortPlatformAdapter, type RegistryState, type WorktreeIdentity } from "./index.js";
import type { ProjectConfig } from "@mpx/config";
import { MpxError, sha256Canonical, type JsonValue } from "@mpx/core";
const roots: string[] = []; const temp = async () => { const root = await mkdtemp(path.join(tmpdir(), "mpx-service-")); roots.push(root); return root; };
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const identity = (repo: string, id: string, worktreePath: string, role: "main"|"linked"): WorktreeIdentity => ({ repositoryId: repo, worktreeId: id, path: worktreePath, role, commonGitPath: `${worktreePath}/.git-common`, gitAdminPath: `${worktreePath}/.git`, head: "abc" });
const platform: PortPlatformAdapter = { holdAvailablePorts: async () => ({ release: async () => undefined }), inspectListeners: async () => [], killProcess: async () => undefined, inspectProcess: async () => undefined };
const config = (projectId = "project", scope: "checkout"|"project" = "checkout", mode: "managed"|"fixed-shared" = "managed"): ProjectConfig => ({ schemaVersion: 1, project: { id: projectId.includes("/") ? projectId : `fixture/${projectId}` }, repository: { provider: "generic", remote: "x" }, development: { services: { app: { scope, port: { mode, preferred: 5100 }, start: { type: "package-script", script: "dev" } } } } });
const git = (current: WorktreeIdentity, all = [current]): GitWorktreeAdapter => ({ identify: async () => current, list: async () => all });
const request = (cwd: string, value: ProjectConfig = config()) => ({ cwd, config: value, configHash: sha256Canonical(value as unknown as JsonValue) });
class RepairTransactionProbeStore extends RegistryStore {
  private calls = 0;
  constructor(stateRoot: string, private readonly secondTransactionEntered: () => void) { super(stateRoot); }
  override async transaction<T>(operation: (state: RegistryState) => T | Promise<T>): Promise<T> {
    if (++this.calls === 2) this.secondTransactionEntered();
    return super.transaction(operation);
  }
}
class ReleaseTransactionProbeStore extends RegistryStore {
  constructor(stateRoot: string, private readonly transactionCompleted: () => void) { super(stateRoot); }
  override async transaction<T>(operation: (state: RegistryState) => T | Promise<T>): Promise<T> {
    return super.transaction(async (state) => { const result = await operation(state); this.transactionCompleted(); return result; });
  }
}
class PausePublicationStore extends RegistryStore {
  private transactions = 0;
  constructor(stateRoot: string, private readonly publicationStarted: () => void, private readonly resume: Promise<void>) { super(stateRoot); }
  override async transaction<T>(operation: (state: RegistryState) => T | Promise<T>): Promise<T> {
    if (++this.transactions === 2) { this.publicationStarted(); await this.resume; }
    return super.transaction(operation);
  }
}

describe("PortService leases", () => {
  it("keeps repeated ensure stable after the main reservation", async () => {
    const root = await temp(), mainPath = await temp(), linkedPath = await temp(); const main = identity("repo", "main", mainPath, "main"), linked = identity("repo", "linked", linkedPath, "linked");
    await new PortService({ store: new RegistryStore(root), git: git(main, [main, linked]), platform }).ensure(request(mainPath));
    const service = new PortService({ store: new RegistryStore(root), git: git(linked, [main, linked]), platform });
    const first = await service.ensure(request(linkedPath)); const second = await service.ensure(request(linkedPath));
    expect(first.lease).toMatchObject({ slot: 1, services: { app: 5101 } }); expect(second.lease.leaseId).toBe(first.lease.leaseId);
    expect((await service.list()).map(({ role, slot }) => [role, slot])).toEqual(expect.arrayContaining([["main", 0], ["linked", 1]]));
  });
  it("advances linked allocation across repositories and shares project-scoped reservations", async () => {
    const root = await temp(), onePath = await temp(), twoPath = await temp(), linkedPath = await temp();
    const one = new PortService({ store: new RegistryStore(root), git: git(identity("r1", "m1", onePath, "main")), platform }); await one.ensure(request(onePath, config("one")));
    const two = new PortService({ store: new RegistryStore(root), git: git(identity("r2", "m2", twoPath, "main")), platform }); await expect(two.ensure(request(twoPath, config("two")))).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    const sharedRoot = await temp(); const main = identity("r3", "m3", twoPath, "main"), linked = identity("r3", "l3", linkedPath, "linked"); const shared = new PortService({ store: new RegistryStore(sharedRoot), git: git(main, [main, linked]), platform });
    await shared.ensure(request(twoPath, config("shared", "project")));
    const linkedService = new PortService({ store: new RegistryStore(sharedRoot), git: git(linked, [main, linked]), platform });
    const linkedResult = await linkedService.ensure(request(linkedPath, config("shared", "project")));
    expect(linkedResult.lease).toMatchObject({ slot: 1, services: { app: 5100 } });
    expect(await linkedService.resolve(request(linkedPath, config("shared", "project")))).toMatchObject({ services: { app: 5100 } });
  });
  it("rejects linked allocations against an obsolete main config", async () => {
    const root = await temp(), mainPath = await temp(), linkedPath = await temp();
    const main = identity("repo", "main", mainPath, "main"), linked = identity("repo", "linked", linkedPath, "linked");
    const original = config(); await new PortService({ store: new RegistryStore(root), git: git(main, [main, linked]), platform }).ensure(request(mainPath, original));
    const changed = { ...original, repository: { ...original.repository, remote: "changed" } };
    const service = new PortService({ store: new RegistryStore(root), git: git(linked, [main, linked]), platform });
    await expect(service.ensure(request(linkedPath, changed))).rejects.toMatchObject({ code: "PORT_CONFIG_MISMATCH" });
  });

  it("rejects changing the main config while linked leases remain and preserves the original leases", async () => {
    const root = await temp(), mainPath = await temp(), linkedPath = await temp();
    const main = identity("repo", "main", mainPath, "main"), linked = identity("repo", "linked", linkedPath, "linked");
    const service = new PortService({ store: new RegistryStore(root), git: git(main, [main, linked]), platform });
    const original = config(); await service.ensure(request(mainPath, original));
    await new PortService({ store: new RegistryStore(root), git: git(linked, [main, linked]), platform }).ensure(request(linkedPath, original));
    const before = await service.list(); const changed = { ...original, repository: { ...original.repository, remote: "changed" } };
    await expect(service.ensure(request(mainPath, changed))).rejects.toMatchObject({ code: "PORT_CONFIG_MISMATCH" });
    expect(await service.list()).toEqual(before);
  });

  it("uses Git's current main identity for linked ensure and resolve and reconcile removes the stale main", async () => {
    const root = await temp(), oldMainPath = await temp(), newMainPath = await temp(), linkedPath = await temp();
    const oldMain = identity("repo", "old-main", oldMainPath, "main"), newMain = identity("repo", "new-main", newMainPath, "main"), linked = identity("repo", "linked", linkedPath, "linked");
    await new PortService({ store: new RegistryStore(root), git: git(oldMain, [oldMain, linked]), platform }).ensure(request(oldMainPath));
    await new PortService({ store: new RegistryStore(root), git: git(linked, [oldMain, linked]), platform }).ensure(request(linkedPath));
    const service = new PortService({ store: new RegistryStore(root), git: git(linked, [newMain, linked]), platform });
    await expect(service.ensure(request(linkedPath))).rejects.toMatchObject({ code: "PORT_MAIN_RESERVATION_REQUIRED" });
    await expect(service.resolve(request(linkedPath))).rejects.toMatchObject({ code: "PORT_MAIN_RESERVATION_REQUIRED" });
    expect((await service.reconcile({ cwd: linkedPath })).removed).toContain("old-main");
    expect((await service.list()).map(({ worktreeId }) => worktreeId)).toEqual([]);
  });

  it("rejects changing the main project ID while linked leases remain and preserves state", async () => {
    const root = await temp(), mainPath = await temp(), linkedPath = await temp();
    const main = identity("repo", "main", mainPath, "main"), linked = identity("repo", "linked", linkedPath, "linked");
    const service = new PortService({ store: new RegistryStore(root), git: git(main, [main, linked]), platform });
    await service.ensure(request(mainPath));
    await new PortService({ store: new RegistryStore(root), git: git(linked, [main, linked]), platform }).ensure(request(linkedPath));
    const before = await service.list();
    await expect(service.ensure(request(mainPath, config("renamed")))).rejects.toMatchObject({ code: "PORT_CONFIG_MISMATCH" });
    expect(await service.list()).toEqual(before);
  });

  it("rejects a superseded same-main ensure before publishing its projection", async () => {
    const root = await temp(), cwd = await temp();
    const current = identity("repo", "main", cwd, "main");
    const first = config();
    const second = { ...first, repository: { ...first.repository, remote: "changed" } };
    let signalPublication!: () => void;
    const publicationStarted = new Promise<void>((resolve) => { signalPublication = resolve; });
    let resumePublication!: () => void;
    const publicationResume = new Promise<void>((resolve) => { resumePublication = resolve; });
    const serviceA = new PortService({ store: new PausePublicationStore(root, signalPublication, publicationResume), git: git(current), platform });
    const serviceB = new PortService({ store: new RegistryStore(root), git: git(current), platform });
    const ensuringA = serviceA.ensure(request(cwd, first));
    await publicationStarted;
    const resultB = await serviceB.ensure(request(cwd, second));
    resumePublication();
    await expect(ensuringA).rejects.toMatchObject({ code: "PORT_ENSURE_SUPERSEDED", retryable: true });
    const registry = await serviceB.list();
    expect(registry).toEqual([resultB.lease]);
    expect(JSON.parse(await readFile(path.join(cwd, ".worktree-ports.json"), "utf8"))).toMatchObject({ leaseId: resultB.lease.leaseId, projectId: resultB.lease.projectId, worktreeId: resultB.lease.worktreeId, configHash: resultB.lease.configHash, services: resultB.lease.services });
  });

  it("warns but permits duplicate fixed-shared claims", async () => {
    const root = await temp(), a = await temp(), b = await temp();
    await new PortService({ store: new RegistryStore(root), git: git(identity("a", "a", a, "main")), platform }).ensure(request(a, config("a", "checkout", "fixed-shared")));
    const result = await new PortService({ store: new RegistryStore(root), git: git(identity("b", "b", b, "main")), platform }).ensure(request(b, config("b", "checkout", "fixed-shared")));
    expect(result.warnings).toEqual([expect.objectContaining({ code: "FIXED_SHARED_DUPLICATE" })]);
  });

  it("canonicalizes duplicate fixed-shared services into one shared claim", async () => {
    const root = await temp(), cwd = await temp();
    const cfg: ProjectConfig = { ...config(), development: { services: {
      first: { scope: "checkout", port: { mode: "fixed-shared", preferred: 5100 }, start: { type: "package-script", script: "first" } },
      second: { scope: "checkout", port: { mode: "fixed-shared", preferred: 5100 }, start: { type: "package-script", script: "second" } },
    } } };
    const result = await new PortService({ store: new RegistryStore(root), git: git(identity("r", "w", cwd, "main")), platform }).ensure(request(cwd, cfg));
    expect(result.lease.services).toEqual({ first: 5100, second: 5100 });
    expect(result.lease.claims).toEqual([{ port: 5100, exclusive: false }]);
  });

  it("rejects a managed and fixed-shared service resolving to the same port", async () => {
    const root = await temp(), cwd = await temp();
    const cfg: ProjectConfig = { ...config(), development: { services: {
      managed: { scope: "checkout", port: { mode: "managed", preferred: 5100 }, start: { type: "package-script", script: "managed" } },
      shared: { scope: "checkout", port: { mode: "fixed-shared", preferred: 5100 }, start: { type: "package-script", script: "shared" } },
    } } };
    const service = new PortService({ store: new RegistryStore(root), git: git(identity("r", "w", cwd, "main")), platform });
    await expect(service.ensure(request(cwd, cfg))).rejects.toMatchObject({ code: "PORT_SERVICE_PORT_COLLISION" });
    expect(await service.list()).toEqual([]);
  });

  it("retries a linked bind-time race by advancing every family together", async () => {
    const root = await temp(), mainPath = await temp(), linkedPath = await temp();
    const main = identity("r", "m", mainPath, "main"), linked = identity("r", "l", linkedPath, "linked");
    const cfg: ProjectConfig = { ...config(), development: { services: {
      web: { scope: "checkout", port: { mode: "managed", preferred: 5100, family: "web" }, start: { type: "package-script", script: "web" } },
      api: { scope: "checkout", port: { mode: "managed", preferred: 5200, family: "api" }, start: { type: "package-script", script: "api" } },
    } } };
    await new PortService({ store: new RegistryStore(root), git: git(main, [main, linked]), platform }).ensure(request(mainPath, cfg));
    const attempts: number[][] = []; const racingPlatform: PortPlatformAdapter = { ...platform, holdAvailablePorts: async (ports) => {
      attempts.push([...ports]);
      if (attempts.length === 1) throw new MpxError({ code: "PORT_UNAVAILABLE", message: "lost bind race" });
      return { release: async () => undefined };
    } };
    const result = await new PortService({ store: new RegistryStore(root), git: git(linked, [main, linked]), platform: racingPlatform }).ensure(request(linkedPath, cfg));
    expect(attempts).toEqual([[5101, 5201], [5102, 5202]]);
    expect(result.lease).toMatchObject({ slot: 2, services: { api: 5202, web: 5102 } });
  });
  it("rejects malformed and copied lease files and recovers the registry lease after local write failure", async () => {
    const root = await temp(), cwd = await temp(); let fail = true;
    const service = new PortService({ store: new RegistryStore(root), git: git(identity("r", "w", cwd, "main")), platform, writeLeaseFile: async (file, value) => { if (fail) { fail = false; throw new Error("disk"); } const { writeFile } = await import("node:fs/promises"); await writeFile(file, value); } });
    await expect(service.ensure(request(cwd))).rejects.toThrow("disk"); const retry = await service.ensure(request(cwd));
    expect((await service.resolve(request(cwd))).leaseId).toBe(retry.lease.leaseId);
    const file = path.join(cwd, ".worktree-ports.json"); await (await import("node:fs/promises")).writeFile(file, "{}"); await expect(service.resolve(request(cwd))).rejects.toMatchObject({ code: "PORT_LEASE_INVALID" });
    await (await import("node:fs/promises")).writeFile(file, JSON.stringify({ schemaVersion: 1, leaseId: retry.lease.leaseId, projectId: "project", worktreeId: "copied", configHash: retry.lease.configHash, services: { app: 5100 } })); await expect(service.resolve(request(cwd))).rejects.toMatchObject({ code: "PORT_LEASE_MISMATCH" });
  });
  it("rejects forged hashes and linked-first reservation", async () => {
    const root = await temp(), mainPath = await temp(), linkedPath = await temp(); const main = identity("r", "m", mainPath, "main"), linked = identity("r", "l", linkedPath, "linked");
    const mainService = new PortService({ store: new RegistryStore(root), git: git(main, [main, linked]), platform });
    await expect(mainService.ensure({ ...request(mainPath), configHash: "0".repeat(64) })).rejects.toMatchObject({ code: "PORT_CONFIG_HASH_MISMATCH" });
    await expect(mainService.resolve({ ...request(mainPath), configHash: "0".repeat(64) })).rejects.toMatchObject({ code: "PORT_CONFIG_HASH_MISMATCH" });
    await expect(new PortService({ store: new RegistryStore(root), git: git(linked, [main, linked]), platform }).ensure(request(linkedPath))).rejects.toMatchObject({ code: "PORT_MAIN_RESERVATION_REQUIRED" });
    const withoutGitMain = new PortService({ store: new RegistryStore(root), git: git(linked, [linked]), platform });
    await expect(withoutGitMain.ensure(request(linkedPath))).rejects.toMatchObject({ code: "PORT_MAIN_NOT_FOUND" });
    await expect(withoutGitMain.resolve(request(linkedPath))).rejects.toMatchObject({ code: "PORT_MAIN_NOT_FOUND" });
  });

  it("authorizes kill only for exclusive claims with a fingerprint and forwards it exactly", async () => {
    const root = await temp(), cwd = await temp(); const store = new RegistryStore(root); const cfg = config(); const hash = request(cwd, cfg).configHash;
    const base = { leaseId: "lease", projectId: "project", repositoryId: "r", worktreeId: "w", worktreePath: cwd, role: "main" as const, slot: 0, configHash: hash, services: { app: 5100 }, claims: [{ port: 5100, exclusive: true }], updatedAt: 1 };
    await store.write({ schemaVersion: 1, leases: [base] }); let killed: unknown;
    const adapter = (listener: { port: number; pid: number; projectPath?: string; startedAt?: string }): PortPlatformAdapter => ({ ...platform, inspectListeners: async () => [listener], killProcess: async (fingerprint) => { killed = fingerprint; } });
    await new PortService({ store, git: git(identity("r", "w", cwd, "main")), platform: adapter({ port: 5100, pid: 42, projectPath: path.join(cwd, "apps/web"), startedAt: "start-exact" }) }).kill(42);
    expect(killed).toEqual({ pid: 42, startedAt: "start-exact" });
    killed = undefined;
    await new PortService({ store, git: git(identity("r", "w", cwd, "main")), platform: adapter({ port: 5100, pid: 42, startedAt: "without-path" }) }).kill(42);
    expect(killed).toEqual({ pid: 42, startedAt: "without-path" });
    await expect(new PortService({ store, git: git(identity("r", "w", cwd, "main")), platform: adapter({ port: 5100, pid: 42 }) }).kill(42)).rejects.toMatchObject({ code: "PROCESS_FINGERPRINT_UNAVAILABLE" });
    await store.write({ schemaVersion: 1, leases: [{ ...base, claims: [{ port: 5100, exclusive: false }] }] });
    await expect(new PortService({ store, git: git(identity("r", "w", cwd, "main")), platform: adapter({ port: 5100, pid: 42, projectPath: cwd, startedAt: "start" }) }).kill(42)).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_UNVERIFIED" });
  });

  it("rejects malformed local lease identities, hashes, names, ports, and unknown fields", async () => {
    const root = await temp(), cwd = await temp(); const service = new PortService({ store: new RegistryStore(root), git: git(identity("r", "w", cwd, "main")), platform }); const ensured = await service.ensure(request(cwd)); const file = path.join(cwd, ".worktree-ports.json");
    for (const malformed of [
      { ...await service.resolve(request(cwd)), leaseId: "" },
      { ...await service.resolve(request(cwd)), configHash: "A".repeat(64) },
      { ...await service.resolve(request(cwd)), services: { "": 5100 } },
      { ...await service.resolve(request(cwd)), services: { app: 0 } },
      { ...await service.resolve(request(cwd)), unknown: true },
    ]) { await (await import("node:fs/promises")).writeFile(file, JSON.stringify(malformed)); await expect(service.resolve(request(cwd))).rejects.toMatchObject({ code: "PORT_LEASE_INVALID" }); await (await import("node:fs/promises")).writeFile(file, `${JSON.stringify({ schemaVersion: 1, leaseId: ensured.lease.leaseId, projectId: ensured.lease.projectId, worktreeId: ensured.lease.worktreeId, configHash: ensured.lease.configHash, services: ensured.lease.services })}\n`); }
  });

  it.each(["missing", "corrupt"] as const)("strictly rebuilds a %s registry from deduplicated roots", async (registryState) => {
    const stateRoot = await temp(), scanRoot = await temp(); const mainPath = path.join(scanRoot, "main"), linkedPath = path.join(scanRoot, "linked"); await mkdir(mainPath); await mkdir(linkedPath);
    const main = identity("rebuild-repo", "main", mainPath, "main"), linked = identity("rebuild-repo", "linked", linkedPath, "linked"), all = [main, linked];
    const adapter: GitWorktreeAdapter = { identify: async (cwd) => path.resolve(cwd).startsWith(path.resolve(linkedPath)) ? linked : main, list: async () => all };
    const cfg = config(); await Promise.all([mainPath, linkedPath].map((directory) => writeFile(path.join(directory, "mpxconfig.json"), JSON.stringify(cfg))));
    const service = new PortService({ store: new RegistryStore(stateRoot), git: adapter, platform, now: () => 10 });
    await service.ensure(request(mainPath, cfg)); await service.ensure(request(linkedPath, cfg));
    if (registryState === "missing") await unlink(path.join(stateRoot, "ports-registry.json"));
    else await writeFile(path.join(stateRoot, "ports-registry.json"), "{corrupt");
    const result = await service.rebuild({ roots: [scanRoot, scanRoot, mainPath] });
    expect(result).toEqual({ discovered: 2, rebuilt: 2, roots: 1 });
    expect((await service.list()).map(({ worktreeId, slot }) => [worktreeId, slot])).toEqual(expect.arrayContaining([["linked", 1], ["main", 0]]));
  });

  it("rebuild assigns stable positive slots to project-only linked leases", async () => {
    const stateRoot = await temp(), scanRoot = await temp(), mainPath = path.join(scanRoot, "main"), linkedPath = path.join(scanRoot, "linked"); await mkdir(mainPath); await mkdir(linkedPath);
    const main = identity("project-only", "main", mainPath, "main"), linked = identity("project-only", "linked", linkedPath, "linked"), all = [main, linked];
    const adapter: GitWorktreeAdapter = { identify: async (cwd) => path.resolve(cwd) === path.resolve(linkedPath) ? linked : main, list: async () => all };
    const cfg = config("project-only", "project"); await Promise.all([mainPath, linkedPath].map((directory) => writeFile(path.join(directory, "mpxconfig.json"), JSON.stringify(cfg))));
    const service = new PortService({ store: new RegistryStore(stateRoot), git: adapter, platform });
    await service.ensure(request(mainPath, cfg)); await service.ensure(request(linkedPath, cfg)); await unlink(path.join(stateRoot, "ports-registry.json"));
    await service.rebuild({ roots: [scanRoot] });
    expect((await service.list()).map(({ worktreeId, slot }) => [worktreeId, slot])).toEqual(expect.arrayContaining([["main", 0], ["linked", 1]]));
    expect(await service.resolve(request(linkedPath, cfg))).toMatchObject({ services: { app: 5100 } });
  });

  it("holds the registry lock throughout rebuild scanning and preserves a following transaction", async () => {
    const stateRoot = await temp(), scanRoot = await temp(), cwd = path.join(scanRoot, "main"); await mkdir(cwd);
    const current = identity("rebuild-repo", "main", cwd, "main"), cfg = config(); await writeFile(path.join(cwd, "mpxconfig.json"), JSON.stringify(cfg));
    let pauseRebuild = false; let reachedScan!: () => void; let resumeScan!: () => void;
    const scanReached = new Promise<void>((resolve) => { reachedScan = resolve; });
    const scanResumed = new Promise<void>((resolve) => { resumeScan = resolve; });
    const adapter: GitWorktreeAdapter = { identify: async () => { if (pauseRebuild) { reachedScan(); await scanResumed; } return current; }, list: async () => [current] };
    const store = new RegistryStore(stateRoot, { retryMs: 1 }); const service = new PortService({ store, git: adapter, platform });
    await service.ensure(request(cwd, cfg)); pauseRebuild = true;
    const rebuilding = service.rebuild({ roots: [scanRoot] }); await scanReached;
    let transactionEntered = false;
    const following = store.transaction((state) => { transactionEntered = true; state.leases.push({ leaseId: "following", projectId: "following", repositoryId: "following", worktreeId: "following", worktreePath: cwd, role: "main", slot: 0, configHash: "f".repeat(64), services: { app: 5200 }, claims: [{ port: 5200, exclusive: true }], updatedAt: 1 }); });
    await new Promise((resolve) => setTimeout(resolve, 20)); expect(transactionEntered).toBe(false);
    resumeScan(); await rebuilding; await following;
    expect((await store.read()).leases.map(({ leaseId }) => leaseId)).toContain("following");
  });

  it("rejects tampered rebuild projections and linked candidates without a rebuilt main", async () => {
    const stateRoot = await temp(), scanRoot = await temp(); const mainPath = path.join(scanRoot, "main"), linkedPath = path.join(scanRoot, "linked"); await mkdir(mainPath); await mkdir(linkedPath);
    const main = identity("rebuild-repo", "main", mainPath, "main"), linked = identity("rebuild-repo", "linked", linkedPath, "linked"), all = [main, linked];
    const adapter: GitWorktreeAdapter = { identify: async (cwd) => path.resolve(cwd).startsWith(path.resolve(linkedPath)) ? linked : main, list: async () => all };
    const cfg = config(); await Promise.all([mainPath, linkedPath].map((directory) => writeFile(path.join(directory, "mpxconfig.json"), JSON.stringify(cfg))));
    const service = new PortService({ store: new RegistryStore(stateRoot), git: adapter, platform });
    await service.ensure(request(mainPath, cfg)); await service.ensure(request(linkedPath, cfg));
    await expect(service.rebuild({ roots: [linkedPath] })).rejects.toMatchObject({ code: "PORT_REBUILD_INVALID" });
    const mainProjectionPath = path.join(mainPath, ".worktree-ports.json"); const projection = JSON.parse(await readFile(mainProjectionPath, "utf8")) as { services: Record<string, number> };
    projection.services.app = 5999; await writeFile(mainProjectionPath, JSON.stringify(projection));
    await expect(service.rebuild({ roots: [scanRoot] })).rejects.toMatchObject({ code: "PORT_REBUILD_INVALID" });
  });

  it("rejects tampered rebuild hashes and symbolic-link projections without changing the registry", async () => {
    const stateRoot = await temp(), scanRoot = await temp(), cwd = path.join(scanRoot, "main"); await mkdir(cwd);
    const current = identity("rebuild-repo", "main", cwd, "main"), cfg = config(); await writeFile(path.join(cwd, "mpxconfig.json"), JSON.stringify(cfg));
    const service = new PortService({ store: new RegistryStore(stateRoot), git: git(current), platform }); await service.ensure(request(cwd, cfg));
    const before = await service.list(), projectionPath = path.join(cwd, ".worktree-ports.json"), original = JSON.parse(await readFile(projectionPath, "utf8")) as { configHash: string };
    await writeFile(projectionPath, JSON.stringify({ ...original, configHash: "0".repeat(64) }));
    await expect(service.rebuild({ roots: [scanRoot] })).rejects.toMatchObject({ code: "PORT_REBUILD_INVALID" }); expect(await service.list()).toEqual(before);
    const target = path.join(scanRoot, "projection-target.json"); await writeFile(target, JSON.stringify(original)); await unlink(projectionPath); await symlink(target, projectionPath, "file");
    await expect(service.rebuild({ roots: [scanRoot] })).rejects.toMatchObject({ code: "PORT_REBUILD_INVALID" }); expect(await service.list()).toEqual(before);
  });

  it("rejects a registry and projection that agree on invalid family semantics", async () => {
    const root = await temp(), cwd = await temp(), store = new RegistryStore(root); const current = identity("r", "w", cwd, "main");
    const service = new PortService({ store, git: git(current), platform }); const ensured = await service.ensure(request(cwd));
    const tampered = { ...ensured.lease, slot: 1, services: { app: 5101 }, claims: [{ port: 5101, exclusive: true }] };
    await store.write({ schemaVersion: 1, leases: [tampered] });
    await writeFile(path.join(cwd, ".worktree-ports.json"), JSON.stringify({ schemaVersion: 1, leaseId: tampered.leaseId, projectId: tampered.projectId, worktreeId: tampered.worktreeId, configHash: tampered.configHash, services: tampered.services }));
    await expect(service.resolve(request(cwd))).rejects.toMatchObject({ code: "PORT_LEASE_STALE" });
  });

  it("release removes both registry authority and the local rebuild projection", async () => {
    const root = await temp(), cwd = await temp(), service = new PortService({ store: new RegistryStore(root), git: git(identity("r", "w", cwd, "main")), platform });
    await service.ensure(request(cwd)); await service.release({ cwd });
    expect(await service.list()).toEqual([]);
    await expect(readFile(path.join(cwd, ".worktree-ports.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconcile removes missing linked worktrees and repairs missing local files", async () => {
    const root = await temp(), mainPath = await temp(), linkedPath = await temp(); const main = identity("r", "m", mainPath, "main"), linked = identity("r", "l", linkedPath, "linked"); await new PortService({ store: new RegistryStore(root), git: git(main, [main, linked]), platform }).ensure(request(mainPath)); const adapter = git(linked, [main, linked]); const service = new PortService({ store: new RegistryStore(root), git: adapter, platform }); await service.ensure(request(linkedPath));
    await unlink(path.join(mainPath, ".worktree-ports.json")); const repaired = await service.reconcile({ cwd: linkedPath }); expect(repaired.repaired).toContain("m");
    adapter.list = async () => [main]; await rm(linkedPath, { recursive: true });
    const removed = await service.reconcile({ cwd: mainPath }); expect(removed.removed).toContain("l"); expect((await service.list()).map(({ worktreeId }) => worktreeId)).toEqual(["m"]);
  });

  it("does not resurrect a projection when release races reconcile repair", async () => {
    const root = await temp(), cwd = await temp();
    const current = identity("r", "w", cwd, "main");
    const seed = new PortService({ store: new RegistryStore(root), git: git(current), platform });
    await seed.ensure(request(cwd));
    const projection = path.join(cwd, ".worktree-ports.json");
    await unlink(projection);

    let resumeRepair!: () => void;
    const repairPaused = new Promise<void>((resolve) => { resumeRepair = resolve; });
    let repairReached!: () => void;
    const repairStarted = new Promise<void>((resolve) => { repairReached = resolve; });
    let repairTransactionEntered!: () => void;
    const repairTransaction = new Promise<void>((resolve) => { repairTransactionEntered = resolve; });
    const repairing = new PortService({
      store: new RepairTransactionProbeStore(root, repairTransactionEntered), git: git(current), platform,
      writeLeaseFile: async (file, value) => { repairReached(); await repairPaused; await writeFile(file, value); },
    });
    let releaseTransactionCompleted!: () => void;
    const releaseCompleted = new Promise<void>((resolve) => { releaseTransactionCompleted = resolve; });
    const releasing = new PortService({ store: new ReleaseTransactionProbeStore(root, releaseTransactionCompleted), git: git(current), platform });
    const reconciling = repairing.reconcile({ cwd });
    await repairStarted;
    const release = releasing.release({ cwd });
    await Promise.race([repairTransaction.then(() => "repair"), releaseCompleted.then(() => "release")]);
    resumeRepair();
    await Promise.all([reconciling, release]);

    expect(await releasing.list()).toEqual([]);
    await expect(readFile(projection, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a prunable linked worktree as absent and permits exact identity-bound recovery", async () => {
    const root = await temp(), mainPath = await temp(), linkedPath = await temp();
    const linked = identity("r", "l", linkedPath, "linked"), main = { ...identity("r", "m", mainPath, "main"), commonGitPath: linked.commonGitPath };
    await new PortService({ store: new RegistryStore(root), git: git(main, [main, linked]), platform }).ensure(request(mainPath));
    const adapter = git(linked, [main, linked]); const service = new PortService({ store: new RegistryStore(root), git: adapter, platform });
    const lease = (await service.ensure(request(linkedPath))).lease;
    const captured = await service.captureReleaseIdentity(request(linkedPath));
    await rm(linkedPath, { recursive: true, force: true });
    adapter.identify = async () => main;
    adapter.list = async () => [main, { ...linked, prunable: "gitdir file points to non-existent location" }];
    await expect(service.reconcile({ cwd: mainPath, orphanPolicy: "report" })).resolves.toMatchObject({ orphaned: [{ leaseId: lease.leaseId }] });
    await expect(service.resolveOrphan({ repositoryCwd: mainPath, identity: captured })).resolves.toMatchObject({ released: true });
  });

  it("fails reconcile structurally when orphan inspection hits a non-ENOENT lstat error", async () => {
    const root = await temp(), mainPath = await temp(), linkedPath = await temp();
    const store = new RegistryStore(root);
    const main = identity("r", "m", mainPath, "main");
    const service = new PortService({ store, git: git(main, [main]), platform });
    const ensured = await service.ensure(request(mainPath));
    await store.write({ schemaVersion: 1, leases: [
      ensured.lease,
      { ...ensured.lease, leaseId: "linked", worktreeId: "l", worktreePath: `${linkedPath}\0invalid`, role: "linked", slot: 1, claims: [{ port: 5101, exclusive: true }], services: { app: 5101 }, updatedAt: 2 },
    ] });
    await expect(service.reconcile({ cwd: mainPath })).rejects.toMatchObject({ code: "PORT_RECONCILE_INSPECTION_FAILED" });
  });
});
