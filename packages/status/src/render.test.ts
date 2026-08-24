import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseStatusSnapshotV1, renderClaudeFixture, renderPiFixture, renderPortSegment, type StatusSnapshotV1 } from "./index.js";
const fixture = async (name: string): Promise<{ snapshot: StatusSnapshotV1; text: string }> => ({
  snapshot: parseStatusSnapshotV1(JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8")) as unknown),
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
