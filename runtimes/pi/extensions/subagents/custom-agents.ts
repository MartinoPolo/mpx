/**
 * custom-agents.ts — Load compiler-owned, global, and project-defined agent overlays.
 */

import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { getAgentDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { loadActiveContentProjection, readActiveContentEntry } from '@mpx/content-compiler';
import {
  parseRuntimeContext,
  revalidateRuntimeArtifact,
  type PublishedRuntimeArtifactReference,
} from '@mpx/runtime-contracts';
import {
  bindNativeAgentDirectory,
  type NativeAgentDirectory,
  type NativeAgentFile,
  readExistingAgentFile,
  readNativeAgentFile,
  resolveAgentDirectory,
  resolveExistingAgentFile,
  resolveNativeAgentFile,
  verifyNativeAgentDirectory,
} from './agent-file-policy.js';
import { BUILTIN_TOOL_NAMES } from './agent-types.js';
import type { AgentConfig, MemoryScope, ThinkingLevel } from './types.js';

/**
 * Scan for agent definitions within one discovery boundary.
 *
 * Managed MPX launches expose only the compiler-owned catalog. Native Pi launches
 * retain global, shared-workspace, and project discovery with their existing
 * precedence. Native roots may be linked; discovery pins their canonical directory
 * identity for the whole scan and reads only verified direct regular files.
 */
export interface CompiledAgentsFileSystem {
  lstat(path: string): {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isReparsePoint?(): boolean;
  };
  realpath(path: string): string;
}

const compiledAgentsFileSystem: CompiledAgentsFileSystem = {
  lstat: (path) => lstatSync(path),
  realpath: (path) => realpathSync.native(path),
};

const MAX_COMPILED_AGENTS_PATH_LENGTH = 4096;

function comparablePath(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/** Validate the compiler-owned directory and every ancestor without following redirects. */
export function resolveCompiledAgentsDirectory(
  configuredPath: string,
  fileSystem: CompiledAgentsFileSystem = compiledAgentsFileSystem,
): string {
  if (
    configuredPath.length === 0 ||
    configuredPath.length > MAX_COMPILED_AGENTS_PATH_LENGTH ||
    /[\x00-\x1f\x7f]/.test(configuredPath) ||
    !isAbsolute(configuredPath)
  ) {
    throw new Error('Unsafe compiled agents directory');
  }

  const directory = resolve(configuredPath);
  const root = parse(directory).root;
  const components = relative(root, directory).split(sep).filter(Boolean);
  let current = root;

  for (const component of [undefined, ...components]) {
    if (component !== undefined) {
      current = join(current, component);
    }
    const metadata = fileSystem.lstat(current);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.isReparsePoint?.() === true ||
      comparablePath(fileSystem.realpath(current)) !== comparablePath(current)
    ) {
      throw new Error(`Unsafe compiled agents directory: "${current}"`);
    }
  }

  return directory;
}

export interface AgentDiscoveryOptions {
  nativeFiles?: Map<string, NativeAgentFile>;
  onDiagnostic?: (message: string) => void;
  onBoundary?: (boundary: 'managed' | 'native') => void;
}

const MANAGED_DISCOVERY_ENVIRONMENT = [
  'MPX_RUNTIME',
  'MPX_RUNTIME_CONTEXT',
  'MPX_ACTIVE_CONTENT_ROOT',
  'MPX_ACTIVE_CONTENT_MANIFEST',
  'MPX_ACTIVE_CONTENT_MANIFEST_INTEGRITY',
  'MPX_COMPILED_AGENTS_DIR',
  'MPX_RUNTIME_PROJECTION_REFERENCE',
  'MPX_IDENTITY',
  'MPX_MODE',
] as const;

function environmentRecord(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Invalid managed agent discovery binding: ${label}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid managed agent discovery binding: ${label}`);
  }
  return parsed as Record<string, unknown>;
}

function bindingText(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid managed agent discovery binding: ${label}.${field}`);
  }
  return value;
}

