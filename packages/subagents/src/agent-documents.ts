import { createHash } from 'node:crypto';
import * as nativeFs from 'node:fs/promises';
import path from 'node:path';
import { parseAgentCatalogV1, resolveAgentCatalogV1 } from './agent-catalog.js';
import { AgentCatalogError } from './agent-catalog-contracts.js';
import {
  AgentDocumentError,
  type CanonicalAgentDocumentFileSystemV1,
  type CanonicalAgentDocumentTranslationV1,
  type CanonicalAgentDocumentV1,
  type CanonicalAgentProjectionInputsV1,
  type CanonicalAgentProjectionLoadOptionsV1,
} from './agent-document-contracts.js';

const MAX_DOCUMENTS = 128,
  MAX_SUPPORT_FILES = 128,
  MAX_DOCUMENT_BYTES = 1024 * 1024,
  MAX_METADATA_BYTES = 4 * 1024 * 1024,
  MAX_SUPPORT_BYTES = 4 * 1024 * 1024,
  MAX_TOTAL_BYTES = 32 * 1024 * 1024;
interface PrivateDocument {
  bytes: Uint8Array;
  nameStart: number;
  nameEnd: number;
  closingStart: number;
  newline: Uint8Array;
}
const verifiedDocuments = new WeakMap<CanonicalAgentDocumentV1, PrivateDocument>();
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const byteSort = (left: string, right: string) =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));
function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
function fail(
  code: ConstructorParameters<typeof AgentDocumentError>[0],
  message: string,
  cause?: unknown,
): never {
  throw new AgentDocumentError(code, message, cause === undefined ? undefined : { cause });
}
async function exactRead(
  fs: CanonicalAgentDocumentFileSystemV1,
  file: string,
  root: string,
  maximum: number,
  kind: 'agent' | 'metadata' | 'reference',
): Promise<Uint8Array> {
  const code =
    kind === 'reference'
      ? 'AGENT_REFERENCE_INVALID'
      : kind === 'metadata'
        ? 'AGENT_METADATA_INVALID'
        : 'AGENT_FILE_INVALID';
  try {
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink()) {
      if (kind === 'metadata') {
        throw new AgentDocumentError(
          'AGENT_METADATA_FILE_INVALID',
          'metadata must be a regular non-symlink file',
          { path: file },
        );
      }
      fail(kind === 'agent' ? 'AGENT_SYMLINK' : code, `${kind} must be a regular non-symlink file`);
    }
    if (before.size > maximum) {
      fail('AGENT_FILE_LIMIT', `${kind} exceeds its byte limit`);
    }
    const resolved = await fs.realpath(file);
    if (!contained(root, resolved)) {
      fail(kind === 'agent' ? 'AGENT_ESCAPE' : code, `${kind} escapes its verified root`);
    }
    const first = new Uint8Array(await fs.readFile(file));
    const second = new Uint8Array(await fs.readFile(file));
    const after = await fs.lstat(file);
    if (
      first.length !== before.size ||
      second.length !== first.length ||
      !Buffer.from(first).equals(second) ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.isSymbolicLink()
    ) {
      fail('AGENT_RACE', `${kind} changed while being read`);
    }
    return first;
  } catch (error) {
    if (error instanceof AgentDocumentError) {
      throw error;
    }
    fail(code, `${kind} could not be read`, error);
  }
}
function parseDocument(identity: string, bytes: Uint8Array): CanonicalAgentDocumentV1 {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch (error) {
    fail('AGENT_DOCUMENT_INVALID', `invalid UTF-8 canonical agent ${identity}`, error);
  }
  const opening = text.startsWith('---\r\n') ? '\r\n' : text.startsWith('---\n') ? '\n' : undefined;
  if (!opening) {
    fail('AGENT_DOCUMENT_INVALID', `invalid canonical agent ${identity}`);
  }
  const linePattern = /(^|\r?\n)([^\r\n]*)(?=\r?\n|$)/gu;
  let closingStart = -1,
    nameStart = -1,
    nameEnd = -1,
    names = 0,
    match: RegExpExecArray | null;
  while ((match = linePattern.exec(text))) {
    const line = match[2]!,
      lineStart = match.index + match[1]!.length;
    if (lineStart === 0) {
      continue;
    }
    if (line === '---') {
      closingStart = lineStart;
      break;
    }
    const name = /^name: ([A-Za-z0-9][A-Za-z0-9-]*)$/u.exec(line);
    if (name) {
      names += 1;
      nameStart = lineStart + 'name: '.length;
      nameEnd = nameStart + name[1]!.length;
    } else if (/^name\s*:/u.test(line)) {
      names += 1;
    }
  }
  if (
    closingStart < 0 ||
    names !== 1 ||
    decoder.decode(bytes.slice(nameStart, nameEnd)) !== identity
  ) {
    fail('AGENT_DOCUMENT_INVALID', `invalid canonical agent ${identity}`);
  }
  const document = Object.freeze({
    schemaVersion: 1 as const,
    identity,
  }) as CanonicalAgentDocumentV1;
  verifiedDocuments.set(document, {
    bytes: new Uint8Array(bytes),
    nameStart,
    nameEnd,
    closingStart: encoder.encode(text.slice(0, closingStart)).length,
    newline: encoder.encode(opening),
  });
  return document;
}

