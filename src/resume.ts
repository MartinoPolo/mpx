import { open, lstat, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { TextDecoder } from 'node:util';
import type { Account, Harness, Thinking, UserConfig } from './contracts.js';

const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_COUNT = 50_000;
const MAX_ID_CHARS = 512;
const MAX_TYPE_CHARS = 128;
const MAX_TIMESTAMP_CHARS = 128;
const MAX_CWD_CHARS = 32_768;
const MAX_METADATA_CHARS = 4_096;
const MAX_USER_DISPLAY_CHARS = 4_096;
const READ_BUFFER_BYTES = 64 * 1024;
const ENCODED_CWD = /^--.+--$/;
const THINKING_VALUES: readonly Thinking[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const THINKING_LEVELS = new Set<Thinking>(THINKING_VALUES);

export interface NativeSession {
  harness: Harness;
  account: Account;
  accountRoot: string;
  file: string;
  id: string;
  cwd: string;
  title: string;
  modified: Date;
  provider?: string;
  model?: string;
  thinking?: Thinking;
}

export interface NativeSessionReadResult {
  session: NativeSession;
  warnings: string[];
}

export interface ResumeOverrides {
  provider?: string;
  model?: string;
  thinking?: Thinking;
}

export interface ResumeField {
  value: string;
  provenance: 'recovered' | 'override';
}

export interface ResumePlan {
  harness: Harness;
  account: Account;
  accountRoot: string;
  args: string[];
  cwd: string;
  fields: {
    provider: ResumeField;
    model: ResumeField;
    thinking: ResumeField;
  };
  overrideLabels: string[];
}

type JsonObject = Record<string, unknown>;
interface ParsedEntry extends JsonObject {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pathInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function absolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function comparablePath(value: string): string {
  if (win32.isAbsolute(value)) {
    let normalized = win32.normalize(value);
    const root = win32.parse(normalized).root;
    if (normalized.length > root.length) normalized = normalized.replace(/[\\/]+$/, '');
    return normalized.toLowerCase();
  }
  let normalized = resolve(value);
  const root = resolve(sep);
  if (normalized.length > root.length) normalized = normalized.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function cleanTitle(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return 'Untitled session';
  return clean.length > 160 ? `${clean.slice(0, 157)}...` : clean;
}

function displayPrefix(text: string, limit: number): string {
  // A V8 sliced string can retain its entire multi-megabyte parent. Copy only
  // this bounded prefix; UTF-16 preserves the original JavaScript code units.
  return Buffer.from(text.slice(0, limit), 'utf16le').toString('utf16le');
}

function displayText(content: unknown): string | undefined {
  if (typeof content === 'string') return displayPrefix(content, MAX_USER_DISPLAY_CHARS);
  if (!Array.isArray(content)) return undefined;
  let result = '';
  let found = false;
  for (const block of content) {
    if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
    if (found && result.length < MAX_USER_DISPLAY_CHARS) result += ' ';
    found = true;
    result += displayPrefix(block.text, MAX_USER_DISPLAY_CHARS - result.length);
    if (result.length >= MAX_USER_DISPLAY_CHARS) break;
  }
  return found ? result : undefined;
}

function diagnostic(file: string, message: string): Error {
  return new Error(`Invalid Pi session ${file}: ${message}`);
}

function boundedField(file: string, lineNumber: number, field: string, value: unknown, maxChars: number): unknown {
  if (typeof value === 'string') {
    if (value.length > maxChars) throw diagnostic(file, `line ${lineNumber} ${field} exceeds the ${maxChars}-character inspection limit`);
    return value;
  }
  // Retain enough invalid-state information for validation without retaining an
  // arbitrary object or array supplied in place of scalar metadata.
  return isObject(value) || Array.isArray(value) ? null : value;
}

function projectJsonValue(file: string, lineNumber: number, value: unknown, header: boolean): unknown {
  if (!isObject(value)) return null;
  if (header) {
    return {
      type: boundedField(file, lineNumber, 'type', value.type, MAX_TYPE_CHARS),
      version: boundedField(file, lineNumber, 'version', value.version, MAX_METADATA_CHARS),
      id: boundedField(file, lineNumber, 'id', value.id, MAX_ID_CHARS),
      timestamp: boundedField(file, lineNumber, 'timestamp', value.timestamp, MAX_TIMESTAMP_CHARS),
      cwd: boundedField(file, lineNumber, 'cwd', value.cwd, MAX_CWD_CHARS),
    };
  }

  const type = boundedField(file, lineNumber, 'type', value.type, MAX_TYPE_CHARS);
  const projected: JsonObject = {
    type,
    id: boundedField(file, lineNumber, 'id', value.id, MAX_ID_CHARS),
    parentId: boundedField(file, lineNumber, 'parentId', value.parentId, MAX_ID_CHARS),
    timestamp: boundedField(file, lineNumber, 'timestamp', value.timestamp, MAX_TIMESTAMP_CHARS),
  };
  if (type === 'session_info') {
    projected.name = boundedField(file, lineNumber, 'session_info name', value.name, MAX_METADATA_CHARS);
  } else if (type === 'model_change') {
    projected.provider = boundedField(file, lineNumber, 'model_change provider', value.provider, MAX_METADATA_CHARS);
    projected.modelId = boundedField(file, lineNumber, 'model_change modelId', value.modelId, MAX_METADATA_CHARS);
  } else if (type === 'thinking_level_change') {
    projected.thinkingLevel = boundedField(file, lineNumber, 'thinking level', value.thinkingLevel, MAX_METADATA_CHARS);
  } else if (type === 'message') {
    if (!isObject(value.message)) {
      projected.message = null;
    } else {
      const role = boundedField(file, lineNumber, 'message role', value.message.role, MAX_TYPE_CHARS);
      const message: JsonObject = { role };
      if (role === 'user') message.content = displayText(value.message.content);
      if (role === 'assistant') {
        message.provider = boundedField(file, lineNumber, 'assistant provider', value.message.provider, MAX_METADATA_CHARS);
        message.model = boundedField(file, lineNumber, 'assistant model', value.message.model, MAX_METADATA_CHARS);
      }
      projected.message = message;
    }
  }
  return projected;
}

async function secureTranscriptPath(file: string, accountRoot: string): Promise<string> {
  if (!absolutePath(file)) throw new Error(`Pi session file must be absolute: ${file}`);
  const root = resolve(accountRoot);
  const sessions = join(root, 'sessions');
  const candidate = resolve(file);
  const rel = relative(sessions, candidate);
  const parts = rel.split(sep);
  if (parts.length !== 2 || !ENCODED_CWD.test(parts[0] ?? '') || !parts[1]?.endsWith('.jsonl') || !pathInside(candidate, sessions)) {
    throw new Error(`Pi session is outside the configured transcript store: ${file}`);
  }

  const [accountInfo, sessionsInfo, directoryInfo, fileInfo] = await Promise.all([
    stat(root),
    lstat(sessions),
    lstat(join(sessions, parts[0]!)),
    lstat(candidate),
  ]).catch((error: unknown) => {
    throw new Error(`Pi session resource is unavailable at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!accountInfo.isDirectory()) throw new Error(`Pi account root is not a directory: ${accountRoot}`);
  if (!sessionsInfo.isDirectory() || sessionsInfo.isSymbolicLink()) throw new Error(`Pi sessions root is not a physical directory: ${sessions}`);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error(`Pi encoded-cwd directory is not a physical directory: ${parts[0]}`);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error(`Pi transcript is not a physical file: ${file}`);
  if (fileInfo.size > MAX_TRANSCRIPT_BYTES) throw new Error(`Pi transcript exceeds the ${MAX_TRANSCRIPT_BYTES}-byte inspection limit: ${file}`);

  const [canonicalRoot, canonicalSessions, canonicalFile] = await Promise.all([
    realpath(root), realpath(sessions), realpath(candidate),
  ]);
  if (!pathInside(canonicalSessions, canonicalRoot) || !pathInside(canonicalFile, canonicalSessions)) {
    throw new Error(`Pi session resolves outside the configured account transcript store: ${file}`);
  }
  // Preserve the configured-root spelling for the eventual --session argument. The
  // canonical path is used only as an escape check; the account root itself may be
  // an intentionally configured link.
  return candidate;
}

async function parseJsonLines(file: string): Promise<unknown[]> {
  const handle = await open(file, 'r');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  const result: unknown[] = [];
  let pending = '';
  let bytes = 0;
  let lineNumber = 0;

  const decode = (chunk?: Uint8Array, stream = false): string => {
    try {
      return decoder.decode(chunk, { stream });
    } catch {
      throw diagnostic(file, `invalid UTF-8 near line ${lineNumber + 1}`);
    }
  };
  const parseLine = (line: string) => {
    lineNumber += 1;
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw diagnostic(file, `line ${lineNumber} exceeds the inspection limit`);
    if (line.trim() === '') return;
    if (result.length > MAX_ENTRY_COUNT) {
      throw diagnostic(file, `entry count exceeds the ${MAX_ENTRY_COUNT}-entry inspection limit`);
    }
    try {
      const parsed: unknown = JSON.parse(line);
      result.push(projectJsonValue(file, lineNumber, parsed, result.length === 0));
    } catch (error) {
      if (error instanceof SyntaxError) throw diagnostic(file, `malformed JSON on line ${lineNumber}`);
      throw error;
    }
  };

  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAX_TRANSCRIPT_BYTES) throw diagnostic(file, `file exceeds the ${MAX_TRANSCRIPT_BYTES}-byte inspection limit`);
      pending += decode(buffer.subarray(0, bytesRead), true);
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        parseLine(pending.slice(0, newline).replace(/\r$/, ''));
        pending = pending.slice(newline + 1);
      }
      if (Buffer.byteLength(pending, 'utf8') > MAX_LINE_BYTES) throw diagnostic(file, `line ${lineNumber + 1} exceeds the inspection limit`);
    }
    pending += decode();
    if (pending.length > 0) parseLine(pending.replace(/\r$/, ''));
  } finally {
    await handle.close();
  }
  return result;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value));
}

function validateEntries(file: string, values: unknown[]): { header: JsonObject; entries: ParsedEntry[] } {
  if (values.length === 0) throw diagnostic(file, 'file is empty');
  const header = values[0];
  if (!isObject(header) || header.type !== 'session') throw diagnostic(file, 'first JSON value is not a session header');
  if (header.version !== 3) {
    throw diagnostic(file, `unsupported session version ${String(header.version ?? 1)}; open it with Pi to migrate it explicitly`);
  }
  if (typeof header.id !== 'string' || header.id.trim() === '') throw diagnostic(file, 'header id is missing');
  if (typeof header.cwd !== 'string' || header.cwd.trim() === '' || !absolutePath(header.cwd)) throw diagnostic(file, 'header cwd is missing or not absolute');
  if (!validTimestamp(header.timestamp)) throw diagnostic(file, 'header timestamp is invalid');

  const entries: ParsedEntry[] = [];
  const byId = new Map<string, ParsedEntry>();
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (!isObject(value) || typeof value.type !== 'string' || value.type === 'session') {
      throw diagnostic(file, `entry ${index} is not a session entry`);
    }
    if (typeof value.id !== 'string' || value.id === '') throw diagnostic(file, `entry ${index} has no id`);
    if (value.parentId !== null && typeof value.parentId !== 'string') throw diagnostic(file, `entry ${value.id} has an invalid parentId`);
    if (!validTimestamp(value.timestamp)) throw diagnostic(file, `entry ${value.id} has an invalid timestamp`);
    if (byId.has(value.id)) throw diagnostic(file, `duplicate entry id ${value.id}`);
    const entry = value as ParsedEntry;
    entries.push(entry);
    byId.set(entry.id, entry);
  }

  for (const entry of entries) {
    if (entry.parentId !== null && !byId.has(entry.parentId)) throw diagnostic(file, `entry ${entry.id} refers to missing parent ${entry.parentId}`);
  }
  const complete = new Set<string>();
  for (const entry of entries) {
    if (complete.has(entry.id)) continue;
    const active = new Set<string>();
    let cursor: ParsedEntry | undefined = entry;
    while (cursor && !complete.has(cursor.id)) {
      if (active.has(cursor.id)) throw diagnostic(file, `parent cycle includes entry ${cursor.id}`);
      active.add(cursor.id);
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    for (const id of active) complete.add(id);
  }
  return { header, entries };
}

function activeBranch(entries: ParsedEntry[]): ParsedEntry[] {
  if (entries.length === 0) return [];
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const branch: ParsedEntry[] = [];
  let cursor: ParsedEntry | undefined = entries[entries.length - 1];
  while (cursor) {
    branch.push(cursor);
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
  }
  branch.reverse();
  return branch;
}

function metadataFromBranch(file: string, branch: ParsedEntry[]): {
  title: string; provider?: string; model?: string; thinking?: Thinking; warnings: string[];
} {
  const warnings: string[] = [];
  let provider: string | undefined;
  let model: string | undefined;
  let thinking: Thinking | undefined;
  let firstUser: string | undefined;
  let namedTitle: string | undefined;

  for (const entry of branch) {
    if (entry.type === 'session_info') {
      if (entry.name === undefined) namedTitle = undefined;
      else if (typeof entry.name === 'string') namedTitle = entry.name;
      else warnings.push(`${file}: active session_info has invalid title metadata; ignoring it`);
      continue;
    }
    if (entry.type === 'thinking_level_change') {
      if (typeof entry.thinkingLevel === 'string' && THINKING_LEVELS.has(entry.thinkingLevel as Thinking)) {
        thinking = entry.thinkingLevel as Thinking;
      } else {
        thinking = undefined;
        warnings.push(`${file}: active branch has an invalid or unsupported thinking level; effort is unknown`);
      }
      continue;
    }
    if (entry.type === 'model_change') {
      if (typeof entry.provider === 'string' && entry.provider !== '' && typeof entry.modelId === 'string' && entry.modelId !== '') {
        provider = entry.provider;
        model = entry.modelId;
      } else {
        provider = undefined;
        model = undefined;
        warnings.push(`${file}: active model_change metadata is invalid; provider and model are unknown`);
      }
      continue;
    }
    if (entry.type !== 'message') continue;
    if (!isObject(entry.message) || typeof entry.message.role !== 'string') {
      warnings.push(`${file}: message entry ${entry.id} has invalid message metadata`);
      continue;
    }
    if (entry.message.role === 'user' && firstUser === undefined) {
      const text = displayText(entry.message.content);
      if (text !== undefined) firstUser = text;
    }
    if (entry.message.role === 'assistant') {
      if (typeof entry.message.provider === 'string' && entry.message.provider !== '' && typeof entry.message.model === 'string' && entry.message.model !== '') {
        provider = entry.message.provider;
        model = entry.message.model;
      } else {
        provider = undefined;
        model = undefined;
        warnings.push(`${file}: active assistant metadata is invalid; provider and model are unknown`);
      }
    }
  }

  if (provider === undefined) warnings.push(`${file}: recovered provider is unknown; an explicit override is required`);
  if (model === undefined) warnings.push(`${file}: recovered model is unknown; an explicit override is required`);
  if (thinking === undefined) warnings.push(`${file}: recovered effort is unknown; an explicit override is required (native Pi's implicit off default is not recovered state)`);
  return { title: cleanTitle(namedTitle ?? firstUser ?? ''), provider, model, thinking, warnings };
}

/** Read one v3 Pi transcript without invoking SessionManager (which can migrate or rewrite it). */
export async function readPiSession(file: string, account: Account, accountRoot: string): Promise<NativeSessionReadResult> {
  const safeFile = await secureTranscriptPath(file, accountRoot);
  const before = await stat(safeFile);
  const { header, entries } = validateEntries(safeFile, await parseJsonLines(safeFile));
  const after = await stat(safeFile);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`Pi session changed while it was being inspected: ${safeFile}`);
  const metadata = metadataFromBranch(safeFile, activeBranch(entries));
  const session: NativeSession = {
    harness: 'pi',
    account,
    accountRoot: resolve(accountRoot),
    file: safeFile,
    id: header.id as string,
    cwd: header.cwd as string,
    title: metadata.title,
    modified: after.mtime,
    ...(metadata.provider === undefined ? {} : { provider: metadata.provider }),
    ...(metadata.model === undefined ? {} : { model: metadata.model }),
    ...(metadata.thinking === undefined ? {} : { thinking: metadata.thinking }),
  };
  return { session, warnings: metadata.warnings };
}

async function listPiAccount(account: Account, accountRoot: string): Promise<{ sessions: NativeSession[]; warnings: string[] }> {
  const sessions: NativeSession[] = [];
  const warnings: string[] = [];
  const root = resolve(accountRoot);
  const sessionsRoot = join(root, 'sessions');
  let directories;
  try {
    const info = await lstat(sessionsRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('not a physical directory');
    directories = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    warnings.push(`${account} Pi session store is unavailable at ${sessionsRoot}: ${error instanceof Error ? error.message : String(error)}`);
    return { sessions, warnings };
  }

  for (const directory of directories) {
    if (!ENCODED_CWD.test(directory.name)) continue;
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      warnings.push(`${account} Pi session directory was skipped because it is not a physical directory: ${join(sessionsRoot, directory.name)}`);
      continue;
    }
    const directoryPath = join(sessionsRoot, directory.name);
    let files;
    try {
      files = await readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      warnings.push(`${account} Pi session directory is unreadable at ${directoryPath}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const file of files) {
      if (!file.name.endsWith('.jsonl')) continue;
      const filePath = join(directoryPath, file.name);
      if (!file.isFile() || file.isSymbolicLink()) {
        warnings.push(`${account} Pi transcript was skipped because it is not a physical file: ${filePath}`);
        continue;
      }
      try {
        const result = await readPiSession(filePath, account, root);
        sessions.push(result.session);
        warnings.push(...result.warnings);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return { sessions, warnings };
}

/** Enumerate every configured native Pi transcript. Claude roots are not inspected without a validated schema. */
export async function listNativeSessions(config: UserConfig, currentCwd: string): Promise<{ sessions: NativeSession[]; warnings: string[] }> {
  const sessions: NativeSession[] = [];
  const warnings: string[] = [];
  for (const account of ['personal', 'work'] as const) {
    const result = await listPiAccount(account, config.accounts[account].pi);
    sessions.push(...result.sessions);
    warnings.push(...result.warnings);
    warnings.push(`${account} Claude session listing is unsupported: no validated native transcript schema is available; ${config.accounts[account].claude} was not inspected`);
  }
  const current = comparablePath(currentCwd);
  sessions.sort((left, right) => {
    const leftCurrent = comparablePath(left.cwd) === current ? 1 : 0;
    const rightCurrent = comparablePath(right.cwd) === current ? 1 : 0;
    if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
    const modified = right.modified.getTime() - left.modified.getTime();
    if (modified !== 0) return modified;
    const account = left.account.localeCompare(right.account);
    if (account !== 0) return account;
    return left.file.localeCompare(right.file);
  });
  return { sessions, warnings };
}

function overrideValue(name: keyof ResumeOverrides, recovered: string | undefined, override: string | undefined): ResumeField {
  if (override !== undefined) {
    if (override.trim() === '') throw new Error(`${name} override must be non-empty`);
    return { value: override, provenance: 'override' };
  }
  if (recovered === undefined) throw new Error(`Recovered ${name} is unknown; an explicit ${name} override is required before resume`);
  return { value: recovered, provenance: 'recovered' };
}

/** Plan an exact native resume. This validates resources and returns arguments; it never launches. */
export async function planResume(session: NativeSession, overrides: ResumeOverrides = {}): Promise<ResumePlan> {
  if (session.harness !== 'pi') throw new Error('Claude native resume is unsupported without a validated session schema and fidelity evidence');
  if (overrides.thinking !== undefined
    && (typeof overrides.thinking !== 'string' || !THINKING_LEVELS.has(overrides.thinking))) {
    throw new Error(`thinking override must be one of: ${THINKING_VALUES.join(', ')}`);
  }
  const file = await secureTranscriptPath(session.file, session.accountRoot);
  const current = await readPiSession(file, session.account, session.accountRoot);
  const changed = current.session.id !== session.id
    || comparablePath(current.session.cwd) !== comparablePath(session.cwd)
    || current.session.modified.getTime() !== session.modified.getTime()
    || current.session.provider !== session.provider
    || current.session.model !== session.model
    || current.session.thinking !== session.thinking;
  if (changed) throw new Error(`Pi session changed since it was listed; refresh before resuming: ${file}`);
  const cwdInfo = await stat(session.cwd).catch((error: unknown) => {
    throw new Error(`Resume cwd is unavailable at ${session.cwd}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!cwdInfo.isDirectory()) throw new Error(`Resume cwd is not a directory: ${session.cwd}`);

  const fields = {
    provider: overrideValue('provider', session.provider, overrides.provider),
    model: overrideValue('model', session.model, overrides.model),
    thinking: overrideValue('thinking', session.thinking, overrides.thinking),
  };
  const args = ['--session', file];
  const overrideLabels: string[] = [];
  for (const [name, flag] of [['provider', '--provider'], ['model', '--model'], ['thinking', '--thinking']] as const) {
    const field = fields[name];
    if (field.provenance === 'override') {
      args.push(flag, field.value);
      overrideLabels.push(`${name}=${field.value} (override)`);
    }
  }
  return {
    harness: session.harness,
    account: session.account,
    accountRoot: resolve(session.accountRoot),
    args,
    cwd: session.cwd,
    fields,
    overrideLabels,
  };
}
