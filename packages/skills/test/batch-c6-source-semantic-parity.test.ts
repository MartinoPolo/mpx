import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import contracts from "./fixtures/batch-c6-source-semantic-parity.json" with { type: "json" };

const root = path.resolve(import.meta.dirname, "../../..");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const normalize = (value: string) => value.replace(/^---[\s\S]*?---/u, "").replace(/`([^`]+)`/gu, "$1").replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1").toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
type Scenario = (typeof contracts.scenarios)[number];

function assertScenario(content: string, scenario: Scenario): void {
  const normalized = normalize(content);
  let cursor = -1;
  for (const step of scenario.flow) {
    const at = normalized.indexOf(normalize(step.clause), cursor + 1);
    expect(at, `${scenario.identity}: ${step.dimension}: ${step.clause}`).toBeGreaterThan(cursor);
    cursor = at;
  }
}

describe("Batch C6 source-derived semantic parity", () => {
  it("binds every remaining C6 personal skill and support asset to captured hashes", async () => {
    const manifest = JSON.parse(await readFile(path.join(root, "docs/history/CONVERGENCE_MANIFEST.json"), "utf8"));
    expect(contracts.base).toBe("036a784");
    expect(contracts.scenarios).toHaveLength(7);
    for (const scenario of contracts.scenarios) {
      const source = manifest.entries.find((entry: { source: string; path: string }) => entry.source === scenario.source.id && entry.path === scenario.source.path);
      expect(scenario.source.revision, scenario.identity).toBe(manifest.sources.find((item: { id: string }) => item.id === scenario.source.id)?.commit);
      expect(source?.sha256 ?? source?.headSha256, scenario.identity).toBe(scenario.source.sha256);
      const content = await readFile(path.join(root, scenario.destination), "utf8");
      expect(sha256(content), scenario.identity).toBe(scenario.destinationSha256);
      for (const asset of scenario.assets) {
        const assetPath = path.join(root, asset.path);
        await expect(stat(assetPath), asset.path).resolves.toBeDefined();
        expect(sha256(await readFile(assetPath)), asset.path).toBe(asset.sha256);
      }
    }
  });

  it("preserves normalized triggers, ordering, branches, gates, concurrency, privacy, OS/output containment, fallbacks, manual handoffs, assets, and outcomes", async () => {
    const required = new Set(["trigger", "branch", "gate", "concurrency", "privacy", "os-containment", "output-containment", "fallback", "manual-handoff", "asset", "outcome"]);
    const observed = new Set(contracts.scenarios.flatMap(scenario => scenario.flow.map(step => step.dimension)));
    expect(observed).toEqual(required);
    for (const scenario of contracts.scenarios) assertScenario(await readFile(path.join(root, scenario.destination), "utf8"), scenario);
  });

  it("detects deletion and reordering mutations for every C6 scenario contract", async () => {
    for (const scenario of contracts.scenarios) {
      const content = await readFile(path.join(root, scenario.destination), "utf8");
      const normalized = normalize(content);
      for (const step of scenario.flow) expect(() => assertScenario(normalized.replace(normalize(step.clause), ""), scenario), `${scenario.identity}: delete ${step.dimension}`).toThrow();
      if (scenario.flow.length > 1) {
        const [first, second] = scenario.flow;
        const swapped = normalized.replace(normalize(first!.clause), "__c6_second__").replace(normalize(second!.clause), normalize(first!.clause)).replace("__c6_second__", normalize(second!.clause));
        expect(() => assertScenario(swapped, scenario), `${scenario.identity}: reorder`).toThrow();
      }
    }
  });
});
