import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PI_NATIVE_PACKAGE_NAME,
  PI_NATIVE_PACKAGE_ROOT,
  createPiNativePackageRegistration,
  installerDigest,
  invertPiNativePackageSettings,
  parsePiNativePackageRegistration,
  parsePiSettings,
  planPiNativePackageSettings,
  resolvePiNativePackageSource,
  type ReleaseFileV1,
} from '../../src/index.js';

const sha = (value: string) => installerDigest(value);
const files = (paths: readonly string[]): ReleaseFileV1[] =>
  paths.map((file, index) => ({
    path: `${PI_NATIVE_PACKAGE_ROOT}/${file}`,
    sha256: sha(file),
    bytes: index + 1,
  }));
const registration = () =>
  createPiNativePackageRegistration({
    schemaVersion: 1,
    kind: 'release-manifest',
    releaseKey: installerDigest(files(['build-metadata.json', 'mpx-extension.mjs', 'package.json'])),
    convergenceHash: installerDigest(files(['build-metadata.json', 'mpx-extension.mjs', 'package.json'])),
    files: files(['build-metadata.json', 'mpx-extension.mjs', 'package.json']),
  });

describe('Pi native package registration', () => {
  it('binds the exact package identity and release-relative inventory', () => {
    const result = registration();
    expect(result).toEqual({
      name: PI_NATIVE_PACKAGE_NAME,
      packageRoot: PI_NATIVE_PACKAGE_ROOT,
      artifactRootDigest: installerDigest(result.files),
      files: [
        { path: 'build-metadata.json', sha256: sha('build-metadata.json'), bytes: 1 },
        { path: 'mpx-extension.mjs', sha256: sha('mpx-extension.mjs'), bytes: 2 },
        { path: 'package.json', sha256: sha('package.json'), bytes: 3 },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/[A-Z]:\\|releaseRoot|nativeRoot/u);
  });

  it.each([
    '.',
    '..',
    '../escape',
    'a/../escape',
    'a//file.js',
    'C:/rooted.js',
    'C:\\rooted.js',
    '\\\\server\\share\\file.js',
    '/rooted.js',
    'directory/',
    'nul\0file.js',
    'a.js',
    'node_modules/x.js',
    'mpx-extension.mjs.map',
    'package-lock.json',
    'cache/token',
  ])('rejects an unsafe or forbidden inventory path with the stable code: %s', (bad) => {
    const base = registration();
    const changed = (
      bad === 'a.js'
        ? [
            ...base.files,
            { path: 'A.js', sha256: sha('A'), bytes: 1 },
            { path: bad, sha256: sha(bad), bytes: 1 },
          ]
        : [...base.files, { path: bad, sha256: sha(bad), bytes: 1 }]
    ).sort((left, right) => left.path.localeCompare(right.path));
    expect(() =>
      parsePiNativePackageRegistration({
        ...base,
        files: changed,
        artifactRootDigest: installerDigest(changed),
      }),
    ).toThrowError(expect.objectContaining({ code: 'PI_NATIVE_INVENTORY_INVALID' }));
  });

  it('resolves only the registered package root below an absolute release root', () => {
    expect(resolvePiNativePackageSource('C:\\MPX\\releases\\release', PI_NATIVE_PACKAGE_ROOT)).toBe(
      'C:\\MPX\\releases\\release\\runtimes\\pi\\extensions\\dist\\package',
    );
    for (const [root, packageRoot] of [
      ['relative', PI_NATIVE_PACKAGE_ROOT],
      ['C:\\MPX\\releases\\release', '../escape'],
    ] as const) {
      expect(() => resolvePiNativePackageSource(root, packageRoot)).toThrowError(
        expect.objectContaining({ code: 'PI_SETTINGS_PATH_INVALID' }),
      );
    }
  });

  it('fails closed when required package artifacts are absent', () => {
    const base = registration();
    for (const required of ['package.json', 'build-metadata.json', 'mpx-extension.mjs']) {
      const changed = base.files.filter((item) => item.path !== required);
      expect(() =>
        parsePiNativePackageRegistration({
          ...base,
          files: changed,
          artifactRootDigest: installerDigest(changed),
        }),
      ).toThrow();
    }
  });
});

describe('Pi settings package merge (domain-only checkpoint; production settings unchanged)', () => {
  const releaseRoot = 'C:\\MPX\\releases\\' + 'a'.repeat(64);
  const desired = path.win32.join(releaseRoot, ...PI_NATIVE_PACKAGE_ROOT.split('/'));

  it('parses absent settings as empty and rejects malformed settings shapes', () => {
    expect(parsePiSettings(undefined)).toEqual({});
    for (const malformed of [null, [], 'bad', { packages: {} }]) {
      expect(() => parsePiSettings(malformed)).toThrow();
    }
  });

  it('preserves unrelated entries and replaces only explicitly owned paths at the first position', () => {
    const foreign = { source: '@mpx/pi-extensions', enabled: false };
    const namedForeign = 'C:\\foreign\\runtimes\\pi\\extensions\\dist\\package';
    const old = 'C:\\MPX\\releases\\old\\runtimes\\pi\\extensions\\dist\\package';
    const settings = {
      secret: 'untouched',
      packages: ['foreign', old, foreign, old, namedForeign, 'tail'],
    };
    const plan = planPiNativePackageSettings({
      settings,
      releaseRoot,
      desiredSource: desired,
      nativePackage: registration(),
      priorOwnedSources: [old],
    });
    expect(plan.settings).toEqual({
      secret: 'untouched',
      packages: ['foreign', desired, foreign, namedForeign, 'tail'],
    });
    expect(plan.packagesBefore).toEqual(settings.packages);
    expect(plan.packagesAfter).toEqual(['foreign', desired, foreign, namedForeign, 'tail']);
    expect(
      invertPiNativePackageSettings({
        settings: plan.settings,
        plan,
        priorOwnedSources: [old],
      }).settings.packages,
    ).toEqual(settings.packages);
  });

  it('restores an exact old-release owned path and retains an unrelated concurrent entry', () => {
    const oldReleaseRoot = `C:\\MPX\\releases\\${'b'.repeat(64)}`;
    const oldSource = path.win32.join(oldReleaseRoot, ...PI_NATIVE_PACKAGE_ROOT.split('/'));
    const upgrade = planPiNativePackageSettings({
      settings: { packages: ['foreign', oldSource] },
      releaseRoot,
      desiredSource: desired,
      nativePackage: registration(),
      priorOwnedSources: [oldSource],
    });
    expect(upgrade.packagesAfter).toEqual(['foreign', desired]);
    expect(upgrade.priorOwnedEntries).toEqual([
      { source: oldSource, packagesBeforeIndex: 1, unownedBefore: 1 },
    ]);
    const { planDigest, ...boundPlan } = upgrade;
    expect(planDigest).toBe(installerDigest(boundPlan));

    const concurrent = { source: 'concurrent-unrelated' };
    const rolledBack = invertPiNativePackageSettings({
      settings: {
        ...upgrade.settings,
        packages: [...(upgrade.settings.packages as unknown[]), concurrent],
      },
      plan: upgrade,
      priorOwnedSources: [oldSource],
    });
    expect(rolledBack.settings.packages).toEqual(['foreign', oldSource, concurrent]);
  });

  it('supports first install and repeat planning', () => {
    const first = planPiNativePackageSettings({
      settings: { packages: ['foreign'] },
      releaseRoot,
      desiredSource: desired,
      nativePackage: registration(),
      priorOwnedSources: [],
    });
    expect(first.packagesAfter).toEqual(['foreign', desired]);
    const repeat = planPiNativePackageSettings({
      settings: first.settings,
      releaseRoot,
      desiredSource: desired,
      nativePackage: registration(),
      priorOwnedSources: [desired],
    });
    expect(repeat.packagesAfter).toEqual(['foreign', desired]);
    expect(
      invertPiNativePackageSettings({
        settings: repeat.settings,
        plan: repeat,
        priorOwnedSources: [],
      }).settings,
    ).toEqual(first.settings);
  });

  it.each([
    { candidateReleaseRoot: releaseRoot, candidateDesired: `${desired}-fake` },
    {
      candidateReleaseRoot: releaseRoot,
      candidateDesired: PI_NATIVE_PACKAGE_ROOT,
    },
    {
      candidateReleaseRoot: releaseRoot,
      candidateDesired: `/MPX/releases/${'a'.repeat(64)}/${PI_NATIVE_PACKAGE_ROOT}`,
    },
    {
      candidateReleaseRoot: `/MPX/releases/${'a'.repeat(64)}`,
      candidateDesired: desired,
    },
    {
      candidateReleaseRoot: `MPX/releases/${'a'.repeat(64)}`,
      candidateDesired: `MPX/releases/${'a'.repeat(64)}/${PI_NATIVE_PACKAGE_ROOT}`,
    },
  ])(
    'rejects fake, relative, or mixed-style desired package paths with the stable code',
    ({ candidateReleaseRoot, candidateDesired }) => {
      expect(() =>
        planPiNativePackageSettings({
          settings: {},
          releaseRoot: candidateReleaseRoot,
          desiredSource: candidateDesired,
          nativePackage: registration(),
          priorOwnedSources: [],
        }),
      ).toThrowError(expect.objectContaining({ code: 'PI_SETTINGS_PATH_INVALID' }));
    },
  );

  it('rejects ambiguous applied-entry drift', () => {
    const plan = planPiNativePackageSettings({
      settings: {},
      releaseRoot,
      desiredSource: desired,
      nativePackage: registration(),
      priorOwnedSources: [],
    });
    expect(() =>
      invertPiNativePackageSettings({
        settings: { packages: [] },
        plan,
        priorOwnedSources: [],
      }),
    ).toThrow();
    expect(() =>
      invertPiNativePackageSettings({
        settings: { packages: [desired, desired] },
        plan,
        priorOwnedSources: [],
      }),
    ).toThrow();
    const anchored = planPiNativePackageSettings({
      settings: { packages: ['foreign'] },
      releaseRoot,
      desiredSource: desired,
      nativePackage: registration(),
      priorOwnedSources: [],
    });
    expect(() =>
      invertPiNativePackageSettings({
        settings: { packages: [desired, 'foreign'] },
        plan: anchored,
        priorOwnedSources: [],
      }),
    ).toThrow();
  });

  it('strictly parses rollback plans and rejects corrupt or forged ownership evidence', () => {
    const oldSource = `C:\\MPX\\releases\\old\\${PI_NATIVE_PACKAGE_ROOT.replaceAll('/', '\\')}`;
    const plan = planPiNativePackageSettings({
      settings: { packages: ['foreign', oldSource] },
      releaseRoot,
      desiredSource: desired,
      nativePackage: registration(),
      priorOwnedSources: [oldSource],
    });
    for (const malformed of [
      null,
      { ...plan, priorOwnedEntries: null },
      { ...plan, priorOwnedEntries: [null] },
      { ...plan, unexpected: true },
    ]) {
      expect(() =>
        invertPiNativePackageSettings({
          settings: plan.settings,
          plan: malformed,
          priorOwnedSources: [oldSource],
        }),
      ).toThrowError(expect.objectContaining({ code: 'PI_SETTINGS_SCHEMA_INVALID' }));
    }
    expect(() =>
      invertPiNativePackageSettings({
        settings: plan.settings,
        plan: { ...plan, planDigest: '0'.repeat(64) },
        priorOwnedSources: [oldSource],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PI_SETTINGS_DRIFT' }));
    expect(() =>
      invertPiNativePackageSettings({
        settings: plan.settings,
        plan,
        priorOwnedSources: ['relative/prior/source'],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PI_SETTINGS_OWNERSHIP_INVALID' }));

    const foreignSource = 'C:\\foreign\\releases\\forged\\runtimes\\pi\\extensions\\dist\\package';
    const forgedPackagesBefore = ['foreign', foreignSource];
    const forgedUnownedBefore = ['foreign'];
    const forgedPackagesAfter = ['foreign', desired];
    const forgedBase = {
      ...plan,
      packagesBefore: forgedPackagesBefore,
      packagesAfter: forgedPackagesAfter,
      beforeDigest: installerDigest(forgedPackagesBefore),
      afterDigest: installerDigest(forgedPackagesAfter),
      priorOwnedEntries: [{ source: foreignSource, packagesBeforeIndex: 1, unownedBefore: 1 }],
      unownedBefore: forgedUnownedBefore,
      settings: { packages: forgedPackagesAfter },
    };
    const { planDigest: _planDigest, ...forgedWithoutDigest } = forgedBase;
    const forged = { ...forgedWithoutDigest, planDigest: installerDigest(forgedWithoutDigest) };
    expect(() =>
      invertPiNativePackageSettings({
        settings: forged.settings,
        plan: forged,
        priorOwnedSources: [oldSource],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PI_SETTINGS_OWNERSHIP_INVALID' }));

    const omittedPackagesAfter = ['foreign', oldSource, desired];
    const omittedOwnershipBase = {
      ...plan,
      packagesAfter: omittedPackagesAfter,
      afterDigest: installerDigest(omittedPackagesAfter),
      priorOwnedEntries: [],
      unownedBefore: ['foreign', oldSource],
      settings: { packages: omittedPackagesAfter },
    };
    const { planDigest: _omittedDigest, ...omittedOwnershipWithoutDigest } = omittedOwnershipBase;
    const omittedOwnership = {
      ...omittedOwnershipWithoutDigest,
      planDigest: installerDigest(omittedOwnershipWithoutDigest),
    };
    expect(() =>
      invertPiNativePackageSettings({
        settings: omittedOwnership.settings,
        plan: omittedOwnership,
        priorOwnedSources: [oldSource],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PI_SETTINGS_OWNERSHIP_INVALID' }));
  });
});
