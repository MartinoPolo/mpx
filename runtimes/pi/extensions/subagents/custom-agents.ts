/**
 * custom-agents.ts — Load compiler-owned, global, and project-defined agent overlays.
 */

import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { getAgentDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';
import {
  readExistingAgentFile,
  resolveAgentDirectory,
  resolveExistingAgentFile,
} from './agent-file-policy.js';
import { BUILTIN_TOOL_NAMES } from './agent-types.js';
import type { AgentConfig, MemoryScope, ThinkingLevel } from './types.js';

/**
 * Scan for custom agent .md files from multiple locations.
 * Discovery hierarchy (higher priority wins):
 *   1. Project:   <cwd>/.pi/agents/*.md (authoritative — also where /agents writes)
 *   2. Workspace: <cwd>/.agents/agents/*.md (shared cross-tool .agents workspace, read-only)
 *   3. Global:    $PI_CODING_AGENT_DIR/agents/*.md (default: ~/.pi/agent/agents/*.md)
 *   4. Compiled:  $MPX_COMPILED_AGENTS_DIR/*.md (compiler-owned immutable base layer)
 *
 * Project-level agents override global ones with the same name. On a name clash
 * between the two project locations, .pi/agents wins — .pi stays the project
 * authority; .agents/agents is an additional read location.
 * Any name is allowed — names matching defaults (e.g. "Explore") override them.
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

export function loadCustomAgents(cwd: string): Map<string, AgentConfig> {
  const globalDir = join(getAgentDir(), 'agents');
  const workspaceProjectDir = join(cwd, '.agents', 'agents');
  const projectDir = join(cwd, '.pi', 'agents');

  const agents = new Map<string, AgentConfig>();
  const compiledDir = process.env.MPX_COMPILED_AGENTS_DIR;
  if (compiledDir !== undefined) {
    try {
      loadFromDir(resolveCompiledAgentsDirectory(compiledDir), agents, 'compiled', true);
    } catch {
      // A malformed, missing, or redirected compiler source contributes no agents.
    }
  }
  loadFromDir(globalDir, agents, 'global');
  loadFromDir(workspaceProjectDir, agents, 'project');
  loadFromDir(projectDir, agents, 'project');
  return agents;
}

/** Load agent configs from a directory into the map. */
function loadFromDir(
  dir: string,
  agents: Map<string, AgentConfig>,
  source: 'compiled' | 'project' | 'global',
  requireDirectRegularFiles = false,
): void {
  let safeDirectory: string;
  let files: string[];
  try {
    safeDirectory = resolveAgentDirectory(dir);
    files = requireDirectRegularFiles
      ? readdirSync(safeDirectory, { withFileTypes: true })
          .filter(
            (entry) => entry.name.endsWith('.md') && entry.isFile() && !entry.isSymbolicLink(),
          )
          .map((entry) => entry.name)
      : readdirSync(safeDirectory).filter((file) => file.endsWith('.md'));
  } catch {
    return;
  }

  for (const file of files) {
    const name = basename(file, '.md');

    let content: string;
    try {
      content = readExistingAgentFile(resolveExistingAgentFile(safeDirectory, name));
    } catch {
      continue;
    }

    const { frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(content);

    const { builtinToolNames, extSelectors } = parseToolsField(fm.tools);

    agents.set(name, {
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
      enabled: fm.enabled !== false, // default true; explicitly false disables
      source,
    });
  }
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
