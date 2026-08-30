import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isPathWithinRoot, MpxError } from '@mpx/core';

export interface TrustedFileEvidence {
  path: string;
  sha256: string;
  size: number;
  modifiedMs: number;
}

export interface ResolvedExecutable extends TrustedFileEvidence {
  /** Arguments inserted between the launcher and the package-manager arguments. */
  trustedPrefixArguments: readonly string[];
  /** Every immutable file referenced by trustedPrefixArguments. */
  supportFiles: readonly TrustedFileEvidence[];
}

export interface TrustedExecutableEntry {
  command: string;
  path: string;
  /** Immutable arguments, normally a path to a trusted JavaScript launcher. */
  trustedPrefixArguments?: readonly string[];
  /** Files backing trustedPrefixArguments. */
  supportFiles?: readonly string[];
}
export interface TrustedExecutablePolicy {
  /** Explicit candidates supplied by an OS-owned discovery mechanism or by tests. PATH is never consulted. */
  allowlist: readonly TrustedExecutableEntry[];
  /** Repository/worktree roots whose contents are attacker-controlled. */
  forbiddenRoots?: readonly string[];
  /** Retained only to make it explicit that inherited PATH is ignored. */
  environment?: Readonly<Record<string, string | undefined>>;
}

function executableError(command: string): MpxError {
  return new MpxError({
    code: 'PREPARATION_EXECUTABLE_UNRESOLVED',
    message: `Executable ${command} is not a trusted allowlisted regular file.`,
  });
}

function changedError(): MpxError {
  return new MpxError({
    code: 'PREPARATION_EXECUTABLE_CHANGED',
    message: 'The approved executable identity changed before spawn.',
  });
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function fixedProductionEntries(): TrustedExecutableEntry[] {
  // Version-manager shell shims can live in transient per-shell directories. Trust the
  // currently running Node binary's canonical installation path, not the shim pathname.
  const nodeExecutable = realpathSync(process.execPath);
  const entries: TrustedExecutableEntry[] = [{ command: 'node', path: nodeExecutable }];
  const nodeDirectory = path.dirname(nodeExecutable);
  if (process.platform === 'win32') {
    // npm, pnpm, and yarn are JavaScript launchers on Windows. Passing their .cmd
    // shims to spawn(shell:false) does not execute them, so invoke them with Node.
    const packageLaunchers: Record<string, string> = {
      npm: path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      pnpm: path.join(nodeDirectory, 'node_modules', 'corepack', 'dist', 'pnpm.js'),
      yarn: path.join(nodeDirectory, 'node_modules', 'corepack', 'dist', 'yarn.js'),
    };
    for (const [command, launcher] of Object.entries(packageLaunchers)) {
      entries.push({
        command,
        path: nodeExecutable,
        trustedPrefixArguments: [launcher],
        supportFiles: [launcher],
      });
    }
    // Keep direct executable candidates for installations that provide them (notably
    // bun). There are deliberately no .cmd candidates in the production policy.
    for (const command of ['npm', 'pnpm', 'yarn', 'bun']) {
      entries.push({ command, path: path.join(nodeDirectory, `${command}.exe`) });
    }
    const programRoots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA,
      process.env.MPX_APPS,
    ].filter((value): value is string => typeof value === 'string' && path.isAbsolute(value));
    for (const root of programRoots) {
      entries.push({ command: 'git', path: path.join(root, 'Git', 'cmd', 'git.exe') });
      entries.push({ command: 'git', path: path.join(root, 'Programs', 'Git', 'cmd', 'git.exe') });
      entries.push({ command: 'pnpm', path: path.join(root, 'pnpm', 'pnpm.exe') });
      entries.push({ command: 'bun', path: path.join(root, '.bun', 'bin', 'bun.exe') });
    }
  } else {
    for (const command of ['npm', 'pnpm', 'yarn', 'bun']) {
      entries.push({ command, path: path.join(nodeDirectory, command) });
    }
    for (const candidate of ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git']) {
      entries.push({ command: 'git', path: candidate });
    }
  }
  return entries;
}

export function productionTrustedExecutablePolicy(
  forbiddenRoots: readonly string[] = [],
): TrustedExecutablePolicy {
  const repositoryRoots = [
    process.env.MPX_PROJECTS,
    process.env.MPX_WORK,
    process.env.MPX_CLONED,
    process.env.MPX_AI_GENERATED,
  ].filter((value): value is string => typeof value === 'string' && path.isAbsolute(value));
  return {
    allowlist: fixedProductionEntries(),
    forbiddenRoots: [...repositoryRoots, ...forbiddenRoots],
  };
}

