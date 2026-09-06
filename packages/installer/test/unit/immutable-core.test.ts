import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NodeInstalledReleaseAuthority,
  activateRelease,
  buildCurrentReleaseManifest,
  buildReleaseManifest,
  canonicalJson,
  installerDigest,
  parseInstallIntentV1,
  parseOwnershipReceiptV1,
  parseReleaseManifestV1,
  publishCurrentRelease,
  publishRelease,
  readActiveRelease,
  type OwnershipReceiptV1,
} from '../../src/immutable-core.js';
import { preparePiExtensionBuildFixture } from '../fixtures/pi-extension-build.js';

const temporary = () => mkdtemp(path.join(tmpdir(), 'mpx-release-'));

async function isolatedCanonicalRepository(
  prepareExtension: typeof preparePiExtensionBuildFixture = preparePiExtensionBuildFixture,
): Promise<{
  repositoryRoot: string;
  buildRelease: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const checkoutRoot = path.resolve(import.meta.dirname, '../../../..');
  const temporaryRoot = path.join(checkoutRoot, 'node_modules');
  await mkdir(temporaryRoot, { recursive: true });
  const repositoryRoot = await mkdtemp(path.join(temporaryRoot, 'mpx-installer-release-'));
  try {
    const buildRelease = await prepareExtension(
      checkoutRoot,
      repositoryRoot,
      `isolated-${Date.now()}`,
    );
    return {
      repositoryRoot,
      buildRelease,
      cleanup: () => rm(repositoryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(repositoryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function writePiExtensionArtifact(repositoryRoot: string): Promise<string> {
  const artifact = path.join(repositoryRoot, 'runtimes', 'pi', 'extensions', 'dist', 'package');
  const payload = {
    'config/settings.json': '{"theme":"amber"}\n',
    'index.mjs': 'export default function extension() {}\n',
  };
  for (const [name, body] of Object.entries(payload)) {
    const target = path.join(artifact, ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  await writeFile(
    path.join(artifact, 'build-metadata.json'),
    `${canonicalJson({
      schemaVersion: 1,
      sourceTreeDigest: 'a'.repeat(64),
      bundlerConfigDigest: 'b'.repeat(64),
      files: Object.fromEntries(
        Object.entries(payload).map(([name, body]) => [
          name,
          createHash('sha256').update(body).digest('hex'),
        ]),
      ),
    })}\n`,
  );
  return artifact;
}

describe('immutable installer core', () => {
  it('accepts non-canonical strict JSON user-config bytes bound to their exact SHA-256', () => {
    const content = '{\n  "identities": {},\n  "domains": {}\n}\n';
    const artifact = {
      target: '%APPDATA%/mpx/config.json',
      content,
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    };
    const intent = {
      schemaVersion: 1,
      kind: 'install-intent',
      releaseKey: 'a'.repeat(64),
      convergenceHash: 'a'.repeat(64),
      components: ['cli'],
      userConfigArtifact: artifact,
    };
    expect(parseInstallIntentV1(intent)).toEqual(intent);
  });

  it.each([
    '{"identities":{},"identities":{}}',
    '{"__proto__":{}}',
    '{"constructor":{}}',
    '{"prototype":{}}',
  ])('rejects duplicate and prototype-polluting user-config source bytes', (content) => {
    const artifact = {
      target: '%APPDATA%/mpx/config.json',
      content,
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    };
    expect(() =>
      parseInstallIntentV1({
        schemaVersion: 1,
        kind: 'install-intent',
        releaseKey: 'a'.repeat(64),
        convergenceHash: 'a'.repeat(64),
        components: ['cli'],
        userConfigArtifact: artifact,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INSTALL_SCHEMA_INVALID' }));
  });

  it('strictly accepts only a bounded user-config artifact with its exact SHA-256', () => {
    const content = canonicalJson({
      identities: {},
      domains: {},
      contentScopes: {},
      modes: {},
      skillPolicies: {},
      presets: {},
      launchDefaults: { scopes: {}, projects: {} },
      networkPolicies: {},
      executors: { host: {} },
    });
    const artifact = {
      target: '%APPDATA%/mpx/config.json',
      content,
      sha256: installerDigest(JSON.parse(content)),
    };
    const base = {
      schemaVersion: 1,
      kind: 'install-intent',
      releaseKey: 'a'.repeat(64),
      convergenceHash: 'a'.repeat(64),
      components: ['cli'],
      userConfigArtifact: artifact,
    };
    expect(parseInstallIntentV1(base)).toEqual(base);
    expect(() =>
      parseInstallIntentV1({ ...base, userConfigArtifact: { ...artifact, extra: true } }),
    ).toThrowError(expect.objectContaining({ code: 'INSTALL_SCHEMA_INVALID' }));
    expect(() =>
      parseInstallIntentV1({
        ...base,
        userConfigArtifact: { ...artifact, content: `${content} ` },
      }),
    ).toThrowError(expect.objectContaining({ code: 'INSTALL_SCHEMA_INVALID' }));
    expect(() =>
      parseInstallIntentV1({
        ...base,
        userConfigArtifact: { ...artifact, sha256: 'b'.repeat(64) },
      }),
    ).toThrowError(expect.objectContaining({ code: 'INSTALL_SCHEMA_INVALID' }));
    expect(() =>
      parseInstallIntentV1({
        ...base,
        userConfigArtifact: {
          ...artifact,
          content: `{"padding":"${'x'.repeat(65_536)}"}`,
          sha256: 'b'.repeat(64),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'INSTALL_SCHEMA_INVALID' }));
  });

  it('refuses foreign selector replacement and reversibly restores an owned prior selector', async () => {
    const root = await temporary(),
      prior = 'a'.repeat(64),
      activated = 'b'.repeat(64),
      foreign = 'c'.repeat(64);
    await mkdir(path.join(root, 'mpx'));
    await writeFile(path.join(root, 'mpx', 'active-release'), `${foreign}\n`);
    await expect(activateRelease(root, prior, activated)).rejects.toMatchObject({
      code: 'INSTALL_FOREIGN_OR_DRIFTED',
    });
    expect(await readActiveRelease(root)).toBe(foreign);
    await writeFile(path.join(root, 'mpx', 'active-release'), `${prior}\n`);
    const rollback = await activateRelease(root, prior, activated);
    expect(await readActiveRelease(root)).toBe(activated);
    await rollback();
    expect(await readActiveRelease(root)).toBe(prior);
    const secondRollback = await activateRelease(root, prior, activated);
    await writeFile(path.join(root, 'mpx', 'active-release'), `${foreign}\n`);
    await expect(secondRollback()).rejects.toMatchObject({ code: 'INSTALL_FOREIGN_OR_DRIFTED' });
    expect(await readActiveRelease(root)).toBe(foreign);
  });

  it('builds a deterministic, complete, sorted release manifest', async () => {
    const source = await temporary();
    await mkdir(path.join(source, 'z'));
    await writeFile(path.join(source, 'z', 'b.txt'), 'beta');
    await writeFile(path.join(source, 'a.txt'), 'alpha');
    const first = await buildReleaseManifest(source);
    const second = await buildReleaseManifest(source);
    expect(first).toEqual(second);
    expect(first.files.map((entry) => entry.path)).toEqual(['a.txt', 'z/b.txt']);
    expect(first.files.map((entry) => entry.bytes)).toEqual([5, 4]);
    expect(first.releaseKey).toBe(first.convergenceHash);
    expect(parseReleaseManifestV1(first)).toEqual(first);
  });

  it('removes only its allocated repository when isolated setup fails', async () => {
    const checkoutRoot = path.resolve(import.meta.dirname, '../../../..');
    const temporaryRoot = path.join(checkoutRoot, 'node_modules');
    await mkdir(temporaryRoot, { recursive: true });
    const sibling = await mkdtemp(path.join(temporaryRoot, 'mpx-installer-release-sibling-'));
    const siblingSentinel = Buffer.from([0x00, 0x7f, 0x80, 0xff]);
    const siblingSentinelPath = path.join(sibling, 'sentinel.bin');
    await writeFile(siblingSentinelPath, siblingSentinel);
    let allocatedRoot: string | undefined;
    try {
      await expect(
        isolatedCanonicalRepository(async (_checkoutRoot, repositoryRoot) => {
          allocatedRoot = repositoryRoot;
          await writeFile(path.join(repositoryRoot, 'partial-setup'), 'partial');
          throw new Error('injected fixture setup failure');
        }),
      ).rejects.toThrow('injected fixture setup failure');
      if (allocatedRoot === undefined) {
        throw new Error('Fixture setup did not expose its allocated root.');
      }
      await expect(stat(allocatedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await stat(sibling)).isDirectory()).toBe(true);
      expect(await readFile(siblingSentinelPath)).toEqual(siblingSentinel);
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it('includes the complete canonically verified Pi extension artifact in the release manifest', async () => {
    const isolated = await isolatedCanonicalRepository();
    try {
      const manifest = await buildCurrentReleaseManifest({
        repositoryRoot: isolated.repositoryRoot,
        assetPaths: ['runtimes/pi/extensions/dist'],
      });
      const paths = manifest.files.map((file) => file.path);
      expect(paths).toContain('runtimes/pi/extensions/dist/package/build-metadata.json');
      expect(paths).toContain('runtimes/pi/extensions/dist/package/index.mjs');
      expect(paths).toContain('runtimes/pi/extensions/dist/package/subagents/LICENSE');
      expect(paths).toContain('runtimes/pi/extensions/dist/package/licenses/croner.LICENSE');
      expect(paths).toContain('runtimes/pi/extensions/dist/package/licenses/nanoid.LICENSE');
      expect(manifest.releaseKey).toBe(installerDigest(manifest.files));
    } finally {
      await isolated.cleanup();
    }
  }, 20_000);

  it('changes artifact digest and release root identity after a checked extension source rebuild', async () => {
    const isolated = await isolatedCanonicalRepository();
    const appsRoot = await temporary();
    const artifactPrefix = 'runtimes/pi/extensions/dist/package/';
    try {
      const first = await publishCurrentRelease({
        repositoryRoot: isolated.repositoryRoot,
        appsRoot,
        assetPaths: ['runtimes/pi/extensions/dist'],
      });
      const firstArtifactDigest = installerDigest(
        first.files.filter((file) => file.path.startsWith(artifactPrefix)),
      );
      const source = path.join(isolated.repositoryRoot, 'runtimes', 'pi', 'extensions', 'index.ts');
      await writeFile(
        source,
        `${await readFile(source, 'utf8')}\nexport const releaseIdentityFixture = 'rebuilt';\n`,
      );
      await isolated.buildRelease();

      const second = await publishCurrentRelease({
        repositoryRoot: isolated.repositoryRoot,
        appsRoot,
        assetPaths: ['runtimes/pi/extensions/dist'],
      });
      const secondArtifactDigest = installerDigest(
        second.files.filter((file) => file.path.startsWith(artifactPrefix)),
      );

      expect(secondArtifactDigest).not.toBe(firstArtifactDigest);
      expect(second.releaseKey).not.toBe(first.releaseKey);
      expect(
        (await stat(path.join(appsRoot, 'mpx', 'releases', first.releaseKey))).isDirectory(),
      ).toBe(true);
      expect(
        (await stat(path.join(appsRoot, 'mpx', 'releases', second.releaseKey))).isDirectory(),
      ).toBe(true);
    } finally {
      await isolated.cleanup();
      await rm(appsRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('does not trust a tampered bundle with self-consistent ignored metadata', async () => {
    const isolated = await isolatedCanonicalRepository();
    const repositoryRoot = isolated.repositoryRoot;
    const artifact = path.join(repositoryRoot, 'runtimes', 'pi', 'extensions', 'dist', 'package');
    try {
      const bundle = path.join(artifact, 'index.mjs');
      const metadataPath = path.join(artifact, 'build-metadata.json');
      const tampered = `${await readFile(bundle, 'utf8')}\n// tampered\n`;
      await writeFile(bundle, tampered);
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
        files: Record<string, string>;
      };
      metadata.files['index.mjs'] = createHash('sha256').update(tampered).digest('hex');
      await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);

      await expect(
        buildCurrentReleaseManifest({
          repositoryRoot,
          assetPaths: ['runtimes/pi/extensions/dist/package'],
        }),
      ).rejects.toMatchObject({ code: 'INSTALL_RELEASE_ARTIFACT_INVALID' });
    } finally {
      await isolated.cleanup();
    }
  }, 20_000);

  it('rejects custom asset paths that include only part of the canonical artifact', async () => {
    const repositoryRoot = await temporary();
    await writePiExtensionArtifact(repositoryRoot);

    await expect(
      buildCurrentReleaseManifest({
        repositoryRoot,
        assetPaths: ['runtimes/pi/extensions/dist/package/index.mjs'],
      }),
    ).rejects.toMatchObject({ code: 'INSTALL_RELEASE_ARTIFACT_INVALID' });
  });

  it('rejects a case-variant partial Pi artifact path before it can bypass verification', async () => {
    const repositoryRoot = await temporary();
    const partial = path.join(
      repositoryRoot,
      'RUNTIMES',
      'PI',
      'EXTENSIONS',
      'DIST',
      'PACKAGE',
      'index.mjs',
    );
    await mkdir(path.dirname(partial), { recursive: true });
    await writeFile(partial, 'export default function unverifiedExtension() {}\n');

    await expect(
      buildCurrentReleaseManifest({
        repositoryRoot,
        assetPaths: ['RUNTIMES/PI/EXTENSIONS/DIST/PACKAGE/index.mjs'],
      }),
    ).rejects.toMatchObject({ code: 'INSTALL_RELEASE_ARTIFACT_INVALID' });
  });

  it('orders full release paths ordinally across prefix siblings and traversal order', async () => {
    const firstSource = await temporary(),
      secondSource = await temporary(),
      apps = await temporary();
    const populate = async (root: string, directories: readonly string[]): Promise<void> => {
      for (const directory of directories) {
        const target = path.join(root, 'content', 'skills', directory);
        await mkdir(target, { recursive: true });
        await writeFile(path.join(target, 'SKILL.md'), directory);
      }
    };
    await populate(firstSource, ['commit', 'commit-push']);
    await populate(secondSource, ['commit-push', 'commit']);

    const first = await buildReleaseManifest(firstSource);
    const second = await buildReleaseManifest(secondSource);

    expect(first.files.map((entry) => entry.path)).toEqual([
      'content/skills/commit-push/SKILL.md',
      'content/skills/commit/SKILL.md',
    ]);
    expect(second).toEqual(first);
    expect(parseReleaseManifestV1(first)).toEqual(first);

    const published = await publishRelease({ sourceDirectory: firstSource, appsRoot: apps });
    const republished = await publishRelease({ sourceDirectory: secondSource, appsRoot: apps });
    expect(republished).toEqual(published);
    expect(
      parseReleaseManifestV1(
        JSON.parse(
          await readFile(
            path.join(apps, 'mpx', 'releases', published.releaseKey, 'release-manifest.json'),
            'utf8',
          ),
        ),
      ),
    ).toEqual(first);
  });

  it('rejects links instead of following them into a release', async () => {
    const source = await temporary();
    await writeFile(path.join(source, 'file'), 'safe');
    const { symlink } = await import('node:fs/promises');
    await symlink(path.join(source, 'file'), path.join(source, 'link'));
    await expect(buildReleaseManifest(source)).rejects.toMatchObject({
      code: 'INSTALL_RELEASE_UNSAFE_ENTRY',
    });
  });

  it('publishes atomically and never mutates an existing release', async () => {
    const source = await temporary(),
      apps = await temporary();
    await writeFile(path.join(source, 'runner.js'), 'one');
    const manifest = await publishRelease({ sourceDirectory: source, appsRoot: apps });
    const destination = path.join(apps, 'mpx', 'releases', manifest.releaseKey);
    await writeFile(path.join(source, 'runner.js'), 'two');
    await expect(
      publishRelease({ sourceDirectory: source, appsRoot: apps, releaseKey: manifest.releaseKey }),
    ).rejects.toMatchObject({ code: 'INSTALL_RELEASE_KEY_MISMATCH' });
    expect(await readFile(path.join(destination, 'runner.js'), 'utf8')).toBe('one');
  });

  it('rejects forged operation locators whose immutable specification no longer matches its receipt binding', () => {
    const operation = {
        id: 'owned',
        adapter: 'files',
        action: 'ensure' as const,
        target: 'C:\\owned',
        desiredDigest: 'b'.repeat(64),
      },
      spec = { kind: 'file' };
    const receipt = {
      schemaVersion: 2,
      kind: 'ownership-receipt',
      releaseKey: installerDigest([]),
      convergenceHash: installerDigest([]),
      files: [],
      operations: [operation],
      operationLocators: [
        {
          operationId: operation.id,
          adapter: operation.adapter,
          spec,
          bindingDigest: installerDigest({ operation, spec }),
        },
      ],
      installedAt: '2025-01-01T00:00:00.000Z',
    };
    expect(() =>
      parseOwnershipReceiptV1({
        ...receipt,
        operationLocators: [{ ...receipt.operationLocators[0], spec: { kind: 'native' } }],
      }),
    ).toThrow(expect.objectContaining({ code: 'INSTALL_SCHEMA_INVALID' }));
  });

  it('rejects legacy receipts whose removal operations have no durable locator', () => {
    const releaseKey = installerDigest([]);
    expect(() =>
      parseOwnershipReceiptV1({
        schemaVersion: 1,
        kind: 'ownership-receipt',
        releaseKey,
        convergenceHash: releaseKey,
        files: [],
        operations: [
          {
            id: 'owned',
            adapter: 'files',
            action: 'ensure',
            target: 'C:\\owned',
            desiredDigest: 'b'.repeat(64),
          },
        ],
        installedAt: '2025-01-01T00:00:00.000Z',
      }),
    ).toThrow(expect.objectContaining({ code: 'INSTALL_SCHEMA_INVALID' }));
  });

  it('authorizes only a receipt-bound regular release file immediately before use', async () => {
    const source = await temporary(),
      apps = await temporary();
    await writeFile(path.join(source, 'runner.js'), 'runner');
    const manifest = await publishRelease({ sourceDirectory: source, appsRoot: apps });
    const entry = manifest.files[0];
    if (!entry) {
      throw new Error('Published release fixture has no files.');
    }
    const receipt: OwnershipReceiptV1 = {
      schemaVersion: 2,
      kind: 'ownership-receipt',
      releaseKey: manifest.releaseKey,
      convergenceHash: manifest.convergenceHash,
      files: manifest.files,
      operations: [],
      operationLocators: [],
      installedAt: '2025-01-01T00:00:00.000Z',
    };
    const authority = new NodeInstalledReleaseAuthority({
      appsRoot: apps,
      receipt: async () => receipt,
      prohibitedRoots: [],
    });
    const evidence = {
      path: path.join(apps, 'mpx', 'releases', manifest.releaseKey, entry.path),
      sha256: entry.sha256,
      bytes: entry.bytes,
      version: manifest.releaseKey,
    };
    await expect(authority.verifyInstalled(evidence)).resolves.toMatchObject(evidence);
    await writeFile(evidence.path, 'tampered');
    await expect(authority.verifyInstalled(evidence)).rejects.toMatchObject({
      code: 'INSTALL_RUNNER_STALE',
    });
    expect((await stat(evidence.path)).isFile()).toBe(true);
  });
});
