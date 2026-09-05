import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import lockfile from 'proper-lockfile';
import { MpxError } from '@mpx/core';
import { atomicReplaceRegularFile, type AtomicRegularFileOperations } from './atomic-file.js';
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

/** Resolves a private Pi account root at execution time. It must return an absolute root for the exact identity, or undefined when that configured identity cannot be resolved. */
export interface PiPrivateRootResolver {
  resolvePiNativeRoot(identity: RuntimeIdentity): Promise<string | undefined>;
}

export class EnvironmentPiPrivateRootResolver implements PiPrivateRootResolver {
  constructor(private readonly environment: Readonly<NodeJS.ProcessEnv>) {}

  async resolvePiNativeRoot(identity: RuntimeIdentity): Promise<string | undefined> {
    return this.environment[`MPX_${identity.replace('-', '_').toUpperCase()}_ROOT`];
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
