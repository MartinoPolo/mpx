import { execFile } from 'node:child_process';
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

async function makeFileLink(target: string, destination: string): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('cmd.exe', ['/d', '/s', '/c', 'mklink', destination, target], {
      windowsVerbatimArguments: true,
    });
  } else {
    await symlink(target, destination, 'file');
  }
}
import type { UserConfig } from '@mpx/config';
import { INSTALL_EXECUTABLE_MAX_BYTES } from '@mpx/installer';
import {
  NodeSetupRequestFactory,
  resolvePiDetachConfig,
} from '../../src/node/setup-application-service.js';

it('derives identities, provider route keys, resolved detach roots and fixed projections', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-node-setup-'));
  const appData = path.join(root, 'appdata');
  const configFile = path.join(appData, 'mpx', 'config.json');
  const claude = path.join(root, 'claude.exe');
  const pi = path.join(root, 'pi.exe');
  await mkdir(path.dirname(configFile), { recursive: true });
  await copyFile(
    new URL('../../../config/test/fixtures/user-launch-contracts.json', import.meta.url),
    configFile,
  );
  await Promise.all([writeFile(claude, 'claude'), writeFile(pi, 'pi')]);
  const environment = {
    APPDATA: appData,
    LOCALAPPDATA: path.join(root, 'local'),
    MPX_PROJECTS: path.join(root, 'projects'),
    MPX_APPS: root,
    MPX_WORK: path.join(root, 'work'),
    MPX_CLONED: path.join(root, 'cloned'),
    MPX_OBSIDIAN_VAULT: path.join(root, 'vault'),
    MPX_AI_GENERATED: path.join(root, 'generated'),
    MPX_ONEDRIVE: path.join(root, 'onedrive'),
    USERPROFILE: path.join(root, 'home'),
    MPX_CLAUDE_EXECUTABLE: claude,
    MPX_PI_EXECUTABLE: pi,
  };
  const version = vi.fn(async (file: string) => (file === claude ? 'Claude 1.2\n' : 'Pi 2.3\r\n'));
  const factory = new NodeSetupRequestFactory(environment, { version });
  const request = await factory.create();
  expect(request.identities).toEqual({ personal: 'personal', work: 'work' });
  expect(request.providers).toEqual({ personal: 'github', work: 'gitlab' });
  expect(request.executables).toEqual({
    claude: { path: claude, version: 'Claude 1.2' },
    pi: { path: pi, version: 'Pi 2.3' },
  });
  expect(request.external.gitRemotes).toEqual([]);
  expect(request.projections.pi).toEqual([
    { path: 'content/agents/metadata.json', role: 'agents' },
    { path: 'content/instructions/runtime/pi/APPEND_SYSTEM.md', role: 'canonical-content' },
    { path: 'runtimes/pi/extensions/subagents/LICENSE', role: 'licenses' },
    { path: 'runtimes/pi/runtime-pi/src/profile.ts', role: 'profile' },
  ]);
  expect(factory.config().identities.personal!.runtimeRoots.pi).toBe('~/.pi/agent');
  expect(version).toHaveBeenCalledWith(claude, ['--version']);
  expect(version).toHaveBeenCalledWith(pi, ['--version']);
});

it('rejects relative executable paths with a redacted typed error', async () => {
  const factory = new NodeSetupRequestFactory({ APPDATA: 'relative' }, { version: vi.fn() });
  await expect(factory.create()).rejects.toMatchObject({
    code: 'SETUP_ENVIRONMENT_INVALID',
    message: 'APPDATA must be an absolute path.',
  });
});

function rawRootConfig(personal: string, work: string): UserConfig {
  return {
    identities: {
      personal: { domain: 'personal', runtimeRoots: { pi: personal, claude: '~/.claude' } },
      work: { domain: 'work', runtimeRoots: { pi: work, claude: 'UNCHANGED' } },
    },
  } as unknown as UserConfig;
}

