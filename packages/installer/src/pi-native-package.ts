import path from 'node:path';
import {
  canonicalJson,
  installerDigest,
  parseReleaseManifestV1,
  type ReleaseManifestV1,
} from './immutable-core.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const FORBIDDEN_PATH =
  /(^|[/._-])(?:node_modules|auth|credentials?|sessions?|cache|trust)(?:[/._-]|$)/iu;
const LOCKFILE =
  /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.lock)$/iu;

export const PI_NATIVE_PACKAGE_NAME = '@mpx/pi-extensions' as const;
export const PI_NATIVE_PACKAGE_ROOT = 'runtimes/pi/extensions/dist/package' as const;

export interface PiNativePackageFileV1 {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}
export interface PiNativePackageRegistrationV1 {
  readonly name: typeof PI_NATIVE_PACKAGE_NAME;
  readonly packageRoot: typeof PI_NATIVE_PACKAGE_ROOT;
  readonly artifactRootDigest: string;
  readonly files: readonly PiNativePackageFileV1[];
}

export class PiNativePackageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'PiNativePackageError';
  }
}
function fail(code: string, message: string): never {
  throw new PiNativePackageError(code, message);
}
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('PI_NATIVE_SCHEMA_INVALID', `${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail('PI_NATIVE_SCHEMA_INVALID', `${label} has unknown or missing fields.`);
  }
  return record;
}
function safeRelative(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.endsWith('/') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /^[A-Za-z]:/u.test(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.normalize(value) !== value
  ) {
    return false;
  }
  return value
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function parsePiNativePackageRegistration(value: unknown): PiNativePackageRegistrationV1 {
  const record = exact(
    value,
    ['name', 'packageRoot', 'artifactRootDigest', 'files'],
    'Pi native package',
  );
  if (
    record.name !== PI_NATIVE_PACKAGE_NAME ||
    record.packageRoot !== PI_NATIVE_PACKAGE_ROOT ||
    typeof record.artifactRootDigest !== 'string' ||
    !SHA256.test(record.artifactRootDigest) ||
    !Array.isArray(record.files) ||
    record.files.length === 0
  ) {
    fail('PI_NATIVE_SCHEMA_INVALID', 'Pi native package header is invalid.');
  }
  const files = record.files.map((value): PiNativePackageFileV1 => {
    const file = exact(value, ['path', 'sha256', 'bytes'], 'Pi native package file');
    if (
      !safeRelative(file.path) ||
      typeof file.sha256 !== 'string' ||
      !SHA256.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      (file.bytes as number) < 0 ||
      FORBIDDEN_PATH.test(file.path) ||
      LOCKFILE.test(file.path) ||
      /\.map$/iu.test(file.path)
    ) {
      fail('PI_NATIVE_INVENTORY_INVALID', 'Pi native package inventory is unsafe.');
    }
    return { path: file.path, sha256: file.sha256, bytes: file.bytes as number };
  });
  if (
    new Set(files.map((file) => file.path.toLowerCase())).size !== files.length ||
    files.some(
      (file, index) => index > 0 && files[index - 1]!.path.localeCompare(file.path) >= 0,
    ) ||
    !files.some((file) => file.path === 'package.json') ||
    !files.some((file) => file.path === 'build-metadata.json') ||
    !files.some((file) => file.path === 'index.mjs') ||
    installerDigest(files) !== record.artifactRootDigest
  ) {
    fail('PI_NATIVE_INVENTORY_INVALID', 'Pi native package inventory is incomplete or changed.');
  }
  return {
    name: PI_NATIVE_PACKAGE_NAME,
    packageRoot: PI_NATIVE_PACKAGE_ROOT,
    artifactRootDigest: record.artifactRootDigest,
    files,
  };
}

export function createPiNativePackageRegistration(
  releaseValue: ReleaseManifestV1,
): PiNativePackageRegistrationV1 {
  const release = parseReleaseManifestV1(releaseValue);
  const prefix = `${PI_NATIVE_PACKAGE_ROOT}/`;
  const files = release.files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({
      path: file.path.slice(prefix.length),
      sha256: file.sha256,
      bytes: file.bytes,
    }));
  return parsePiNativePackageRegistration({
    name: PI_NATIVE_PACKAGE_NAME,
    packageRoot: PI_NATIVE_PACKAGE_ROOT,
    artifactRootDigest: installerDigest(files),
    files,
  });
}

export type PiSettings = Readonly<Record<string, unknown>>;
export interface PiPackageSettingsPlanV1 {
  readonly desiredSource: string;
  readonly packagesBefore: readonly unknown[];
  readonly packagesAfter: readonly unknown[];
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly priorOwnedEntries: readonly {
    readonly source: string;
    readonly packagesBeforeIndex: number;
    readonly unownedBefore: number;
  }[];
  readonly unownedBefore: readonly unknown[];
  readonly settings: PiSettings;
  readonly planDigest: string;
}

function jsonValue(value: unknown, code: string, depth = 0): unknown {
  if (depth > 32) {
    fail(code, 'Settings exceed safe JSON depth.');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonValue(item, code, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    fail(code, 'Settings must contain JSON values.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, 'Settings must contain only parsed JSON objects.');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([key]) => ['__proto__', 'prototype', 'constructor'].includes(key))) {
    fail(code, 'Settings contain an unsafe key.');
  }
  return Object.fromEntries(entries.map(([key, item]) => [key, jsonValue(item, code, depth + 1)]));
}
function parseSettings(value: unknown | undefined, code: string): PiSettings {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, 'Pi settings must be an object.');
  }
  const parsed = jsonValue(value, code) as Record<string, unknown>;
  if ('packages' in parsed && !Array.isArray(parsed.packages)) {
    fail(code, 'Pi settings packages must be an array.');
  }
  return parsed;
}
export function parsePiSettings(value: unknown | undefined): PiSettings {
  return parseSettings(value, 'PI_SETTINGS_INVALID');
}
export function serializePiSettings(value: unknown | undefined): string {
  return `${canonicalJson(parsePiSettings(value))}\n`;
}
function windowsPath(value: string): boolean {
  return (
    path.win32.isAbsolute(value) && (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\'))
  );
}
function normalizeAbsolute(value: string): string {
  if (windowsPath(value)) {
    return path.win32
      .normalize(value)
      .replace(/[\\]+$/u, '')
      .toLowerCase();
  }
  if (path.posix.isAbsolute(value)) {
    return path.posix.normalize(value).replace(/\/+$/u, '');
  }
  fail('PI_SETTINGS_PATH_INVALID', 'Package source must be absolute.');
}
function validateDesired(
  releaseRoot: string,
  desired: string,
  registration: PiNativePackageRegistrationV1,
): void {
  parsePiNativePackageRegistration(registration);
  const windows = windowsPath(releaseRoot);
  if ((!windows && !path.posix.isAbsolute(releaseRoot)) || windows !== windowsPath(desired)) {
    fail(
      'PI_SETTINGS_PATH_INVALID',
      'Release root and package source must use one absolute path style.',
    );
  }
  const expected = windows
    ? path.win32.join(releaseRoot, ...registration.packageRoot.split('/'))
    : path.posix.join(releaseRoot, ...registration.packageRoot.split('/'));
  const root = normalizeAbsolute(releaseRoot),
    source = normalizeAbsolute(desired);
  const separator = windows ? '\\' : '/';
  if (source !== normalizeAbsolute(expected) || !source.startsWith(`${root}${separator}`)) {
    fail(
      'PI_SETTINGS_PATH_INVALID',
      'Package source is not the registered artifact under the immutable release root.',
    );
  }
}
function semanticEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function trustedPriorOwnedSources(value: unknown): Set<string> {
  if (
    !Array.isArray(value) ||
    value.some(
      (item) => typeof item !== 'string' || (!windowsPath(item) && !path.posix.isAbsolute(item)),
    )
  ) {
    fail('PI_SETTINGS_OWNERSHIP_INVALID', 'Prior owned sources must be explicit absolute paths.');
  }
  return new Set(value.map(normalizeAbsolute));
}

export function planPiNativePackageSettings(input: {
  readonly settings: unknown | undefined;
  readonly releaseRoot: string;
  readonly desiredSource: string;
  readonly nativePackage: PiNativePackageRegistrationV1;
  readonly priorOwnedSources: readonly string[];
}): PiPackageSettingsPlanV1 {
  validateDesired(input.releaseRoot, input.desiredSource, input.nativePackage);
  const settings = parsePiSettings(input.settings);
  const owned = trustedPriorOwnedSources(input.priorOwnedSources);
  owned.add(normalizeAbsolute(input.desiredSource));
  const packagesBefore = [...((settings.packages as unknown[] | undefined) ?? [])];
  let firstOwned = -1;
  const priorOwnedEntries: {
      source: string;
      packagesBeforeIndex: number;
      unownedBefore: number;
    }[] = [],
    unownedBefore: unknown[] = [];
  for (const [packagesBeforeIndex, entry] of packagesBefore.entries()) {
    const isOwned =
      typeof entry === 'string' &&
      (windowsPath(entry) || path.posix.isAbsolute(entry)) &&
      owned.has(normalizeAbsolute(entry));
    if (isOwned) {
      if (firstOwned < 0) {
        firstOwned = unownedBefore.length;
      }
      priorOwnedEntries.push({
        source: entry,
        packagesBeforeIndex,
        unownedBefore: unownedBefore.length,
      });
    } else {
      unownedBefore.push(entry);
    }
  }
  const insertAt = firstOwned < 0 ? unownedBefore.length : firstOwned;
  const packagesAfter = [
    ...unownedBefore.slice(0, insertAt),
    input.desiredSource,
    ...unownedBefore.slice(insertAt),
  ];
  const base = {
    desiredSource: input.desiredSource,
    packagesBefore,
    packagesAfter,
    beforeDigest: installerDigest(packagesBefore),
    afterDigest: installerDigest(packagesAfter),
    priorOwnedEntries,
    unownedBefore,
    settings: { ...settings, packages: packagesAfter },
  };
  return { ...base, planDigest: installerDigest(base) };
}

function exactPlanRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('PI_SETTINGS_SCHEMA_INVALID', `${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail('PI_SETTINGS_SCHEMA_INVALID', `${label} has unknown or missing fields.`);
  }
  return record;
}

