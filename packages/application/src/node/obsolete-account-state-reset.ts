import { constants, type Dir, type Stats } from 'node:fs';
import { lstat, open, opendir, realpath, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { MpxError } from '@mpx/core';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 1024;
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export interface ObsoleteAccountStateResetFileSystem {
  readonly lstat: typeof lstat;
  readonly realpath: typeof realpath;
  readonly open: typeof open;
  readonly opendir: typeof opendir;
  readonly unlink: typeof unlink;
}

interface PathSnapshot {
  readonly file: string;
  readonly info: Stats;
}

type DeletionCandidate = PathSnapshot;

const nodeFileSystem: ObsoleteAccountStateResetFileSystem = {
  lstat,
  realpath,
  open,
  opendir,
  unlink,
};

function invalid(): never {
  throw new MpxError({
    code: 'SETUP_OBSOLETE_STATE_INVALID',
    message: 'Obsolete local setup state is malformed or unsafe.',
  });
}

function identity(value: unknown): boolean {
  return (
    exact(value, ['domain', 'name']) &&
    typeof value.domain === 'string' &&
    typeof value.name === 'string' &&
    value.domain.length > 0 &&
    value.name.length > 0
  );
}

function legacyAccountRecord(value: unknown): boolean {
  return (
    exact(value, [
      'schemaVersion',
      'ref',
      'identity',
      'runtime',
      'rootDigest',
      'mode',
      'createdAt',
      'updatedAt',
    ]) &&
    value.schemaVersion === 1 &&
    value.runtime === 'pi' &&
    value.mode === 'root-attested' &&
    identity(value.identity) &&
    typeof value.ref === 'string' &&
    typeof value.rootDigest === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.rootDigest) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function legacyRegistry(value: unknown): boolean {
  return (
    exact(value, ['schemaVersion', 'records']) &&
    value.schemaVersion === 1 &&
    Array.isArray(value.records) &&
    value.records.length <= MAX_DIRECTORY_ENTRIES &&
    value.records.every(legacyAccountRecord)
  );
}

const bindingKeys = [
  'schemaVersion',
  'ref',
  'identity',
  'runtime',
  'recordedRootDigest',
  'createdAt',
  'updatedAt',
] as const;

function binding(value: unknown, legacy: boolean): boolean {
  const keys = legacy ? [...bindingKeys, 'accountBindingRef'] : bindingKeys;
  if (
    !exact(value, keys) ||
    value.schemaVersion !== 1 ||
    !identity(value.identity) ||
    (value.runtime !== 'pi' && value.runtime !== 'claude') ||
    typeof value.ref !== 'string' ||
    typeof value.recordedRootDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.recordedRootDigest) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return false;
  }
  return !legacy || value.accountBindingRef === null || typeof value.accountBindingRef === 'string';
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return (
    left.isFile() === right.isFile() &&
    left.isDirectory() === right.isDirectory() &&
    left.isSymbolicLink() === right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function sameFile(left: Stats, right: Stats): boolean {
  return sameIdentity(left, right) && left.size === right.size;
}

/** One-shot migration boundary. It recognizes obsolete schemas but exposes no reader API. */
export class ObsoleteAccountStateResetService {
  constructor(
    private readonly localAppData: string,
    private readonly fileSystem: ObsoleteAccountStateResetFileSystem = nodeFileSystem,
  ) {}

  async run(): Promise<void> {
    try {
      if (!path.isAbsolute(this.localAppData)) {
        invalid();
      }
      const stateRoot = path.join(this.localAppData, 'mpx');
      const accounts = [
        stateRoot,
        path.join(stateRoot, 'accounts'),
        path.join(stateRoot, 'accounts', 'v1'),
      ];
      const bindings = [
        stateRoot,
        path.join(stateRoot, 'sessions'),
        path.join(stateRoot, 'sessions', 'v1'),
        path.join(stateRoot, 'sessions', 'v1', 'private'),
        path.join(stateRoot, 'sessions', 'v1', 'private', 'native-bindings'),
      ];
      const directories = await this.preflightDirectories([
        [this.localAppData, ...accounts],
        [this.localAppData, ...bindings],
      ]);
      const candidates: DeletionCandidate[] = [];
      await this.preflightRegistry(
        path.join(stateRoot, 'accounts', 'v1', 'registry.json'),
        candidates,
      );
      await this.preflightBindings(bindings.at(-1)!, candidates);

      for (const candidate of candidates) {
        await this.deleteCandidate(candidate, directories);
      }
    } catch (error) {
      if (error instanceof MpxError) {
        throw error;
      }
      invalid();
    }
  }

  private async preflightDirectories(
    chains: readonly (readonly string[])[],
  ): Promise<Map<string, PathSnapshot>> {
    const snapshots = new Map<string, PathSnapshot>();
    for (const files of chains) {
      for (const file of files) {
        if (snapshots.has(file)) {
          continue;
        }
        try {
          const before = await this.fileSystem.lstat(file);
          if (!before.isDirectory() || before.isSymbolicLink()) {
            invalid();
          }
          const resolved = await this.fileSystem.realpath(file);
          const after = await this.fileSystem.lstat(file);
          if (
            path.resolve(resolved) !== path.resolve(file) ||
            !sameIdentity(before, after) ||
            !after.isDirectory() ||
            after.isSymbolicLink()
          ) {
            invalid();
          }
          snapshots.set(file, { file, info: after });
        } catch (error) {
          if (missing(error) && file !== this.localAppData) {
            break;
          }
          throw error;
        }
      }
    }
    return snapshots;
  }

  private async readRegular(file: string): Promise<{ value: unknown; snapshot: PathSnapshot }> {
    const before = await this.fileSystem.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) {
      invalid();
    }
    let handle: FileHandle | undefined;
    try {
      handle = await this.fileSystem.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_FILE_BYTES || !sameFile(before, opened)) {
        invalid();
      }
      const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length);
        if (result.bytesRead === 0) {
          break;
        }
        length += result.bytesRead;
      }
      if (length > MAX_FILE_BYTES) {
        invalid();
      }
      const handleAfter = await handle.stat();
      const namedAfter = await this.fileSystem.lstat(file);
      if (!sameFile(opened, handleAfter) || !sameFile(opened, namedAfter)) {
        invalid();
      }
      return {
        value: JSON.parse(buffer.subarray(0, length).toString('utf8')) as unknown,
        snapshot: { file, info: namedAfter },
      };
    } finally {
      await handle?.close();
    }
  }

  private async preflightRegistry(file: string, candidates: DeletionCandidate[]): Promise<void> {
    try {
      const parsed = await this.readRegular(file);
      if (!legacyRegistry(parsed.value)) {
        invalid();
      }
      candidates.push(parsed.snapshot);
    } catch (error) {
      if (!missing(error)) {
        throw error;
      }
    }
  }

  private async preflightBindings(
    directory: string,
    candidates: DeletionCandidate[],
  ): Promise<void> {
    let opened: Dir;
    try {
      opened = await this.fileSystem.opendir(directory);
    } catch (error) {
      if (missing(error)) {
        return;
      }
      throw error;
    }
    let count = 0;
    for await (const entry of opened) {
      if (++count > MAX_DIRECTORY_ENTRIES) {
        invalid();
      }
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !/^[A-Za-z0-9_-]{1,512}\.json$/u.test(entry.name)
      ) {
        invalid();
      }
      const parsed = await this.readRegular(path.join(directory, entry.name));
      if (binding(parsed.value, true)) {
        candidates.push(parsed.snapshot);
      } else if (!binding(parsed.value, false)) {
        invalid();
      }
    }
  }

  private async deleteCandidate(
    candidate: DeletionCandidate,
    directories: ReadonlyMap<string, PathSnapshot>,
  ): Promise<void> {
    try {
      for (const directory of directories.values()) {
        if (
          candidate.file === directory.file ||
          candidate.file.startsWith(`${directory.file}${path.sep}`)
        ) {
          const current = await this.fileSystem.lstat(directory.file);
          const resolved = await this.fileSystem.realpath(directory.file);
          if (
            !sameIdentity(directory.info, current) ||
            path.resolve(resolved) !== path.resolve(directory.file)
          ) {
            invalid();
          }
        }
      }
      const current = await this.fileSystem.lstat(candidate.file);
      if (!sameFile(candidate.info, current) || !current.isFile() || current.isSymbolicLink()) {
        invalid();
      }
      await this.fileSystem.unlink(candidate.file);
    } catch (error) {
      if (!missing(error)) {
        throw error;
      }
    }
  }
}
