import { execFile } from 'node:child_process';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createNodeSetupApplicationService, resolvePiDetachConfig } from '@mpx/application/node';
import { parseUserConfig } from '@mpx/config';
import { PiLegacyDetachService } from '@mpx/installer';
import { afterEach, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const digest = 'a'.repeat(64);
const entries = [
  ['mpx-pi', 'agents', 'agents', 'tree'],
  ['mpx-pi', 'extensions', 'extensions', 'tree'],
  ['mpx-pi', 'prompts', 'prompts', 'tree'],
  ['mpx-pi', 'themes', 'themes', 'tree'],
  ['mpx-pi', 'APPEND_SYSTEM.md', 'APPEND_SYSTEM.md', 'file'],
  ['mpx-pi', 'keybindings.json', 'keybindings.json', 'file'],
  ['mpx-pi', 'settings.json', 'settings.json', 'file'],
  ['mpx-pi', 'subagents.json', 'subagents.json', 'file'],
  ['mpx-pi', 'skills/mp-symlink', 'skills/mp-symlink', 'tree'],
  ['mpx-pi', 'skills/mp-sync-base', 'skills/mp-sync-base', 'tree'],
  ['mpx-claude-code', 'instructions/AGENTS.md', 'AGENTS.md', 'file'],
  ['mpx-claude-code', 'skills/mp-fallow-fix', 'skills/mp-fallow-fix', 'tree'],
  ['mpx-claude-code', 'skills/mp-vocabulary', 'skills/mp-vocabulary', 'tree'],
] as const;

const materializationSource = (projects: string, repo: string, source: string): string =>
  path.join(
    projects,
    repo,
    repo === 'mpx-claude-code' && ['skills/mp-fallow-fix', 'skills/mp-vocabulary'].includes(source)
      ? `plugins/mp/${source}`
      : source,
  );

async function makeLink(target: string, destination: string, directory: boolean): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  if (process.platform === 'win32') {
    await execFileAsync(
      'cmd.exe',
      ['/d', '/s', '/c', 'mklink', ...(directory ? ['/D'] : []), destination, target],
      { windowsVerbatimArguments: true },
    );
  } else {
    await symlink(target, destination, directory ? 'dir' : 'file');
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-setup-integration-'));
  roots.push(root);
  const projects = path.join(root, 'projects');
  const home = path.join(root, 'home');
  const personal = path.join(home, '.pi', 'agent');
  const work = path.join(home, 'work-pi');
  const appData = path.join(root, 'appdata');
  const localAppData = path.join(root, 'localappdata');
  await Promise.all([
    mkdir(projects, { recursive: true }),
    mkdir(personal, { recursive: true }),
    mkdir(work, { recursive: true }),
    mkdir(path.join(appData, 'mpx'), { recursive: true }),
    mkdir(localAppData, { recursive: true }),
  ]);
  const sourceBodies = new Map<string, string>();
  for (const [repo, source, destination, kind] of entries) {
    const linkTarget = path.join(projects, repo, source);
    const sourcePath = materializationSource(projects, repo, source);
    const body = `source:${repo}:${source}`;
    sourceBodies.set(sourcePath, body);
    if (kind === 'tree') {
      await mkdir(sourcePath, { recursive: true });
      await writeFile(path.join(sourcePath, 'payload.txt'), body);
    } else {
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, body);
    }
    await makeLink(linkTarget, path.join(personal, destination), kind === 'tree');
    await makeLink(linkTarget, path.join(work, destination), kind === 'tree');
  }
  await writeFile(path.join(personal, 'native-sentinel.txt'), 'personal-native');
  await writeFile(path.join(work, 'native-sentinel.txt'), 'work-native');

  const config = JSON.parse(
    await readFile(
      new URL('../../../packages/config/test/fixtures/user-launch-contracts.json', import.meta.url),
      'utf8',
    ),
  ) as { identities: Record<string, { runtimeRoots: { pi: string } }> };
  config.identities.personal!.runtimeRoots.pi = '~/.pi/agent';
  config.identities.work!.runtimeRoots.pi = '~/work-pi';
  const configFile = path.join(appData, 'mpx', 'config.json');
  const configBody = Buffer.from(
    `${JSON.stringify(config, null, 2).replace(/\n/gu, '\r\n')}\r\n`,
    'utf8',
  );
  await writeFile(configFile, configBody);

  const bin = path.join(root, 'apps', 'bin');
  const piCli = path.join(
    bin,
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'dist',
    'bundle',
    'cli.js',
  );
  const node = path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node');
  const pi = path.join(bin, 'pi');
  await mkdir(path.dirname(piCli), { recursive: true });
  await link(process.execPath, node);
  await writeFile(piCli, "console.log('Pi disposable 1.0')\n");
  await writeFile(
    pi,
    '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\nexec "$basedir/node" "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"\n',
  );
  return {
    root,
    projects,
    personal,
    work,
    sourceBodies,
    configFile,
    configBody,
    environment: {
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      USERPROFILE: home,
      HOME: home,
      MPX_PROJECTS: projects,
      MPX_APPS: path.join(root, 'apps'),
      MPX_WORK: path.join(root, 'work'),
      MPX_CLONED: path.join(root, 'cloned'),
      MPX_ONEDRIVE: path.join(root, 'onedrive'),
      MPX_AI_GENERATED: path.join(root, 'generated'),
      MPX_OBSIDIAN_VAULT: path.join(root, 'vault'),
      MPX_CLAUDE_EXECUTABLE: node,
      MPX_PI_EXECUTABLE: pi,
    },
  };
}

