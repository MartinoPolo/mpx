import path from 'node:path';
import {
  installerDigest,
  parseReleaseManifestV1,
  type ReleaseManifestV1,
} from './immutable-core.js';
export { installerDigest } from './immutable-core.js';

const SHA256 = /^[a-f0-9]{64}$/u;
export type RuntimeIdentity = 'claude-personal' | 'claude-work' | 'pi-personal' | 'pi-work';
export type AccountDomain = 'personal' | 'work';
export type RegisteredRuntime = 'claude' | 'pi';
export type ProjectionRole =
  | 'plugin'
  | 'hooks'
  | 'extension'
  | 'profile'
  | 'keybindings'
  | 'themes'
  | 'status'
  | 'settings'
  | 'canonical-content'
  | 'agents'
  | 'licenses';
export interface ExecutableEvidenceV1 {
  readonly path: string;
  readonly sha256: string;
  readonly version: string;
}
export interface ProjectionFileV1 {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly role: ProjectionRole;
  readonly owner: 'convergence';
}
export interface ImmutableProjectionV1 {
  readonly rootDigest: string;
  readonly files: readonly ProjectionFileV1[];
  readonly reader: 'canonical';
  readonly activation: 'argv-only';
}
export interface RouteLabelsV1 {
  readonly git: string;
  readonly provider: string;
  readonly ssh: string;
  readonly mcpSharing: 'shared' | 'isolated';
}
export interface RuntimeRegistrationInput {
  readonly runtime: RegisteredRuntime;
  readonly domain: AccountDomain;
  readonly nativeRoot: string;
  readonly executable: ExecutableEvidenceV1;
  readonly projection: ImmutableProjectionV1;
  readonly routes: RouteLabelsV1;
}
export interface RuntimeRegistrationV1 {
  readonly schemaVersion: 1;
  readonly kind: 'runtime-registration';
  readonly identity: RuntimeIdentity;
  readonly runtime: RegisteredRuntime;
  readonly domain: AccountDomain;
  readonly nativeRootDigest: string;
  readonly executable: ExecutableEvidenceV1;
  readonly projection: ImmutableProjectionV1;
  readonly routes: RouteLabelsV1;
}
export interface RuntimeRegistrationMatrixV1 {
  readonly schemaVersion: 1;
  readonly kind: 'runtime-registration-matrix';
  readonly registrations: readonly RuntimeRegistrationV1[];
  readonly matrixDigest: string;
}