export function parsePiPackageSettingsPlanV1(value: unknown): PiPackageSettingsPlanV1 {
  try {
    const record = exactPlanRecord(
      value,
      [
        'desiredSource',
        'packagesBefore',
        'packagesAfter',
        'beforeDigest',
        'afterDigest',
        'priorOwnedEntries',
        'unownedBefore',
        'settings',
        'planDigest',
      ],
      'Pi settings plan',
    );
    if (
      typeof record.desiredSource !== 'string' ||
      (!windowsPath(record.desiredSource) && !path.posix.isAbsolute(record.desiredSource)) ||
      !Array.isArray(record.packagesBefore) ||
      !Array.isArray(record.packagesAfter) ||
      !Array.isArray(record.priorOwnedEntries) ||
      !Array.isArray(record.unownedBefore) ||
      typeof record.beforeDigest !== 'string' ||
      !SHA256.test(record.beforeDigest) ||
      typeof record.afterDigest !== 'string' ||
      !SHA256.test(record.afterDigest) ||
      typeof record.planDigest !== 'string' ||
      !SHA256.test(record.planDigest)
    ) {
      fail('PI_SETTINGS_SCHEMA_INVALID', 'Pi settings plan fields are invalid.');
    }
    const desiredSource = record.desiredSource;
    const packagesBefore = jsonValue(
      record.packagesBefore,
      'PI_SETTINGS_SCHEMA_INVALID',
    ) as unknown[];
    const packagesAfter = jsonValue(
      record.packagesAfter,
      'PI_SETTINGS_SCHEMA_INVALID',
    ) as unknown[];
    const unownedBefore = jsonValue(
      record.unownedBefore,
      'PI_SETTINGS_SCHEMA_INVALID',
    ) as unknown[];
    const priorOwnedEntries = record.priorOwnedEntries.map((value) => {
      const entry = exactPlanRecord(
        value,
        ['source', 'packagesBeforeIndex', 'unownedBefore'],
        'Prior owned entry',
      );
      if (
        typeof entry.source !== 'string' ||
        (!windowsPath(entry.source) && !path.posix.isAbsolute(entry.source)) ||
        !Number.isSafeInteger(entry.packagesBeforeIndex) ||
        (entry.packagesBeforeIndex as number) < 0 ||
        !Number.isSafeInteger(entry.unownedBefore) ||
        (entry.unownedBefore as number) < 0
      ) {
        fail('PI_SETTINGS_SCHEMA_INVALID', 'Prior owned entry fields are invalid.');
      }
      return {
        source: entry.source,
        packagesBeforeIndex: entry.packagesBeforeIndex as number,
        unownedBefore: entry.unownedBefore as number,
      };
    });
    const settings = parseSettings(record.settings, 'PI_SETTINGS_SCHEMA_INVALID');
    const base = {
      desiredSource,
      packagesBefore,
      packagesAfter,
      beforeDigest: record.beforeDigest,
      afterDigest: record.afterDigest,
      priorOwnedEntries,
      unownedBefore,
      settings,
    };
    if (installerDigest(base) !== record.planDigest) {
      fail('PI_SETTINGS_DRIFT', 'Pi settings plan digest changed.');
    }
    if (
      installerDigest(packagesBefore) !== record.beforeDigest ||
      installerDigest(packagesAfter) !== record.afterDigest
    ) {
      fail('PI_SETTINGS_DRIFT', 'Settings rollback evidence changed.');
    }
    const ownedIndices = new Set<number>();
    let previousOwnedIndex = -1;
    for (const entry of priorOwnedEntries) {
      if (
        entry.packagesBeforeIndex <= previousOwnedIndex ||
        entry.packagesBeforeIndex >= packagesBefore.length ||
        packagesBefore[entry.packagesBeforeIndex] !== entry.source ||
        entry.unownedBefore !== entry.packagesBeforeIndex - ownedIndices.size ||
        entry.unownedBefore > unownedBefore.length
      ) {
        fail('PI_SETTINGS_DRIFT', 'Prior owned package evidence is invalid.');
      }
      ownedIndices.add(entry.packagesBeforeIndex);
      previousOwnedIndex = entry.packagesBeforeIndex;
    }
    const reconstructedUnowned = packagesBefore.filter((_entry, index) => !ownedIndices.has(index));
    const desiredIndices = packagesAfter.flatMap((entry, index) =>
      entry === desiredSource ? [index] : [],
    );
    const expectedInsertion = priorOwnedEntries[0]?.unownedBefore ?? unownedBefore.length;
    const plannedUnowned = packagesAfter.filter((_entry, index) => index !== desiredIndices[0]);
    if (
      !semanticEqual(reconstructedUnowned, unownedBefore) ||
      desiredIndices.length !== 1 ||
      desiredIndices[0] !== expectedInsertion ||
      !semanticEqual(plannedUnowned, unownedBefore) ||
      !semanticEqual(settings.packages, packagesAfter)
    ) {
      fail('PI_SETTINGS_DRIFT', 'Pi settings plan rollback evidence is inconsistent.');
    }
    return { ...base, planDigest: record.planDigest } as PiPackageSettingsPlanV1;
  } catch (failure) {
    if (failure instanceof PiNativePackageError) {
      throw failure;
    }
    fail('PI_SETTINGS_SCHEMA_INVALID', 'Pi settings plan could not be parsed.');
  }
}