it.each([
  ['~', 'home'],
  ['~/pi-personal', 'pi-personal'],
  ['~\\pi-personal', 'pi-personal'],
])('resolves supported Pi detach root %s without mutating parsed config', (rootValue, leaf) => {
  const home = path.join(path.parse(process.cwd()).root, 'disposable-home');
  const config = rawRootConfig(rootValue, path.join(home, 'pi-work'));
  const before = structuredClone(config);

  const detached = resolvePiDetachConfig(config, { USERPROFILE: home, HOME: home });

  expect(detached.identities.personal!.runtimeRoots.pi).toBe(
    leaf === 'home' ? home : path.join(home, leaf),
  );
  expect(config).toEqual(before);
  expect(config.identities.personal!.runtimeRoots.claude).toBe('~/.claude');
});

it.each(['~somebody/pi', 'relative/pi'])('rejects unsupported Pi detach root %s', (rootValue) => {
  expect(() =>
    resolvePiDetachConfig(rawRootConfig(rootValue, 'C:/other/pi'), {
      USERPROFILE: 'C:/home',
    }),
  ).toThrow(expect.objectContaining({ code: 'SETUP_ROOT_INVALID' }));
});

it('rejects a tilde Pi root when no absolute home is available', () => {
  expect(() => resolvePiDetachConfig(rawRootConfig('~/.pi', 'C:/other/pi'), {})).toThrow(
    expect.objectContaining({ code: 'SETUP_ROOT_INVALID' }),
  );
});

it('rejects duplicate resolved Pi roots', () => {
  expect(() =>
    resolvePiDetachConfig(rawRootConfig('~/.pi', 'C:/home/.pi'), { USERPROFILE: 'C:/home' }),
  ).toThrow(expect.objectContaining({ code: 'SETUP_ROOT_INVALID' }));
});

async function requestFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-node-setup-invalid-'));
  const appData = path.join(root, 'appdata');
  const configFile = path.join(appData, 'mpx', 'config.json');
  const claude = path.join(root, 'claude.exe');
  const pi = path.join(root, 'pi.exe');
  await mkdir(path.dirname(configFile), { recursive: true });
  await copyFile(
    new URL('../../../config/test/fixtures/user-launch-contracts.json', import.meta.url),
    configFile,
  );
  await Promise.all([writeFile(claude, 'claude'), writeFile(pi, 'pi')]);
  const environment = {
    APPDATA: appData,
    LOCALAPPDATA: root,
    MPX_PROJECTS: path.join(root, 'projects'),
    MPX_APPS: root,
    MPX_WORK: path.join(root, 'work'),
    MPX_CLONED: path.join(root, 'cloned'),
    MPX_OBSIDIAN_VAULT: path.join(root, 'vault'),
    MPX_AI_GENERATED: path.join(root, 'generated'),
    MPX_ONEDRIVE: path.join(root, 'onedrive'),
    USERPROFILE: path.join(root, 'home'),
    MPX_CLAUDE_EXECUTABLE: claude,
    MPX_PI_EXECUTABLE: pi,
  };
  return { root, configFile, claude, pi, environment };
}

it.each(['', '   ', `bad\u0001value`, 'bad\tvalue', 'x'.repeat(257), 'x'.repeat(16 * 1024 + 1)])(
  'rejects invalid executable version output',
  async (output) => {
    const value = await requestFixture();
    const factory = new NodeSetupRequestFactory(value.environment, { version: async () => output });
    await expect(factory.create()).rejects.toMatchObject({ code: 'SETUP_EXECUTABLE_INVALID' });
  },
);

it('rejects executable process failure', async () => {
  const value = await requestFixture();
  const factory = new NodeSetupRequestFactory(value.environment, {
    version: async () => {
      throw new Error('private process detail');
    },
  });
  await expect(factory.create()).rejects.toMatchObject({
    code: 'SETUP_EXECUTABLE_INVALID',
    message: 'MPX_CLAUDE_EXECUTABLE is not a usable executable.',
  });
});

it('rejects a symlink executable', async () => {
  const value = await requestFixture();
  const target = path.join(value.root, 'target.exe');
  await writeFile(target, 'target');
  await rm(value.pi);
  await makeFileLink(target, value.pi);
  const factory = new NodeSetupRequestFactory(value.environment, { version: async () => '1.0' });
  await expect(factory.create()).rejects.toMatchObject({ code: 'SETUP_EXECUTABLE_INVALID' });
});

