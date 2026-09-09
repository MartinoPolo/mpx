import type { Stats } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  installerDigest,
  NodePiNativeSettingsPort,
  UserConfigPiPrivateRootResolver,
} from '../../src/index.js';

it('atomically writes and removes settings through the native port', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mpx-pi-native-port-'));
  try {
    const target = path.join(temporary, 'settings.json');
    const port = new NodePiNativeSettingsPort();
    await port.atomicWrite(target, Buffer.from('{"packages":[]}\n'));
    expect(await readFile(target, 'utf8')).toBe('{"packages":[]}\n');
    await port.remove(target);
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it('exposes lock contention as ELOCKED without relabeling other lock failures', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mpx-pi-native-lock-'));
  try {
    const target = path.join(temporary, 'settings.json');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '{}\n');
    const port = new NodePiNativeSettingsPort();
    const held = await port.lock(target);
    try {
      await expect(port.lock(target)).rejects.toMatchObject({ code: 'ELOCKED' });
      expect(held.compromisedFailure()).toBeUndefined();
    } finally {
      await held.release();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

const configuredRootDigest = (root: string) =>
  installerDigest(
    path.win32
      .normalize(root)
      .replace(/[\\]+$/u, '')
      .toLowerCase(),
  );

const userConfig = (identities: Record<string, unknown>) =>
  JSON.stringify({
    schemaVersion: 2,
    identities,
    domains: { personal: ['C:\\projects'], work: ['C:\\work'] },
    locations: {},
    modes: {},
    presets: {},
    launchDefaults: { locations: {}, projects: {} },
    networkPolicies: {},
    executors: { host: {} },
  });

const identity = (domain: 'personal' | 'work', pi: string) => ({
  domain,
  runtimeRoots: { claude: `C:\\claude-${domain}`, pi },
  gitAuthorRoute: `${domain}-git`,
  allowedSkillPacks: domain === 'personal' ? ['development', 'personal'] : ['development'],
});

it('resolves a first-install Pi root from validated intent artifact content', async () => {
  const root = 'C:\\private\\pi-personal';
  const resolver = new UserConfigPiPrivateRootResolver({ APPDATA: 'C:\\missing' });

  await expect(
    resolver.resolvePiNativeRoot({
      identity: 'pi-personal',
      expectedNativeRootDigest: configuredRootDigest(root),
      userConfigArtifactContent: userConfig({ personal: identity('personal', root) }),
    }),
  ).resolves.toBe(root);
});

it('resolves recovery Pi roots from the retained installed config', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mpx-pi-config-'));
  try {
    const configPath = path.join(temporary, 'mpx', 'config.json');
    const root = 'C:\\private\\pi-work';
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, userConfig({ engineer: identity('work', root) }));

    const resolver = new UserConfigPiPrivateRootResolver({ APPDATA: temporary });
    await expect(
      resolver.resolvePiNativeRoot({
        identity: 'pi-work',
        expectedNativeRootDigest: configuredRootDigest(root),
      }),
    ).resolves.toBe(root);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it.each([
  ['missing APPDATA', {}],
  ['missing installed config', { APPDATA: 'C:\\missing' }],
])('fails with a bounded error for %s', async (_label, environment) => {
  const resolver = new UserConfigPiPrivateRootResolver(environment);
  const failure = resolver.resolvePiNativeRoot({
    identity: 'pi-personal',
    expectedNativeRootDigest: 'a'.repeat(64),
  });
  await expect(failure).rejects.toMatchObject({
    code: 'INSTALL_PI_ROOT_UNAVAILABLE',
    message: 'A registered Pi root could not be resolved from validated user config.',
  });
});

it('rejects an installed config file reported as a symlink without reading it', async () => {
  const readFile = vi.fn<() => Promise<Buffer>>();
  const resolver = new UserConfigPiPrivateRootResolver(
    { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
    {
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => true, size: 10 }) as Stats,
      readFile,
    },
  );

  await expect(
    resolver.resolvePiNativeRoot({
      identity: 'pi-personal',
      expectedNativeRootDigest: 'a'.repeat(64),
    }),
  ).rejects.toMatchObject({ code: 'INSTALL_PI_ROOT_UNAVAILABLE' });
  expect(readFile).not.toHaveBeenCalled();
});

it('selects the only digest match among multiple identities in the same domain', async () => {
  const expected = 'C:\\private\\selected';
  const resolver = new UserConfigPiPrivateRootResolver({});
  await expect(
    resolver.resolvePiNativeRoot({
      identity: 'pi-personal',
      expectedNativeRootDigest: configuredRootDigest(expected),
      userConfigArtifactContent: userConfig({
        first: identity('personal', 'C:\\private\\other'),
        second: identity('personal', expected),
      }),
    }),
  ).resolves.toBe(expected);
});

it('rejects duplicate identity bindings to the same Pi root', async () => {
  const root = 'C:\\private\\duplicate';
  const resolver = new UserConfigPiPrivateRootResolver({});
  await expect(
    resolver.resolvePiNativeRoot({
      identity: 'pi-personal',
      expectedNativeRootDigest: configuredRootDigest(root),
      userConfigArtifactContent: userConfig({
        first: identity('personal', root),
        second: identity('personal', root),
      }),
    }),
  ).rejects.toMatchObject({ code: 'INSTALL_PI_ROOT_UNAVAILABLE' });
});

it.each([
  ['wrong domain', 'pi-work' as const, 'C:\\private\\personal'],
  ['wrong digest', 'pi-personal' as const, 'C:\\private\\different'],
])('rejects a configured Pi root with the %s', async (_label, runtimeIdentity, digestRoot) => {
  const configured = 'C:\\private\\personal';
  const resolver = new UserConfigPiPrivateRootResolver({});
  await expect(
    resolver.resolvePiNativeRoot({
      identity: runtimeIdentity,
      expectedNativeRootDigest: configuredRootDigest(digestRoot),
      userConfigArtifactContent: userConfig({ personal: identity('personal', configured) }),
    }),
  ).rejects.toMatchObject({ code: 'INSTALL_PI_ROOT_UNAVAILABLE' });
});

it('does not require legacy Pi root environment variables', async () => {
  const root = 'C:\\private\\configured';
  const resolver = new UserConfigPiPrivateRootResolver({});
  await expect(
    resolver.resolvePiNativeRoot({
      identity: 'pi-personal',
      expectedNativeRootDigest: configuredRootDigest(root),
      userConfigArtifactContent: userConfig({ personal: identity('personal', root) }),
    }),
  ).resolves.toBe(root);
});