export async function loadCanonicalAgentProjectionInputsV1(
  root: string,
  options: CanonicalAgentProjectionLoadOptionsV1 = {},
  injectedFs?: CanonicalAgentDocumentFileSystemV1,
): Promise<CanonicalAgentProjectionInputsV1> {
  const fs = injectedFs ?? (nativeFs as unknown as CanonicalAgentDocumentFileSystemV1);
  let verifiedRoot: string;
  try {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail('AGENT_ROOT_INVALID', 'canonical agents root must be a real non-symlink directory');
    }
    verifiedRoot = await fs.realpath(root);
  } catch (error) {
    if (error instanceof AgentDocumentError) {
      throw error;
    }
    fail('AGENT_ROOT_INVALID', 'canonical agents root must be a real non-symlink directory', error);
  }
  const rootEntries = await fs.readdir(verifiedRoot, { withFileTypes: true });
  const rootInventory = rootEntries
    .map(
      (entry) =>
        `${entry.name}\0${entry.isFile() ? 'f' : entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'o'}`,
    )
    .sort(byteSort);
  const names = rootEntries
    .map((x) => x.name)
    .filter((name) => /^mpx-[a-z0-9-]+\.md$/u.test(name))
    .sort(byteSort);
  if (names.length > MAX_DOCUMENTS) {
    fail('AGENT_INVENTORY_LIMIT', 'canonical agent document count exceeds limit');
  }
  let total = 0;
  const documents: {
    identity: string;
    document: CanonicalAgentDocumentV1;
    sourcePath: string;
    sourceSha256: string;
    sourceByteCount: number;
  }[] = [];
  for (const name of names) {
    const bytes = await exactRead(
      fs,
      path.join(verifiedRoot, name),
      verifiedRoot,
      MAX_DOCUMENT_BYTES,
      'agent',
    );
    total += bytes.length;
    const identity = name.slice(0, -3);
    documents.push({
      identity,
      document: parseDocument(identity, bytes),
      sourcePath: name,
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
      sourceByteCount: bytes.byteLength,
    });
  }
  let metadataBytes: Uint8Array | undefined;
  try {
    metadataBytes = await exactRead(
      fs,
      path.join(verifiedRoot, 'metadata.json'),
      verifiedRoot,
      MAX_METADATA_BYTES,
      'metadata',
    );
    total += metadataBytes.length;
  } catch (error) {
    if (
      !options.allowMissingMetadata ||
      !(error instanceof AgentDocumentError) ||
      (error.cause as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT'
    ) {
      throw error;
    }
  }
  let catalog;
  try {
    catalog = resolveAgentCatalogV1(
      metadataBytes
        ? parseAgentCatalogV1(decoder.decode(metadataBytes))
        : { schemaVersion: 1, agents: {} },
      documents.map((x) => x.identity),
    );
  } catch (error) {
    if (error instanceof AgentCatalogError) {
      throw error;
    }
    fail('AGENT_METADATA_INVALID', 'agent metadata is invalid', error);
  }
  const supportFiles: { relativePath: string; bytes: Uint8Array }[] = [];
  let referenceInventory: readonly string[] | undefined;
  const references = path.join(verifiedRoot, 'references');
  try {
    const referenceStat = await fs.lstat(references);
    if (!referenceStat.isDirectory() || referenceStat.isSymbolicLink()) {
      fail('AGENT_REFERENCE_INVALID', 'agent references root must be a real non-symlink directory');
    }
    const referenceRoot = await fs.realpath(references);
    if (!contained(verifiedRoot, referenceRoot)) {
      fail('AGENT_REFERENCE_INVALID', 'agent references must remain within the verified root');
    }
    const entries = [...(await fs.readdir(referenceRoot, { withFileTypes: true }))].sort((a, b) =>
      byteSort(a.name, b.name),
    );
    referenceInventory = entries.map(
      (entry) =>
        `${entry.name}\0${entry.isFile() ? 'f' : entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'o'}`,
    );
    if (entries.length > MAX_SUPPORT_FILES) {
      fail('AGENT_INVENTORY_LIMIT', 'agent support file count exceeds limit');
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        fail('AGENT_REFERENCE_INVALID', 'agent references must be regular files');
      }
      const bytes = await exactRead(
        fs,
        path.join(referenceRoot, entry.name),
        referenceRoot,
        MAX_SUPPORT_BYTES,
        'reference',
      );
      total += bytes.length;
      supportFiles.push(
        Object.freeze({ relativePath: `references/${entry.name}`, bytes: new Uint8Array(bytes) }),
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw error;
    }
  }
  if (total > MAX_TOTAL_BYTES) {
    fail('AGENT_FILE_LIMIT', 'canonical agent aggregate bytes exceed limit');
  }
  const finalRoot = (await fs.readdir(verifiedRoot, { withFileTypes: true }))
    .map(
      (entry) =>
        `${entry.name}\0${entry.isFile() ? 'f' : entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'o'}`,
    )
    .sort(byteSort);
  if (rootInventory.join('\n') !== finalRoot.join('\n')) {
    fail('AGENT_RACE', 'canonical agent inventory changed while being read');
  }
  if (referenceInventory) {
    const finalReferences = (await fs.readdir(references, { withFileTypes: true }))
      .map(
        (entry) =>
          `${entry.name}\0${entry.isFile() ? 'f' : entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'o'}`,
      )
      .sort(byteSort);
    if (referenceInventory.join('\n') !== finalReferences.join('\n')) {
      fail('AGENT_RACE', 'agent support inventory changed while being read');
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    entries: Object.freeze(
      documents.map(({ identity, document, sourcePath, sourceSha256, sourceByteCount }) =>
        Object.freeze({
          identity,
          document,
          metadata: catalog.agents[identity]!,
          sourcePath,
          sourceSha256,
          sourceByteCount,
        }),
      ),
    ),
    supportFiles: Object.freeze(supportFiles),
  });
}

export function renderCanonicalAgentDocumentV1(
  document: CanonicalAgentDocumentV1,
  translation: CanonicalAgentDocumentTranslationV1,
): Uint8Array {
  const source = verifiedDocuments.get(document);
  if (!source || document.identity !== (document as { identity?: unknown }).identity) {
    fail('AGENT_DOCUMENT_INVALID', 'canonical agent document is not verified');
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(translation.name) ||
    translation.fields.some(
      (field) => !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(field.name) || /[\r\n]/u.test(field.value),
    )
  ) {
    fail('AGENT_DOCUMENT_INVALID', 'runtime agent translation is invalid');
  }
  const name = encoder.encode(translation.name),
    lines = encoder.encode(
      translation.fields
        .map((field) => `${field.name}: ${field.value}`)
        .join(decoder.decode(source.newline)),
    );
  const insertion = translation.fields.length
    ? Buffer.concat([lines, source.newline, source.newline])
    : new Uint8Array();
  return Buffer.concat([
    source.bytes.slice(0, source.nameStart),
    name,
    source.bytes.slice(source.nameEnd, source.closingStart),
    insertion,
    source.bytes.slice(source.closingStart),
  ]);
}
