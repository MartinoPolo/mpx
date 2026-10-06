import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Harness, UserConfig } from './contracts.js';

const PI_STATUS_FILE = 'orca-agent-status.ts';
const PI_FILES = [
  PI_STATUS_FILE,
  'orca-prefill.ts',
  'orca-titlebar-spinner.ts',
] as const;
const PI_MARKER = Buffer.from('@orca-managed-pi-extension');
const JSON_LIMIT = 1024 * 1024;
const EXTENSION_LIMIT = 4 * 1024 * 1024;

export type OrcaMirrorStatus =
  | 'unchanged'
  | 'would-create'
  | 'would-update'
  | 'created'
  | 'updated'
  | 'conflict'
  | 'skipped'
  | 'failed';

export interface OrcaMirrorEntry {
  harness: Harness;
  source: string;
  destination: string;
  status: OrcaMirrorStatus;
  error?: string;
}

export interface OrcaMirrorResult {
  ok: boolean;
  preview: boolean;
  results: OrcaMirrorEntry[];
}

class HookMetadataConflict extends Error {}

type JsonObject = Record<string, unknown>;
type Root = { physical: string };
type Snapshot = { exists: false } | { exists: true; bytes: Buffer };

function record(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function managedCommandMatcher(command: string | undefined): boolean {
  if (!command) return false;
  const match = command.match(/\s-EncodedCommand\s+(\S+)/i);
  let decoded: string | undefined;
  if (match?.[1]) {
    try {
      decoded = Buffer.from(match[1], 'base64').toString('utf16le');
    } catch {
      decoded = undefined;
    }
  }
  const normalized = (decoded ? `${command}\n${decoded}` : command).replaceAll('\\', '/');
  return ['cmd', 'ps1', 'sh'].some(extension =>
    normalized.includes(`agent-hooks/claude-hook.${extension}`));
}

function managedNestedHook(value: JsonObject): boolean {
  if (managedCommandMatcher(typeof value.command === 'string' ? value.command : undefined)) return true;
  return Array.isArray(value.args) && value.args.some(argument =>
    typeof argument === 'string' && managedCommandMatcher(argument));
}

function validateHookSettings(value: unknown): asserts value is JsonObject {
  if (!record(value)) throw new Error('settings must be a JSON object');
  if (value.hooks === undefined) return;
  if (!record(value.hooks)) throw new Error('hooks must be an object');
  for (const definitions of Object.values(value.hooks)) {
    if (!Array.isArray(definitions)) throw new Error('hook event must be an array');
    for (const definition of definitions) {
      if (!record(definition)) throw new Error('hook definition must be an object');
      if (definition.hooks === undefined) continue;
      if (!Array.isArray(definition.hooks)) throw new Error('nested hooks must be an array');
      for (const hook of definition.hooks) {
        if (!record(hook)) throw new Error('nested hook must be an object');
        if (hook.command !== undefined && typeof hook.command !== 'string') {
          throw new Error('nested hook command must be a string');
        }
        if (hook.args !== undefined &&
          (!Array.isArray(hook.args) || hook.args.some(argument => typeof argument !== 'string'))) {
          throw new Error('nested hook args must be strings');
        }
      }
    }
  }
}

/** Merge only Orca-owned nested Claude hooks from personal settings into work settings. */
export function mergeClaudeHookSettings(sourceValue: unknown, targetValue: unknown): JsonObject {
  validateHookSettings(sourceValue);
  validateHookSettings(targetValue);
  const sourceHooks = (sourceValue.hooks ?? {}) as JsonObject;
  const targetHooks = (targetValue.hooks ?? {}) as JsonObject;
  let nextHooks: JsonObject | undefined;

  for (const [eventName, sourceDefinitionsValue] of Object.entries(sourceHooks)) {
    const sourceDefinitions = sourceDefinitionsValue as JsonObject[];
    const additions: JsonObject[] = [];
    for (const definition of sourceDefinitions) {
      const hooks = (definition.hooks ?? []) as JsonObject[];
      const managed = hooks.filter(managedNestedHook);
      if (managed.length > 0) {
        const addition: JsonObject = { ...definition, hooks: managed };
        delete addition.command;
        delete addition.bash;
        delete addition.powershell;
        additions.push(addition);
      }
    }
    if (additions.length === 0) continue;

    const targetDefinitions = (targetHooks[eventName] ?? []) as JsonObject[];
    const cleaned = targetDefinitions.flatMap(definition => {
      if (!Array.isArray(definition.hooks)) return [definition];
      const hooks = (definition.hooks as JsonObject[]).filter(hook => !managedNestedHook(hook));
      if (hooks.length === definition.hooks.length) return [definition];
      if (hooks.length > 0) return [{ ...definition, hooks }];
      if (['command', 'bash', 'powershell'].some(key => typeof definition[key] === 'string')) {
        const preserved = { ...definition };
        delete preserved.hooks;
        return [preserved];
      }
      const metadata = Object.entries(definition).filter(([key]) => key !== 'hooks');
      if (!additions.some(addition => metadata.every(([key, value]) =>
        Object.hasOwn(addition, key) && isDeepStrictEqual(addition[key], value)))) {
        throw new HookMetadataConflict('Replacing managed hooks would discard target wrapper metadata');
      }
      return [];
    });
    nextHooks ??= { ...targetHooks };
    nextHooks[eventName] = [...cleaned, ...additions];
  }

  return nextHooks === undefined ? targetValue : { ...targetValue, hooks: nextHooks };
}

async function accountRoot(configured: string): Promise<Root> {
  const entry = await lstat(configured);
  if (!entry.isDirectory() && !entry.isSymbolicLink()) throw new Error('account root is not a directory');
  const physical = await realpath(configured);
  if (!(await stat(physical)).isDirectory()) throw new Error('account root is not a directory');
  return { physical: path.normalize(physical) };
}

function child(root: Root, relative: string): string {
  const candidate = path.resolve(root.physical, relative);
  const relation = path.relative(root.physical, candidate);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error('path leaves account root');
  }
  return candidate;
}

