import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { NodeSetupRequestFactory } from '../../src/node/setup-application-service.js';

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
    MPX_APPS: path.join(root, 'apps'),
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
  expect(factory.config().identities.personal!.runtimeRoots.pi).toBe(
    path.join(root, 'home', '.pi', 'agent'),
  );
  expect(version).toHaveBeenCalledWith(claude);
  expect(version).toHaveBeenCalledWith(pi);
});

it('rejects relative executable paths with a redacted typed error', async () => {
  const factory = new NodeSetupRequestFactory({ APPDATA: 'relative' }, { version: vi.fn() });
  await expect(factory.create()).rejects.toMatchObject({
    code: 'SETUP_ENVIRONMENT_INVALID',
    message: 'APPDATA must be an absolute path.',
  });
});
