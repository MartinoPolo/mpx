import { execFile } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  opendir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  ObsoleteAccountStateResetService,
  type ObsoleteAccountStateResetFileSystem,
} from '../../src/node/obsolete-account-state-reset.js';

const execFileAsync = promisify(execFile);

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);
const digest = 'a'.repeat(64);
const timestamp = '2025-01-01T00:00:00.000Z';
const binding = (legacy: boolean) => ({
  schemaVersion: 1,
  ref: 'binding',
  identity: { domain: 'personal', name: 'main' },
  runtime: 'pi',
  recordedRootDigest: digest,
  ...(legacy ? { accountBindingRef: 'account' } : {}),
  createdAt: timestamp,
  updatedAt: timestamp,
});

async function fixture() {
  const local = await mkdtemp(path.join(os.tmpdir(), 'mpx-reset-'));
  roots.push(local);
  const state = path.join(local, 'mpx');
  const bindings = path.join(state, 'sessions', 'v1', 'private', 'native-bindings');
  await mkdir(bindings, { recursive: true });
  return { local, state, bindings };
}

async function makeDirectoryLink(target: string, destination: string): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('cmd.exe', ['/d', '/s', '/c', 'mklink', '/D', destination, target], {
      windowsVerbatimArguments: true,
    });
  } else {
    await symlink(target, destination, 'dir');
  }
}

const nodeFileSystem: ObsoleteAccountStateResetFileSystem = {
  lstat,
  realpath,
  open,
  opendir,
  unlink,
};

it('removes only exact obsolete account state and preserves current bindings, sessions, and sentinels', async () => {
  const f = await fixture();
  const accounts = path.join(f.state, 'accounts', 'v1');
  const sessions = path.join(f.state, 'sessions', 'v1', 'identities', 'sentinel');
  await mkdir(accounts, { recursive: true });
  await mkdir(sessions, { recursive: true });
  await writeFile(
    path.join(accounts, 'registry.json'),
    JSON.stringify({ schemaVersion: 1, records: [] }),
  );
  await writeFile(path.join(f.bindings, 'legacy.json'), JSON.stringify(binding(true)));
  await writeFile(path.join(f.bindings, 'current.json'), JSON.stringify(binding(false)));
  await writeFile(path.join(sessions, 'registry.json'), 'session sentinel');
  await writeFile(path.join(f.state, 'sentinel.txt'), 'keep');

  const reset = new ObsoleteAccountStateResetService(f.local);
  await reset.run();
  await reset.run();

  await expect(readFile(path.join(accounts, 'registry.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readdir(f.bindings)).toEqual(['current.json']);
  await expect(readFile(path.join(sessions, 'registry.json'), 'utf8')).resolves.toBe(
    'session sentinel',
  );
  await expect(readFile(path.join(f.state, 'sentinel.txt'), 'utf8')).resolves.toBe('keep');
});

it('fails closed on linked objects without removing their target', async () => {
  const f = await fixture();
  const outside = path.join(f.local, 'outside.json');
  await writeFile(outside, JSON.stringify(binding(true)));
  await symlink(outside, path.join(f.bindings, 'legacy.json'), 'file');
  await expect(new ObsoleteAccountStateResetService(f.local).run()).rejects.toMatchObject({
    code: 'SETUP_OBSOLETE_STATE_INVALID',
  });
  await expect(readFile(outside, 'utf8')).resolves.toContain('accountBindingRef');
});

it.each(['accounts', 'native-bindings'] as const)(
  'rejects a symlinked %s ancestor without deleting outside state',
  async (ancestor) => {
    const f = await fixture();
    const outside = path.join(f.local, `outside-${ancestor}`);
    await mkdir(outside);
    if (ancestor === 'accounts') {
      await rm(path.join(f.state, 'accounts'), { recursive: true, force: true });
      await mkdir(path.join(outside, 'v1'));
      await writeFile(
        path.join(outside, 'v1', 'registry.json'),
        JSON.stringify({ schemaVersion: 1, records: [] }),
      );
      await makeDirectoryLink(outside, path.join(f.state, 'accounts'));
    } else {
      await rm(f.bindings, { recursive: true });
      await writeFile(path.join(outside, 'legacy.json'), JSON.stringify(binding(true)));
      await makeDirectoryLink(outside, f.bindings);
    }

    await expect(new ObsoleteAccountStateResetService(f.local).run()).rejects.toMatchObject({
      code: 'SETUP_OBSOLETE_STATE_INVALID',
    });
    expect(await readdir(outside, { recursive: true })).not.toHaveLength(0);
  },
);

it('preflights every candidate before deleting any obsolete state', async () => {
  const f = await fixture();
  const registry = path.join(f.state, 'accounts', 'v1', 'registry.json');
  const earlier = path.join(f.bindings, 'a-legacy.json');
  await mkdir(path.dirname(registry), { recursive: true });
  await writeFile(registry, JSON.stringify({ schemaVersion: 1, records: [] }));
  await writeFile(earlier, JSON.stringify(binding(true)));
  await writeFile(path.join(f.bindings, 'z-malformed.json'), '{}');

  await expect(new ObsoleteAccountStateResetService(f.local).run()).rejects.toMatchObject({
    code: 'SETUP_OBSOLETE_STATE_INVALID',
  });
  await expect(readFile(registry, 'utf8')).resolves.toContain('records');
  await expect(readFile(earlier, 'utf8')).resolves.toContain('accountBindingRef');
});

it('rejects named-path drift immediately before unlink', async () => {
  const f = await fixture();
  const legacy = path.join(f.bindings, 'legacy.json');
  await writeFile(legacy, JSON.stringify(binding(true)));
  let inspections = 0;
  const driftingFileSystem: ObsoleteAccountStateResetFileSystem = {
    ...nodeFileSystem,
    lstat: (async (file: Parameters<typeof lstat>[0]) => {
      const info = await lstat(file);
      if (file === legacy && ++inspections === 3) {
        return new Proxy(info, {
          get(target, property, receiver) {
            return property === 'size' ? target.size + 1 : Reflect.get(target, property, receiver);
          },
        });
      }
      return info;
    }) as typeof lstat,
  };

  await expect(
    new ObsoleteAccountStateResetService(f.local, driftingFileSystem).run(),
  ).rejects.toMatchObject({ code: 'SETUP_OBSOLETE_STATE_INVALID' });
  await expect(readFile(legacy, 'utf8')).resolves.toContain('accountBindingRef');
});

it('continues an idempotent retry after an interrupted partial cleanup', async () => {
  const f = await fixture();
  const registry = path.join(f.state, 'accounts', 'v1', 'registry.json');
  const remaining = path.join(f.bindings, 'remaining.json');
  await mkdir(path.dirname(registry), { recursive: true });
  await writeFile(registry, JSON.stringify({ schemaVersion: 1, records: [] }));
  await writeFile(remaining, JSON.stringify(binding(true)));
  let deletions = 0;
  const interruptedFileSystem: ObsoleteAccountStateResetFileSystem = {
    ...nodeFileSystem,
    async unlink(file) {
      if (++deletions === 2) {
        throw new Error('simulated interruption');
      }
      await unlink(file);
    },
  };

  await expect(
    new ObsoleteAccountStateResetService(f.local, interruptedFileSystem).run(),
  ).rejects.toMatchObject({ code: 'SETUP_OBSOLETE_STATE_INVALID' });
  await new ObsoleteAccountStateResetService(f.local).run();

  await expect(readFile(registry)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(remaining)).rejects.toMatchObject({ code: 'ENOENT' });
});
