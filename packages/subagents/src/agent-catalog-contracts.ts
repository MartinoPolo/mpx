export type AgentModelClass = 'mechanical' | 'exploration' | 'standard' | 'advanced' | 'frontier';
export type AgentThinking = 'low' | 'medium' | 'high';
export type AgentCapability = 'read' | 'search' | 'shell' | 'write' | 'browser' | 'context' | 'web';

export interface AgentCatalogEntry {
  readonly modelClass: AgentModelClass;
  readonly thinking: AgentThinking;
  readonly capabilities: readonly AgentCapability[];
  readonly nesting: readonly string[];
  readonly outputSchema: string;
}

export interface AgentCatalog {
  readonly schemaVersion: 1;
  readonly agents: Readonly<Record<string, AgentCatalogEntry>>;
}

export interface ResolvedAgentCatalogEntry extends Omit<AgentCatalogEntry, 'nesting'> {
  readonly nesting: readonly string[];
}

export interface ResolvedAgentCatalog {
  readonly schemaVersion: 1;
  readonly identities: readonly string[];
  readonly agents: Readonly<Record<string, ResolvedAgentCatalogEntry>>;
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
