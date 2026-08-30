import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { MpxError } from '@mpx/core';
import type { ProjectConfig } from './types.js';

export interface InitPlan {
  schemaVersion: 1;
  cwd: string;
  actions: ReadonlyArray<{ type: 'create' | 'skip'; path: string; reason: string }>;
}
export interface ConfirmedInit {
  plan: InitPlan;
  manifestPath: string;
  created: boolean;
  createdFile?: { dev: number; ino: number; bytes: Uint8Array };
  pendingTemporaryPath?: string;
}
export interface InitFileOperations {
  unlink?: typeof unlink;
  link?: typeof link;
  copyFile?: typeof copyFile;
}
export interface RollbackInitFileOperations {
  unlink?: typeof unlink;
  link?: typeof link;
  lstat?: typeof lstat;
  rename?: typeof rename;
}

export function planInit(cwd: string, hasManifest: boolean): InitPlan {
  const root = join(cwd, 'mpxconfig.json');
  const type: 'create' | 'skip' = hasManifest ? 'skip' : 'create';
  return Object.freeze({
    schemaVersion: 1,
    cwd,
    actions: Object.freeze([
      { type, path: root, reason: hasManifest ? 'manifest-exists' : 'manifest-missing' },
    ]),
  });
}

function cleanupError(publicationCode?: string): MpxError {
  return new MpxError({
    code: 'INIT_CLEANUP_FAILED',
    message: 'Init cleanup could not be completed.',
    remediation:
      'Retry init after the owned temporary artifact is accessible; unrelated files will not be removed.',
    ...(publicationCode ? { details: { publicationCode } } : {}),
  });
}
function stableCode(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === 'string' && code.length > 0 ? code : 'COMMAND_FAILED';
}
function supportsCopyPublication(error: unknown): boolean {
  return ['EPERM', 'ENOTSUP', 'EXDEV', 'EOPNOTSUPP'].includes(stableCode(error));
}
function pendingTemporaryPath(cwd: string): string {
  return join(cwd, `.mpxconfig.json.${process.pid}.${randomUUID()}.mpx-init-pending`);
}
function isOwnedRegular(
  status: Awaited<ReturnType<typeof lstat>>,
  identity: { dev: number; ino: number },
): boolean {
  return (
    status.isFile() &&
    !status.isSymbolicLink() &&
    status.dev === identity.dev &&
    status.ino === identity.ino
  );
}
async function removeOwnedPendingTemporary(
  file: string | undefined,
  identity: { dev: number; ino: number } | undefined,
  remove: typeof unlink,
): Promise<void> {
  if (!file || !identity) {
    return;
  }
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw cleanupError();
  }
  if (!isOwnedRegular(status, identity)) {
    return;
  }
  try {
    await remove(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw cleanupError();
    }
  }
}
async function retryOwnedPendingTemporary(
  cwd: string,
  manifestPath: string,
  remove: typeof unlink,
): Promise<void> {
  const entries = await readdir(cwd, { withFileTypes: true }).catch(() => {
    throw cleanupError();
  });
  let manifest: Awaited<ReturnType<typeof lstat>>;
  try {
    manifest = await lstat(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw cleanupError();
  }
  if (!manifest.isFile() || manifest.isSymbolicLink()) {
    return;
  }
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !/^\.mpxconfig\.json\.\d+\.[0-9a-f-]+\.mpx-init-pending$/u.test(entry.name)
    ) {
      continue;
    }
    await removeOwnedPendingTemporary(
      join(cwd, entry.name),
      { dev: manifest.dev, ino: manifest.ino },
      remove,
    );
  }
}

