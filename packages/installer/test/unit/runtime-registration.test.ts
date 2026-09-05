import { describe, expect, it } from 'vitest';
import {
  bindRuntimeMatrixToRelease,
  createRuntimeRegistrationMatrix,
  installerDigest,
  materializePrivateRuntimeLaunch,
  parseRuntimeRegistrationMatrixV1,
  parseRuntimeRegistrationReleaseV1,
  registerStaticMcp,
  verifyAccountEnrollment,
  verifyRuntimeRegistrationMatrix,
  type ImmutableProjectionV1,
  type ProjectionFileV1,
  type ProjectionRole,
  type RuntimeRegistrationInput,
} from '../../src/runtime-registration.js';
import { parsePiNativePackageRegistration } from '../../src/pi-native-package.js';

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

const sha = (value: string) => installerDigest(value);
const projection = (runtime: 'claude' | 'pi'): ImmutableProjectionV1 => {
  const roles: readonly ProjectionRole[] =
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
  const files: ProjectionFileV1[] = roles.map((role) => ({
    path: `${role}/owned`,
    sha256: sha(role),
    bytes: role.length,
    role,
    owner: 'convergence' as const,
  }));
  return {
    rootDigest: installerDigest(files),
    files,
    reader: 'canonical' as const,
    activation: 'argv-only' as const,
  };
};
const nativePackage = parsePiNativePackageRegistration({
  name: '@mpx/pi-extensions',
  packageRoot: 'runtimes/pi/extensions/dist/package',
  files: [
    { path: 'build-metadata.json', sha256: sha('metadata'), bytes: 1 },
    { path: 'index.mjs', sha256: sha('index'), bytes: 1 },
    { path: 'package.json', sha256: sha('package'), bytes: 1 },
  ],
  artifactRootDigest: installerDigest([
    { path: 'build-metadata.json', sha256: sha('metadata'), bytes: 1 },
    { path: 'index.mjs', sha256: sha('index'), bytes: 1 },
    { path: 'package.json', sha256: sha('package'), bytes: 1 },
  ]),
});
function input(
  runtime: 'claude',
  domain: 'personal' | 'work',
  root: string,
): Extract<RuntimeRegistrationInput, { runtime: 'claude' }>;
function input(
  runtime: 'pi',
  domain: 'personal' | 'work',
  root: string,
): Extract<RuntimeRegistrationInput, { runtime: 'pi' }>;
function input(
  runtime: 'claude' | 'pi',
  domain: 'personal' | 'work',
  root: string,
): RuntimeRegistrationInput {
  const common = {
    domain,
    nativeRoot: root,
    executable: { path: `C:\\_MP_apps\\${runtime}.exe`, sha256: sha(runtime), version: '1.0.0' },
    projection: projection(runtime),
    routes: {
      git: `${domain}:git`,
      provider: `${domain}:provider`,
      ssh: `${domain}:ssh`,
      mcpSharing: domain === 'work' ? ('isolated' as const) : ('shared' as const),
    },
  };
  return runtime === 'pi'
    ? { ...common, runtime: 'pi', nativePackage }
    : { ...common, runtime: 'claude' };
}

