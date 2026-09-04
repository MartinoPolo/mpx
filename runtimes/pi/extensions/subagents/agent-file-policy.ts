import {
  closeSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isUnsafeName } from './memory.js';

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export interface AgentFileMetadata {
  device: string;
  inode: string;
  mode: string;
  size: string;
  modificationTime: string;
  changeTime: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface AgentFileSystem {
  lstat(path: string): AgentFileMetadata;
  realpath(path: string): string;
  mkdir(path: string): void;
  open(path: string, flags: string): number;
  fstat(fileDescriptor: number): AgentFileMetadata;
  read(fileDescriptor: number): string;
  truncate(fileDescriptor: number): void;
  write(fileDescriptor: number, content: string): void;
  close(fileDescriptor: number): void;
  unlink(path: string): void;
}

export interface ExistingAgentFile {
  name: string;
  path: string;
  directoryPath: string;
  directoryRealPath: string;
  fileRealPath: string;
  directoryMetadata: AgentFileMetadata;
  fileMetadata: AgentFileMetadata;
}

export interface AgentFileDestination {
  path: string;
  existing?: ExistingAgentFile;
}

function metadataFromStats(stats: Stats): AgentFileMetadata {
  return {
    device: String(stats.dev),
    inode: String(stats.ino),
    mode: String(stats.mode),
    size: String(stats.size),
    modificationTime: String(stats.mtimeMs),
    changeTime: String(stats.ctimeMs),
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink(),
  };
}

export const nodeAgentFileSystem: AgentFileSystem = {
  lstat: (path) => metadataFromStats(lstatSync(path)),
  realpath: (path) => realpathSync(path),
  mkdir: (path) => mkdirSync(path),
  open: (path, flags) => openSync(path, flags),
  fstat: (fileDescriptor) => metadataFromStats(fstatSync(fileDescriptor)),
  read: (fileDescriptor) => readFileSync(fileDescriptor, 'utf-8'),
  truncate: (fileDescriptor) => ftruncateSync(fileDescriptor, 0),
  write: (fileDescriptor, content) => writeFileSync(fileDescriptor, content, 'utf-8'),
  close: (fileDescriptor) => closeSync(fileDescriptor),
  unlink: (path) => unlinkSync(path),
};

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function pathsEqual(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function metadataEqual(left: AgentFileMetadata, right: AgentFileMetadata): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.modificationTime === right.modificationTime &&
    left.changeTime === right.changeTime &&
    left.isFile === right.isFile &&
    left.isDirectory === right.isDirectory &&
    left.isSymbolicLink === right.isSymbolicLink
  );
}

function directoryIdentityEqual(left: AgentFileMetadata, right: AgentFileMetadata): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.isDirectory === right.isDirectory &&
    left.isSymbolicLink === right.isSymbolicLink
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function isMissing(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}

function inspectDirectory(
  targetDirectory: string,
  fileSystem: AgentFileSystem,
): { path: string; realPath: string; metadata: AgentFileMetadata } {
  const directoryPath = resolve(targetDirectory);
  const metadata = fileSystem.lstat(directoryPath);
  if (!metadata.isDirectory || metadata.isSymbolicLink) {
    throw new Error(`Unsafe agent directory: "${directoryPath}"`);
  }

  const realPath = fileSystem.realpath(directoryPath);
  if (!pathsEqual(realPath, directoryPath)) {
    throw new Error(`Redirected agent directory: "${directoryPath}"`);
  }

  return { path: directoryPath, realPath, metadata };
}

/** Verify an existing declared agent directory without following redirected ancestors. */
export function resolveAgentDirectory(
  targetDirectory: string,
  fileSystem: AgentFileSystem = nodeAgentFileSystem,
): string {
  return inspectDirectory(targetDirectory, fileSystem).path;
}

