import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { executeMigrationCommand } from "./migration.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-phase-j-cli-")); roots.push(root);
  const projects = path.join(root, "projects"), repoRoot = path.join(root, "repo"), appdata = path.join(root, "roaming"), local = path.join(root, "local"), apps = path.join(root, "apps");
  await Promise.all([mkdir(projects), mkdir(path.join(repoRoot, "docs", "history"), { recursive: true }), mkdir(path.join(repoRoot, "runtimes"), { recursive: true }), mkdir(path.join(appdata, "mpx", "logs"), { recursive: true }), mkdir(path.join(local, "mpx", "logs"), { recursive: true }), mkdir(apps)]);
  const entries = [];
  for (const id of ["claude", "pi"] as const) {
    const source = path.join(projects, id === "claude" ? "mpx-claude-code" : "mpx-pi"); await mkdir(source);
    await exec("git", ["init", "-q"], { cwd: source }); await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: source }); await exec("git", ["config", "user.name", "Test"], { cwd: source });
    const body = `${id} canonical source\n`; await writeFile(path.join(source, "source.txt"), body); await exec("git", ["add", "."], { cwd: source }); await exec("git", ["commit", "-qm", "fixture"], { cwd: source });
    entries.push({ source: id, path: "source.txt", sha256: sha256(body), destination: `content/${id}.txt`, disposition: "canonicalized", evidence: [{ kind: "behavior-test", reference: `${id}.test.ts` }] });
  }
  await writeFile(path.join(repoRoot, "docs", "history", "CONVERGENCE_MANIFEST.json"), JSON.stringify({ schemaVersion: 2, sources: [], entries }));
  const profile = path.join(projects, "phase-j-profile.ps1");
  await writeFile(profile, "native\n# >>> old-mpx owned >>>\nlegacy\n# <<< old-mpx owned <<<\n");
  await writeFile(path.join(repoRoot, "docs", "phase-j-owned-activations.json"), JSON.stringify([{ path: "${MPX_PROJECTS}/phase-j-profile.ps1", startMarker: "# >>> old-mpx owned >>>", endMarker: "# <<< old-mpx owned <<<" }]));
  await writeFile(path.join(appdata, "mpx", "logs", "runtime.jsonl"), "canonical runtime only\n");
  await writeFile(path.join(repoRoot, "runtimes", "projection.txt"), "canonical projection only\n");
  const processSnapshot = path.join(root, "process-lines.json"); await writeFile(processSnapshot, "[]\n");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, TEMP: process.env.TEMP, TMP: process.env.TMP, MPX_PROJECTS: projects, MPX_APPS: apps, APPDATA: appdata, LOCALAPPDATA: local, MPX_MIGRATION_PROCESS_SNAPSHOT: processSnapshot };
  return { root, repoRoot, env, profile };
}

async function bundled(f: Awaited<ReturnType<typeof fixture>>, action: string, legacy = false) {
  const bundle = path.resolve(import.meta.dirname, "../../../bin/mpx.mjs");
  const argv = [bundle, "--json", "--cwd", f.repoRoot, "migration", action, ...(legacy ? ["--legacy-disabled"] : [])];
  const result = await exec(process.execPath, argv, { cwd: f.repoRoot, env: f.env, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(result.stdout) as { ok: boolean; data: any };
}

describe("Phase J CLI acceptance fixtures", () => {
  it("reconciles real source, baseline, log, and projection fixtures and requires explicit legacy-disabled acceptance", async () => {
    const f = await fixture();
    const observation = await executeMigrationCommand({ action: "reconcile", repoRoot: f.repoRoot, env: f.env, legacyDisabled: false });
    expect(observation).toMatchObject({ kind: "mpx-migration-reconciliation", gate: { passed: false }, runtimeAccessAudit: { acceptance: { mode: "observation", passed: false } } });
    const accepted = await executeMigrationCommand({ action: "report", repoRoot: f.repoRoot, env: f.env, legacyDisabled: true });
    expect(accepted).toMatchObject({ gate: { passed: true, legacyDisabledAccepted: true }, runtimeAccessAudit: { readOnly: true, findings: [] } });
  }, 30_000);

  it("produces gated cutover and cleanup-safe rollback evidence through executeMigrationCommand", async () => {
    const f = await fixture();
    const cutover = await executeMigrationCommand({ action: "cutover-plan", repoRoot: f.repoRoot, env: f.env, legacyDisabled: true });
    expect(cutover).toMatchObject({ nonDestructive: true, gatePassed: true, actions: [{ exactOwnedMatch: true, eligible: true }] });
    expect(await readFile(f.profile, "utf8")).toContain("legacy");
    const rollback = await executeMigrationCommand({ action: "rollback-drill", repoRoot: f.repoRoot, env: f.env, legacyDisabled: true });
    expect(rollback).toMatchObject({ passed: true, realStateTouched: false, snapshot: { immutable: true, retentionDays: 30 } });
  }, 30_000);

  it("routes legacy-disabled, cutover, and rollback through the bundled mpx migration command", async () => {
    const f = await fixture();
    expect(await bundled(f, "report", true)).toMatchObject({ ok: true, data: { gate: { passed: true, legacyDisabledAccepted: true } } });
    expect(await bundled(f, "cutover-plan", true)).toMatchObject({ ok: true, data: { actions: [{ eligible: true }] } });
    expect(await bundled(f, "rollback-drill")).toMatchObject({ ok: true, data: { passed: true, realStateTouched: false } });
  }, 30_000);
});