it('rejects a symlink setup state directory before detachment', async () => {
  const value = await fixture();
  const stateTarget = path.join(value.root, 'outside-state');
  await mkdir(stateTarget);
  await makeLink(stateTarget, path.join(value.environment.LOCALAPPDATA, 'mpx'), true);
  const intent = {
    schemaVersion: 1,
    kind: 'install-intent',
    releaseKey: digest,
    convergenceHash: digest,
    components: ['cli'],
  } as const;
  const service = createNodeSetupApplicationService({
    environment: value.environment,
    builder: {
      build: async () =>
        ({
          schemaVersion: 1,
          kind: 'install-intent-build-result',
          intent,
          externalPlans: [],
        }) as never,
      verify: vi.fn(),
    },
    orchestrator: { plan: vi.fn(), apply: vi.fn(), verify: vi.fn() },
  });

  await expect(service.execute()).rejects.toMatchObject({ code: 'SETUP_STATE_INVALID' });
});

it('detaches both disposable legacy roots through the complete node setup composition', async () => {
  const value = await fixture();
  const order: string[] = [];
  let buildCount = 0;
  const intent = {
    schemaVersion: 1,
    kind: 'install-intent',
    releaseKey: digest,
    convergenceHash: digest,
    components: ['cli'],
  } as const;
  const built = {
    schemaVersion: 1,
    kind: 'install-intent-build-result',
    intent,
    externalPlans: [],
  } as never;
  const builder = {
    build: vi.fn(async () => {
      order.push('build');
      expect((await lstat(path.join(value.personal, 'settings.json'))).isSymbolicLink()).toBe(
        buildCount++ === 0,
      );
      return built;
    }),
    verify: vi.fn(
      async () =>
        ({
          schemaVersion: 1,
          kind: 'install-external-verification',
          integrations: [],
        }) as const,
    ),
  };
  const orchestrator = {
    plan: vi.fn(async () => {
      order.push('plan');
      for (const root of [value.personal, value.work]) {
        for (const [, , destination] of entries) {
          expect((await lstat(path.join(root, destination))).isSymbolicLink()).toBe(false);
        }
      }
      return {
        schemaVersion: 1,
        kind: 'install-plan',
        intent,
        confirmationDigest: digest,
        classifications: { automatic: [], confirmationRequired: [], manualOnly: [] },
      } as never;
    }),
    apply: vi.fn(async () => ({}) as never),
    verify: vi.fn(async (_strict: boolean, external?: () => Promise<unknown>) => {
      await external?.();
      return { healthy: true, issues: [] } as never;
    }),
  };

  const service = createNodeSetupApplicationService({
    environment: value.environment,
    builder,
    orchestrator: orchestrator as never,
  });
  await expect(service.execute()).resolves.toMatchObject({ verification: { healthy: true } });
  expect(await readFile(value.configFile)).toEqual(value.configBody);
  await expect(service.execute()).resolves.toMatchObject({ verification: { healthy: true } });
  expect(order).toEqual(['build', 'plan', 'build', 'plan']);
  expect(await readFile(value.configFile)).toEqual(value.configBody);
  expect(await readdir(path.join(value.environment.LOCALAPPDATA, 'mpx'))).toContain(
    'pi-legacy-detach.receipt.json',
  );
  for (const root of [value.personal, value.work]) {
    expect(await readFile(path.join(root, 'native-sentinel.txt'), 'utf8')).toMatch(/native$/u);
  }
  for (const [source, body] of value.sourceBodies) {
    const info = await lstat(source);
    expect(info.isSymbolicLink()).toBe(false);
    expect(
      await readFile(info.isDirectory() ? path.join(source, 'payload.txt') : source, 'utf8'),
    ).toBe(body);
  }
  expect(await readFile(path.join(value.personal, 'settings.json'), 'utf8')).toBe(
    value.sourceBodies.get(path.join(value.projects, 'mpx-pi', 'settings.json')),
  );
  for (const skill of ['mp-fallow-fix', 'mp-vocabulary']) {
    expect(await readFile(path.join(value.personal, 'skills', skill, 'payload.txt'), 'utf8')).toBe(
      `source:mpx-claude-code:skills/${skill}`,
    );
  }
});

