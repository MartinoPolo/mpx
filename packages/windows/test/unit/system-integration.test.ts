import { describe, expect, it } from 'vitest';
import {
  FakeBinaryFileSystem,
  FakeJsonResourceStore,
  ManagedLauncherAdapter,
  OwnedJsonResourceAdapter,
  deterministicTerminalProfileGuid,
  type OwnedResourceSpec,
} from '../../src/system-integration.js';

const bashBlock = '# MPX aliases\ncc() { mpx launch claude "$@"; }\n';

it('creates a binary file only when its target is absent', async () => {
  const files = new FakeBinaryFileSystem({ existing: Buffer.from('preserve') });
  await expect(files.create('new', Buffer.from('created'))).resolves.toBe(true);
  await expect(files.create('existing', Buffer.from('replacement'))).resolves.toBe(false);
  expect((await files.read('new'))?.toString()).toBe('created');
  expect((await files.read('existing'))?.toString()).toBe('preserve');
});

describe('managed launcher integration', () => {
  it('inserts and removes exactly one managed block while preserving unrelated bytes', async () => {
    const files = new FakeBinaryFileSystem({
      '/home/me/.bashrc': Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('before\r\nafter\r\n')]),
    });
    const adapter = new ManagedLauncherAdapter(files);
    const plan = await adapter.plan({ shell: 'bash', path: '/home/me/.bashrc', body: bashBlock });
    const receipt = await adapter.apply(plan);
    const installed = await files.read('/home/me/.bashrc');
    expect(installed?.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(installed?.toString()).toContain('before\r\n');
    expect(installed?.toString()).toContain('# >>> MPX MANAGED LAUNCHERS >>>\r\n');
    await adapter.remove(receipt);
    expect(await files.read('/home/me/.bashrc')).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('before\r\nafter\r\n')]),
    );
  });

  it.each([
    'x\n# >>> MPX MANAGED LAUNCHERS >>>\na\n# >>> MPX MANAGED LAUNCHERS >>>\nb\n# <<< MPX MANAGED LAUNCHERS <<<\n',
    'x\n# >>> MPX MANAGED LAUNCHERS >>>\na\n',
    'x\n# <<< MPX MANAGED LAUNCHERS <<<\n',
  ])('rejects duplicate or malformed markers without mutation', async (text) => {
    const files = new FakeBinaryFileSystem({ profile: Buffer.from(text) });
    const adapter = new ManagedLauncherAdapter(files);
    await expect(
      adapter.plan({ shell: 'bash', path: 'profile', body: bashBlock }),
    ).rejects.toMatchObject({ code: 'WINDOWS_MANAGED_BLOCK_MALFORMED' });
    expect((await files.read('profile'))?.toString()).toBe(text);
  });

  it('refuses removal after managed bytes drift but ignores unrelated-byte drift', async () => {
    const files = new FakeBinaryFileSystem({ profile: Buffer.from('native\n') });
    const adapter = new ManagedLauncherAdapter(files);
    const receipt = await adapter.apply(
      await adapter.plan({
        shell: 'powershell',
        path: 'profile',
        body: 'function cc { mpx launch claude @args }\n',
      }),
    );
    await files.write(
      'profile',
      Buffer.from(`${(await files.read('profile'))!.toString()}unrelated\n`),
    );
    await expect(adapter.remove(receipt)).resolves.toBeUndefined();
    const next = await adapter.apply(
      await adapter.plan({
        shell: 'powershell',
        path: 'profile',
        body: 'function cc { mpx launch claude @args }\n',
      }),
    );
    await files.write(
      'profile',
      Buffer.from(
        (await files.read('profile'))!.toString().replace('launch claude', 'launch evil'),
      ),
    );
    await expect(adapter.remove(next)).rejects.toMatchObject({
      code: 'WINDOWS_OWNED_RESOURCE_DRIFT',
    });
  });
});

describe('owned JSON system resources', () => {
  it('uses a deterministic MPX Terminal GUID and preserves foreign profiles', async () => {
    const store = new FakeJsonResourceStore({
      terminal: { profiles: [{ guid: 'foreign', name: 'Keep' }] },
    });
    const adapter = new OwnedJsonResourceAdapter(store);
    const guid = deterministicTerminalProfileGuid('MPX');
    const spec: OwnedResourceSpec = {
      kind: 'terminal-profile',
      target: 'terminal',
      ownershipKey: guid,
      desired: { guid, name: 'MPX', commandline: 'C:\\_MP_apps\\mpx\\bin\\mpx.exe shell' },
    };
    const receipt = await adapter.apply(await adapter.plan(spec));
    expect(((await store.read('terminal')) as any).profiles).toEqual([
      { guid: 'foreign', name: 'Keep' },
      spec.desired,
    ]);
    await adapter.remove(receipt);
    expect(await store.read('terminal')).toEqual({ profiles: [{ guid: 'foreign', name: 'Keep' }] });
  });

  it('merges and removes owned user environment values without touching unrelated registry values', async () => {
    const store = new FakeJsonResourceStore({ environment: { TEMP: 'C:\\Temp', Path: 'native' } });
    const adapter = new OwnedJsonResourceAdapter(store);
    const spec: OwnedResourceSpec = {
      kind: 'user-environment',
      target: 'environment',
      ownershipKey: 'mpx',
      desired: { owner: 'mpx', MPX_EXECUTABLE: 'C:\\Apps\\mpx.exe', PathPrepend: 'C:\\Apps' },
    };
    const receipt = await adapter.apply(await adapter.plan(spec));
    expect(await store.read('environment')).toEqual({
      TEMP: 'C:\\Temp',
      Path: 'native',
      ...spec.desired,
    });
    await adapter.remove(receipt);
    expect(await store.read('environment')).toEqual({ TEMP: 'C:\\Temp', Path: 'native' });
  });

  it.each(['user-environment', 'shortcut', 'scheduled-task'] as const)(
    'refuses to overwrite or remove a foreign %s resource',
    async (kind) => {
      const store = new FakeJsonResourceStore({
        target: { owner: 'foreign', value: 'do-not-touch' },
      });
      const adapter = new OwnedJsonResourceAdapter(store);
      const spec: OwnedResourceSpec = {
        kind,
        target: 'target',
        ownershipKey: 'mpx',
        desired: { owner: 'mpx', value: 'safe' },
      };
      await expect(adapter.apply(await adapter.plan(spec))).rejects.toMatchObject({
        code: 'WINDOWS_FOREIGN_RESOURCE',
      });
    },
  );

  it('registers a scheduled task only with a direct immutable runner and round-trips transactionally', async () => {
    const store = new FakeJsonResourceStore();
    const adapter = new OwnedJsonResourceAdapter(store);
    const desired = {
      owner: 'mpx',
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      executableSha256: 'b'.repeat(64),
      cliSha256: 'c'.repeat(64),
      argv: [
        'C:\\_MP_apps\\mpx\\releases\\' + 'a'.repeat(64) + '\\bin\\mpx.mjs',
        'session',
        'reconcile',
        '--json',
      ],
    };
    const spec: OwnedResourceSpec = {
      kind: 'scheduled-task',
      target: 'task',
      ownershipKey: 'mpx',
      desired,
    };
    const receipt = await adapter.apply(await adapter.plan(spec));
    expect(await adapter.inspect(spec)).toMatchObject({ status: 'owned', value: desired });
    await adapter.remove(receipt);
    expect(await store.read('task')).toBeUndefined();
  });
});