async function resolveManagedAgentsDirectory(
  environment: NodeJS.ProcessEnv,
  configuredCompiledDirectory: string | undefined,
) {
  const present = MANAGED_DISCOVERY_ENVIRONMENT.filter((name) => environment[name] !== undefined);
  if (present.length === 0) {
    return undefined;
  }

  const required = MANAGED_DISCOVERY_ENVIRONMENT.slice(0, 7);
  if (required.some((name) => !environment[name])) {
    throw new Error('Invalid managed agent discovery binding: partial environment');
  }
  if ((environment.MPX_IDENTITY === undefined) !== (environment.MPX_MODE === undefined)) {
    throw new Error('Invalid managed agent discovery binding: partial identity');
  }
  if (
    environment.MPX_IDENTITY !== undefined &&
    ![environment.MPX_IDENTITY, environment.MPX_MODE].every((value) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value!),
    )
  ) {
    throw new Error('Invalid managed agent discovery binding: identity');
  }
  if (environment.MPX_RUNTIME !== 'pi') {
    throw new Error('Invalid managed agent discovery binding: runtime');
  }

  const activeRoot = environment.MPX_ACTIVE_CONTENT_ROOT!;
  const manifest = environment.MPX_ACTIVE_CONTENT_MANIFEST!;
  const compiled = configuredCompiledDirectory!;
  if (
    !isAbsolute(activeRoot) ||
    comparablePath(manifest) !== comparablePath(join(activeRoot, 'active-content.json')) ||
    comparablePath(compiled) !== comparablePath(join(activeRoot, 'agents'))
  ) {
    throw new Error('Invalid managed agent discovery binding: projection paths');
  }

  const context = parseRuntimeContext(
    environmentRecord(environment.MPX_RUNTIME_CONTEXT!, 'runtime context'),
  );
  const reference = environmentRecord(
    environment.MPX_RUNTIME_PROJECTION_REFERENCE!,
    'projection reference',
  );
  const launchDescriptor = context.launchDescriptor;
  const runtimeArtifact = context.runtimeArtifact;
  const launchBinding = reference.launchBinding;
  if (
    typeof launchDescriptor !== 'object' ||
    launchDescriptor === null ||
    typeof launchBinding !== 'object' ||
    launchBinding === null
  ) {
    throw new Error('Invalid managed agent discovery binding: projection identity');
  }
  const descriptor = launchDescriptor as Record<string, unknown>;
  const binding = launchBinding as Record<string, unknown>;
  const digest = (value: string): boolean => /^[a-f0-9]{64}$/u.test(value);
  if (
    !digest(bindingText(reference, 'projectionKey', 'projection reference')) ||
    !digest(bindingText(reference, 'fileMapHash', 'projection reference')) ||
    context.launchKey !== bindingText(binding, 'launchKey', 'projection reference') ||
    descriptor.digest !== bindingText(binding, 'descriptorDigest', 'projection reference') ||
    context.manifestKey !== bindingText(binding, 'manifestKey', 'projection reference') ||
    runtimeArtifact.artifactKey !==
      bindingText(binding, 'runtimeArtifactKey', 'projection reference') ||
    runtimeArtifact.runtime !== 'pi' ||
    binding.runtime !== 'pi'
  ) {
    throw new Error('Invalid managed agent discovery binding: projection identity');
  }

  const integrity = environmentRecord(
    environment.MPX_ACTIVE_CONTENT_MANIFEST_INTEGRITY!,
    'manifest integrity',
  );
  if (
    !/^[a-f0-9]{64}$/u.test(bindingText(integrity, 'sha256', 'manifest integrity')) ||
    !Number.isSafeInteger(integrity.byteCount) ||
    (integrity.byteCount as number) < 0
  ) {
    throw new Error('Invalid managed agent discovery binding: manifest integrity');
  }

  resolveCompiledAgentsDirectory(compiled);
  const active = await loadActiveContentProjection({
    root: activeRoot,
    manifestPath: manifest,
    expected: {
      runtime: 'pi',
      manifestKey: context.manifestKey,
      binding: context.binding,
      manifestFile: {
        sha256: bindingText(integrity, 'sha256', 'manifest integrity'),
        byteCount: integrity.byteCount as number,
      },
    },
  });
  const projectionValidation = await revalidateRuntimeArtifact(
    activeRoot,
    reference as unknown as PublishedRuntimeArtifactReference,
  );
  if (!projectionValidation.valid) {
    throw new Error('Invalid managed agent discovery binding: projection integrity');
  }
  return active;
}