/** Create a missing declared agent directory one verified direct child at a time. */
export function ensureAgentDirectory(
  targetDirectory: string,
  fileSystem: AgentFileSystem = nodeAgentFileSystem,
): string {
  const directoryPath = resolve(targetDirectory);
  try {
    return resolveAgentDirectory(directoryPath, fileSystem);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const parentPath = dirname(directoryPath);
  if (parentPath === directoryPath)
    throw new Error(`Cannot create agent directory: "${directoryPath}"`);
  ensureAgentDirectory(parentPath, fileSystem);

  try {
    fileSystem.mkdir(directoryPath);
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
  }
  return resolveAgentDirectory(directoryPath, fileSystem);
}

/** Resolve a new agent file while guaranteeing it is a direct child of targetDirectory. */
export function resolveSafeAgentFile(targetDirectory: string, name: string): string {
  if (isUnsafeName(name) || WINDOWS_DEVICE_NAME.test(name) || /[\x00-\x1f\x7f]/.test(name)) {
    throw new Error(`Unsafe agent name: "${name}"`);
  }

  const directoryPath = resolve(targetDirectory);
  const targetPath = resolve(directoryPath, `${name}.md`);
  if (dirname(targetPath) !== directoryPath) throw new Error(`Unsafe agent name: "${name}"`);
  return targetPath;
}

/** Resolve and snapshot a genuine existing agent file without following redirects. */
export function resolveExistingAgentFile(
  targetDirectory: string,
  name: string,
  fileSystem: AgentFileSystem = nodeAgentFileSystem,
): ExistingAgentFile {
  const targetPath = resolveSafeAgentFile(targetDirectory, name);
  const directory = inspectDirectory(targetDirectory, fileSystem);
  if (!pathsEqual(dirname(targetPath), directory.path)) {
    throw new Error(`Agent file is not a direct child: "${targetPath}"`);
  }

  const fileMetadata = fileSystem.lstat(targetPath);
  if (!fileMetadata.isFile || fileMetadata.isSymbolicLink) {
    throw new Error(`Unsafe agent file: "${targetPath}"`);
  }

  const fileRealPath = fileSystem.realpath(targetPath);
  if (
    !pathsEqual(dirname(fileRealPath), directory.realPath) ||
    !pathsEqual(fileRealPath, targetPath)
  ) {
    throw new Error(`Redirected agent file: "${targetPath}"`);
  }

  return {
    name,
    path: targetPath,
    directoryPath: directory.path,
    directoryRealPath: directory.realPath,
    fileRealPath,
    directoryMetadata: directory.metadata,
    fileMetadata,
  };
}

/** Inspect a create/overwrite destination, rejecting any unverifiable existing entry. */
export function inspectAgentFileDestination(
  targetDirectory: string,
  name: string,
  fileSystem: AgentFileSystem = nodeAgentFileSystem,
): AgentFileDestination {
  const path = resolveSafeAgentFile(targetDirectory, name);
  inspectDirectory(targetDirectory, fileSystem);

  try {
    return { path, existing: resolveExistingAgentFile(targetDirectory, name, fileSystem) };
  } catch (error) {
    if (isMissing(error)) return { path };
    throw error;
  }
}

function verifyExistingAgentFile(
  expected: ExistingAgentFile,
  fileSystem: AgentFileSystem,
): ExistingAgentFile {
  const current = resolveExistingAgentFile(expected.directoryPath, expected.name, fileSystem);
  if (
    !pathsEqual(current.path, expected.path) ||
    !pathsEqual(current.directoryRealPath, expected.directoryRealPath) ||
    !pathsEqual(current.fileRealPath, expected.fileRealPath) ||
    !directoryIdentityEqual(current.directoryMetadata, expected.directoryMetadata) ||
    !metadataEqual(current.fileMetadata, expected.fileMetadata)
  ) {
    throw new Error(`Agent file changed during operation: "${expected.path}"`);
  }
  return current;
}

function withVerifiedOpenFile<T>(
  expected: ExistingAgentFile,
  flags: string,
  fileSystem: AgentFileSystem,
  action: (fileDescriptor: number) => T,
): T {
  verifyExistingAgentFile(expected, fileSystem);
  const fileDescriptor = fileSystem.open(expected.path, flags);
  try {
    const descriptorMetadata = fileSystem.fstat(fileDescriptor);
    if (!metadataEqual(descriptorMetadata, expected.fileMetadata)) {
      throw new Error(`Agent file changed during operation: "${expected.path}"`);
    }
    verifyExistingAgentFile(expected, fileSystem);
    return action(fileDescriptor);
  } finally {
    fileSystem.close(fileDescriptor);
  }
}

export function readExistingAgentFile(
  file: ExistingAgentFile,
  fileSystem: AgentFileSystem = nodeAgentFileSystem,
): string {
  return withVerifiedOpenFile(file, 'r', fileSystem, (fileDescriptor) =>
    fileSystem.read(fileDescriptor),
  );
}

export function writeExistingAgentFile(
  file: ExistingAgentFile,
  content: string,
  fileSystem: AgentFileSystem = nodeAgentFileSystem,
): void {
  withVerifiedOpenFile(file, 'r+', fileSystem, (fileDescriptor) => {
    fileSystem.truncate(fileDescriptor);
    fileSystem.write(fileDescriptor, content);
  });
}

export function deleteExistingAgentFile(
  file: ExistingAgentFile,
  fileSystem: AgentFileSystem = nodeAgentFileSystem,
): void {
  verifyExistingAgentFile(file, fileSystem);
  fileSystem.unlink(file.path);
}

/** Safely create a direct child, or replace a verified regular file when explicitly allowed. */
export function writeAgentFile(
  targetDirectory: string,
  name: string,
  content: string,
  allowExisting: boolean,
  fileSystem: AgentFileSystem = nodeAgentFileSystem,
): string {
  const destination = inspectAgentFileDestination(targetDirectory, name, fileSystem);
  if (destination.existing) {
    if (!allowExisting) throw new Error(`Agent file already exists: "${destination.path}"`);
    writeExistingAgentFile(destination.existing, content, fileSystem);
    return destination.path;
  }

  const directory = inspectDirectory(targetDirectory, fileSystem);
  try {
    fileSystem.lstat(destination.path);
    throw new Error(`Agent file already exists: "${destination.path}"`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const currentDirectory = inspectDirectory(targetDirectory, fileSystem);
  if (
    !pathsEqual(currentDirectory.realPath, directory.realPath) ||
    !directoryIdentityEqual(currentDirectory.metadata, directory.metadata)
  ) {
    throw new Error(`Agent directory changed during operation: "${directory.path}"`);
  }

  const fileDescriptor = fileSystem.open(destination.path, 'wx');
  try {
    const created = resolveExistingAgentFile(targetDirectory, name, fileSystem);
    if (!metadataEqual(fileSystem.fstat(fileDescriptor), created.fileMetadata)) {
      throw new Error(`Agent file changed during operation: "${destination.path}"`);
    }
    fileSystem.write(fileDescriptor, content);
  } finally {
    fileSystem.close(fileDescriptor);
  }
  return destination.path;
}