async function inspectFile(
  candidate: string,
  command: string,
  policy: TrustedExecutablePolicy,
): Promise<TrustedFileEvidence> {
  if (!path.isAbsolute(candidate) || (await lstat(candidate)).isSymbolicLink()) {
    throw executableError(command);
  }
  const canonical = await realpath(candidate);
  if (!samePath(canonical, candidate)) {
    throw executableError(command);
  }
  if (
    (policy.forbiddenRoots ?? []).some(
      (root) => samePath(canonical, root) || isPathWithinRoot(canonical, path.resolve(root)),
    )
  ) {
    throw executableError(command);
  }
  const facts = await stat(canonical);
  if (!facts.isFile()) {
    throw executableError(command);
  }
  return {
    path: canonical,
    sha256: createHash('sha256')
      .update(await readFile(canonical))
      .digest('hex'),
    size: facts.size,
    modifiedMs: facts.mtimeMs,
  };
}

function supportPaths(prefixArguments: readonly string[], declared: readonly string[]): string[] {
  return [
    ...new Set([...declared, ...prefixArguments.filter((argument) => path.isAbsolute(argument))]),
  ];
}

async function inspectTrusted(
  candidate: string,
  command: string,
  policy: TrustedExecutablePolicy,
  prefixArguments: readonly string[] = [],
  declaredSupportFiles: readonly string[] = [],
): Promise<ResolvedExecutable> {
  const launcher = await inspectFile(candidate, command, policy);
  const supports = await Promise.all(
    supportPaths(prefixArguments, declaredSupportFiles).map((file) =>
      inspectFile(file, command, policy),
    ),
  );
  const canonicalPrefix = prefixArguments.map((argument) => {
    const index = supportPaths(prefixArguments, declaredSupportFiles).findIndex((file) =>
      samePath(file, argument),
    );
    return index < 0 ? argument : supports[index]!.path;
  });
  return { ...launcher, trustedPrefixArguments: canonicalPrefix, supportFiles: supports };
}

/** Resolves only explicit fixed/OS-verified candidates. Inherited PATH and cwd are never searched. */
export async function resolveTrustedExecutable(
  command: string,
  cwd: string,
  policy: TrustedExecutablePolicy = productionTrustedExecutablePolicy([cwd]),
): Promise<ResolvedExecutable> {
  if (
    command.length === 0 ||
    command.includes('\0') ||
    (!path.isAbsolute(command) && (command.includes('/') || command.includes('\\')))
  ) {
    throw executableError(command);
  }
  const matches = policy.allowlist.filter((entry) =>
    path.isAbsolute(command)
      ? samePath(entry.path, command) ||
        (entry.command === 'node' && samePath(command, process.execPath))
      : entry.command === command,
  );
  for (const entry of matches) {
    try {
      return await inspectTrusted(
        entry.path,
        command,
        { ...policy, forbiddenRoots: [...(policy.forbiddenRoots ?? []), cwd] },
        entry.trustedPrefixArguments ?? [],
        entry.supportFiles ?? [],
      );
    } catch {
      /* try another fixed candidate */
    }
  }
  throw executableError(command);
}

function sameEvidence(left: TrustedFileEvidence, right: TrustedFileEvidence): boolean {
  return (
    samePath(left.path, right.path) &&
    left.sha256 === right.sha256 &&
    left.size === right.size &&
    left.modifiedMs === right.modifiedMs
  );
}

/** Revalidates all mutable pathname evidence immediately before a spawn. */
export async function revalidateTrustedExecutable(
  expected: ResolvedExecutable,
  policy: TrustedExecutablePolicy,
): Promise<void> {
  let current: ResolvedExecutable;
  try {
    current = await inspectTrusted(
      expected.path,
      expected.path,
      policy,
      expected.trustedPrefixArguments ?? [],
      (expected.supportFiles ?? []).map((file) => file.path),
    );
  } catch {
    throw changedError();
  }
  const samePrefix =
    JSON.stringify(current.trustedPrefixArguments) ===
    JSON.stringify(expected.trustedPrefixArguments ?? []);
  const sameSupports =
    current.supportFiles.length === (expected.supportFiles ?? []).length &&
    current.supportFiles.every((file, index) => sameEvidence(file, expected.supportFiles[index]!));
  if (!sameEvidence(current, expected) || !samePrefix || !sameSupports) {
    throw changedError();
  }
}
