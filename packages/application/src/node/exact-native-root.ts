import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { MpxError } from '@mpx/core';

export interface ExactNativeRootDependencies {
  readonly lstat: (root: string) => Promise<Stats>;
  readonly realpath: (root: string) => Promise<string>;
}

const normalize = (value: string): string => {
  const resolved = path.resolve(value).replaceAll('\\', '/').replace(/\/$/u, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

function sameIdentity(left: Stats, right: Stats): boolean {
  if (!left.isDirectory() || !right.isDirectory()) {
    return false;
  }
  // Windows may report zero inode values. In that case path stability and repeated
  // metadata checks remain the available Node boundary.
  return left.ino === 0 || right.ino === 0 || (left.ino === right.ino && left.dev === right.dev);
}

function invalid(): MpxError {
  return new MpxError({
    code: 'NATIVE_ROOT_INVALID',
    message: 'The configured native runtime root is missing or unsafe.',
  });
}

/** Stateless verification of an exact configured native runtime directory. */
export class ExactNativeRootVerifier {
  readonly #dependencies: ExactNativeRootDependencies;

  constructor(dependencies: Partial<ExactNativeRootDependencies> = {}) {
    this.#dependencies = {
      lstat: dependencies.lstat ?? lstat,
      realpath: dependencies.realpath ?? realpath,
    };
  }

  async verify(root: string): Promise<void> {
    try {
      if (!path.isAbsolute(root)) {
        throw invalid();
      }
      const expected = normalize(root);
      const before = await this.#dependencies.lstat(root);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw invalid();
      }
      const canonical = await this.#dependencies.realpath(root);
      const middle = await this.#dependencies.lstat(root);
      const canonicalInfo = await this.#dependencies.lstat(canonical);
      const canonicalAgain = await this.#dependencies.realpath(root);
      const after = await this.#dependencies.lstat(root);
      if (
        middle.isSymbolicLink() ||
        canonicalInfo.isSymbolicLink() ||
        after.isSymbolicLink() ||
        normalize(canonical) !== expected ||
        normalize(canonicalAgain) !== expected ||
        !sameIdentity(before, middle) ||
        !sameIdentity(middle, canonicalInfo) ||
        !sameIdentity(canonicalInfo, after)
      ) {
        throw invalid();
      }
    } catch (error) {
      if (error instanceof MpxError && error.code === 'NATIVE_ROOT_INVALID') {
        throw error;
      }
      throw invalid();
    }
  }
}

export function createExactNativeRootVerifier(): ExactNativeRootVerifier {
  return new ExactNativeRootVerifier();
}