async function validateParents(root: Root, relative: string): Promise<'present' | 'missing'> {
  const parent = path.dirname(relative);
  if (parent === '.') return 'present';
  let current = root.physical;
  for (const part of parent.split(/[\\/]+/).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('unsafe path ancestry');
    } catch (error) {
      if (missing(error)) return 'missing';
      throw error;
    }
  }
  return 'present';
}

function sameFileObservation(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs;
}

async function boundedFile(root: Root, relative: string, limit: number): Promise<Snapshot> {
  child(root, relative);
  if (await validateParents(root, relative) === 'missing') return { exists: false };
  const file = child(root, relative);
  let entry;
  try {
    entry = await lstat(file);
  } catch (error) {
    if (missing(error)) return { exists: false };
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('path is not a regular file');

  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > limit || !sameFileObservation(entry, opened)) {
      throw new Error('file is unavailable, too large, or changed');
    }
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const observed = await handle.stat();
    const after = await lstat(file);
    if (offset > limit || offset !== opened.size || !observed.isFile() ||
      !after.isFile() || after.isSymbolicLink() ||
      !sameFileObservation(opened, observed) || !sameFileObservation(observed, after)) {
      throw new Error('path changed while reading');
    }
    return { exists: true, bytes: bytes.subarray(0, offset) };
  } finally {
    await handle.close();
  }
}

async function ensureExtensionDirectory(root: Root): Promise<void> {
  const directory = child(root, 'extensions');
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('unsafe extensions directory');
    return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  await mkdir(directory);
  const created = await lstat(directory);
  if (!created.isDirectory() || created.isSymbolicLink()) throw new Error('unsafe extensions directory');
}

async function stillMatches(root: Root, relative: string, expected: Snapshot, limit: number): Promise<boolean> {
  const current = await boundedFile(root, relative, limit);
  if (!expected.exists || !current.exists) return expected.exists === current.exists;
  return expected.bytes.equals(current.bytes);
}

async function atomicWrite(
  root: Root,
  relative: string,
  bytes: Buffer,
  expected: Snapshot,
  limit: number,
): Promise<void> {
  if (relative.startsWith(`extensions${path.sep}`) || relative.startsWith('extensions/')) {
    await ensureExtensionDirectory(root);
  }
  if (await validateParents(root, relative) !== 'present') throw new Error('destination parent is missing');
  const destination = child(root, relative);
  const temporary = path.join(path.dirname(destination), `.orca-mirror-${randomUUID()}.tmp`);
  let created = false;
  let moved = false;
  try {
    const handle = await open(temporary, 'wx');
    created = true;
    try { await handle.writeFile(bytes); }
    finally { await handle.close(); }
    if (!await stillMatches(root, relative, expected, limit)) {
      throw new Error('destination changed concurrently');
    }
    if (await validateParents(root, relative) !== 'present') throw new Error('destination path became unsafe');
    await rename(temporary, destination);
    moved = true;
  } finally {
    if (created && !moved) {
      try { await unlink(temporary); }
      catch (error) {
        if (!missing(error)) throw new Error('temporary file cleanup failed');
      }
    }
  }
}

function failed(harness: Harness, source: string, destination: string, error: string): OrcaMirrorEntry {
  return { harness, source, destination, status: 'failed', error };
}

