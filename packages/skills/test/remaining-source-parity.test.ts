import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import agentContracts from "./fixtures/agent-semantic-contracts.json" with { type: "json" };
import sharedContracts from "./fixtures/shared-instruction-contracts.json" with { type: "json" };

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const normalizeWhitespace = (value: string) => value.replace(/\s+/gu, " ").trim();

type SourceCapture = Readonly<{ id: string; path: string; revision: string; sha256: string }>;
type AgentContract = (typeof agentContracts.agents)[number];

type AgentCandidate = Readonly<{
  content: string;
  metadata: {
    modelClass: string;
    thinking: string;
    capabilities: string[];
    nesting: string[];
    outputSchema: string;
  };
}>;

function assertSourceCapture(capture: SourceCapture, revisions: Map<string, string>, entries: Map<string, string>): void {
  expect(capture.revision, `${capture.id}:${capture.path}: revision`).toBe(revisions.get(capture.id));
  expect(capture.sha256, `${capture.id}:${capture.path}: SHA-256`).toBe(entries.get(`${capture.id}:${capture.path}`));
}

function assertAgentSemantics(candidate: AgentCandidate, contract: AgentContract): void {
  expect(candidate.metadata).toEqual(contract.mapping);
  expect(candidate.content).toContain(`name: ${contract.identity}`);
  const normalized = normalizeWhitespace(candidate.content);
  expect(normalized).toContain(normalizeWhitespace(contract.intent));
  for (const restriction of contract.toolRestrictions) expect(normalized, `${contract.identity}: ${restriction}`).toContain(normalizeWhitespace(restriction));
  for (const branch of contract.branches) expect(normalized, `${contract.identity}: ${branch}`).toContain(normalizeWhitespace(branch));
  for (const output of contract.outputRequirements) expect(normalized, `${contract.identity}: ${output}`).toContain(normalizeWhitespace(output));
  for (const behavior of contract.providerBehavior) expect(normalized, `${contract.identity}: ${behavior}`).toContain(normalizeWhitespace(behavior));
}

describe("remaining source-derived shared instruction parity", () => {
  it("binds every shared contract to captured source path, revision, SHA-256, and reviewed destination hash", async () => {
    const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "docs/history/CONVERGENCE_MANIFEST.json"), "utf8"));
    const revisions = new Map<string, string>(manifest.sources.map((source: { id: string; commit: string }) => [source.id, source.commit]));
    const entries = new Map<string, string>(manifest.entries.map((entry: { source: string; path: string; sha256?: string; headSha256?: string }) => [`${entry.source}:${entry.path}`, entry.sha256 ?? entry.headSha256]));
    expect(sharedContracts.contracts).toHaveLength(13);
    for (const contract of sharedContracts.contracts) {
      assertSourceCapture(contract.source, revisions, entries);
      const content = await readFile(path.join(repositoryRoot, contract.destination), "utf8");
      expect(sha256(content), `${contract.id}: reviewed destination`).toBe(contract.destinationSha256);
    }
  });

  it("preserves required policy decisions and their order", async () => {
    for (const contract of sharedContracts.contracts) {
      const content = await readFile(path.join(repositoryRoot, contract.destination), "utf8");
      let cursor = -1;
      for (const decision of contract.orderedDecisions) {
        const next = content.indexOf(decision, cursor + 1);
        expect(next, `${contract.id}: ${decision}`).toBeGreaterThan(cursor);
        cursor = next;
      }
    }
  });

  it("preserves trust, least-privilege tool, and runtime-neutral adaptation rules", async () => {
    const content = (await Promise.all(sharedContracts.contracts.map(contract => readFile(path.join(repositoryRoot, contract.destination), "utf8")))).join("\n");
    for (const rule of sharedContracts.crossCuttingRules) expect(normalizeWhitespace(content)).toContain(normalizeWhitespace(rule));
    expect(content).not.toMatch(/\b(?:gh|glab)\s+(?:issue|pr|run|api)\b/u);
    expect(content).not.toMatch(/\b(?:claude-|openai-codex\/|gpt-[0-9])\S*/iu);
    expect(content).not.toMatch(/(?:[A-Z]:[\\/](?:Users|_MP_projects)|\/(?:Users|home)\/)/u);
  });

  it("keeps every relative markdown link closed", async () => {
    for (const contract of sharedContracts.contracts) {
      const file = path.join(repositoryRoot, contract.destination);
      const content = await readFile(file, "utf8");
      for (const match of content.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/gu)) {
        if (/^[a-z]+:/iu.test(match[1]!)) continue;
        await expect(readFile(path.resolve(path.dirname(file), match[1]!), "utf8"), `${contract.id}: ${match[1]}`).resolves.toBeTypeOf("string");
      }
    }
  });
});

