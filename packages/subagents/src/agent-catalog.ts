import {
  AgentCatalogError,
  type AgentCapabilityV1,
  type AgentCatalogEntryV1,
  type AgentCatalogV1,
  type ResolvedAgentCatalogEntryV1,
  type ResolvedAgentCatalogV1,
} from './agent-catalog-contracts.js';

const identityPattern = /^mpx-[a-z0-9-]+$/u;
const MAX_IDENTITY_LENGTH = 128;
const MAX_SELECTOR_LENGTH = 256;
const MAX_SELECTOR_WILDCARDS = 16;
const modelClasses = new Set(['sol', 'terra', 'luna']);
const thinkingLevels = new Set(['low', 'medium', 'high']);
const capabilities = new Set(['read', 'search', 'shell', 'write', 'browser', 'context', 'web']);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validEntry(value: unknown): value is AgentCatalogEntryV1 {
  if (!record(value)) {
    return false;
  }
  return (
    modelClasses.has(value.modelClass as string) &&
    thinkingLevels.has(value.thinking as string) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length > 0 &&
    value.capabilities.every((item) => typeof item === 'string' && capabilities.has(item)) &&
    Array.isArray(value.nesting) &&
    value.nesting.every(
      (item) =>
        typeof item === 'string' &&
        item.length <= MAX_SELECTOR_LENGTH &&
        item.split('*').length - 1 <= MAX_SELECTOR_WILDCARDS,
    ) &&
    typeof value.outputSchema === 'string' &&
    value.outputSchema.length > 0
  );
}

function immutableEntry(value: AgentCatalogEntryV1): AgentCatalogEntryV1 {
  return Object.freeze({
    modelClass: value.modelClass,
    thinking: value.thinking,
    capabilities: Object.freeze([...value.capabilities]) as readonly AgentCapabilityV1[],
    nesting: Object.freeze([...value.nesting]),
    outputSchema: value.outputSchema,
  });
}

export function parseAgentCatalogV1(source: string): AgentCatalogV1 {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    throw new AgentCatalogError('AGENT_CATALOG_JSON_INVALID', 'agent catalog must be valid JSON', {
      cause: cause as SyntaxError,
    });
  }
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !record(value.agents) ||
    !Object.entries(value.agents).every(
      ([identity, entry]) =>
        identity.length <= MAX_IDENTITY_LENGTH &&
        identityPattern.test(identity) &&
        validEntry(entry),
    )
  ) {
    throw new AgentCatalogError('AGENT_CATALOG_SCHEMA_INVALID', 'agent catalog schema is invalid');
  }
  const agents = Object.fromEntries(
    Object.entries(value.agents).map(([identity, entry]) => [
      identity,
      immutableEntry(entry as unknown as AgentCatalogEntryV1),
    ]),
  );
  return Object.freeze({ schemaVersion: 1, agents: Object.freeze(agents) });
}

function wildcardMatch(selector: string, candidate: string): boolean {
  let previous = new Uint8Array(candidate.length + 1);
  previous[0] = 1;
  for (const character of selector) {
    const current = new Uint8Array(candidate.length + 1);
    if (character === '*') {
      current[0] = previous[0]!;
      for (let index = 1; index <= candidate.length; index += 1) {
        current[index] = previous[index]! || current[index - 1]! ? 1 : 0;
      }
    } else {
      for (let index = 1; index <= candidate.length; index += 1) {
        current[index] = previous[index - 1] && candidate[index - 1] === character ? 1 : 0;
      }
    }
    previous = current;
  }
  return previous[candidate.length] === 1;
}

export function resolveAgentCatalogV1(
  catalog: AgentCatalogV1,
  canonicalIdentities: readonly string[],
): ResolvedAgentCatalogV1 {
  const identities = [...canonicalIdentities].sort();
  const metadataIdentities = Object.keys(catalog.agents).sort();
  if (
    new Set(identities).size !== identities.length ||
    identities.length !== metadataIdentities.length ||
    identities.some((identity, index) => identity !== metadataIdentities[index])
  ) {
    const canonical = new Set(identities);
    const metadata = new Set(metadataIdentities);
    throw new AgentCatalogError(
      'AGENT_CATALOG_COVERAGE_INVALID',
      'agent catalog must exactly cover canonical agents',
      {
        missingIdentities: identities.filter((identity) => !metadata.has(identity)),
        unexpectedIdentities: metadataIdentities.filter((identity) => !canonical.has(identity)),
      },
    );
  }

  const agents: Record<string, ResolvedAgentCatalogEntryV1> = {};
  for (const identity of identities) {
    const entry = catalog.agents[identity]!;
    const nesting: string[] = [];
    const seen = new Set<string>();
    for (const selector of entry.nesting) {
      const matches = selector.includes('*')
        ? identities.filter((candidate) => wildcardMatch(selector, candidate))
        : identities.filter((candidate) => candidate === selector);
      if (matches.length === 0) {
        throw new AgentCatalogError(
          'AGENT_CATALOG_SELECTOR_UNRESOLVED',
          `agent nesting selector '${selector}' does not resolve to a canonical identity`,
        );
      }
      for (const match of matches) {
        if (!seen.has(match)) {
          seen.add(match);
          nesting.push(match);
        }
      }
    }
    agents[identity] = Object.freeze({
      modelClass: entry.modelClass,
      thinking: entry.thinking,
      capabilities: Object.freeze([...entry.capabilities]),
      nesting: Object.freeze(nesting),
      outputSchema: entry.outputSchema,
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    identities: Object.freeze(identities),
    agents: Object.freeze(agents),
  });
}
