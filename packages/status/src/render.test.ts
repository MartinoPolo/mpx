import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { renderClaudeFixture, renderPiFixture, renderPortSegment, type StatusSnapshotV1 } from "./index.js";

const record = (value: unknown): Record<string, unknown> => { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Malformed status fixture"); return value as Record<string, unknown>; };
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T => typeof value === "string" && allowed.includes(value as T);
function validateSnapshot(value: unknown): StatusSnapshotV1 {
  const snapshot = record(value); const project = record(snapshot.project); const worktree = record(snapshot.worktree);
  if (snapshot.schemaVersion !== 1 || typeof project.id !== "string" || typeof project.cwd !== "string" || !oneOf(snapshot.portResolution, ["valid", "missing", "invalid", "stale"] as const) || !Array.isArray(snapshot.services) || !Array.isArray(snapshot.diagnostics)) throw new Error("Malformed status fixture");
  if (!(worktree.id === null || typeof worktree.id === "string") || !(worktree.path === null || typeof worktree.path === "string") || !(worktree.branch === null || typeof worktree.branch === "string") || !(worktree.role === null || oneOf(worktree.role, ["main", "linked"] as const))) throw new Error("Malformed status fixture");
  for (const raw of snapshot.services) { const service = record(raw); if (typeof service.id !== "string" || !oneOf(service.mode, ["managed", "fixed-shared"] as const) || !oneOf(service.scope, ["checkout", "project"] as const) || !oneOf(service.protocol, ["http", "https", "tcp"] as const) || !(service.port === null || typeof service.port === "number") || typeof service.listening !== "boolean" || !oneOf(service.conflict, ["none", "external", "unknown"] as const) || !(service.pid === null || typeof service.pid === "number")) throw new Error("Malformed status fixture"); }
  for (const raw of snapshot.diagnostics) { const diagnostic = record(raw); if (typeof diagnostic.code !== "string" || !oneOf(diagnostic.severity, ["info", "warning", "error"] as const) || typeof diagnostic.message !== "string" || !(diagnostic.serviceId === null || typeof diagnostic.serviceId === "string")) throw new Error("Malformed status fixture"); }
  return snapshot as unknown as StatusSnapshotV1;
}
const fixture = async (name: string): Promise<{ snapshot: StatusSnapshotV1; text: string }> => ({
  snapshot: validateSnapshot(JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"))),
  text: (await readFile(new URL(`../fixtures/${name}.txt`, import.meta.url), "utf8")).trimEnd(),
});

describe("port segment renderers", () => {
  it.each(["valid", "fixed-shared", "missing", "invalid", "stale", "external-conflict", "unknown-listener"])("keeps the provider fixture renderers exactly equal to the %s text snapshot", async (name) => {
    const { snapshot, text } = await fixture(name);
    expect(renderPortSegment(snapshot)).toBe(text);
    expect(renderClaudeFixture(snapshot)).toBe(text);
    expect(renderPiFixture(snapshot)).toBe(text);
  });

  it("collectively covers every resolution state, service mode, and conflict value", async () => {
    const snapshots = await Promise.all(["valid", "fixed-shared", "missing", "invalid", "stale", "external-conflict", "unknown-listener"].map(async (name) => (await fixture(name)).snapshot));
    expect(new Set(snapshots.map(({ portResolution }) => portResolution))).toEqual(new Set(["valid", "missing", "invalid", "stale"]));
    expect(new Set(snapshots.flatMap(({ services }) => services.map(({ mode }) => mode)))).toEqual(new Set(["managed", "fixed-shared"]));
    expect(new Set(snapshots.flatMap(({ services }) => services.map(({ conflict }) => conflict)))).toEqual(new Set(["none", "external", "unknown"]));
  });

  it("renders shuffled service input in the same deterministic order", async () => {
    const { snapshot, text } = await fixture("valid");
    const shuffled = { ...snapshot, services: [...snapshot.services].reverse() };
    expect(renderClaudeFixture(shuffled)).toBe(text);
    expect(renderPiFixture(shuffled)).toBe(text);
  });
});
