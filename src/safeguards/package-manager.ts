import { access, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { PolicyResult } from './contracts.js';
import { inspectStaticShell, type ShellWord, type StaticShellCommand } from './shell.js';

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const LOCKFILES: Readonly<Record<string, PackageManager>> = {
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
};

const MANAGER_COMMANDS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx']);
const MANAGER_MENTION = new RegExp(`(^|[^A-Za-z0-9_-])(?:${[...MANAGER_COMMANDS].join('|')})(?:\\.(?:exe|cmd|bat))?([^A-Za-z0-9_-]|$)`, 'iu');
const MAX_OPAQUE_INSPECTION_LENGTH = 64 * 1024;
const EXPECTED_COMMANDS: Readonly<Record<PackageManager, ReadonlySet<string>>> = {
  npm: new Set(['npm', 'npx']),
  pnpm: new Set(['pnpm']),
  yarn: new Set(['yarn']),
  bun: new Set(['bun', 'bunx']),
};
const REPLACEMENTS: Readonly<Record<PackageManager, string>> = {
  npm: 'npm or npx',
  pnpm: 'pnpm or pnpm exec',
  yarn: 'yarn or yarn exec',
  bun: 'bun or bunx',
};

const MAX_CONFIG_BYTES = 1024 * 1024;

interface DirectoryEvidence {
  readonly directory: string;
  readonly managers: ReadonlyMap<PackageManager, readonly string[]>;
  readonly packageExists: boolean;
  readonly workspaces: readonly string[];
  readonly warnings: readonly string[];
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function missingPath(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function exists(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if (missingPath(error)) return false;
    throw error;
  }
}

class ConfigInspectionError extends Error {}

function configReadIssue(error: unknown): string {
  return error instanceof ConfigInspectionError ? error.message : 'read error';
}

async function readConfig(filename: string): Promise<string> {
  const initialMetadata = await stat(filename);
  if (!initialMetadata.isFile()) throw new ConfigInspectionError('not a regular file');
  if (initialMetadata.size > MAX_CONFIG_BYTES) {
    throw new ConfigInspectionError(`exceeds the ${MAX_CONFIG_BYTES}-byte inspection limit`);
  }

  const file = await open(filename, 'r');
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new ConfigInspectionError('not a regular file');
    if (metadata.size > MAX_CONFIG_BYTES) {
      throw new ConfigInspectionError(`exceeds the ${MAX_CONFIG_BYTES}-byte inspection limit`);
    }

    const contents = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < contents.length) {
      const { bytesRead } = await file.read(contents, length, contents.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_CONFIG_BYTES) {
      throw new ConfigInspectionError(`exceeds the ${MAX_CONFIG_BYTES}-byte inspection limit`);
    }
    return contents.subarray(0, length).toString('utf8');
  } finally {
    await file.close();
  }
}

function managerFromPackageField(value: unknown): PackageManager | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.trim().match(/^(npm|pnpm|yarn|bun)(?:@|$)/u);
  return match?.[1] as PackageManager | undefined;
}

function workspacePatterns(value: unknown): string[] {
  const candidate = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { packages?: unknown }).packages)
      ? (value as { packages: unknown[] }).packages
      : [];
  return candidate.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

