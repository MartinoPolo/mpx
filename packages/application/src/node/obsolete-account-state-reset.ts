import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
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

/** One-shot migration boundary. It recognizes obsolete schemas but exposes no reader API. */
export class ObsoleteAccountStateResetService {
  constructor(private readonly localAppData: string) {}

  async run(): Promise<void> {
    try {
      if (!path.isAbsolute(this.localAppData)) {
        invalid();
      }
      const stateRoot = path.join(this.localAppData, 'mpx');
      for (const directory of [this.localAppData, stateRoot]) {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          invalid();
        }
      }
      if (path.resolve(await realpath(stateRoot)) !== path.resolve(stateRoot)) {
        invalid();
      }
      await this.removeRegistry(path.join(stateRoot, 'accounts', 'v1', 'registry.json'));
      await this.resetBindings(
        path.join(stateRoot, 'sessions', 'v1', 'private', 'native-bindings'),
      );
    } catch (error) {
      if (error instanceof MpxError) {
        throw error;
      }
      invalid();
    }
  }

  private async parseRegular(file: string): Promise<unknown> {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) {
      invalid();
    }
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  }

  private async removeRegistry(file: string): Promise<void> {
    let value: unknown;
    try {
      value = await this.parseRegular(file);
    } catch (error) {
      if (missing(error)) {
        return;
      }
      throw error;
    }
    if (!legacyRegistry(value)) {
      invalid();
    }
    await rm(file);
  }

  private async resetBindings(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) {
        return;
      }
      throw error;
    }
    if (entries.length > MAX_DIRECTORY_ENTRIES) {
      invalid();
    }
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !/^[A-Za-z0-9_-]{1,512}\.json$/u.test(entry.name)
      ) {
        invalid();
      }
      const file = path.join(directory, entry.name);
      const value = await this.parseRegular(file);
      if (binding(value, true)) {
        await rm(file);
      } else if (!binding(value, false)) {
        invalid();
      }
    }
  }
}
