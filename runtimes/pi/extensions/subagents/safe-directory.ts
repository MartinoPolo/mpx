import { lstatSync, mkdirSync, realpathSync, type MakeDirectoryOptions, type Stats } from 'node:fs';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';

export interface SafeDirectoryFileSystem {
  lstat(path: string): Pick<Stats, 'dev' | 'ino' | 'isDirectory' | 'isSymbolicLink'>;
  mkdir(path: string, options: MakeDirectoryOptions): void;
  realpath(path: string): string;
}

const nodeFileSystem: SafeDirectoryFileSystem = {
  lstat: (path) => lstatSync(path),
  mkdir: (path, options) => {
    mkdirSync(path, options);
  },
  realpath: (path) => realpathSync.native(path),
};

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function comparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function hasSameIdentity(
  left: Pick<Stats, 'dev' | 'ino'>,
  right: Pick<Stats, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

type DirectoryMetadata = Pick<Stats, 'dev' | 'ino' | 'isDirectory' | 'isSymbolicLink'>;

function verifyDirectoryComponent(
  path: string,
  before: DirectoryMetadata,
  fileSystem: SafeDirectoryFileSystem,
): void {
  if (before.isSymbolicLink()) {
    throw new Error(`Refusing to use linked directory component: ${path}`);
  }
  if (!before.isDirectory()) {
    throw new Error(`Directory component is not a directory: ${path}`);
  }

  const realPath = fileSystem.realpath(path);
  if (comparablePath(realPath) !== comparablePath(path)) {
    throw new Error(`Directory component resolves outside its expected path: ${path}`);
  }

  const resolvedMetadata = fileSystem.lstat(realPath);
  const after = fileSystem.lstat(path);
  if (
    resolvedMetadata.isSymbolicLink() ||
    after.isSymbolicLink() ||
    !resolvedMetadata.isDirectory() ||
    !after.isDirectory() ||
    !hasSameIdentity(before, resolvedMetadata) ||
    !hasSameIdentity(before, after)
  ) {
    throw new Error(`Directory component changed during verification: ${path}`);
  }
}

/**
 * Create a directory without traversing links or unverified parents.
 * Every component is checked from its filesystem root through the target.
 */
export function ensureSafeDirectory(
  target: string,
  fileSystem: SafeDirectoryFileSystem = nodeFileSystem,
): void {
  const absoluteTarget = resolve(target);
  const root = parse(absoluteTarget).root;
  const remainder = relative(root, absoluteTarget);
  const components = remainder ? remainder.split(sep).filter(Boolean) : [];

  let current = root;
  const rootMetadata = fileSystem.lstat(current);
  verifyDirectoryComponent(current, rootMetadata, fileSystem);

  for (const component of components) {
    current = join(current, component);
    let metadata: DirectoryMetadata;
    try {
      metadata = fileSystem.lstat(current);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      if (dirname(current) === current) {
        throw new Error(`Refusing to create filesystem root: ${current}`);
      }
      fileSystem.mkdir(current, { mode: 0o700 });
      metadata = fileSystem.lstat(current);
    }
    verifyDirectoryComponent(current, metadata, fileSystem);
  }
}
