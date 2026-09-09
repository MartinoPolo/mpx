import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { MpxError, parseStrictJson } from '@mpx/core';
import { parseUserConfig, type UserConfig } from '@mpx/config';
import {
  USER_CONFIG_ARTIFACT_MAX_BYTES,
  installerDigest,
  parseInstallIntent,
  type InstallIntent,
} from './immutable-core.js';
import {
  createRuntimeRegistrationMatrix,
  type ProjectionRole,
  type RegisteredRuntime,
} from './runtime-registration.js';
import { createPiNativePackageRegistration } from './pi-native-package.js';
import type { CurrentReleaseBuilder } from './orchestration.js';

const MAX_REQUEST_ITEMS = 128;
const MAX_TEXT = 4_096;
export const INSTALL_EXECUTABLE_MAX_BYTES = 512 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PROJECTION_ROLES = new Set<ProjectionRole>([
  'plugin',
  'hooks',
  'profile',
  'status',
  'settings',
  'canonical-content',
  'agents',
  'licenses',
]);

function fail(message: string, code = 'INSTALL_SCHEMA_INVALID'): never {
  throw new MpxError({ code, message });
}
function exact(
  value: unknown,
  keys: readonly string[],
  label = 'protocol value',
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail(`${label} has unknown or missing fields.`);
  }
  return record;
}
function absolute(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TEXT ||
    (!path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)) ||
    /[\0\r\n]/u.test(value)
  ) {
    fail(`${label} must be an absolute bounded path.`);
  }
  return path.normalize(value);
}
function text(value: unknown, label: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > MAX_TEXT ||
    /[\0\r\n]/u.test(value)
  ) {
    fail(`${label} is invalid.`);
  }
  return value;
}
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    fail(`${label} must be a safe ID.`);
  }
  return value;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_REQUEST_ITEMS) {
    fail(`${label} exceeds array bounds.`);
  }
  return value;
}
function sortedUnique<T>(items: readonly T[], key: (item: T) => string, label: string): void {
  if (
    new Set(items.map(key)).size !== items.length ||
    items.some((item, index) => index > 0 && key(items[index - 1]!).localeCompare(key(item)) >= 0)
  ) {
    fail(`${label} must be unique and sorted.`);
  }
}
export interface InstallExecutableRequest {
  readonly path: string;
  readonly version: string;
}
export interface InstallProjectionRequest {
  readonly path: string;
  readonly role: ProjectionRole;
}
export interface InstallIntentRequest {
  readonly schemaVersion: 1;
  readonly kind: 'install-intent-request';
  readonly userConfigPath: string;
  readonly identities: { readonly personal: string; readonly work: string };
  readonly providers: { readonly personal: string; readonly work: string };
  readonly executables: {
    readonly claude: InstallExecutableRequest;
    readonly pi: InstallExecutableRequest;
  };
  readonly projections: {
    readonly claude: readonly InstallProjectionRequest[];
    readonly pi: readonly InstallProjectionRequest[];
  };
}

function parseSelection(value: unknown, label: string): { personal: string; work: string } {
  const item = exact(value, ['personal', 'work'], label);
  return { personal: id(item.personal, `${label}.personal`), work: id(item.work, `${label}.work`) };
}
function parseExecutable(value: unknown): InstallExecutableRequest {
  const item = exact(value, ['path', 'version'], 'executable request');
  return {
    path: absolute(item.path, 'Executable path'),
    version: text(item.version, 'Executable version'),
  };
}
function parseProjection(value: unknown, label: string): InstallProjectionRequest[] {
  const result = array(value, label).map((entry) => {
    const item = exact(entry, ['path', 'role'], 'projection item');
    const relative = text(item.path, 'Projection path');
    if (
      relative.includes('\\') ||
      path.posix.isAbsolute(relative) ||
      path.posix.normalize(relative) !== relative ||
      relative === '..' ||
      relative.startsWith('../')
    ) {
      fail('Projection path is unsafe.');
    }
    if (typeof item.role !== 'string' || !PROJECTION_ROLES.has(item.role as ProjectionRole)) {
      fail('Projection role is invalid.');
    }
    return { path: relative, role: item.role as ProjectionRole };
  });
  sortedUnique(result, (item) => item.path, label);
  return result;
}
export function parseInstallIntentRequest(value: unknown): InstallIntentRequest {
  const request = exact(
    value,
    [
      'schemaVersion',
      'kind',
      'userConfigPath',
      'identities',
      'providers',
      'executables',
      'projections',
    ],
    'Install intent request',
  );
  if (request.schemaVersion !== 1 || request.kind !== 'install-intent-request') {
    fail('Install intent request header is invalid.');
  }
  const executables = exact(request.executables, ['claude', 'pi'], 'Executables'),
    projections = exact(request.projections, ['claude', 'pi'], 'Projections');
  const parsed: InstallIntentRequest = {
    schemaVersion: 1,
    kind: 'install-intent-request',
    userConfigPath: absolute(request.userConfigPath, 'User config path'),
    identities: parseSelection(request.identities, 'Identity selections'),
    providers: parseSelection(request.providers, 'Provider selections'),
    executables: {
      claude: parseExecutable(executables.claude),
      pi: parseExecutable(executables.pi),
    },
    projections: {
      claude: parseProjection(projections.claude, 'Claude projections'),
      pi: parseProjection(projections.pi, 'Pi projections'),
    },
  };
  return parsed;
}

export interface InstallIntentBuildResult {
  readonly schemaVersion: 1;
  readonly kind: 'install-intent-build-result';
  readonly intent: InstallIntent;
}