it('keeps the committed detachment receipt when setup fails afterward so retry can continue', async () => {
  const value = await fixture();
  const intent = {
    schemaVersion: 1,
    kind: 'install-intent',
    releaseKey: digest,
    convergenceHash: digest,
    components: ['cli'],
  } as const;
  const built = {
    schemaVersion: 1,
    kind: 'install-intent-build-result',
    intent,
    externalPlans: [],
  } as never;
  let fail = true;
  const service = createNodeSetupApplicationService({
    environment: value.environment,
    builder: {
      build: async () => built,
      verify: vi.fn(
        async () =>
          ({
            schemaVersion: 1,
            kind: 'install-external-verification',
            integrations: [],
          }) as const,
      ),
    },
    orchestrator: {
      plan: async () => {
        if (fail) {
          throw new Error('injected post-detachment setup failure');
        }
        return {
          schemaVersion: 1,
          kind: 'install-plan',
          intent,
          confirmationDigest: digest,
          classifications: { automatic: [], confirmationRequired: [], manualOnly: [] },
        } as never;
      },
      apply: vi.fn(async () => ({}) as never),
      verify: vi.fn(async () => ({ healthy: true, issues: [] }) as never),
    },
  });

  await expect(service.execute()).rejects.toThrow('injected post-detachment setup failure');
  await expect(
    readFile(path.join(value.environment.LOCALAPPDATA, 'mpx', 'pi-legacy-detach.receipt.json')),
  ).resolves.toBeInstanceOf(Buffer);
  fail = false;
  await expect(service.execute()).resolves.toMatchObject({ verification: { healthy: true } });
  for (const root of [value.personal, value.work]) {
    for (const [, , destination] of entries) {
      expect((await lstat(path.join(root, destination))).isSymbolicLink()).toBe(false);
    }
  }
});

it('completes detachment after recovering an interrupted journal', async () => {
  const value = await fixture();
  const stateRoot = path.join(value.environment.LOCALAPPDATA, 'mpx');
  await mkdir(stateRoot);
  let crashed = false;
  await expect(
    new PiLegacyDetachService({
      config: resolvePiDetachConfig(
        parseUserConfig(value.configBody.toString('utf8'), value.environment),
        value.environment,
      ),
      projectsRoot: value.projects,
      stateRoot,
      testCrash: (point) => {
        if (point === 'journaled' && !crashed) {
          crashed = true;
          throw new Error('disposable interruption');
        }
      },
    }).run(),
  ).rejects.toMatchObject({ code: 'PI_LEGACY_CRASH_INJECTED' });
  expect(crashed).toBe(true);
  const intent = {
    schemaVersion: 1,
    kind: 'install-intent',
    releaseKey: digest,
    convergenceHash: digest,
    components: ['cli'],
  } as const;
  const plan = vi.fn(async () => {
    for (const root of [value.personal, value.work]) {
      for (const [, , destination] of entries) {
        expect((await lstat(path.join(root, destination))).isSymbolicLink()).toBe(false);
      }
    }
    return {
      schemaVersion: 1,
      kind: 'install-plan',
      intent,
      confirmationDigest: digest,
      classifications: { automatic: [], confirmationRequired: [], manualOnly: [] },
    } as never;
  });
  const service = createNodeSetupApplicationService({
    environment: value.environment,
    builder: {
      build: async () =>
        ({
          schemaVersion: 1,
          kind: 'install-intent-build-result',
          intent,
          externalPlans: [],
        }) as never,
      verify: vi.fn(),
    },
    orchestrator: {
      plan,
      apply: vi.fn(async () => ({}) as never),
      verify: vi.fn(async () => ({ healthy: true, issues: [] }) as never),
    },
  });

  await expect(service.execute()).resolves.toMatchObject({ verification: { healthy: true } });
  for (const root of [value.personal, value.work]) {
    for (const [, , destination] of entries) {
      expect((await lstat(path.join(root, destination))).isSymbolicLink()).toBe(false);
    }
  }
  expect(await readdir(stateRoot)).toContain('pi-legacy-detach.receipt.json');
});
