import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import contracts from "./fixtures/batch-c3-source-parity.json" with { type: "json" };

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const normalize = (value: string) => value
  .replace(/`([^`]+)`/gu, "$1")
  .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
  .toLocaleLowerCase("en-US")
  .replace(/[^a-z0-9]+/gu, " ")
  .trim();

function semanticUnits(markdown: string): string[] {
  const body = markdown.replace(/^---[\s\S]*?---\s*/u, "");
  const units: string[] = [];
  let current = "";
  for (const raw of body.replaceAll("\r\n", "\n").split("\n")) {
    const line = raw.trim();
    if (!line) {
      if (current) units.push(current);
      current = "";
      continue;
    }
    if (/^(?:#{1,6}\s+|(?:\d+\.|[-*])\s+)/u.test(line)) {
      if (current) units.push(current);
      current = line;
    } else if (current) current += ` ${line}`;
    else current = line;
  }
  if (current) units.push(current);
  return units.map(normalize).filter(Boolean);
}

type Scenario = (typeof contracts.scenarios)[number];
const dimensions = [
  "triggers", "orderedDecisions", "requiredBranches", "safetyConfirmation",
  "concurrencyDelegation", "providerNeutralActions", "privacy",
  "fallbackManualHandoff", "assets", "terminalOutcomes",
] as const;

function satisfiesUnits(units: string[], portable: string, scenario: Scenario): boolean {
  for (const dimension of dimensions) {
    const coverage = scenario.contract[dimension];
    if (coverage.evidence.length === 0 || !coverage.rationale) return false;
    if (coverage.evidence.some(clause => !units.includes(normalize(clause)))) return false;
  }
  const ordered = scenario.contract.orderedDecisions.evidence.map(normalize);
  const positions = ordered.map(clause => units.indexOf(clause));
  if (positions.some(position => position < 0)) return false;
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1]!)) return false;
  return !/(?:^|[\n`$;|&])\s*(?:gh|glab|kf)(?:\.exe)?\s+(?=[a-z-])/imu.test(portable)
    && !/\bSendMessage\b|~\/\.claude|\$ARGUMENTS/iu.test(portable);
}

function satisfiesScenario(markdown: string, scenario: Scenario): boolean {
  return satisfiesUnits(semanticUnits(markdown), markdown.replace(/^---[\s\S]*?---/u, ""), scenario);
}

describe("Batch C3 source-derived scenario parity", () => {
  it("binds all 27 remaining skills to captured source and destination hashes", async () => {
    const convergence = JSON.parse(await readFile(path.join(repositoryRoot, "docs/history/CONVERGENCE_MANIFEST.json"), "utf8"));
    const provenance = JSON.parse(await readFile(path.join(repositoryRoot, "docs/history/SOURCE_PROVENANCE.json"), "utf8"));
    expect(contracts.scenarios).toHaveLength(27);
    expect(new Set(contracts.scenarios.map(scenario => scenario.identity)).size).toBe(27);
    for (const scenario of contracts.scenarios) {
      const source = convergence.entries.find((entry: { source: string; path: string }) => entry.source === scenario.source.id && entry.path === scenario.source.path);
      const imported = provenance.entries.find((entry: { destination?: string }) => entry.destination === scenario.destination);
      expect(scenario.source.revision, scenario.identity).toBe(convergence.sources.find((entry: { id: string }) => entry.id === scenario.source.id)?.commit);
      expect(scenario.source.sha256, scenario.identity).toBe(source?.sha256 ?? source?.headSha256);
      expect(imported?.originalSha256, scenario.identity).toBe(scenario.source.sha256);
      const destination = await readFile(path.join(repositoryRoot, scenario.destination), "utf8");
      expect(sha256(destination), scenario.identity).toBe(scenario.review.destinationSha256);
      for (const asset of scenario.supportAssets) {
        const assetSource = convergence.entries.find((entry: { source: string; path: string }) => entry.source === scenario.source.id && entry.path === asset.sourcePath);
        const assetProvenance = provenance.entries.find((entry: { destination?: string }) => entry.destination === asset.path);
        expect(asset.sourceSha256, asset.path).toBe(assetSource?.sha256 ?? assetSource?.headSha256);
        expect(Boolean(assetProvenance), asset.path).toBe(asset.provenanceCaptured);
        if (assetProvenance) {
          expect(asset.sourceSha256, asset.path).toBe(assetProvenance.originalSha256);
          expect(asset.destinationSha256, asset.path).toBe(assetProvenance.destinationSha256);
        }
        expect(sha256(await readFile(path.join(repositoryRoot, asset.path))), asset.path).toBe(asset.destinationSha256);
      }
    }
  });

  it("covers every requested semantic dimension with ordered, provider-neutral scenario evidence", async () => {
    for (const scenario of contracts.scenarios) {
      const destination = await readFile(path.join(repositoryRoot, scenario.destination), "utf8");
      expect(satisfiesScenario(destination, scenario), scenario.identity).toBe(true);
      for (const dimension of dimensions) expect(["direct", "equivalent"]).toContain(scenario.contract[dimension].coverage);
    }
  });

  it("is mutation-sensitive for every skill's branches, decision order, and neutral action boundary", async () => {
    for (const scenario of contracts.scenarios) {
      const destination = await readFile(path.join(repositoryRoot, scenario.destination), "utf8");
      const units = semanticUnits(destination);
      const branch = normalize(scenario.contract.requiredBranches.evidence[0]!);
      expect(satisfiesUnits(units.filter(unit => unit !== branch), destination, scenario), `${scenario.identity}: deleted branch`).toBe(false);
      const [first, second] = scenario.contract.orderedDecisions.evidence.map(normalize);
      if (second) {
        const reordered = [...units];
        const firstAt = reordered.indexOf(first!);
        const secondAt = reordered.indexOf(second);
        [reordered[firstAt], reordered[secondAt]] = [reordered[secondAt]!, reordered[firstAt]!];
        expect(satisfiesUnits(reordered, destination, scenario), `${scenario.identity}: reordered decisions`).toBe(false);
      }
      expect(satisfiesUnits(units, `${destination}\n\`gh issue list\``, scenario), `${scenario.identity}: provider-specific action`).toBe(false);
    }
  });
});