export class RuntimeRegistrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RuntimeRegistrationError';
  }
}
function fail(code: string, message: string): never {
  throw new RuntimeRegistrationError(code, message);
}
function absolute(value: string, label: string): string {
  if (!path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)) {
    fail('REGISTRATION_PATH_INVALID', `${label} must be absolute.`);
  }
  return path.win32.normalize(value);
}
function normalized(value: string): string {
  return path.win32
    .normalize(value)
    .replace(/[\\]+$/u, '')
    .toLowerCase();
}
function overlap(left: string, right: string): boolean {
  const a = normalized(left),
    b = normalized(right);
  return a === b || a.startsWith(`${b}\\`) || b.startsWith(`${a}\\`);
}
function executable(value: ExecutableEvidenceV1): ExecutableEvidenceV1 {
  const location = absolute(value.path, 'Executable path');
  if (!SHA256.test(value.sha256) || !value.version.trim()) {
    fail('REGISTRATION_EXECUTABLE_INVALID', 'Executable evidence requires hash and version.');
  }
  return { path: location, sha256: value.sha256, version: value.version };
}
function projection(
  value: ImmutableProjectionV1,
  runtime: RegisteredRuntime,
): ImmutableProjectionV1 {
  if (
    value.reader !== 'canonical' ||
    value.activation !== 'argv-only' ||
    !SHA256.test(value.rootDigest) ||
    value.files.length === 0
  ) {
    fail(
      'REGISTRATION_PROJECTION_INVALID',
      'Projection must use one canonical reader and argv-only activation.',
    );
  }
  const files = value.files.map((file) => ({ ...file }));
  if (
    new Set(files.map((file) => file.path.toLowerCase())).size !== files.length ||
    files.some(
      (file) =>
        file.owner !== 'convergence' ||
        !SHA256.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        !file.path ||
        file.path.includes('\\') ||
        path.posix.isAbsolute(file.path) ||
        path.posix.normalize(file.path) !== file.path ||
        file.path === '..' ||
        file.path.startsWith('../'),
    )
  ) {
    fail('REGISTRATION_PROJECTION_INVALID', 'Projection inventory is invalid.');
  }
  if (
    files.some((file) =>
      /(^|[\\/.-])(auth|credentials?|sessions?|cache|trust|native-plugin-copy|native-extension-copy)([\\/.-]|$)/iu.test(
        file.path,
      ),
    )
  ) {
    fail(
      'REGISTRATION_NATIVE_STATE_FORBIDDEN',
      'Native auth, session, cache, trust, plugin, and extension state cannot be projected.',
    );
  }
  const required: ProjectionRole[] =
    runtime === 'claude'
      ? ['plugin', 'hooks', 'status', 'settings', 'canonical-content', 'agents', 'licenses']
      : [
          'extension',
          'profile',
          'keybindings',
          'themes',
          'status',
          'settings',
          'canonical-content',
          'agents',
          'licenses',
        ];
  const roles = new Set(files.map((file) => file.role));
  if (required.some((role) => !roles.has(role))) {
    fail('REGISTRATION_PROJECTION_INCOMPLETE', `The ${runtime} projection is incomplete.`);
  }
  if (installerDigest(files) !== value.rootDigest) {
    fail('REGISTRATION_PROJECTION_INVALID', 'Projection root digest changed.');
  }
  return { rootDigest: value.rootDigest, files, reader: 'canonical', activation: 'argv-only' };
}
function routes(value: RouteLabelsV1, domain: AccountDomain): RouteLabelsV1 {
  for (const label of [value.git, value.provider, value.ssh]) {
    if (!label.startsWith(`${domain}:`) || label.length > 128) {
      fail('REGISTRATION_CROSS_DOMAIN', 'Route label crosses its account domain.');
    }
  }
  return { ...value };
}

function exactRegistrationRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('REGISTRATION_SCHEMA_INVALID', 'Registration contract must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail('REGISTRATION_SCHEMA_INVALID', 'Registration contract has unknown or missing fields.');
  }
  return record;
}

export function createRuntimeRegistrationMatrix(
  inputs: readonly RuntimeRegistrationInput[],
): RuntimeRegistrationMatrixV1 {
  if (inputs.length !== 4) {
    fail('REGISTRATION_MATRIX_INCOMPLETE', 'Exactly four runtime identities are required.');
  }
  const roots = inputs.map((input) => absolute(input.nativeRoot, 'Native account root'));
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (overlap(roots[left]!, roots[right]!)) {
        fail(
          'REGISTRATION_ROOT_OVERLAP',
          'Native account roots must be distinct and non-overlapping.',
        );
      }
    }
  }
  const registrations = inputs
    .map((input): RuntimeRegistrationV1 => {
      const identity = `${input.runtime}-${input.domain}` as RuntimeIdentity;
      return {
        schemaVersion: 1,
        kind: 'runtime-registration',
        identity,
        runtime: input.runtime,
        domain: input.domain,
        nativeRootDigest: installerDigest(normalized(input.nativeRoot)),
        executable: executable(input.executable),
        projection: projection(input.projection, input.runtime),
        routes: routes(input.routes, input.domain),
      };
    })
    .sort((left, right) => left.identity.localeCompare(right.identity));
  const expected: RuntimeIdentity[] = ['claude-personal', 'claude-work', 'pi-personal', 'pi-work'];
  if (registrations.some((entry, index) => entry.identity !== expected[index])) {
    fail('REGISTRATION_MATRIX_DUPLICATE', 'The complete unique four-route matrix is required.');
  }
  const base = {
    schemaVersion: 1 as const,
    kind: 'runtime-registration-matrix' as const,
    registrations,
  };
  return { ...base, matrixDigest: installerDigest(base) };
}

