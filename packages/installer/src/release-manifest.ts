import { createHash } from 'node:crypto';
import { MpxError } from '@mpx/core';

export const SHA = /^[a-f0-9]{64}$/u;

export interface ReleaseFileV1 {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ReleaseManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: 'release-manifest';
  readonly releaseKey: string;
  readonly convergenceHash: string;
  readonly files: readonly ReleaseFileV1[];
}

function fail(code: string, message: string): never {
  throw new MpxError({ code, message });
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

export function installerDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INSTALL_SCHEMA_INVALID', 'Protocol value must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail('INSTALL_SCHEMA_INVALID', 'Unknown or missing protocol field.');
  }
  return record;
}

export function safeRelative(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/')
  ) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function compareReleasePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseFile(value: unknown): ReleaseFileV1 {
  const file = exact(value, ['path', 'bytes', 'sha256']);
  if (
    !safeRelative(file.path) ||
    !Number.isSafeInteger(file.bytes) ||
    (file.bytes as number) < 0 ||
    typeof file.sha256 !== 'string' ||
    !SHA.test(file.sha256)
  ) {
    fail('INSTALL_SCHEMA_INVALID', 'Invalid release file.');
  }
  return file as unknown as ReleaseFileV1;
}

export function parseReleaseManifestV1(value: unknown): ReleaseManifestV1 {
  const manifest = exact(value, [
    'schemaVersion',
    'kind',
    'releaseKey',
    'convergenceHash',
    'files',
  ]);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== 'release-manifest' ||
    typeof manifest.releaseKey !== 'string' ||
    !SHA.test(manifest.releaseKey) ||
    typeof manifest.convergenceHash !== 'string' ||
    !SHA.test(manifest.convergenceHash) ||
    !Array.isArray(manifest.files)
  ) {
    fail('INSTALL_SCHEMA_INVALID', 'Invalid release manifest.');
  }
  const files = manifest.files.map(parseFile);
  if (
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.some(
      (file, index) => index > 0 && compareReleasePaths(files[index - 1]!.path, file.path) >= 0,
    )
  ) {
    fail('INSTALL_SCHEMA_INVALID', 'Release files must be unique and sorted.');
  }
  const convergenceHash = installerDigest(files);
  if (manifest.releaseKey !== convergenceHash || manifest.convergenceHash !== convergenceHash) {
    fail('INSTALL_SCHEMA_INVALID', 'Release convergence hash is invalid.');
  }
  return {
    schemaVersion: 1,
    kind: 'release-manifest',
    releaseKey: convergenceHash,
    convergenceHash,
    files,
  };
}