export function invertPiNativePackageSettings(input: {
  readonly settings: unknown;
  readonly plan: unknown;
  readonly priorOwnedSources: readonly string[];
}): {
  readonly settings: PiSettings;
  readonly packagesBefore: readonly unknown[];
  readonly packagesAfter: readonly unknown[];
  readonly beforeDigest: string;
  readonly afterDigest: string;
} {
  const settings = parsePiSettings(input.settings),
    plan = parsePiPackageSettingsPlanV1(input.plan);
  const trustedSources = trustedPriorOwnedSources(input.priorOwnedSources);
  const currentRegistrationSource = normalizeAbsolute(plan.desiredSource);
  if (
    plan.priorOwnedEntries.some(
      (entry) =>
        normalizeAbsolute(entry.source) !== currentRegistrationSource &&
        !trustedSources.has(normalizeAbsolute(entry.source)),
    )
  ) {
    fail('PI_SETTINGS_OWNERSHIP_INVALID', 'Rollback plan contains an untrusted owned source.');
  }
  const authorizedSources = new Set(trustedSources);
  authorizedSources.add(currentRegistrationSource);
  let unownedBefore = 0;
  const expectedPriorOwnedEntries: PiPackageSettingsPlanV1['priorOwnedEntries'][number][] = [];
  for (const [packagesBeforeIndex, entry] of plan.packagesBefore.entries()) {
    const isExpectedOwned =
      typeof entry === 'string' &&
      (windowsPath(entry) || path.posix.isAbsolute(entry)) &&
      authorizedSources.has(normalizeAbsolute(entry));
    if (isExpectedOwned) {
      expectedPriorOwnedEntries.push({ source: entry, packagesBeforeIndex, unownedBefore });
    } else {
      unownedBefore += 1;
    }
  }
  if (!semanticEqual(plan.priorOwnedEntries, expectedPriorOwnedEntries)) {
    fail('PI_SETTINGS_OWNERSHIP_INVALID', 'Rollback plan omits or changes trusted ownership.');
  }
  const plannedDesired = plan.packagesAfter.flatMap((entry, index) =>
    entry === plan.desiredSource ? [index] : [],
  );
  const current = [...((settings.packages as unknown[] | undefined) ?? [])];
  const indices = current.flatMap((entry, index) => (entry === plan.desiredSource ? [index] : []));
  if (indices.length !== 1) {
    fail('PI_SETTINGS_DRIFT', 'Applied package entry is missing or ambiguous.');
  }
  const desiredIndex = indices[0]!;
  const currentUnowned = current.filter((_entry, index) => index !== desiredIndex);
  let cursor = 0;
  const matchedCurrentIndices: number[] = [];
  for (const original of plan.unownedBefore) {
    while (cursor < currentUnowned.length && !semanticEqual(currentUnowned[cursor], original)) {
      cursor += 1;
    }
    if (cursor === currentUnowned.length) {
      fail('PI_SETTINGS_DRIFT', 'Previously unrelated package entries drifted.');
    }
    matchedCurrentIndices.push(cursor);
    cursor += 1;
  }
  const insertion = plannedDesired[0]!;
  const priorBoundary = insertion === 0 ? -1 : matchedCurrentIndices[insertion - 1]!;
  const nextBoundary =
    insertion === matchedCurrentIndices.length
      ? currentUnowned.length
      : matchedCurrentIndices[insertion]!;
  if (desiredIndex <= priorBoundary || desiredIndex > nextBoundary) {
    fail('PI_SETTINGS_DRIFT', 'Applied package entry moved ambiguously.');
  }
  const firstAnchor = plan.priorOwnedEntries[0]?.unownedBefore;
  const byAnchor = new Map<number, string[]>();
  for (const entry of plan.priorOwnedEntries) {
    const sources = byAnchor.get(entry.unownedBefore) ?? [];
    sources.push(entry.source);
    byAnchor.set(entry.unownedBefore, sources);
  }
  const currentToOriginal = new Map(
    matchedCurrentIndices.map((index, original) => [index, original]),
  );
  const packagesAfter: unknown[] = [];
  let unownedIndex = 0;
  for (let index = 0; index < current.length; index += 1) {
    if (index === desiredIndex) {
      if (firstAnchor !== undefined) {
        packagesAfter.push(...(byAnchor.get(firstAnchor) ?? []));
        byAnchor.delete(firstAnchor);
      }
      continue;
    }
    const original = currentToOriginal.get(unownedIndex);
    if (original !== undefined) {
      packagesAfter.push(...(byAnchor.get(original) ?? []));
      byAnchor.delete(original);
    }
    packagesAfter.push(current[index]);
    unownedIndex += 1;
  }
  packagesAfter.push(...(byAnchor.get(plan.unownedBefore.length) ?? []));
  byAnchor.delete(plan.unownedBefore.length);
  if (byAnchor.size !== 0) {
    fail('PI_SETTINGS_DRIFT', 'Owned rollback anchors are invalid.');
  }
  return {
    settings: { ...settings, packages: packagesAfter },
    packagesBefore: current,
    packagesAfter,
    beforeDigest: installerDigest(current),
    afterDigest: installerDigest(packagesAfter),
  };
}
