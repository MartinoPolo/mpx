import type { Stats } from 'node:fs';
import { lstat, readlink, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MpxError } from '@mpx/core';

export interface LegacyPiExtensionCleanupFileSystem {
  readonly lstat: (target: string) => Promise<Stats>;
  readonly readlink: (target: string) => Promise<string>;
  readonly realpath: (target: string) => Promise<string>;
  readonly unlink: (target: string) => Promise<void>;
}

export interface LegacyPiExtensionCleanupOptions {
  readonly piRoots: readonly string[];
  readonly projectsRoot: string;
  readonly fileSystem?: LegacyPiExtensionCleanupFileSystem;
  readonly platform?: NodeJS.Platform;
}

interface Snapshot {
  readonly path: string;
  readonly info: Stats;
}

interface Candidate extends Snapshot {
  readonly linkTarget: string;
  readonly parents: readonly Snapshot[];
}

const nodeFileSystem: LegacyPiExtensionCleanupFileSystem = { lstat, readlink, realpath, unlink };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

function invalid(): never {
  throw new MpxError({
    code: 'SETUP_LEGACY_PI_EXTENSION_INVALID',
    message: 'A configured Pi extension path is unsafe.',
  });
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return (
    left.isFile() === right.isFile() &&
    left.isDirectory() === right.isDirectory() &&
    left.isSymbolicLink() === right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

/** Removes only obsolete links whose destination and source are both exact known legacy paths. */
export class LegacyPiExtensionCleanupService {
  readonly #fileSystem: LegacyPiExtensionCleanupFileSystem;
  readonly #path: typeof path.posix | typeof path.win32;
  readonly #caseInsensitive: boolean;

  constructor(private readonly options: LegacyPiExtensionCleanupOptions) {
    this.#fileSystem = options.fileSystem ?? nodeFileSystem;
    this.#caseInsensitive = (options.platform ?? process.platform) === 'win32';
    this.#path = this.#caseInsensitive ? path.win32 : path.posix;
  }

  async run(): Promise<void> {
    try {
      if (!this.#absolute(this.options.projectsRoot)) {
        invalid();
      }
      const expectedTargets = new Map([
        [
          'worktree',
          this.#path.join(this.options.projectsRoot, 'mpx-pi', 'extensions', 'worktree'),
        ],
        [
          'mp-namespace-commands.ts',
          this.#path.join(
            this.options.projectsRoot,
            'mpx-pi',
            'extensions',
            'mp-namespace-commands.ts',
          ),
        ],
      ]);
      const candidates: Candidate[] = [];
      const uniqueRoots = new Map<string, string>();
      for (const root of this.options.piRoots) {
        if (!this.#absolute(root)) {
          invalid();
        }
        const normalized = this.#normalize(root);
        if (!uniqueRoots.has(normalized)) {
          uniqueRoots.set(normalized, this.#path.resolve(root));
        }
      }
      for (const root of uniqueRoots.values()) {
        const rootSnapshot = await this.#directory(root);
        if (!rootSnapshot) {
          continue;
        }
        const extensionsSnapshot = await this.#directory(this.#path.join(root, 'extensions'));
        if (!extensionsSnapshot) {
          continue;
        }
        for (const [name, expectedTarget] of expectedTargets) {
          const candidate = await this.#candidate(
            this.#path.join(extensionsSnapshot.path, name),
            expectedTarget,
            [rootSnapshot, extensionsSnapshot],
          );
          if (candidate) {
            candidates.push(candidate);
          }
        }
      }
      for (const candidate of candidates) {
        await this.#delete(candidate);
      }
    } catch (error) {
      if (error instanceof MpxError && error.code === 'SETUP_LEGACY_PI_EXTENSION_INVALID') {
        throw error;
      }
      invalid();
    }
  }

  async #directory(directory: string): Promise<Snapshot | undefined> {
    let before: Stats;
    try {
      before = await this.#fileSystem.lstat(directory);
    } catch (error) {
      if (missing(error)) {
        return undefined;
      }
      throw error;
    }
    if (!before.isDirectory() || before.isSymbolicLink()) {
      invalid();
    }
    const canonical = await this.#fileSystem.realpath(directory);
    const after = await this.#fileSystem.lstat(directory);
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      !sameIdentity(before, after) ||
      this.#normalize(canonical) !== this.#normalize(directory)
    ) {
      invalid();
    }
    return { path: directory, info: after };
  }

  async #candidate(
    candidatePath: string,
    expectedTarget: string,
    parents: readonly Snapshot[],
  ): Promise<Candidate | undefined> {
    let before: Stats;
    try {
      before = await this.#fileSystem.lstat(candidatePath);
    } catch (error) {
      if (missing(error)) {
        return undefined;
      }
      throw error;
    }
    if (!before.isSymbolicLink()) {
      return undefined;
    }
    const linkTarget = await this.#fileSystem.readlink(candidatePath);
    const after = await this.#fileSystem.lstat(candidatePath);
    if (!after.isSymbolicLink() || !sameIdentity(before, after)) {
      invalid();
    }
    const resolvedTarget = this.#path.resolve(this.#path.dirname(candidatePath), linkTarget);
    if (this.#normalize(resolvedTarget) !== this.#normalize(expectedTarget)) {
      return undefined;
    }
    return { path: candidatePath, info: after, linkTarget, parents };
  }

  async #delete(candidate: Candidate): Promise<void> {
    for (const parent of candidate.parents) {
      const current = await this.#fileSystem.lstat(parent.path);
      const canonical = await this.#fileSystem.realpath(parent.path);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        !sameIdentity(parent.info, current) ||
        this.#normalize(canonical) !== this.#normalize(parent.path)
      ) {
        invalid();
      }
    }
    const current = await this.#fileSystem.lstat(candidate.path);
    const linkTarget = await this.#fileSystem.readlink(candidate.path);
    if (
      !current.isSymbolicLink() ||
      !sameIdentity(candidate.info, current) ||
      this.#normalize(this.#path.resolve(this.#path.dirname(candidate.path), linkTarget)) !==
        this.#normalize(
          this.#path.resolve(this.#path.dirname(candidate.path), candidate.linkTarget),
        )
    ) {
      invalid();
    }
    await this.#fileSystem.unlink(candidate.path);
  }

  #absolute(value: string): boolean {
    return this.#path.isAbsolute(value);
  }

  #normalize(value: string): string {
    let normalized = this.#path.resolve(value).replaceAll('\\', '/').replace(/\/$/u, '');
    if (this.#caseInsensitive) {
      normalized = normalized.replace(/^\/\/\?\/UNC\//iu, '//').replace(/^\/\/\?\//u, '');
      normalized = normalized.toLowerCase();
    }
    return normalized;
  }
}