describe("all canonical agent source-derived semantic contracts", () => {
  it("binds exactly all 22 canonical agents to both captured source revisions and hashes", async () => {
    const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "docs/history/CONVERGENCE_MANIFEST.json"), "utf8"));
    const revisions = new Map<string, string>(manifest.sources.map((source: { id: string; commit: string }) => [source.id, source.commit]));
    const entries = new Map<string, string>(manifest.entries.map((entry: { source: string; path: string; sha256?: string; headSha256?: string }) => [`${entry.source}:${entry.path}`, entry.sha256 ?? entry.headSha256]));
    expect(agentContracts.agents).toHaveLength(22);
    expect(new Set(agentContracts.agents.map(agent => agent.identity)).size).toBe(22);
    for (const contract of agentContracts.agents) {
      expect(contract.sources.map(source => source.id).sort()).toEqual(["claude", "pi"]);
      for (const source of contract.sources) assertSourceCapture(source, revisions, entries);
    }
  });

  it("preserves identity intent, model class and thinking, exact tools, state, outputs, nesting, branches, and provider behavior", async () => {
    const metadata = JSON.parse(await readFile(path.join(repositoryRoot, "content/agents/metadata.json"), "utf8")).agents;
    expect(agentContracts.agents.map(agent => agent.identity).sort()).toEqual(Object.keys(metadata).sort());
    for (const contract of agentContracts.agents) {
      const content = await readFile(path.join(repositoryRoot, `content/agents/${contract.identity}.md`), "utf8");
      expect(sha256(content), `${contract.identity}: reviewed destination`).toBe(contract.destinationSha256);
      assertAgentSemantics({ content, metadata: metadata[contract.identity] }, contract);
    }
  });

  it("preserves the built-in Explore override search breadth, read-only scope, environment roots, docs route, and cited report", async () => {
    const contract = agentContracts.agents.find(agent => agent.identity === "mpx-explorer")!;
    const content = await readFile(path.join(repositoryRoot, `content/agents/${contract.identity}.md`), "utf8");
    for (const clause of agentContracts.exploreSemantics) expect(content).toContain(clause);
  });

  it("rejects mutations that drop a tool restriction, branch, output requirement, or model mapping", async () => {
    const contract = agentContracts.agents.find(agent => agent.identity === "mpx-check-fixer")!;
    const content = await readFile(path.join(repositoryRoot, `content/agents/${contract.identity}.md`), "utf8");
    const candidate = { content, metadata: structuredClone(contract.mapping) };
    expect(() => assertAgentSemantics({ ...candidate, content: content.replace(contract.toolRestrictions[0]!, "") }, contract)).toThrow();
    expect(() => assertAgentSemantics({ ...candidate, content: content.replace(contract.branches[0]!, "") }, contract)).toThrow();
    expect(() => assertAgentSemantics({ ...candidate, content: content.replace(contract.outputRequirements[0]!, "") }, contract)).toThrow();
    expect(() => assertAgentSemantics({ ...candidate, metadata: { ...candidate.metadata, modelClass: "terra" } }, contract)).toThrow();
  });
});