export function parseInstallIntentBuildResult(value: unknown): InstallIntentBuildResult {
  const result = exact(value, ['schemaVersion', 'kind', 'intent'], 'Install intent build result');
  if (result.schemaVersion !== 1 || result.kind !== 'install-intent-build-result') {
    fail('Install intent build result header is invalid.');
  }
  const intent = parseInstallIntent(result.intent);
  return { schemaVersion: 1, kind: 'install-intent-build-result', intent };
}

async function regularFileEvidence(
  request: InstallExecutableRequest,
): Promise<{ path: string; sha256: string; version: string }> {
  const info = await lstat(request.path).catch(() =>
    fail('Executable is unavailable.', 'INSTALL_EXECUTABLE_INVALID'),
  );
  if (!info.isFile() || info.isSymbolicLink() || info.size > INSTALL_EXECUTABLE_MAX_BYTES) {
    fail(
      'Executable must be a regular non-symlink file of at most 512 MiB.',
      'INSTALL_EXECUTABLE_INVALID',
    );
  }
  return {
    path: request.path,
    sha256: createHash('sha256')
      .update(await readFile(request.path))
      .digest('hex'),
    version: request.version,
  };
}
function selectedIdentity(config: UserConfig, name: string, domain: 'personal' | 'work') {
  const identity = config.identities[name];
  if (!identity || identity.domain !== domain) {
    fail(
      `Selected ${domain} identity must exist in the exact configured domain.`,
      'INSTALL_IDENTITY_INVALID',
    );
  }
  const ssh = identity.sshRoute;
  if (!ssh) {
    fail(`Selected ${domain} identity requires an SSH route.`, 'INSTALL_ROUTE_REQUIRED');
  }
  return { identity, ssh };
}

export interface InstallIntentBuilderOptions {
  readonly releases: CurrentReleaseBuilder;
  readonly environment?: NodeJS.ProcessEnv;
}
export class InstallIntentBuilder {
  constructor(private readonly options: InstallIntentBuilderOptions) {}
  async build(value: InstallIntentRequest | unknown): Promise<InstallIntentBuildResult> {
    const request = parseInstallIntentRequest(value),
      info = await lstat(request.userConfigPath).catch(() =>
        fail('User configuration is unavailable.', 'INSTALL_USER_CONFIG_INVALID'),
      );
    if (!info.isFile() || info.isSymbolicLink() || info.size > USER_CONFIG_ARTIFACT_MAX_BYTES) {
      fail(
        'User configuration must be a regular file of at most 64 KiB.',
        'INSTALL_USER_CONFIG_INVALID',
      );
    }
    const raw = await readFile(request.userConfigPath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > USER_CONFIG_ARTIFACT_MAX_BYTES) {
      fail('User configuration exceeds 64 KiB.', 'INSTALL_USER_CONFIG_INVALID');
    }
    parseStrictJson(raw);
    const config = parseUserConfig(raw, this.options.environment ?? process.env),
      manifest = await this.options.releases.build();
    const [claudeExecutable, piExecutable] = await Promise.all([
      regularFileEvidence(request.executables.claude),
      regularFileEvidence(request.executables.pi),
    ]);
    const identities = {
      personal: selectedIdentity(config, request.identities.personal, 'personal'),
      work: selectedIdentity(config, request.identities.work, 'work'),
    };
    const projection = (runtime: RegisteredRuntime) => {
      const inventory = request.projections[runtime],
        files = inventory.map((item) => {
          const manifestFile = manifest.files.find((file) => file.path === item.path);
          if (!manifestFile) {
            fail(
              `Projection ${item.path} is absent from the current manifest.`,
              'INSTALL_PROJECTION_MISMATCH',
            );
          }
          return { ...manifestFile, role: item.role, owner: 'convergence' as const };
        });
      return {
        rootDigest: installerDigest(files),
        files,
        reader: 'canonical' as const,
        activation: 'argv-only' as const,
      };
    };
    const nativePackage = createPiNativePackageRegistration(manifest);
    const matrix = createRuntimeRegistrationMatrix(
      (['claude', 'pi'] as const).flatMap((runtime) =>
        (['personal', 'work'] as const).map((domain) => {
          const selected = identities[domain],
            provider = request.providers[domain],
            providerRoute = selected.identity.providerRoutes?.[provider];
          if (!providerRoute) {
            fail(
              `Selected ${domain} identity requires the selected provider route.`,
              'INSTALL_ROUTE_REQUIRED',
            );
          }
          const common = {
            domain,
            nativeRoot: selected.identity.runtimeRoots[runtime],
            executable: runtime === 'claude' ? claudeExecutable : piExecutable,
            projection: projection(runtime),
            routes: {
              git: `${domain}:${selected.identity.gitAuthorRoute}`,
              provider: `${domain}:${providerRoute}`,
              ssh: `${domain}:${selected.ssh}`,
              mcpSharing: 'isolated' as const,
            },
          };
          return runtime === 'pi'
            ? { ...common, runtime: 'pi' as const, nativePackage }
            : { ...common, runtime: 'claude' as const };
        }),
      ),
    );
    const intent = parseInstallIntent({
      schemaVersion: 1,
      kind: 'install-intent',
      releaseKey: manifest.releaseKey,
      convergenceHash: manifest.convergenceHash,
      components: ['cli', 'runtime-registrations', 'user-config'],
      userConfigArtifact: {
        target: '%APPDATA%/mpx/config.json',
        content: raw,
        sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
      },
      runtimeRegistrations: matrix,
    });
    return parseInstallIntentBuildResult({
      schemaVersion: 1,
      kind: 'install-intent-build-result',
      intent,
    });
  }
}
