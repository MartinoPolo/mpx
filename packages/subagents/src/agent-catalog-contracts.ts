export type AgentModelClassV1 = 'mechanical' | 'exploration' | 'standard' | 'advanced' | 'frontier';
export type AgentThinkingV1 = 'low' | 'medium' | 'high';
export type AgentCapabilityV1 =
  'read' | 'search' | 'shell' | 'write' | 'browser' | 'context' | 'web';

export interface AgentCatalogEntryV1 {
  readonly modelClass: AgentModelClassV1;
  readonly thinking: AgentThinkingV1;
  readonly capabilities: readonly AgentCapabilityV1[];
  readonly nesting: readonly string[];
  readonly outputSchema: string;
}

export interface AgentCatalogV1 {
  readonly schemaVersion: 1;
  readonly agents: Readonly<Record<string, AgentCatalogEntryV1>>;
}

export interface ResolvedAgentCatalogEntryV1 extends Omit<AgentCatalogEntryV1, 'nesting'> {
  readonly nesting: readonly string[];
}

export interface ResolvedAgentCatalogV1 {
  readonly schemaVersion: 1;
  readonly identities: readonly string[];
  readonly agents: Readonly<Record<string, ResolvedAgentCatalogEntryV1>>;
}

export type AgentCatalogErrorCode =
  | 'AGENT_CATALOG_JSON_INVALID'
  | 'AGENT_CATALOG_SCHEMA_INVALID'
  | 'AGENT_CATALOG_COVERAGE_INVALID'
  | 'AGENT_CATALOG_SELECTOR_UNRESOLVED';

export interface AgentCatalogErrorOptions {
  readonly cause?: SyntaxError;
  readonly missingIdentities?: readonly string[];
  readonly unexpectedIdentities?: readonly string[];
}

export class AgentCatalogError extends Error {
  declare readonly cause?: SyntaxError;
  declare readonly missingIdentities: readonly string[];
  declare readonly unexpectedIdentities: readonly string[];

  constructor(
    readonly code: AgentCatalogErrorCode,
    message: string,
    options?: AgentCatalogErrorOptions,
  ) {
    super(message, options);
    this.name = 'AgentCatalogError';
    Object.defineProperties(this, {
      missingIdentities: {
        value: Object.freeze([...(options?.missingIdentities ?? [])]),
        enumerable: true,
      },
      unexpectedIdentities: {
        value: Object.freeze([...(options?.unexpectedIdentities ?? [])]),
        enumerable: true,
      },
    });
  }
}