export function parseRuntimeRegistrationMatrixV1(value: unknown): RuntimeRegistrationMatrixV1 {
  const matrix = exactRegistrationRecord(value, [
    'schemaVersion',
    'kind',
    'registrations',
    'matrixDigest',
  ]);
  if (
    matrix.schemaVersion !== 1 ||
    matrix.kind !== 'runtime-registration-matrix' ||
    !Array.isArray(matrix.registrations) ||
    typeof matrix.matrixDigest !== 'string' ||
    !SHA256.test(matrix.matrixDigest)
  ) {
    fail('REGISTRATION_SCHEMA_INVALID', 'Registration matrix header is invalid.');
  }
  const registrations = matrix.registrations.map((item): RuntimeRegistrationV1 => {
    const registration = exactRegistrationRecord(item, [
      'schemaVersion',
      'kind',
      'identity',
      'runtime',
      'domain',
      'nativeRootDigest',
      'executable',
      'projection',
      'routes',
    ]);
    if (
      registration.schemaVersion !== 1 ||
      registration.kind !== 'runtime-registration' ||
      (registration.runtime !== 'claude' && registration.runtime !== 'pi') ||
      (registration.domain !== 'personal' && registration.domain !== 'work') ||
      registration.identity !== `${registration.runtime}-${registration.domain}` ||
      typeof registration.nativeRootDigest !== 'string' ||
      !SHA256.test(registration.nativeRootDigest)
    ) {
      fail('REGISTRATION_SCHEMA_INVALID', 'Runtime registration identity is invalid.');
    }
    const executableRecord = exactRegistrationRecord(registration.executable, [
      'path',
      'sha256',
      'version',
    ]);
    const projectionRecord = exactRegistrationRecord(registration.projection, [
      'rootDigest',
      'files',
      'reader',
      'activation',
    ]);
    if (!Array.isArray(projectionRecord.files)) {
      fail('REGISTRATION_SCHEMA_INVALID', 'Projection files are invalid.');
    }
    for (const file of projectionRecord.files) {
      exactRegistrationRecord(file, ['path', 'sha256', 'bytes', 'role', 'owner']);
    }
    const routeRecord = exactRegistrationRecord(registration.routes, [
      'git',
      'provider',
      'ssh',
      'mcpSharing',
    ]);
    return {
      schemaVersion: 1,
      kind: 'runtime-registration',
      identity: registration.identity as RuntimeIdentity,
      runtime: registration.runtime,
      domain: registration.domain,
      nativeRootDigest: registration.nativeRootDigest,
      executable: executable(executableRecord as unknown as ExecutableEvidenceV1),
      projection: projection(
        projectionRecord as unknown as ImmutableProjectionV1,
        registration.runtime,
      ),
      routes: routes(routeRecord as unknown as RouteLabelsV1, registration.domain),
    };
  });
  const expected: RuntimeIdentity[] = ['claude-personal', 'claude-work', 'pi-personal', 'pi-work'];
  if (
    registrations.length !== 4 ||
    registrations.some((entry, index) => entry.identity !== expected[index])
  ) {
    fail('REGISTRATION_SCHEMA_INVALID', 'Registration matrix is incomplete or unordered.');
  }
  const base = {
    schemaVersion: 1 as const,
    kind: 'runtime-registration-matrix' as const,
    registrations,
  };
  if (installerDigest(base) !== matrix.matrixDigest) {
    fail('REGISTRATION_SCHEMA_INVALID', 'Registration matrix digest changed.');
  }
  return { ...base, matrixDigest: matrix.matrixDigest };
}