describe('immutable runtime registration', () => {
  it('creates exactly the four secret-free Claude/Pi personal/work registrations and rejects overlapping native roots', () => {
    const matrix = createRuntimeRegistrationMatrix([
      input('claude', 'personal', 'C:\\native\\claude-personal'),
      input('claude', 'work', 'C:\\native\\claude-work'),
      input('pi', 'personal', 'C:\\native\\pi-personal'),
      input('pi', 'work', 'C:\\native\\pi-work'),
    ]);
    expect(matrix.registrations.map((x) => x.identity)).toEqual([
      'claude-personal',
      'claude-work',
      'pi-personal',
      'pi-work',
    ]);
    expect(JSON.stringify(matrix)).not.toMatch(/C:\\\\native|auth|session|cache|trust/iu);
    expect(() =>
      createRuntimeRegistrationMatrix([
        input('claude', 'personal', 'C:\\native'),
        input('claude', 'work', 'C:\\native\\nested'),
        input('pi', 'personal', 'C:\\native\\pi-personal'),
        input('pi', 'work', 'C:\\native\\pi-work'),
      ]),
    ).toThrowError(/REGISTRATION_ROOT_OVERLAP/u);
    expect(() =>
      createRuntimeRegistrationMatrix([
        input('claude', 'personal', 'C:\\native\\claude-personal'),
        {
          ...input('claude', 'work', 'C:\\native\\claude-work'),
          executable: {
            path: 'C:\\_MP_apps\\different-claude.exe',
            sha256: sha('different-claude'),
            version: '1.0.0',
          },
        },
        input('pi', 'personal', 'C:\\native\\pi-personal'),
        input('pi', 'work', 'C:\\native\\pi-work'),
      ]),
    ).toThrowError(/REGISTRATION_EXECUTABLE_AMBIGUOUS/u);

    const changedFiles = nativePackage.files.map((file) =>
      file.path === 'index.mjs' ? { ...file, sha256: sha('different-package') } : file,
    );
    const changedPackage = parsePiNativePackageRegistration({
      ...nativePackage,
      files: changedFiles,
      artifactRootDigest: installerDigest(changedFiles),
    });
    expect(() =>
      createRuntimeRegistrationMatrix([
        input('claude', 'personal', 'C:\\native\\claude-personal'),
        input('claude', 'work', 'C:\\native\\claude-work'),
        input('pi', 'personal', 'C:\\native\\pi-personal'),
        { ...input('pi', 'work', 'C:\\native\\pi-work'), nativePackage: changedPackage },
      ]),
    ).toThrowError(/REGISTRATION_NATIVE_PACKAGE_AMBIGUOUS/u);
  });

  it('strictly parses installed registration contracts and refuses native state fields', () => {
    const matrix = createRuntimeRegistrationMatrix([
      input('claude', 'personal', 'C:\\native\\claude-personal'),
      input('claude', 'work', 'C:\\native\\claude-work'),
      input('pi', 'personal', 'C:\\native\\pi-personal'),
      input('pi', 'work', 'C:\\native\\pi-work'),
    ]);
    expect(parseRuntimeRegistrationMatrixV1(JSON.parse(JSON.stringify(matrix)))).toEqual(matrix);
    expect(() =>
      parseRuntimeRegistrationMatrixV1({ ...matrix, auth: { token: 'secret' } }),
    ).toThrowError(/REGISTRATION_SCHEMA_INVALID/u);

    const missingNativeBase = {
      schemaVersion: 1 as const,
      kind: 'runtime-registration-matrix' as const,
      registrations: matrix.registrations.map((item) => {
        if (item.runtime !== 'pi') {
          return item;
        }
        const { nativePackage: _nativePackage, ...without } = item;
        return without;
      }),
    };
    expect(() =>
      parseRuntimeRegistrationMatrixV1({
        ...missingNativeBase,
        matrixDigest: installerDigest(missingNativeBase),
      }),
    ).toThrowError(/REGISTRATION_SCHEMA_INVALID/u);

    const claudeNativeBase = {
      schemaVersion: 1 as const,
      kind: 'runtime-registration-matrix' as const,
      registrations: matrix.registrations.map((item) =>
        item.runtime === 'claude' ? { ...item, nativePackage } : item,
      ),
    };
    expect(() =>
      parseRuntimeRegistrationMatrixV1({
        ...claudeNativeBase,
        matrixDigest: installerDigest(claudeNativeBase),
      }),
    ).toThrowError(/REGISTRATION_SCHEMA_INVALID/u);
  });

  it('registers only bounded secret-free static MCP descriptors and materializes private launch bindings with native argv isolation', () => {
    const descriptor = registerStaticMcp({
      label: 'personal:github',
      executable: { path: 'C:\\_MP_apps\\mcp.exe', sha256: sha('mcp'), version: '1' },
      argv: ['--stdio'],
    });
    expect(descriptor).toEqual({
      schemaVersion: 1,
      kind: 'static-mcp-registration',
      label: 'personal:github',
      executable: { path: 'C:\\_MP_apps\\mcp.exe', sha256: sha('mcp'), version: '1' },
      argv: ['--stdio'],
    });
    expect(() =>
      registerStaticMcp({ ...descriptor, argv: Array.from({ length: 33 }, () => 'x') }),
    ).toThrowError(/MCP_ARGV_BOUNDS/u);
    const matrix = createRuntimeRegistrationMatrix([
      input('claude', 'personal', 'C:\\native\\claude-personal'),
      input('claude', 'work', 'C:\\native\\claude-work'),
      input('pi', 'personal', 'C:\\native\\pi-personal'),
      input('pi', 'work', 'C:\\native\\pi-work'),
    ]);
    const claude = materializePrivateRuntimeLaunch({
      registration: required(matrix.registrations[0], 'Claude personal registration'),
      launchKey: sha('launch'),
      nativeRoot: 'C:\\native\\claude-personal',
      projectionRoot: 'C:\\immutable\\claude',
      mcpBindings: [{ label: descriptor.label, privateConfigPath: 'C:\\private\\mcp.json' }],
    });
    const pi = materializePrivateRuntimeLaunch({
      registration: required(matrix.registrations[2], 'Pi personal registration'),
      launchKey: sha('pi-launch'),
      nativeRoot: 'C:\\native\\pi-personal',
      projectionRoot: 'C:\\immutable\\pi',
      mcpBindings: [],
    });
    expect(claude.argv.slice(0, 2)).toEqual(['--plugin-dir', 'C:\\immutable\\claude']);
    expect(pi.argv.slice(0, 4)).toEqual([
      '--no-extensions',
      '--extension',
      'C:\\immutable\\pi\\extension.js',
      '--no-skills',
    ]);
    expect(claude.privateFiles.map((file) => file.name)).toEqual([
      'launch-key.json',
      'route-bindings.json',
    ]);
    expect(JSON.stringify(descriptor)).not.toContain('C:\\private');
  });

  it('refuses credentials and environment material in static MCP argv', () => {
    expect(() =>
      registerStaticMcp({
        label: 'work:github',
        executable: { path: 'C:\\_MP_apps\\mcp.exe', sha256: sha('mcp'), version: '1' },
        argv: ['--token', 'secret'],
      }),
    ).toThrowError(/MCP_SECRET_FORBIDDEN/u);
    expect(() =>
      registerStaticMcp({
        label: 'work:github',
        executable: { path: 'C:\\_MP_apps\\mcp.exe', sha256: sha('mcp'), version: '1' },
        argv: ['API_KEY=value'],
      }),
    ).toThrowError(/MCP_SECRET_FORBIDDEN/u);
  });

  it('verifies synthetic clean/existing account enrollment across the full four-route matrix without credentials', () => {
    const matrix = createRuntimeRegistrationMatrix([
      input('claude', 'personal', 'C:\\native\\claude-personal'),
      input('claude', 'work', 'C:\\native\\claude-work'),
      input('pi', 'personal', 'C:\\native\\pi-personal'),
      input('pi', 'work', 'C:\\native\\pi-work'),
    ]);
    const enrolled = matrix.registrations.map((registration) => ({
      identity: registration.identity,
      runtime: registration.runtime,
      domain: registration.domain,
      nativeRootDigest: registration.nativeRootDigest,
      status: 'enrolled' as const,
      accountLabel: `${registration.domain}:account`,
    }));
    expect(verifyAccountEnrollment(matrix, enrolled)).toMatchObject({
      healthy: true,
      routes: [
        { identity: 'claude-personal', healthy: true },
        { identity: 'claude-work', healthy: true },
        { identity: 'pi-personal', healthy: true },
        { identity: 'pi-work', healthy: true },
      ],
    });
    expect(verifyAccountEnrollment(matrix, [])).toMatchObject({
      healthy: false,
      scenario: 'clean',
      issues: [
        'probe-missing:claude-personal',
        'probe-missing:claude-work',
        'probe-missing:pi-personal',
        'probe-missing:pi-work',
      ],
    });
    expect(JSON.stringify(enrolled)).not.toMatch(/token|credential|secret/iu);
  });

  it('verifies installed executable and synthetic projection evidence for every route', () => {
    const matrix = createRuntimeRegistrationMatrix([
      input('claude', 'personal', 'C:\\native\\claude-personal'),
      input('claude', 'work', 'C:\\native\\claude-work'),
      input('pi', 'personal', 'C:\\native\\pi-personal'),
      input('pi', 'work', 'C:\\native\\pi-work'),
    ]);
    const observed = matrix.registrations.map(({ identity, executable, projection }) => ({
      identity,
      executable,
      projection,
    }));
    expect(verifyRuntimeRegistrationMatrix(matrix, observed)).toMatchObject({
      healthy: true,
      issues: [],
    });
    const drifted = observed.map((entry) =>
      entry.identity === 'pi-work'
        ? { ...entry, projection: { ...entry.projection, rootDigest: sha('drift') } }
        : entry,
    );
    expect(verifyRuntimeRegistrationMatrix(matrix, drifted)).toMatchObject({
      healthy: false,
      issues: ['projection-drift:pi-work'],
    });
  });

  it('binds the release convergence hash to the exact four-route registration matrix', () => {
    const matrix = createRuntimeRegistrationMatrix([
      input('claude', 'personal', 'C:\\native\\claude-personal'),
      input('claude', 'work', 'C:\\native\\claude-work'),
      input('pi', 'personal', 'C:\\native\\pi-personal'),
      input('pi', 'work', 'C:\\native\\pi-work'),
    ]);
    const releaseFiles = nativePackage.files.map((file) => ({
      ...file,
      path: `${nativePackage.packageRoot}/${file.path}`,
    }));
    const convergenceHash = installerDigest(releaseFiles);
    const release = {
      schemaVersion: 1 as const,
      kind: 'release-manifest' as const,
      releaseKey: convergenceHash,
      convergenceHash,
      files: releaseFiles,
    };
    const binding = bindRuntimeMatrixToRelease(release, matrix);
    expect(parseRuntimeRegistrationReleaseV1(binding)).toEqual(binding);
    expect(() =>
      parseRuntimeRegistrationReleaseV1({ ...binding, registrationMatrixDigest: sha('other') }),
    ).toThrowError(/INSTALL_REGISTRATION_BINDING_INVALID/u);

    const alternateInventories = [
      nativePackage.files.map((file) =>
        file.path === 'index.mjs' ? { ...file, sha256: sha('alternate-index') } : file,
      ),
      [
        ...nativePackage.files,
        { path: 'runtime-helper.mjs', sha256: sha('absent-from-release'), bytes: 1 },
      ].sort((left, right) => left.path.localeCompare(right.path)),
    ];
    for (const alternateFiles of alternateInventories) {
      const alternatePackage = parsePiNativePackageRegistration({
        ...nativePackage,
        files: alternateFiles,
        artifactRootDigest: installerDigest(alternateFiles),
      });
      const alternateBase = {
        schemaVersion: matrix.schemaVersion,
        kind: matrix.kind,
        registrations: matrix.registrations.map((registration) =>
          registration.runtime === 'pi'
            ? { ...registration, nativePackage: alternatePackage }
            : registration,
        ),
      };
      const alternateMatrix = {
        ...alternateBase,
        matrixDigest: installerDigest(alternateBase),
      };
      expect(() => bindRuntimeMatrixToRelease(release, alternateMatrix)).toThrowError(
        expect.objectContaining({ code: 'REGISTRATION_NATIVE_PACKAGE_RELEASE_MISMATCH' }),
      );
    }
  });

  it('rejects projection inventory paths that are absolute or escape the immutable root', () => {
    const unsafe = input('pi', 'personal', 'C:\\native\\pi-personal');
    const files = unsafe.projection.files.map((file, index) =>
      index === 0 ? { ...file, path: '../outside' } : file,
    );
    expect(() =>
      createRuntimeRegistrationMatrix([
        input('claude', 'personal', 'C:\\native\\claude-personal'),
        input('claude', 'work', 'C:\\native\\claude-work'),
        {
          ...unsafe,
          projection: { ...unsafe.projection, files, rootDigest: installerDigest(files) },
        },
        input('pi', 'work', 'C:\\native\\pi-work'),
      ]),
    ).toThrowError(/REGISTRATION_PROJECTION_INVALID/u);
  });

  it('requires the complete convergence-owned synthetic projection and rejects native/static readers', () => {
    const incomplete = input('pi', 'personal', 'C:\\native\\pi-personal');
    const files = incomplete.projection.files.filter((file) => file.role !== 'themes');
    const altered = {
      ...incomplete,
      projection: { ...incomplete.projection, files, rootDigest: installerDigest(files) },
    };
    expect(() =>
      createRuntimeRegistrationMatrix([
        input('claude', 'personal', 'C:\\native\\claude-personal'),
        input('claude', 'work', 'C:\\native\\claude-work'),
        altered,
        input('pi', 'work', 'C:\\native\\pi-work'),
      ]),
    ).toThrowError(/REGISTRATION_PROJECTION_INCOMPLETE/u);
    const nativeCopy = input('claude', 'personal', 'C:\\native\\claude-personal');
    const copiedFiles = [
      ...nativeCopy.projection.files,
      {
        path: 'cache/native-plugin-copy',
        sha256: sha('copy'),
        bytes: 1,
        role: 'plugin' as const,
        owner: 'convergence' as const,
      },
    ];
    expect(() =>
      createRuntimeRegistrationMatrix([
        {
          ...nativeCopy,
          projection: {
            ...nativeCopy.projection,
            files: copiedFiles,
            rootDigest: installerDigest(copiedFiles),
          },
        },
        input('claude', 'work', 'C:\\native\\claude-work'),
        input('pi', 'personal', 'C:\\native\\pi-personal'),
        input('pi', 'work', 'C:\\native\\pi-work'),
      ]),
    ).toThrowError(/REGISTRATION_NATIVE_STATE_FORBIDDEN/u);
  });
});