export async function loadCustomAgents(
  cwd: string,
  options: AgentDiscoveryOptions = {},
): Promise<Map<string, AgentConfig>> {
  const globalDir = join(getAgentDir(), 'agents');
  const workspaceProjectDir = join(cwd, '.agents', 'agents');
  const projectDir = join(cwd, '.pi', 'agents');

  const agents = new Map<string, AgentConfig>();
  options.nativeFiles?.clear();
  let diagnosticsRemaining = 3;
  const diagnose = (error: unknown): void => {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' && diagnosticsRemaining-- > 0) {
      options.onDiagnostic?.(
        String(error)
          .replace(/[\x00-\x1f\x7f]/g, ' ')
          .slice(0, 300),
      );
    }
  };
  const managed = await resolveManagedAgentsDirectory(
    process.env,
    process.env.MPX_COMPILED_AGENTS_DIR,
  );
  if (managed !== undefined) {
    options.onBoundary?.('managed');
    for (const entry of managed.manifest.agents) {
      const content = (
        await readActiveContentEntry(managed, 'agent', entry.projectedIdentity)
      ).toString('utf8');
      agents.set(
        entry.projectedIdentity,
        parseAgentConfig(entry.projectedIdentity, content, 'compiled'),
      );
    }
    return agents;
  }
  options.onBoundary?.('native');
  loadFromDir(globalDir, agents, 'global', options, diagnose);
  loadFromDir(workspaceProjectDir, agents, 'project', options, diagnose);
  loadFromDir(projectDir, agents, 'project', options, diagnose);
  return agents;
}

/** Load agent configs from a directory into the map. */
function loadFromDir(
  dir: string,
  agents: Map<string, AgentConfig>,
  source: 'compiled' | 'project' | 'global',
  options: AgentDiscoveryOptions,
  diagnose: (error: unknown) => void,
): void {
  let safeDirectory: string;
  let directory: NativeAgentDirectory | undefined;
  let files: string[];
  try {
    directory = source === 'compiled' ? undefined : bindNativeAgentDirectory(dir);
    safeDirectory = directory?.canonicalPath ?? resolveAgentDirectory(dir);
    files = readdirSync(safeDirectory, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith('.md') && entry.isFile() && !entry.isSymbolicLink())
      .map((entry) => entry.name);
    if (directory) {
      verifyNativeAgentDirectory(directory);
    }
  } catch (error) {
    diagnose(error);
    return;
  }

  const discoveredAgents = new Map<string, AgentConfig>();
  const discoveredFiles = new Map<string, NativeAgentFile>();
  for (const file of files) {
    const name = basename(file, '.md');

    let content: string;
    try {
      if (directory) {
        const nativeFile = resolveNativeAgentFile(directory, name);
        content = readNativeAgentFile(nativeFile);
        discoveredFiles.set(name, nativeFile);
      } else {
        content = readExistingAgentFile(resolveExistingAgentFile(safeDirectory, name));
      }
    } catch (error) {
      diagnose(error);
      continue;
    }

    discoveredAgents.set(name, parseAgentConfig(name, content, source));
  }
  try {
    if (directory) {
      verifyNativeAgentDirectory(directory);
    }
  } catch (error) {
    diagnose(error);
    return;
  }
  for (const [name, config] of discoveredAgents) {
    agents.set(name, config);
    const file = discoveredFiles.get(name);
    if (file) {
      options.nativeFiles?.set(name, file);
    }
  }
}

