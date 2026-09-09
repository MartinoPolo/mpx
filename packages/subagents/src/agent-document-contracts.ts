import type { ResolvedAgentCatalogEntry } from './agent-catalog-contracts.js';

declare const verifiedCanonicalAgentDocument: unique symbol;
export interface CanonicalAgentDocument {
  readonly schemaVersion: 1;
  readonly identity: string;
  readonly [verifiedCanonicalAgentDocument]: true;
}
export interface CanonicalAgentProjectionEntry {
  readonly identity: string;
  readonly document: CanonicalAgentDocument;
  readonly metadata: ResolvedAgentCatalogEntry;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly sourceByteCount: number;
}
export interface CanonicalAgentSupportFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}
export interface CanonicalAgentProjectionInputs {
  readonly schemaVersion: 1;
  readonly entries: readonly CanonicalAgentProjectionEntry[];
  readonly supportFiles: readonly CanonicalAgentSupportFile[];
}
export interface CanonicalAgentRuntimeField {
  readonly name: string;
  readonly value: string;
}
export interface CanonicalAgentDocumentTranslation {
  readonly name: string;
  readonly fields: readonly CanonicalAgentRuntimeField[];
}
export interface CanonicalAgentProjectionLoadOptions {
  readonly allowMissingMetadata?: boolean;
}
export interface CanonicalAgentDocumentFileSystem {
  lstat(path: string): Promise<{
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    size: number;
    mtimeMs: number;
  }>;
  realpath(path: string): Promise<string>;
  readdir(
    path: string,
    options?: { withFileTypes: true },
  ): Promise<
    readonly {
      name: string;
      isFile(): boolean;
      isDirectory(): boolean;
      isSymbolicLink(): boolean;
    }[]
  >;
  readFile(path: string): Promise<Uint8Array>;
}
export type AgentDocumentErrorCode =
  | 'AGENT_ROOT_INVALID'
  | 'AGENT_FILE_INVALID'
  | 'AGENT_SYMLINK'
  | 'AGENT_ESCAPE'
  | 'AGENT_DOCUMENT_INVALID'
  | 'AGENT_METADATA_INVALID'
  | 'AGENT_METADATA_FILE_INVALID'
  | 'AGENT_REFERENCE_INVALID'
  | 'AGENT_INVENTORY_LIMIT'
  | 'AGENT_FILE_LIMIT'
  | 'AGENT_RACE';
export interface AgentDocumentErrorOptions extends ErrorOptions {
  readonly path?: string;
}
export class AgentDocumentError extends Error {
  declare readonly path?: string;

  constructor(
    readonly code: AgentDocumentErrorCode,
    message: string,
    options?: AgentDocumentErrorOptions,
  ) {
    super(message, options);
    this.name = 'AgentDocumentError';
    if (options?.path !== undefined) {
      Object.defineProperty(this, 'path', { value: options.path, enumerable: true });
    }
  }
}
