import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { withInstallerCleanup } from './failure.js';

export interface AtomicRegularFileOperations {
  writeFile(target: string, body: Buffer, options: { readonly flag: 'wx' }): Promise<void>;
  rename(source: string, target: string): Promise<void>;
  remove(target: string): Promise<void>;
  temporarySuffix(): string;
}

const nodeAtomicRegularFileOperations: AtomicRegularFileOperations = {
  writeFile: (target, body, options) => writeFile(target, body, options),
  rename,
  remove: (target) => rm(target, { force: true }),
  temporarySuffix: randomUUID,
};

export async function atomicReplaceRegularFile(
  target: string,
  body: Buffer,
  cleanupFailureMessage: string,
  overrides: Partial<AtomicRegularFileOperations> = {},
): Promise<void> {
  const operations = { ...nodeAtomicRegularFileOperations, ...overrides };
  const temporary = `${target}.${operations.temporarySuffix()}.tmp`;
  await withInstallerCleanup(
    async () => {
      await operations.writeFile(temporary, body, { flag: 'wx' });
      await operations.rename(temporary, target);
    },
    () => operations.remove(temporary),
    cleanupFailureMessage,
  );
}