export interface RuntimeRegistrationObservationV1 {
  readonly identity: RuntimeIdentity;
  readonly executable: ExecutableEvidenceV1;
  readonly projection: ImmutableProjectionV1;
}
export interface RuntimeRegistrationVerificationV1 {
  readonly schemaVersion: 1;
  readonly kind: 'runtime-registration-verification';
  readonly healthy: boolean;
  readonly issues: readonly string[];
}
export function verifyRuntimeRegistrationMatrix(
  matrix: RuntimeRegistrationMatrixV1,
  observations: readonly RuntimeRegistrationObservationV1[],
): RuntimeRegistrationVerificationV1 {
  const observed = new Map<RuntimeIdentity, RuntimeRegistrationObservationV1>();
  const issues: string[] = [];
  for (const value of observations) {
    if (observed.has(value.identity)) {
      issues.push(`observation-duplicate:${value.identity}`);
    } else {
      observed.set(value.identity, value);
    }
  }
  for (const registration of matrix.registrations) {
    const actual = observed.get(registration.identity);
    if (!actual) {
      issues.push(`observation-missing:${registration.identity}`);
      continue;
    }
    if (installerDigest(actual.executable) !== installerDigest(registration.executable)) {
      issues.push(`executable-drift:${registration.identity}`);
    }
    if (
      actual.projection.rootDigest !== registration.projection.rootDigest ||
      installerDigest(actual.projection.files) !== installerDigest(registration.projection.files) ||
      actual.projection.reader !== 'canonical' ||
      actual.projection.activation !== 'argv-only'
    ) {
      issues.push(`projection-drift:${registration.identity}`);
    }
    observed.delete(registration.identity);
  }
  for (const identity of [...observed.keys()].sort()) {
    issues.push(`observation-unregistered:${identity}`);
  }
  return {
    schemaVersion: 1,
    kind: 'runtime-registration-verification',
    healthy: issues.length === 0,
    issues,
  };
}

export interface RuntimeRegistrationReleaseV1 {
  readonly schemaVersion: 1;
  readonly kind: 'runtime-registration-release';
  readonly releaseKey: string;
  readonly convergenceHash: string;
  readonly registrationMatrixDigest: string;
  readonly bindingDigest: string;
}
export function bindRuntimeMatrixToRelease(
  releaseValue: ReleaseManifestV1,
  matrix: RuntimeRegistrationMatrixV1,
): RuntimeRegistrationReleaseV1 {
  const release = parseReleaseManifestV1(releaseValue);
  const base = {
    schemaVersion: 1 as const,
    kind: 'runtime-registration-release' as const,
    releaseKey: release.releaseKey,
    convergenceHash: release.convergenceHash,
    registrationMatrixDigest: matrix.matrixDigest,
  };
  return { ...base, bindingDigest: installerDigest(base) };
}
export function parseRuntimeRegistrationReleaseV1(value: unknown): RuntimeRegistrationReleaseV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INSTALL_REGISTRATION_BINDING_INVALID', 'Registration release binding must be an object.');
  }
  const record = value as Record<string, unknown>,
    keys = [
      'schemaVersion',
      'kind',
      'releaseKey',
      'convergenceHash',
      'registrationMatrixDigest',
      'bindingDigest',
    ];
  if (
    Object.keys(record).sort().join('\0') !== keys.sort().join('\0') ||
    record.schemaVersion !== 1 ||
    record.kind !== 'runtime-registration-release' ||
    ![
      record.releaseKey,
      record.convergenceHash,
      record.registrationMatrixDigest,
      record.bindingDigest,
    ].every((item) => typeof item === 'string' && SHA256.test(item))
  ) {
    fail('INSTALL_REGISTRATION_BINDING_INVALID', 'Registration release binding is invalid.');
  }
  const parsed = record as unknown as RuntimeRegistrationReleaseV1;
  const base = {
    schemaVersion: parsed.schemaVersion,
    kind: parsed.kind,
    releaseKey: parsed.releaseKey,
    convergenceHash: parsed.convergenceHash,
    registrationMatrixDigest: parsed.registrationMatrixDigest,
  };
  if (installerDigest(base) !== parsed.bindingDigest) {
    fail('INSTALL_REGISTRATION_BINDING_INVALID', 'Registration release binding digest changed.');
  }
  return { ...parsed };
}

