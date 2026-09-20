import { open, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Packages retained as native Pi packages during the migration. */
export const RETAINED_NATIVE_PACKAGES = [
  'pi-web-access',
  'pi-mcp-adapter',
  '@juicesharp/rpiv-ask-user-question',
] as const;

export type RetainedNativePackage = (typeof RETAINED_NATIVE_PACKAGES)[number];

export interface NativePackageRoot {
  account: string;
  /** Explicit Pi agent directory containing settings.json and npm/. */
  root: string;
}

export interface NativePackageStatus {
  account: string;
  packageName: RetainedNativePackage;
  source?: string;
  configured: boolean;
  packagePath: string;
  version?: string;
  /** Existing extension entry points declared by the package manifest; settings filters are not applied. */
  loadTargets: string[];
  missing: string[];
  conflict: boolean;
  status: 'ready' | 'missing';
}

export interface NativePackageConflict {
  packageName: RetainedNativePackage;
  versions: string[];
  accounts: Array<{ account: string; version: string; packagePath: string }>;
}

export interface NativePackageInspection {
  ok: boolean;
  packages: NativePackageStatus[];
  conflicts: NativePackageConflict[];
}

type PackageSetting = string | {
  source?: unknown;
  autoload?: unknown;
  extensions?: unknown;
};

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  pi?: { extensions?: unknown } | null;
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

const MAX_JSON_BYTES = 1024 * 1024;

async function readJson(path: string): Promise<unknown> {
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.allocUnsafe(MAX_JSON_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_JSON_BYTES) throw new Error(`JSON file exceeds ${MAX_JSON_BYTES} bytes: ${path}`);
    return JSON.parse(bytes.subarray(0, length).toString('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

function sourceString(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return undefined;
  return typeof (entry as PackageSetting & object).source === 'string'
    ? (entry as PackageSetting & { source: string }).source
    : undefined;
}

function hasExtensionFilter(entry: PackageSetting): boolean {
  if (typeof entry === 'string') return false;
  return entry.autoload === false || Object.prototype.hasOwnProperty.call(entry, 'extensions');
}

function npmName(source: string): string | undefined {
  if (!source.startsWith('npm:')) return undefined;
  const spec = source.slice(4).trim();
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    if (slash < 2) return undefined;
    const versionAt = spec.indexOf('@', slash);
    return versionAt < 0 ? spec : spec.slice(0, versionAt);
  }
  const versionAt = spec.indexOf('@');
  return versionAt < 0 ? spec : spec.slice(0, versionAt);
}

function containedFile(root: string, entry: string): string | undefined {
  if (!entry.trim() || entry.includes('*') || entry.includes('?') || entry.startsWith('!') || entry.startsWith('+') || entry.startsWith('-')) return undefined;
  const target = resolve(root, entry);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return target;
}

async function inspectOne(input: NativePackageRoot, packageName: RetainedNativePackage): Promise<NativePackageStatus> {
  const root = resolve(input.root);
  const packagePath = join(root, 'npm', 'node_modules', ...packageName.split('/'));
  const missing: string[] = [];
  let configuredSource: string | undefined;
  let configuredEntry: PackageSetting | undefined;
  let entries: unknown[] = [];

  try {
    const settings = await readJson(join(root, 'settings.json'));
    if (settings && typeof settings === 'object' && Array.isArray((settings as { packages?: unknown }).packages)) {
      entries = (settings as { packages: unknown[] }).packages;
    } else {
      missing.push('settings.packages');
    }
  } catch {
    missing.push('settings.json');
  }

  for (const entry of entries) {
    const source = sourceString(entry);
    if (source && npmName(source) === packageName) {
      configuredSource = source;
      configuredEntry = entry as PackageSetting;
      break;
    }
  }
  if (!configuredSource) {
    missing.push('configured package');
  } else if (configuredEntry && hasExtensionFilter(configuredEntry)) {
    // Do not claim readiness without reproducing Pi's complete package-filter semantics.
    missing.push('configured extension disabled/filtered');
  }

  let version: string | undefined;
  const loadTargets: string[] = [];
  const manifestPath = join(packagePath, 'package.json');
  try {
    const parsedManifest = await readJson(manifestPath);
    if (!parsedManifest || typeof parsedManifest !== 'object') throw new Error('Invalid package manifest.');
    const manifest = parsedManifest as PackageManifest;
    if (manifest.name !== packageName) missing.push('package name');
    if (typeof manifest.version === 'string' && manifest.version.trim()) version = manifest.version;
    else missing.push('package version');
    const declared = manifest.pi?.extensions;
    if (!Array.isArray(declared) || declared.length === 0) {
      missing.push('pi.extensions');
    } else {
      for (const entry of declared) {
        if (typeof entry !== 'string') {
          missing.push('extension target');
          continue;
        }
        const target = containedFile(packagePath, entry);
        if (!target || !(await isFile(target))) missing.push(`extension target: ${entry}`);
        else loadTargets.push(target);
      }
    }
  } catch {
    missing.push('package.json');
  }

  return {
    account: input.account,
    packageName,
    source: configuredSource,
    configured: configuredSource !== undefined,
    packagePath,
    version,
    loadTargets,
    missing: [...new Set(missing)],
    conflict: false,
    status: missing.length === 0 ? 'ready' : 'missing',
  };
}

/**
 * Read-only status API for explicitly supplied Pi account roots.
 *
 * It reads only settings.json plus retained package manifests/entry-point stats.
 * It never invokes Pi's installing resolver, package managers, credentials, or
 * session/history storage. Callers that need loader proof should pass the
 * returned packagePath to DefaultResourceLoader.additionalExtensionPaths.
 */
export async function inspectNativePackages(roots: NativePackageRoot[]): Promise<NativePackageInspection> {
  if (roots.length === 0) throw new Error('At least one explicit native package root is required.');
  const seenAccounts = new Set<string>();
  for (const input of roots) {
    if (!input.account.trim()) throw new Error('Native package account names must be non-empty.');
    if (!isAbsolute(input.root)) throw new Error(`Native package root for ${input.account} must be absolute.`);
    if (seenAccounts.has(input.account)) throw new Error(`Duplicate native package account: ${input.account}`);
    seenAccounts.add(input.account);
  }

  const packages = (await Promise.all(roots.flatMap(input =>
    RETAINED_NATIVE_PACKAGES.map(packageName => inspectOne(input, packageName)),
  ))).sort((a, b) => a.account.localeCompare(b.account) || a.packageName.localeCompare(b.packageName));

  const conflicts: NativePackageConflict[] = [];
  for (const packageName of RETAINED_NATIVE_PACKAGES) {
    const candidates = packages.filter(entry => entry.packageName === packageName && entry.status === 'ready' && entry.version);
    const versions = [...new Set(candidates.map(entry => entry.version!))].sort();
    if (versions.length < 2) continue;
    conflicts.push({
      packageName,
      versions,
      accounts: candidates.map(entry => ({ account: entry.account, version: entry.version!, packagePath: entry.packagePath })),
    });
    for (const candidate of candidates) candidate.conflict = true;
  }

  return { ok: packages.every(entry => entry.status === 'ready'), packages, conflicts };
}
