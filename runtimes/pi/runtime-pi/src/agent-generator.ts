import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentCatalogError, type AgentCapabilityV1, type AgentModelClassV1 } from '@mpx/subagents';
import {
  AgentDocumentError,
  loadCanonicalAgentProjectionInputsV1,
  renderCanonicalAgentDocumentV1,
} from '@mpx/subagents/documents';
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
function normalizePiLineEndings(bytes: Uint8Array): Uint8Array {
  return Buffer.from(Buffer.from(bytes).toString('utf8').replaceAll('\r\n', '\n'));
}
function translateError(error: unknown): never {
  if (error instanceof AgentCatalogError) {
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
  if (error instanceof AgentDocumentError) {
    if (error.code === 'AGENT_DOCUMENT_INVALID') {
      throw new Error('canonical agent must have frontmatter');
    }
    if (error.code === 'AGENT_METADATA_FILE_INVALID') {
      throw new AgentDocumentError('AGENT_METADATA_INVALID', error.message);
    }
  }
  throw error;
}
export async function generatePiAgents(
  input: GeneratePiAgentsInput,
): Promise<{ changed: string[]; drift: string[] }> {
  let canonical;
  try {
    canonical = await loadCanonicalAgentProjectionInputsV1(input.source);
  } catch (error) {
    translateError(error);
  }
  const changed: string[] = [],
    drift: string[] = [];
  if (!input.check) {
    await mkdir(input.output, { recursive: true });
  }
  const generatedNames = canonical.entries.map(
      (entry) => `${projectedAgentName(entry.identity)}.md`,
    ),
    generated = new Set(generatedNames);
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
  for (const entry of canonical.entries) {
    const outputName = `${projectedAgentName(entry.identity)}.md`,
      metadata = entry.metadata;
    const tools = [
      ...new Set(metadata.capabilities.flatMap((capability) => piTools[capability] ?? [])),
    ];
    const fields = [
      { name: 'model', value: piModels[metadata.modelClass] },
      { name: 'thinking', value: metadata.thinking },
      { name: 'tools', value: tools.join(',') },
      { name: 'output_schema', value: metadata.outputSchema },
      ...(metadata.nesting.length
        ? [{ name: 'allowed_subagents', value: metadata.nesting.join(',') }]
        : []),
    ];
    const expected = normalizePiLineEndings(
      renderCanonicalAgentDocumentV1(entry.document, {
        name: projectedAgentName(entry.identity),
        fields,
      }),
    );
    const target = path.join(input.output, outputName),
      actual = await readFile(target).catch(() => undefined);
    if (actual && Buffer.from(actual).equals(expected)) {
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