export interface AccountProbeV1 {
  readonly identity: RuntimeIdentity;
  readonly runtime: RegisteredRuntime;
  readonly domain: AccountDomain;
  readonly nativeRootDigest: string;
  readonly status: 'enrolled' | 'unenrolled' | 'unavailable';
  readonly accountLabel: string;
}
export interface EnrollmentRouteVerificationV1 {
  readonly identity: RuntimeIdentity;
  readonly healthy: boolean;
  readonly issues: readonly string[];
}
export interface AccountEnrollmentVerificationV1 {
  readonly schemaVersion: 1;
  readonly kind: 'account-enrollment-verification';
  readonly scenario: 'clean' | 'existing';
  readonly healthy: boolean;
  readonly routes: readonly EnrollmentRouteVerificationV1[];
  readonly issues: readonly string[];
}
export function verifyAccountEnrollment(
  matrix: RuntimeRegistrationMatrixV1,
  probes: readonly AccountProbeV1[],
): AccountEnrollmentVerificationV1 {
  const byIdentity = new Map<RuntimeIdentity, AccountProbeV1>();
  for (const probe of probes) {
    if (byIdentity.has(probe.identity)) {
      fail('ACCOUNT_PROBE_DUPLICATE', 'Account probes must be unique.');
    }
    byIdentity.set(probe.identity, probe);
  }
  const routes = matrix.registrations.map((registration): EnrollmentRouteVerificationV1 => {
    const probe = byIdentity.get(registration.identity);
    const issues: string[] = [];
    if (!probe) {
      issues.push(`probe-missing:${registration.identity}`);
    } else {
      if (
        probe.runtime !== registration.runtime ||
        probe.domain !== registration.domain ||
        probe.nativeRootDigest !== registration.nativeRootDigest
      ) {
        issues.push(`probe-binding-mismatch:${registration.identity}`);
      }
      if (probe.status !== 'enrolled') {
        issues.push(`account-not-enrolled:${registration.identity}`);
      }
      if (!probe.accountLabel.startsWith(`${registration.domain}:`)) {
        issues.push(`account-cross-domain:${registration.identity}`);
      }
    }
    return { identity: registration.identity, healthy: issues.length === 0, issues };
  });
  const issues = routes.flatMap((route) => route.issues);
  return {
    schemaVersion: 1,
    kind: 'account-enrollment-verification',
    scenario: probes.length === 0 ? 'clean' : 'existing',
    healthy: issues.length === 0,
    routes,
    issues,
  };
}