async function mirrorPi(config: UserConfig, preview: boolean): Promise<OrcaMirrorEntry[]> {
  const sourceBase = config.accounts.personal.pi;
  const destinationBase = config.accounts.work.pi;
  let sourceRoot: Root;
  let destinationRoot: Root;
  try { sourceRoot = await accountRoot(sourceBase); }
  catch { return PI_FILES.map(name => failed('pi', path.join(sourceBase, 'extensions', name), path.join(destinationBase, 'extensions', name), 'personal Pi account root is unavailable')); }
  try { destinationRoot = await accountRoot(destinationBase); }
  catch { return PI_FILES.map(name => failed('pi', path.join(sourceBase, 'extensions', name), path.join(destinationBase, 'extensions', name), 'work Pi account root is unavailable')); }

  const results: OrcaMirrorEntry[] = [];
  for (const name of PI_FILES) {
    const source = path.join(sourceBase, 'extensions', name);
    const destination = path.join(destinationBase, 'extensions', name);
    try {
      const sourceSnapshot = await boundedFile(sourceRoot, path.join('extensions', name), EXTENSION_LIMIT);
      if (!sourceSnapshot.exists && name !== PI_STATUS_FILE) {
        results.push({ harness: 'pi', source, destination, status: 'skipped', error: 'optional Pi source extension is not installed; destination preserved' });
        continue;
      }
      if (!sourceSnapshot.exists || !sourceSnapshot.bytes.includes(PI_MARKER)) {
        results.push(failed('pi', source, destination, 'managed Pi source extension is missing or invalid'));
        continue;
      }
      const target = await boundedFile(destinationRoot, path.join('extensions', name), EXTENSION_LIMIT);
      if (target.exists && !target.bytes.includes(PI_MARKER)) {
        results.push({ harness: 'pi', source, destination, status: 'conflict', error: 'destination Pi extension is user-owned' });
        continue;
      }
      if (target.exists && target.bytes.equals(sourceSnapshot.bytes)) {
        results.push({ harness: 'pi', source, destination, status: 'unchanged' });
        continue;
      }
      const kind = target.exists ? 'update' : 'create';
      if (!preview) await atomicWrite(destinationRoot, path.join('extensions', name), sourceSnapshot.bytes, target, EXTENSION_LIMIT);
      results.push({ harness: 'pi', source, destination, status: preview ? `would-${kind}` : `${kind}d` } as OrcaMirrorEntry);
    } catch {
      results.push(failed('pi', source, destination, 'Pi extension could not be safely mirrored'));
    }
  }
  return results;
}

async function mirrorClaude(config: UserConfig, preview: boolean): Promise<OrcaMirrorEntry> {
  const source = path.join(config.accounts.personal.claude, 'settings.json');
  const destination = path.join(config.accounts.work.claude, 'settings.json');
  let sourceRoot: Root;
  let destinationRoot: Root;
  try { sourceRoot = await accountRoot(config.accounts.personal.claude); }
  catch { return failed('claude', source, destination, 'personal Claude account root is unavailable'); }
  try { destinationRoot = await accountRoot(config.accounts.work.claude); }
  catch { return failed('claude', source, destination, 'work Claude account root is unavailable'); }

  try {
    const sourceSnapshot = await boundedFile(sourceRoot, 'settings.json', JSON_LIMIT);
    if (!sourceSnapshot.exists) return failed('claude', source, destination, 'personal Claude settings are unavailable');
    const target = await boundedFile(destinationRoot, 'settings.json', JSON_LIMIT);
    let sourceSettings: unknown;
    let targetSettings: unknown = {};
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      sourceSettings = JSON.parse(decoder.decode(sourceSnapshot.bytes));
      if (target.exists) targetSettings = JSON.parse(decoder.decode(target.bytes));
    } catch {
      return failed('claude', source, destination, 'Claude settings JSON is malformed');
    }
    let merged: JsonObject;
    try {
      const ownedSource = mergeClaudeHookSettings(sourceSettings, {});
      if (!ownedSource.hooks) return failed('claude', source, destination, 'personal Claude settings contain no Orca-managed nested hooks');
      merged = mergeClaudeHookSettings(ownedSource, targetSettings);
    } catch (error) {
      if (error instanceof HookMetadataConflict) return { harness: 'claude', source, destination, status: 'conflict', error: 'Target hook metadata would be lost; resolve the hook conflict manually.' };
      return failed('claude', source, destination, 'Claude hook settings structure is malformed');
    }
    if (isDeepStrictEqual(merged, targetSettings)) {
      return { harness: 'claude', source, destination, status: 'unchanged' };
    }
    const bytes = Buffer.from(`${JSON.stringify(merged, null, 2)}\n`);
    if (bytes.length > JSON_LIMIT) throw new Error('merged Claude settings are too large');
    const kind = target.exists ? 'update' : 'create';
    if (!preview) await atomicWrite(destinationRoot, 'settings.json', bytes, target, JSON_LIMIT);
    return { harness: 'claude', source, destination, status: preview ? `would-${kind}` : `${kind}d` } as OrcaMirrorEntry;
  } catch {
    return failed('claude', source, destination, 'Claude settings could not be safely mirrored');
  }
}

/** Preview by default; writes only when preview is explicitly false. */
export async function mirrorOrcaHooks(
  config: UserConfig,
  options: { preview?: boolean; harness?: Harness } = {},
): Promise<OrcaMirrorResult> {
  const preview = options.preview !== false;
  const results = options.harness === 'pi'
    ? await mirrorPi(config, preview)
    : options.harness === 'claude'
      ? [await mirrorClaude(config, preview)]
      : [...await mirrorPi(config, preview), await mirrorClaude(config, preview)];
  return {
    ok: results.every(entry => entry.status !== 'failed' && entry.status !== 'conflict'),
    preview,
    results,
  };
}
