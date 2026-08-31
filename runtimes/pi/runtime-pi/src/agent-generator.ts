import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AgentCatalogError,
  parseAgentCatalogV1,
  resolveAgentCatalogV1,
  type AgentCapabilityV1,
  type AgentModelClassV1,
  type ResolvedAgentCatalogEntryV1,
  type ResolvedAgentCatalogV1,
} from '@mpx/subagents';
export interface GeneratePiAgentsInput {
  source: string;
  output: string;
  check?: boolean;
}
const piModels: Record<AgentModelClassV1, string> = {
  sol: 'openai-codex/gpt-5.6-sol',
  terra: 'openai-codex/gpt-5.6-terra',
  luna: 'openai-codex/gpt-5.6-luna',
};
const piTools: Record<AgentCapabilityV1, string[]> = {
  read: ['read'],
  search: ['grep', 'find', 'ls'],
  shell: ['bash'],
  write: ['edit', 'write'],
  browser: ['mcp'],
  context: ['mcp'],
  web: ['web_search', 'fetch_content', 'get_search_content', 'source_check'],
};
function projectedAgentName(identity: string): string {
  return identity === 'mpx-explorer' ? 'Explore' : identity;
}
function adaptAgent(
  source: string,
  identity: string,
  metadata: ResolvedAgentCatalogEntryV1,
): string {
  const normalized = source.replaceAll('\r\n', '\n');
  const marker = normalized.indexOf('\n---\n', 4);
  if (!normalized.startsWith('---\n') || marker < 0) {
    throw new Error('canonical agent must have frontmatter');
  }
  const frontmatter = normalized
    .slice(0, marker)
    .replace(`\nname: ${identity}\n`, `\nname: ${projectedAgentName(identity)}\n`);
  const tools = [
    ...new Set(metadata.capabilities.flatMap((capability) => piTools[capability] ?? [])),
  ];
  const nesting = metadata.nesting.length
    ? `\nallowed_subagents: ${metadata.nesting.join(',')}`
    : '';
  return `${frontmatter}\nmodel: ${piModels[metadata.modelClass]}\nthinking: ${metadata.thinking}\ntools: ${tools.join(',')}\noutput_schema: ${metadata.outputSchema}${nesting}\n${normalized.slice(marker)}`;
}
async function readAgentCatalog(
  source: string,
  identities: readonly string[],
): Promise<ResolvedAgentCatalogV1> {
  try {
    const catalog = parseAgentCatalogV1(await readFile(path.join(source, 'metadata.json'), 'utf8'));
    return resolveAgentCatalogV1(catalog, identities);
  } catch (error) {
    if (!(error instanceof AgentCatalogError)) {
      throw error;
    }
    if (error.code === 'AGENT_CATALOG_JSON_INVALID' && error.cause instanceof SyntaxError) {
      throw error.cause;
    }
    if (error.code === 'AGENT_CATALOG_COVERAGE_INVALID') {
      throw new Error('agent metadata must exactly cover canonical agents');
    }
    if (error.code === 'AGENT_CATALOG_SELECTOR_UNRESOLVED') {
      throw new Error(error.message);
    }
    throw new Error('invalid agent metadata');
  }
}
export async function generatePiAgents(
  input: GeneratePiAgentsInput,
): Promise<{ changed: string[]; drift: string[] }> {
  const names = (await readdir(input.source))
    .filter((name) => /^mpx-[a-z0-9-]+\.md$/u.test(name))
    .sort();
  const identities = names.map((name) => name.slice(0, -3));
  const catalog = await readAgentCatalog(input.source, identities);
  const changed: string[] = [];
  const drift: string[] = [];
  if (!input.check) {
    await mkdir(input.output, { recursive: true });
  }
  const generatedNames = names.map((name) => `${projectedAgentName(name.slice(0, -3))}.md`);
  const generated = new Set(generatedNames);
  const extras = (await readdir(input.output).catch(() => [] as string[]))
    .filter((name) => /^(?:mpx-[a-z0-9-]+|Explore)\.md$/u.test(name) && !generated.has(name))
    .sort();
  if (input.check) {
    drift.push(...extras);
  } else {
    for (const extra of extras) {
      await rm(path.join(input.output, extra));
      changed.push(extra);
    }
  }
  for (const name of names) {
    const identity = name.slice(0, -3),
      outputName = `${projectedAgentName(identity)}.md`;
    const metadata = catalog.agents[identity]!;
    const expected = adaptAgent(
      await readFile(path.join(input.source, name), 'utf8'),
      identity,
      metadata,
    );
    const target = path.join(input.output, outputName);
    const actual = await readFile(target, 'utf8').catch(() => undefined);
    if (actual === expected) {
      continue;
    }
    if (input.check) {
      drift.push(outputName);
    } else {
      await writeFile(target, expected);
      changed.push(outputName);
    }
  }
  return { changed: changed.sort(), drift: drift.sort() };
}
