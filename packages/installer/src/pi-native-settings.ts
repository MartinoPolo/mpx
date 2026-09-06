import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { parseUserConfig } from '@mpx/config';
import { MpxError } from '@mpx/core';
import { atomicReplaceRegularFile, type AtomicRegularFileOperations } from './atomic-file.js';
import { installerDigest, USER_CONFIG_ARTIFACT_MAX_BYTES } from './immutable-core.js';
import type { RuntimeIdentity } from './runtime-registration.js';

export interface PiNativeSettingsLock {
  compromisedFailure(): Error | undefined;
  release(): Promise<void>;
}

export interface PiNativeSettingsPort {
  lstat(target: string): Promise<Stats>;
  realpath(target: string): Promise<string>;
  read(target: string): Promise<Buffer>;
  atomicWrite(target: string, body: Buffer): Promise<void>;
  remove(target: string): Promise<void>;
  lock(target: string): Promise<PiNativeSettingsLock>;
}

export interface PiPrivateRootResolution {
  readonly identity: RuntimeIdentity;
  readonly expectedNativeRootDigest: string;
  readonly userConfigArtifactContent?: string;
}

/** Resolves a private Pi native root from validated user configuration. */
export interface PiPrivateRootResolver {
  resolvePiNativeRoot(input: PiPrivateRootResolution): Promise<string>;
}

interface UserConfigFileOperations {
  lstat(target: string): Promise<Stats>;
  readFile(target: string): Promise<Buffer>;
}

const userConfigFileOperations: UserConfigFileOperations = { lstat, readFile };
const normalizedPrivateRoot = (value: string): string =>
  path.win32
    .normalize(value)
    .replace(/[\\]+$/u, '')
    .toLowerCase();

export class UserConfigPiPrivateRootResolver implements PiPrivateRootResolver {
  private readonly files: UserConfigFileOperations;

  constructor(
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
    files: Partial<UserConfigFileOperations> = {},
  ) {
    this.files = { ...userConfigFileOperations, ...files };
  }

  private unavailable(): never {
    throw new MpxError({
      code: 'INSTALL_PI_ROOT_UNAVAILABLE',
      message: 'A registered Pi root could not be resolved from validated user config.',
    });
  }

  private async installedContent(): Promise<string> {
    const appData = this.environment.APPDATA;
    if (!appData || !path.win32.isAbsolute(appData)) {
      return this.unavailable();
    }
    const target = path.win32.join(appData, 'mpx', 'config.json');
    try {
      const info = await this.files.lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size > USER_CONFIG_ARTIFACT_MAX_BYTES) {
        return this.unavailable();
      }
      const body = await this.files.readFile(target);
      if (body.byteLength > USER_CONFIG_ARTIFACT_MAX_BYTES) {
        return this.unavailable();
      }
      return body.toString('utf8');
    } catch {
      return this.unavailable();
    }
  }

  async resolvePiNativeRoot(input: PiPrivateRootResolution): Promise<string> {
    try {
      const content = input.userConfigArtifactContent ?? (await this.installedContent());
      if (Buffer.byteLength(content, 'utf8') > USER_CONFIG_ARTIFACT_MAX_BYTES) {
        return this.unavailable();
      }
      const domain =
        input.identity === 'pi-personal'
          ? 'personal'
          : input.identity === 'pi-work'
            ? 'work'
            : this.unavailable();
      const config = parseUserConfig(content, this.environment);
      const matches = Object.values(config.identities).filter(
        (identity) =>
          identity.domain === domain &&
          path.win32.isAbsolute(identity.runtimeRoots.pi) &&
          installerDigest(normalizedPrivateRoot(identity.runtimeRoots.pi)) ===
            input.expectedNativeRootDigest,
      );
      if (matches.length !== 1) {
        return this.unavailable();
      }
      return matches[0]!.runtimeRoots.pi;
    } catch {
      return this.unavailable();
    }
  }
}

function withCause(code: string, message: string, cause: unknown): MpxError {
  const failure = new MpxError({ code, message });
  Object.defineProperty(failure, 'cause', { value: cause, configurable: true });
  return failure;
}

export class NodePiNativeSettingsPort implements PiNativeSettingsPort {
  constructor(private readonly atomicWriteOperations: Partial<AtomicRegularFileOperations> = {}) {}

  lstat(target: string): Promise<Stats> {
    return lstat(target);
  }

  realpath(target: string): Promise<string> {
    return realpath(target);
  }

  read(target: string): Promise<Buffer> {
    return readFile(target);
  }

  async atomicWrite(target: string, body: Buffer): Promise<void> {
    await atomicReplaceRegularFile(
      target,
      body,
      'Pi settings replacement and temporary cleanup both failed.',
      this.atomicWriteOperations,
    );
  }

  remove(target: string): Promise<void> {
    return rm(target, { force: true });
  }

  async lock(target: string): Promise<PiNativeSettingsLock> {
    let compromised: Error | undefined;
    const release = await lockfile.lock(target, {
      realpath: false,
      retries: { retries: 0 },
      stale: 10_000,
      update: 4_000,
      onCompromised: (cause) => {
        compromised ??= withCause(
          'INSTALL_PI_SETTINGS_LOCK_COMPROMISED',
          'The Pi settings lock was compromised.',
          cause,
        );
      },
    });
    return {
      compromisedFailure: () => compromised,
      release,
    };
  }
}