function parseAgentConfig(
  name: string,
  content: string,
  source: 'compiled' | 'project' | 'global',
): AgentConfig {
  const { frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(content);
  const { builtinToolNames, extSelectors } = parseToolsField(fm.tools);
  return {
    name,
    displayName: str(fm.display_name),
    description: str(fm.description) ?? name,
    builtinToolNames,
    extSelectors,
    disallowedTools: csvListOptional(fm.disallowed_tools),
    extensions: inheritField(fm.extensions ?? fm.inherit_extensions),
    excludeExtensions: csvListOptional(fm.exclude_extensions),
    skills: inheritField(fm.skills ?? fm.inherit_skills),
    model: str(fm.model),
    thinking: str(fm.thinking) as ThinkingLevel | undefined,
    maxTurns: nonNegativeInt(fm.max_turns),
    persistSession: fm.persist_session != null ? fm.persist_session === true : undefined,
    outputTranscript: fm.output_transcript != null ? fm.output_transcript !== false : undefined,
    sessionDir: str(fm.session_dir),
    allowedSubagents: parseAllowedSubagents(fm.allowed_subagents),
    systemPrompt: body.trim(),
    promptMode: fm.prompt_mode === 'append' ? 'append' : 'replace',
    inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
    runInBackground: fm.run_in_background != null ? fm.run_in_background === true : undefined,
    isolated: fm.isolated != null ? fm.isolated === true : undefined,
    memory: parseMemory(fm.memory),
    isolation: fm.isolation === 'worktree' ? 'worktree' : undefined,
    enabled: fm.enabled !== false,
    source,
  };
}

// ---- Field parsers ----
// All follow the same convention: omitted → default, "none"/empty → nothing, value → exact.

/** Extract a string or undefined. */
function str(val: unknown): string | undefined {
  return typeof val === 'string' ? val : undefined;
}

/** Extract a non-negative integer or undefined. 0 means unlimited for max_turns. */
function nonNegativeInt(val: unknown): number | undefined {
  return typeof val === 'number' && val >= 0 ? val : undefined;
}

/**
 * Parse a raw CSV field value into items, or undefined if absent/empty/"none".
 */
function parseCsvField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) {
    return undefined;
  }
  const s = String(val).trim();
  if (!s || s === 'none') {
    return undefined;
  }
  const items = s
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * Parse the nested-delegation allowlist. Single field, default-off:
 * omitted/empty/"none"/`false` → undefined (no nested tools); "all"/"*"/`true`
 * → "all" (any enabled agent); csv → only the listed types.
 *
 * Booleans are accepted because `extensions:`/`skills:` take them and users
 * generalize: without this, YAML's `true` stringifies into an agent type
 * literally named "true", so the tools appear and every spawn is refused.
 */
function parseAllowedSubagents(val: unknown): 'all' | string[] | undefined {
  if (typeof val === 'boolean') {
    return val ? 'all' : undefined;
  }
  const items = parseCsvField(val);
  if (!items) {
    return undefined;
  }
  return items.some((i) => i === '*' || i.toLowerCase() === 'all') ? 'all' : items;
}

/**
 * Parse a comma-separated list field with defaults.
 * omitted → defaults; "none"/empty → []; csv → listed items.
 */
function csvList(val: unknown, defaults: string[]): string[] {
  if (val === undefined || val === null) {
    return defaults;
  }
  return parseCsvField(val) ?? [];
}

/**
 * Partition the `tools:` CSV into the built-in tool allowlist and raw `ext:` selectors.
 * `*` (and the case-insensitive alias `all`, for `tools: all`) expands to all
 * built-ins; plain entries are built-in names; `ext:` entries are extension-tool
 * selectors parsed later by the runner. omitted → all built-ins, no selectors.
 * `tools:` present with only `ext:` entries → zero built-ins (use `*`).
 */
function parseToolsField(val: unknown): {
  builtinToolNames: string[];
  extSelectors: string[] | undefined;
} {
  const entries = csvList(val, BUILTIN_TOOL_NAMES);
  const isWildcard = (e: string) => e === '*' || e.toLowerCase() === 'all';
  const hasWildcard = entries.some(isWildcard);
  const plain = entries.filter((e) => !isWildcard(e) && !e.startsWith('ext:'));
  const extEntries = entries.filter((e) => e.startsWith('ext:'));
  return {
    builtinToolNames: hasWildcard ? [...new Set([...BUILTIN_TOOL_NAMES, ...plain])] : plain,
    extSelectors: extEntries.length > 0 ? extEntries : undefined,
  };
}

/**
 * Parse an optional comma-separated list field.
 * omitted → undefined; "none"/empty → undefined; csv → listed items.
 */
function csvListOptional(val: unknown): string[] | undefined {
  return parseCsvField(val);
}

/**
 * Parse a memory scope field.
 * omitted → undefined; "user"/"project"/"local" → MemoryScope.
 */
function parseMemory(val: unknown): MemoryScope | undefined {
  if (val === 'user' || val === 'project' || val === 'local') {
    return val;
  }
  return undefined;
}

/**
 * Parse an inherit field (extensions, skills).
 * omitted/true → true (inherit all); false/"none"/empty → false; csv → listed names.
 */
function inheritField(val: unknown): true | string[] | false {
  if (val === undefined || val === null || val === true) {
    return true;
  }
  if (val === false || val === 'none') {
    return false;
  }
  const items = csvList(val, []);
  return items.length > 0 ? items : false;
}