it('rejects a non-file executable', async () => {
  const value = await requestFixture();
  await rm(value.pi);
  await mkdir(value.pi);
  value.environment.MPX_PI_EXECUTABLE = value.pi;
  const factory = new NodeSetupRequestFactory(value.environment, { version: async () => '1.0' });
  await expect(factory.create()).rejects.toMatchObject({ code: 'SETUP_EXECUTABLE_INVALID' });
});

it('rejects an oversized executable', async () => {
  const value = await requestFixture();
  await truncate(value.pi, INSTALL_EXECUTABLE_MAX_BYTES + 1);
  const factory = new NodeSetupRequestFactory(value.environment, { version: async () => '1.0' });
  await expect(factory.create()).rejects.toMatchObject({ code: 'SETUP_EXECUTABLE_INVALID' });
});

it('rejects an oversized configuration with a fixed redacted error', async () => {
  const value = await requestFixture();
  await truncate(value.configFile, 1024 * 1024 + 1);
  const factory = new NodeSetupRequestFactory(value.environment, { version: async () => '1.0' });
  await expect(factory.create()).rejects.toMatchObject({
    code: 'SETUP_CONFIG_INVALID',
    message: 'Setup configuration is invalid or unreadable.',
  });
});

it('rejects an ambiguous root identity selection', async () => {
  const value = await requestFixture();
  const config = JSON.parse(await readFile(value.configFile, 'utf8')) as {
    identities: Record<string, { domain: string }>;
  };
  config.identities.work!.domain = 'personal';
  await writeFile(value.configFile, JSON.stringify(config));
  const factory = new NodeSetupRequestFactory(value.environment, { version: async () => '1.0' });
  await expect(factory.create()).rejects.toMatchObject({ code: 'SETUP_IDENTITY_INVALID' });
});

it('rejects an ambiguous provider selection', async () => {
  const value = await requestFixture();
  const config = JSON.parse(await readFile(value.configFile, 'utf8')) as {
    identities: Record<string, { providerRoutes: Record<string, string> }>;
  };
  config.identities.personal!.providerRoutes = { gitlab: 'one', kanbanflow: 'two' };
  await writeFile(value.configFile, JSON.stringify(config));
  const factory = new NodeSetupRequestFactory(value.environment, { version: async () => '1.0' });
  await expect(factory.create()).rejects.toMatchObject({ code: 'SETUP_PROVIDER_INVALID' });
});

it('rejects a symlink configuration with a fixed redacted error', async () => {
  const value = await requestFixture();
  const body = await readFile(value.configFile);
  const target = path.join(value.root, 'secret-config.json');
  await writeFile(target, body);
  await rm(value.configFile);
  await makeFileLink(target, value.configFile);
  const factory = new NodeSetupRequestFactory(value.environment, { version: async () => '1.0' });
  await expect(factory.create()).rejects.toMatchObject({
    code: 'SETUP_CONFIG_INVALID',
    message: 'Setup configuration is invalid or unreadable.',
  });
});

it.runIf(process.platform === 'win32')(
  'uses the real default process port for a trusted extensionless pi-fnm wrapper',
  async () => {
    const value = await requestFixture();
    const bin = path.join(value.root, 'fnm-bin');
    const cli = path.join(
      bin,
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'dist',
      'bundle',
      'cli.js',
    );
    const wrapper = path.join(bin, 'pi');
    const node = path.join(bin, 'node.exe');
    await mkdir(path.dirname(cli), { recursive: true });
    await link(process.execPath, node);
    await writeFile(cli, "console.log('Pi disposable 9.8.7')\n");
    await writeFile(
      wrapper,
      '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\nexec "$basedir/node" "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"\n',
    );
    value.environment.MPX_CLAUDE_EXECUTABLE = node;
    value.environment.MPX_PI_EXECUTABLE = wrapper;
    value.environment.MPX_APPS = value.root;
    const factory = new NodeSetupRequestFactory(value.environment);

    await expect(factory.create()).resolves.toMatchObject({
      executables: { pi: { path: wrapper, version: 'Pi disposable 9.8.7' } },
    });
  },
);