export interface StaticMcpRegistrationV1 {
  readonly schemaVersion: 1;
  readonly kind: 'static-mcp-registration';
  readonly label: string;
  readonly executable: ExecutableEvidenceV1;
  readonly argv: readonly string[];
}
export function registerStaticMcp(input: {
  readonly label: string;
  readonly executable: ExecutableEvidenceV1;
  readonly argv: readonly string[];
}): StaticMcpRegistrationV1 {
  if (!/^(personal|work):[a-z0-9][a-z0-9.-]{0,63}$/u.test(input.label)) {
    fail('MCP_LABEL_INVALID', 'MCP label must include its account domain.');
  }
  if (
    input.argv.length > 32 ||
    input.argv.some(
      (argument) => !argument || argument.length > 1_024 || /[\u0000\r\n]/u.test(argument),
    )
  ) {
    fail('MCP_ARGV_BOUNDS', 'MCP argv exceeds static registration bounds.');
  }
  if (
    input.argv.some(
      (argument) =>
        /^(?:--?)(?:api[-_]?key|auth|credential|password|secret|token)(?:=|$)/iu.test(argument) ||
        /^(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)=/u.test(argument),
    )
  ) {
    fail(
      'MCP_SECRET_FORBIDDEN',
      'Static MCP argv cannot contain credentials or environment material.',
    );
  }
  return {
    schemaVersion: 1,
    kind: 'static-mcp-registration',
    label: input.label,
    executable: executable(input.executable),
    argv: [...input.argv],
  };
}
export function parseStaticMcpRegistrationV1(value: unknown): StaticMcpRegistrationV1 {
  const record = exactRegistrationRecord(value, [
    'schemaVersion',
    'kind',
    'label',
    'executable',
    'argv',
  ]);
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'static-mcp-registration' ||
    !Array.isArray(record.argv) ||
    record.argv.some((argument) => typeof argument !== 'string')
  ) {
    fail('REGISTRATION_SCHEMA_INVALID', 'Static MCP registration is invalid.');
  }
  const executableRecord = exactRegistrationRecord(record.executable, [
    'path',
    'sha256',
    'version',
  ]);
  return registerStaticMcp({
    label: record.label as string,
    executable: executableRecord as unknown as ExecutableEvidenceV1,
    argv: record.argv as string[],
  });
}
export interface PrivateLaunchFile {
  readonly name: 'launch-key.json' | 'route-bindings.json';
  readonly content: string;
}
export interface PrivateRuntimeLaunch {
  readonly executable: ExecutableEvidenceV1;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly privateFiles: readonly PrivateLaunchFile[];
}
export function materializePrivateRuntimeLaunch(input: {
  readonly registration: RuntimeRegistrationV1;
  readonly launchKey: string;
  readonly nativeRoot: string;
  readonly projectionRoot: string;
  readonly mcpBindings: readonly { readonly label: string; readonly privateConfigPath: string }[];
}): PrivateRuntimeLaunch {
  if (!SHA256.test(input.launchKey)) {
    fail('LAUNCH_KEY_INVALID', 'Launch key must be immutable.');
  }
  const nativeRoot = absolute(input.nativeRoot, 'Private native account root'),
    projectionRoot = absolute(input.projectionRoot, 'Immutable projection root');
  if (installerDigest(normalized(nativeRoot)) !== input.registration.nativeRootDigest) {
    fail('REGISTRATION_ROOT_MISMATCH', 'Private native root does not match the registration.');
  }
  if (
    input.mcpBindings.length > 32 ||
    new Set(input.mcpBindings.map((binding) => binding.label)).size !== input.mcpBindings.length ||
    input.mcpBindings.some((binding) => !binding.label.startsWith(`${input.registration.domain}:`))
  ) {
    fail('REGISTRATION_CROSS_DOMAIN', 'MCP binding crosses its account domain.');
  }
  const bindings = input.mcpBindings
    .map((binding) => ({
      label: binding.label,
      privateConfigPath: absolute(binding.privateConfigPath, 'Private MCP binding'),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const privateFiles: PrivateLaunchFile[] = [
    {
      name: 'launch-key.json',
      content: JSON.stringify({
        schemaVersion: 1,
        launchKey: input.launchKey,
        identity: input.registration.identity,
        registrationDigest: installerDigest(input.registration),
      }),
    },
    {
      name: 'route-bindings.json',
      content: JSON.stringify({
        schemaVersion: 1,
        nativeRoot,
        routes: input.registration.routes,
        mcpBindings: bindings,
      }),
    },
  ];
  if (input.registration.runtime === 'claude') {
    return {
      executable: input.registration.executable,
      argv: [
        '--plugin-dir',
        projectionRoot,
        ...bindings.flatMap((binding) => ['--mcp-config', binding.privateConfigPath]),
        ...(bindings.length ? ['--strict-mcp-config'] : []),
      ],
      environment: { CLAUDE_CONFIG_DIR: nativeRoot, MPX_LAUNCH_KEY: input.launchKey },
      privateFiles,
    };
  }
  return {
    executable: input.registration.executable,
    argv: [
      '--no-extensions',
      '--extension',
      path.win32.join(projectionRoot, 'extension.js'),
      '--no-skills',
    ],
    environment: { PI_CODING_AGENT_DIR: nativeRoot, MPX_LAUNCH_KEY: input.launchKey },
    privateFiles,
  };
}
