import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import contracts from "./fixtures/source-semantic-contracts.json" with { type: "json" };

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const normalize = (value: string) => value
  .replace(/^---[\s\S]*?---/u, "")
  .replace(/`([^`]+)`/gu, "$1")
  .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
  .toLocaleLowerCase("en-US")
  .replace(/[^a-z0-9]+/gu, " ")
  .trim();

type Scenario = (typeof contracts.scenarios)[number];
const dimensions = ["triggers", "decisions", "gates", "boundaries", "actions", "privacy", "fallbacks", "supportAssets", "outcomes"] as const;

function assertOrderedSemantics(content: string, scenario: Scenario): void {
  const normalized = normalize(content);
  const mapped = dimensions.flatMap(dimension => {
    expect(scenario.contract[dimension].length, `${scenario.id}: ${dimension}`).toBeGreaterThan(0);
    return scenario.contract[dimension];
  });
  expect(new Set(scenario.flow), `${scenario.id}: flow covers every mapped obligation`).toEqual(new Set(mapped));
  let cursor = -1;
  for (const clause of scenario.flow) {
    const at = normalized.indexOf(normalize(clause), cursor + 1);
    expect(at, `${scenario.id}: ordered clause: ${clause}`).toBeGreaterThan(cursor);
    cursor = at;
  }
}

describe("source-derived semantic parity contracts", () => {
  it("binds every reviewed scenario to the captured convergence source revision and SHA-256", async () => {
    const convergence = JSON.parse(await readFile(path.join(repositoryRoot, "docs/history/CONVERGENCE_MANIFEST.json"), "utf8"));
    const provenance = JSON.parse(await readFile(path.join(repositoryRoot, "docs/history/SOURCE_PROVENANCE.json"), "utf8"));
    const revisions = new Map(convergence.sources.map((source: { id: string; commit: string }) => [source.id, source.commit]));
    for (const scenario of contracts.scenarios) {
      expect(scenario.review.status).toBe("reviewed");
      expect(scenario.source.revision).toBe(revisions.get(scenario.source.id));
      const sourceEntry = convergence.entries.find((entry: { source: string; path: string }) => entry.source === scenario.source.id && entry.path === scenario.source.path);
      expect(sourceEntry?.sha256 ?? sourceEntry?.headSha256, scenario.id).toBe(scenario.source.sha256);
      const provenanceEntry = provenance.entries.find((entry: { destination?: string }) => entry.destination === scenario.destination);
      if (provenanceEntry) expect(provenanceEntry.originalSha256, scenario.id).toBe(scenario.source.sha256);
    }
  });

  it("preserves each reviewed scenario's branches, ordering, gates, boundaries, neutral actions, privacy, handoffs, assets, and outcomes", async () => {
    expect(new Set(contracts.scenarios.map(scenario => scenario.family))).toEqual(new Set([
      "canonical-skills", "recovery", "decision-harvest", "provider-delivery", "provider-setup",
      "personal-skills", "shared-instructions", "agent-semantics",
    ]));
    for (const scenario of contracts.scenarios) {
      const content = await readFile(path.join(repositoryRoot, scenario.destination), "utf8");
      expect(sha256(content), `${scenario.id}: destination review hash`).toBe(scenario.review.destinationSha256);
      assertOrderedSemantics(content, scenario);
    }
  });

  it("rejects retained vocabulary when a mapped branch is deleted or decision order changes", async () => {
    const scenario = contracts.scenarios.find(item => item.id === "continue-recovery")!;
    const content = await readFile(path.join(repositoryRoot, scenario.destination), "utf8");
    const branch = scenario.contract.fallbacks[0]!;
    expect(() => assertOrderedSemantics(content.replace(branch, ""), scenario)).toThrow();
    const [first, second] = scenario.flow.slice(1, 3);
    const reordered = content.replace(first!, "__SECOND__").replace(second!, first!).replace("__SECOND__", second!);
    expect(() => assertOrderedSemantics(reordered, scenario)).toThrow();
  });
});
