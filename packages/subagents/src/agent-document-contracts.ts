import type { ResolvedAgentCatalogEntryV1 } from './agent-catalog-contracts.js';

declare const verifiedCanonicalAgentDocument: unique symbol;
export interface CanonicalAgentDocumentV1 {
  readonly schemaVersion: 1;
  readonly identity: string;
  readonly [verifiedCanonicalAgentDocument]: true;
}
export interface CanonicalAgentProjectionEntryV1 {
  readonly identity: string;
  readonly document: CanonicalAgentDocumentV1;
  readonly metadata: ResolvedAgentCatalogEntryV1;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly sourceByteCount: number;
}
export interface CanonicalAgentSupportFileV1 {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}
export interface CanonicalAgentProjectionInputsV1 {
  readonly schemaVersion: 1;
  readonly entries: readonly CanonicalAgentProjectionEntryV1[];
  readonly supportFiles: readonly CanonicalAgentSupportFileV1[];
}
export interface CanonicalAgentRuntimeFieldV1 {
  readonly name: string;
  readonly value: string;
}
export interface CanonicalAgentDocumentTranslationV1 {
  readonly name: string;
  readonly fields: readonly CanonicalAgentRuntimeFieldV1[];
}
export interface CanonicalAgentProjectionLoadOptionsV1 {
  readonly allowMissingMetadata?: boolean;
}
export interface CanonicalAgentDocumentFileSystemV1 {
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