async function evidenceAt(directory: string): Promise<DirectoryEvidence> {
  const sources = new Map<PackageManager, string[]>();
  const warnings: string[] = [];
  const add = (manager: PackageManager, source: string): void => {
    sources.set(manager, [...(sources.get(manager) ?? []), source]);
  };

  const packageFile = path.join(directory, 'package.json');
  const packageExists = await exists(packageFile);
  let workspaces: string[] = [];
  if (packageExists) {
    let contents: string | undefined;
    try {
      contents = await readConfig(packageFile);
    } catch (error) {
      warnings.push(`Package-manager inspection could not read ${packageFile}: ${configReadIssue(error)}.`);
    }
    if (contents !== undefined) {
      try {
        const parsed = JSON.parse(contents) as Record<string, unknown>;
        workspaces = workspacePatterns(parsed.workspaces);
        if (parsed.packageManager !== undefined) {
          const manager = managerFromPackageField(parsed.packageManager);
          if (manager) add(manager, 'package.json packageManager');
          else warnings.push(`Package-manager inspection skipped unsupported packageManager evidence in ${directory}.`);
        }
      } catch {
        warnings.push(`Package-manager inspection found malformed package.json in ${directory}.`);
      }
    }
  }
  const pnpmWorkspaceFile = path.join(directory, 'pnpm-workspace.yaml');
  if (await exists(pnpmWorkspaceFile)) {
    let contents: string | undefined;
    try {
      contents = await readConfig(pnpmWorkspaceFile);
    } catch (error) {
      warnings.push(`Package-manager inspection could not read ${pnpmWorkspaceFile}: ${configReadIssue(error)}.`);
    }
    if (contents !== undefined) {
      try {
        const workspace = parseYaml(contents) as { packages?: unknown } | null;
        workspaces = [...workspaces, ...workspacePatterns(workspace?.packages)];
      } catch {
        warnings.push(`Package-manager inspection found malformed pnpm-workspace.yaml in ${directory}.`);
      }
    }
  }
  const lockfiles = Object.entries(LOCKFILES);
  const present = await Promise.all(
    lockfiles.map(([filename]) => exists(path.join(directory, filename))),
  );
  lockfiles.forEach(([filename, manager], index) => {
    if (present[index]) add(manager, filename);
  });
  return { directory, managers: sources, packageExists, workspaces, warnings };
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const normalized = path.resolve(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

async function nearestGitRoot(start: string): Promise<string | undefined> {
  let directory = path.resolve(start);
  for (let depth = 0; depth < 128; depth += 1) {
    if (await exists(path.join(directory, '.git'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

function globMatches(pattern: string, relativeDirectory: string): boolean {
  const normalize = (value: string): string => {
    const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return path.posix.matchesGlob(normalize(relativeDirectory), normalize(pattern));
}

function ownsWorkspace(evidence: DirectoryEvidence, nestedPackage: string): boolean {
  const relative = path.relative(evidence.directory, nestedPackage);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const included = evidence.workspaces.some((raw) => !raw.startsWith('!') && globMatches(raw, relative));
  const excluded = evidence.workspaces.some((raw) => raw.startsWith('!') && globMatches(raw.slice(1), relative));
  return included && !excluded;
}

async function detectManager(directory: string): Promise<{
  manager?: PackageManager;
  diagnostics: string[];
}> {
  const start = path.resolve(directory);
  const gitRoot = await nearestGitRoot(start);
  const stopBeforeHome = !gitRoot;
  const levels: DirectoryEvidence[] = [];
  let current = start;
  for (let depth = 0; depth < 128; depth += 1) {
    if (stopBeforeHome && samePath(current, homedir())) break;
    levels.push(await evidenceAt(current));
    if (gitRoot && samePath(current, gitRoot)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const nearestPackage = levels.find((entry) => entry.packageExists);
  for (const evidence of levels) {
    if (evidence.managers.size === 0) {
      if (evidence === nearestPackage && evidence.warnings.length > 0) {
        return { diagnostics: [...evidence.warnings] };
      }
      continue;
    }
    if (
      nearestPackage &&
      evidence !== nearestPackage &&
      path.relative(evidence.directory, nearestPackage.directory) !== '' &&
      !ownsWorkspace(evidence, nearestPackage.directory)
    ) {
      return { diagnostics: nearestPackage.warnings.length > 0 ? [...nearestPackage.warnings] : [] };
    }
    const diagnostics = [...evidence.warnings];
    if (evidence.managers.size > 1) {
      const details = [...evidence.managers].flatMap(([manager, sources]) =>
        sources.map((source) => `${source}=${manager}`),
      );
      diagnostics.push(
        `Package-manager inspection skipped ${evidence.directory}: conflicting credible evidence (${details.join(', ')}).`,
      );
      return { diagnostics };
    }
    return { manager: evidence.managers.keys().next().value as PackageManager, diagnostics };
  }
  return { diagnostics: nearestPackage?.warnings ? [...nearestPackage.warnings] : [] };
}

function executableName(value: string): string {
  return value.split(/[\\/]/u).at(-1)?.replace(/\.(?:exe|cmd|bat)$/iu, '').toLowerCase() ?? '';
}

function nativeLiteralPath(value: string): string {
  if (process.platform === 'win32') {
    const gitBash = value.match(/^\/([A-Za-z])(?:\/(.*))?$/u);
    if (gitBash) return `${gitBash[1]?.toUpperCase()}:/${gitBash[2] ?? ''}`;
  }
  return value;
}

function isAbsoluteLiteral(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || /^\/[A-Za-z](?:\/|$)/u.test(value);
}

const DIRECTORY_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(['--prefix']),
  npx: new Set(['--prefix']),
  pnpm: new Set(['--dir', '--prefix', '--cwd', '-C']),
  yarn: new Set(['--cwd']),
  bun: new Set(['--cwd']),
  bunx: new Set(['--cwd']),
};

function effectiveDirectory(command: StaticShellCommand, executable: string): string | undefined {
  let directory = command.cwd;
  const flags = DIRECTORY_FLAGS[executable] ?? new Set<string>();
  for (let index = 1; index < command.words.length; index += 1) {
    const word = command.words[index];
    if (!word || word.value === '--') break;
    const equals = word.value.indexOf('=');
    const flag = equals >= 0 ? word.value.slice(0, equals) : word.value;
    let target: ShellWord | undefined;
    if (flags.has(flag)) {
      target = equals >= 0
        ? { value: word.value.slice(equals + 1), dynamic: word.dynamic }
        : command.words[++index];
    } else if (executable === 'pnpm' && word.value.startsWith('-C') && word.value.length > 2) {
      target = { value: word.value.slice(2), dynamic: word.dynamic };
    } else continue;
    if (!target || target.dynamic || target.value === '' || target.value.startsWith('~')) return undefined;
    const literal = nativeLiteralPath(target.value);
    directory = isAbsoluteLiteral(target.value)
      ? path.normalize(literal)
      : directory === undefined
        ? undefined
        : path.resolve(directory, literal);
  }
  return directory;
}

const NPX_VALUE_OPTIONS = new Set([
  '-p', '--package', '-c', '--call', '--cache', '--userconfig', '--registry', '--shell', '--node-options', '--prefix',
]);

function isDirectNpxTsc(words: readonly ShellWord[]): boolean {
  for (let index = 1; index < words.length; index += 1) {
    const value = words[index]?.value ?? '';
    if (value === '--') return executableName(words[index + 1]?.value ?? '') === 'tsc';
    if (value.startsWith('-')) {
      const flag = value.split('=', 1)[0] ?? value;
      if (!value.includes('=') && NPX_VALUE_OPTIONS.has(flag)) index += 1;
      continue;
    }
    return executableName(value) === 'tsc';
  }
  return false;
}

async function directoryDiagnostic(directory: string): Promise<string | undefined> {
  try {
    const metadata = await stat(directory);
    if (!metadata.isDirectory()) {
      return `Package-manager inspection skipped ${directory}: its effective path is not a directory.`;
    }
    return undefined;
  } catch (error) {
    return missingPath(error)
      ? `Package-manager inspection skipped ${directory}: its effective directory does not exist.`
      : `Package-manager inspection could not access ${directory}: ${errorMessage(error)}.`;
  }
}

/** Evaluate package-manager invocations in their statically resolved effective directories. */
export async function evaluatePackageManager(command: string, cwd: string): Promise<PolicyResult> {
  const inspection = inspectStaticShell(command, cwd);
  const inspectedManager = inspection.commands.some(invocation =>
    MANAGER_COMMANDS.has(executableName(invocation.words[0]?.value ?? '')),
  );
  const potentiallyHiddenManager = inspection.uninspected.some(fragment => {
    const first = fragment[0];
    if (!first) return false;
    if (first.dynamic || MANAGER_COMMANDS.has(executableName(first.value))) return true;
    const wrapper = executableName(first.value);
    if (!['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'env', 'sudo', 'eval', 'source', '.', '!'].includes(wrapper)) return false;
    return fragment.slice(1).some(word => word.dynamic || MANAGER_MENTION.test(word.value));
  });
  const potentiallyOpaqueManager = inspection.opaqueInputs.some(input =>
    input.length > MAX_OPAQUE_INSPECTION_LENGTH || MANAGER_MENTION.test(input) || /(?:^|[;\n|&()])\s*\$/u.test(input),
  );
  const warnings = inspectedManager || potentiallyHiddenManager || potentiallyOpaqueManager ? [...inspection.diagnostics] : [];
  const blocks: string[] = [];
  // One inspection-call cache only: the shell text is never executed while it is checked.
  const directories = new Map<string, ReturnType<typeof detectManager>>();
  const inspectDirectory = (directory: string): ReturnType<typeof detectManager> => {
    const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
    let result = directories.get(key);
    if (!result) {
      result = (async () => {
        const invalid = await directoryDiagnostic(directory);
        return invalid ? { diagnostics: [invalid] } : detectManager(directory);
      })();
      directories.set(key, result);
    }
    return result;
  };

  for (const invocation of inspection.commands) {
    const executable = executableName(invocation.words[0]?.value ?? '');
    if (!MANAGER_COMMANDS.has(executable)) continue;
    if (executable === 'npx' && isDirectNpxTsc(invocation.words)) {
      blocks.push(
        "Blocked direct 'npx tsc'. Use a repository-defined check script or an already-installed focused compiler command (without downloads).",
      );
      continue;
    }
    const directory = effectiveDirectory(invocation, executable);
    if (!directory) {
      warnings.push(`Package-manager inspection skipped ${executable}: its effective directory is dynamic or unresolved.`);
      continue;
    }
    try {
      const detected = await inspectDirectory(directory);
      warnings.push(...detected.diagnostics);
      if (detected.manager && !EXPECTED_COMMANDS[detected.manager].has(executable)) {
        blocks.push(
          `Blocked ${executable} in ${directory}: this project uses ${detected.manager}; use ${REPLACEMENTS[detected.manager]}.`,
        );
      }
    } catch (error) {
      warnings.push(`Package-manager inspection could not read project evidence in ${directory}: ${errorMessage(error)}.`);
    }
  }

  const diagnostics = [...new Set([...blocks, ...warnings])];
  if (blocks.length > 0) return { decision: 'block', diagnostics };
  if (warnings.length > 0) return { decision: 'warn', diagnostics };
  return { decision: 'allow', diagnostics: [] };
}