/** Atomically publish exactly the manifest action represented by planInit; existing manifests are never rewritten. */
export async function confirmInit(
  cwd: string,
  hasManifest: boolean,
  suggestedManifest: ProjectConfig,
  operations: InitFileOperations = {},
): Promise<ConfirmedInit> {
  const plan = planInit(cwd, hasManifest),
    manifestPath = plan.actions[0]!.path;
  const remove = operations.unlink ?? unlink,
    publish = operations.link ?? link,
    copyPublish = operations.copyFile ?? copyFile;
  if (hasManifest) {
    await retryOwnedPendingTemporary(cwd, manifestPath, remove);
    return { plan, manifestPath, created: false };
  }

  const bytes = Buffer.from(`${JSON.stringify(suggestedManifest, null, 2)}\n`, 'utf8'),
    temporaryPath = pendingTemporaryPath(cwd);
  let handle: Awaited<ReturnType<typeof open>> | undefined,
    ownsTemporary = false,
    published = false,
    publicationError: unknown;
  try {
    handle = await open(temporaryPath, 'wx');
    ownsTemporary = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await publish(temporaryPath, manifestPath);
    } catch (error) {
      if (!supportsCopyPublication(error)) {
        throw error;
      }
      await copyPublish(temporaryPath, manifestPath, constants.COPYFILE_EXCL);
    }
    published = true;
    const publishedHandle = await open(manifestPath, 'r+');
    try {
      await publishedHandle.sync();
    } finally {
      await publishedHandle.close();
    }
    const identity = await lstat(manifestPath);
    if (!identity.isFile() || identity.isSymbolicLink()) {
      throw cleanupError();
    }
    const createdFile = { dev: identity.dev, ino: identity.ino, bytes };
    let pendingPath: string | undefined;
    try {
      await remove(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        pendingPath = temporaryPath;
      }
    }
    return {
      plan,
      manifestPath,
      created: true,
      createdFile,
      ...(pendingPath ? { pendingTemporaryPath: pendingPath } : {}),
    };
  } catch (error) {
    publicationError = error;
    throw error;
  } finally {
    let closeError: unknown;
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        closeError = error;
      }
    }
    if (ownsTemporary && !published) {
      try {
        await remove(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          // eslint-disable-next-line no-unsafe-finally -- cleanup outcome intentionally determines the reported failure.
          throw cleanupError(stableCode(publicationError ?? closeError));
        }
      }
    }
    if (closeError && !publicationError) {
      // eslint-disable-next-line no-unsafe-finally -- cleanup outcome intentionally determines the reported failure.
      throw cleanupError(stableCode(closeError));
    }
  }
}

/** Remove only the unchanged regular manifest created by this confirmation. */
export async function rollbackConfirmedInit(
  confirmation: ConfirmedInit,
  operations: RollbackInitFileOperations = {},
): Promise<void> {
  if (!confirmation.created || !confirmation.createdFile) {
    return;
  }
  const move = operations.rename ?? rename,
    inspect = operations.lstat ?? lstat,
    restoreLink = operations.link ?? link,
    remove = operations.unlink ?? unlink;
  const quarantinePath = join(
    confirmation.plan.cwd,
    `.mpxconfig.json.${process.pid}.${randomUUID()}.rollback`,
  );
  let quarantined = false;
  try {
    try {
      await move(confirmation.manifestPath, quarantinePath);
      quarantined = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw cleanupError();
      }
    }
    if (quarantined) {
      const status = await inspect(quarantinePath).catch(() => {
        throw cleanupError();
      });
      const bytesMatch =
        isOwnedRegular(status, confirmation.createdFile) &&
        (
          await readFile(quarantinePath).catch(() => {
            throw cleanupError();
          })
        ).equals(Buffer.from(confirmation.createdFile.bytes));
      if (bytesMatch) {
        await remove(quarantinePath).catch(() => {
          throw cleanupError();
        });
      } else if (status.isFile() && !status.isSymbolicLink()) {
        try {
          await restoreLink(quarantinePath, confirmation.manifestPath);
          await remove(quarantinePath);
        } catch {
          throw cleanupError();
        }
      } else {
        try {
          await inspect(confirmation.manifestPath);
          throw cleanupError();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
        try {
          await move(quarantinePath, confirmation.manifestPath);
        } catch {
          throw cleanupError();
        }
      }
    }
    await removeOwnedPendingTemporary(
      confirmation.pendingTemporaryPath,
      confirmation.createdFile,
      remove,
    );
  } catch (error) {
    if (error instanceof MpxError) {
      throw error;
    }
    throw cleanupError();
  }
}
