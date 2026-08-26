import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type AgentModelClass = "sol" | "terra" | "luna";
type AgentCapability = "read" | "search" | "shell" | "write" | "browser" | "context" | "web";
interface AgentMetadata { modelClass: AgentModelClass; thinking: "low" | "medium" | "high"; capabilities: AgentCapability[]; nesting: string[]; outputSchema: string }
interface AgentCatalog { schemaVersion: 1; agents: Record<string, AgentMetadata> }
export interface GeneratePiAgentsInput { source: string; output: string; check?: boolean }
const piModels: Record<AgentModelClass, string> = { sol: "openai-codex/gpt-5.6-sol", terra: "openai-codex/gpt-5.6-terra", luna: "openai-codex/gpt-5.6-luna" };
const piTools: Record<AgentCapability, string[]> = { read: ["read"], search: ["grep", "find", "ls"], shell: ["bash"], write: ["edit", "write"], browser: ["mcp"], context: ["mcp"], web: ["web_search", "fetch_content", "get_search_content", "source_check"] };
function projectedAgentName(identity: string): string { return identity === "mpx-explorer" ? "Explore" : identity; }
function expandAgentNesting(selectors: readonly string[], identities: readonly string[]): string[] {
  const expanded = selectors.flatMap((selector) => {
    const matches = selector.includes("*")
      ? identities.filter((identity) => new RegExp(`^${selector.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u").test(identity))
      : identities.filter((identity) => identity === selector);
    if (matches.length === 0) throw new Error(`agent nesting selector '${selector}' does not resolve to a canonical identity`);
    return matches;
  });
  return [...new Set(expanded)];
}
function adaptAgent(source: string, identity: string, metadata: AgentMetadata): string {
  const normalized = source.replaceAll("\r\n", "\n");
  const marker = normalized.indexOf("\n---\n", 4);
  if (!normalized.startsWith("---\n") || marker < 0) throw new Error("canonical agent must have frontmatter");
  const frontmatter = normalized.slice(0, marker).replace(`\nname: ${identity}\n`, `\nname: ${projectedAgentName(identity)}\n`);
  const tools = [...new Set(metadata.capabilities.flatMap((capability) => piTools[capability] ?? []))];
  const nesting = metadata.nesting.length ? `\nallowed_subagents: ${metadata.nesting.join(",")}` : "";
  return `${frontmatter}\nmodel: ${piModels[metadata.modelClass]}\nthinking: ${metadata.thinking}\ntools: ${tools.join(",")}\noutput_schema: ${metadata.outputSchema}${nesting}\n${normalized.slice(marker)}`;
}
async function readAgentCatalog(source: string): Promise<AgentCatalog> {
  const value = JSON.parse(await readFile(path.join(source, "metadata.json"), "utf8")) as AgentCatalog;
  const classes = new Set(["sol", "terra", "luna"]), thinking = new Set(["low", "medium", "high"]), capabilities = new Set(Object.keys(piTools));
  const valid = value.schemaVersion === 1 && value.agents && !Array.isArray(value.agents) && Object.entries(value.agents).every(([identity, agent]) =>
    /^mpx-[a-z0-9-]+$/u.test(identity) && classes.has(agent?.modelClass) && thinking.has(agent?.thinking)
    && Array.isArray(agent?.capabilities) && agent.capabilities.length > 0 && agent.capabilities.every((item) => capabilities.has(item))
    && Array.isArray(agent?.nesting) && agent.nesting.every((item) => typeof item === "string") && typeof agent?.outputSchema === "string" && agent.outputSchema.length > 0);
  if (!valid) throw new Error("invalid agent metadata");
  return value;
}
export async function generatePiAgents(input: GeneratePiAgentsInput): Promise<{ changed: string[]; drift: string[] }> {
  const names = (await readdir(input.source)).filter((name) => /^mpx-[a-z0-9-]+\.md$/u.test(name)).sort();
  const catalog = await readAgentCatalog(input.source); const identities = names.map((name) => name.slice(0, -3));
  if (Object.keys(catalog.agents).sort().join() !== identities.join()) throw new Error("agent metadata must exactly cover canonical agents");
  const changed: string[] = []; const drift: string[] = [];
  if (!input.check) await mkdir(input.output, { recursive: true });
  const generatedNames = names.map((name) => `${projectedAgentName(name.slice(0, -3))}.md`); const generated = new Set(generatedNames);
  const extras = (await readdir(input.output).catch(() => [] as string[])).filter((name) => /^(?:mpx-[a-z0-9-]+|Explore)\.md$/u.test(name) && !generated.has(name)).sort();
  if (input.check) drift.push(...extras); else for (const extra of extras) { await rm(path.join(input.output, extra)); changed.push(extra); }
  for (const name of names) {
    const identity = name.slice(0, -3), outputName = `${projectedAgentName(identity)}.md`;
    const metadata = catalog.agents[identity]!; const expected = adaptAgent(await readFile(path.join(input.source, name), "utf8"), identity, { ...metadata, nesting: expandAgentNesting(metadata.nesting, identities) });
    const target = path.join(input.output, outputName); const actual = await readFile(target, "utf8").catch(() => undefined);
    if (actual === expected) continue;
    if (input.check) drift.push(outputName); else { await writeFile(target, expected); changed.push(outputName); }
  }
  return { changed: changed.sort(), drift: drift.sort() };
}
