import { describe, expect, it } from 'vitest';
import {
  FakeBinaryFileSystem,
  FakeJsonResourceStore,
  ManagedLauncherAdapter,
  OwnedJsonResourceAdapter,
  deterministicTerminalProfileGuid,
  type JsonResourceStore,
  type OwnedResourceSpec,
} from '../../src/system-integration.js';

const bashBlock = '# MPX aliases\ncc-mpx() { mpx launch claude "$@"; }\n';

class SequencedJsonResourceStore implements JsonResourceStore {
  readonly writes: unknown[] = [];
  private readIndex = 0;

  constructor(private readonly reads: readonly unknown[]) {}

  async read(): Promise<unknown> {
    const value = this.reads[Math.min(this.readIndex, this.reads.length - 1)];
    this.readIndex += 1;
    return structuredClone(value);
  }

  async write(_target: string, value: unknown): Promise<void> {
    this.writes.push(structuredClone(value));
  }

  async remove(): Promise<void> {}
}

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
        body: 'function cc-mpx { mpx launch claude @args }\n',
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
        body: 'function cc-mpx { mpx launch claude @args }\n',
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
  it('round-trips an MPX profile in modern Terminal settings without changing defaults or foreign data', async () => {
    const foreignBefore = { guid: 'foreign-before', name: 'Before' };
    const foreignAfter = { guid: 'foreign-after', name: 'After' };
    const original = {
      $help: 'https://aka.ms/terminal-documentation',
      theme: 'system',
      profiles: {
        defaults: { font: { face: 'Cascadia Mono' }, opacity: 91 },
        list: [foreignBefore, foreignAfter],
      },
    };
    const store = new FakeJsonResourceStore({ terminal: original });
    const adapter = new OwnedJsonResourceAdapter(store);
    const guid = deterministicTerminalProfileGuid('MPX modern');
    const spec: OwnedResourceSpec = {
      kind: 'terminal-profile',
      target: 'terminal',
      ownershipKey: guid,
      desired: { guid, name: 'MPX', commandline: 'C:\\_MP_apps\\mpx\\bin\\mpx.exe shell' },
    };

    await expect(adapter.inspect(spec)).resolves.toMatchObject({ status: 'absent', digest: null });
    const plan = await adapter.plan(spec);
    const receipt = await adapter.apply(plan);
    await expect(adapter.inspect(spec)).resolves.toMatchObject({
      status: 'owned',
      digest: receipt.desiredDigest,
      value: spec.desired,
    });
    expect(await store.read('terminal')).toEqual({
      ...original,
      profiles: {
        ...original.profiles,
        list: [foreignBefore, foreignAfter, spec.desired],
      },
    });

    await adapter.remove(receipt);
    expect(await store.read('terminal')).toEqual(original);
  });

  it.each([
    { profiles: { defaults: [], list: [] } },
    { profiles: { defaults: {}, list: 'not-an-array' } },
    { profiles: { defaults: {}, list: [null] } },
    { profiles: [{ guid: 'duplicate' }, { guid: 'duplicate' }] },
  ])(
    'rejects malformed, unsafe, or duplicate Terminal profiles during planning',
    async (terminal) => {
      const store = new FakeJsonResourceStore({ terminal });
      const adapter = new OwnedJsonResourceAdapter(store);
      const guid = deterministicTerminalProfileGuid('MPX invalid settings');
      const spec: OwnedResourceSpec = {
        kind: 'terminal-profile',
        target: 'terminal',
        ownershipKey: guid,
        desired: { guid, name: 'MPX' },
      };

      await expect(adapter.plan(spec)).rejects.toMatchObject({ code: 'WINDOWS_FOREIGN_RESOURCE' });
      expect(await store.read('terminal')).toEqual(terminal);
    },
  );

  it('rejects a Terminal profile whose desired GUID is not its ownership key', async () => {
    const store = new FakeJsonResourceStore({ terminal: { profiles: [] } });
    const adapter = new OwnedJsonResourceAdapter(store);
    const spec: OwnedResourceSpec = {
      kind: 'terminal-profile',
      target: 'terminal',
      ownershipKey: deterministicTerminalProfileGuid('MPX owner'),
      desired: { guid: deterministicTerminalProfileGuid('someone else'), name: 'MPX' },
    };

    await expect(adapter.plan(spec)).rejects.toMatchObject({ code: 'WINDOWS_RESOURCE_INVALID' });
    expect(await store.read('terminal')).toEqual({ profiles: [] });
  });

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

  it('updates an exact prior-owned resource when its desired shape changes', async () => {
    const prior: OwnedResourceSpec = {
      kind: 'user-environment',
      target: 'environment',
      ownershipKey: 'mpx',
      desired: { owner: 'mpx', MPX_EXECUTABLE: 'C:\\Apps\\mpx.exe', PathPrepend: 'C:\\Apps' },
    };
    const next: OwnedResourceSpec = {
      ...prior,
      desired: { ...prior.desired, MPX_NODE_ENTRY: 'C:\\Apps\\mpx-node.mjs' },
    };
    const store = new FakeJsonResourceStore({
      environment: { TEMP: 'C:\\Temp', Path: 'native', ...prior.desired },
    });
    const adapter = new OwnedJsonResourceAdapter(store);
    const priorDigest = (await adapter.inspect(prior)).digest!;

    await adapter.apply(await adapter.plan(next), {
      kind: prior.kind,
      target: prior.target,
      ownershipKey: prior.ownershipKey,
      desiredDigest: priorDigest,
    });

    expect(await store.read('environment')).toEqual({
      TEMP: 'C:\\Temp',
      Path: 'native',
      ...next.desired,
    });
  });

  it.each([
    { field: 'kind', value: 'shortcut' },
    { field: 'target', value: 'other' },
    { field: 'ownershipKey', value: 'other' },
    { field: 'desiredDigest', value: '0'.repeat(64) },
  ] as const)('requires exact prior-owned $field authorization', async ({ field, value }) => {
    const prior: OwnedResourceSpec = {
      kind: 'user-environment',
      target: 'environment',
      ownershipKey: 'mpx',
      desired: { owner: 'mpx', MPX_EXECUTABLE: 'old' },
    };
    const next: OwnedResourceSpec = {
      ...prior,
      desired: { ...prior.desired, MPX_NODE_ENTRY: 'new' },
    };
    const store = new FakeJsonResourceStore({ environment: prior.desired });
    const adapter = new OwnedJsonResourceAdapter(store);
    const authorization = {
      kind: prior.kind,
      target: prior.target,
      ownershipKey: prior.ownershipKey,
      desiredDigest: (await adapter.inspect(prior)).digest!,
      [field]: value,
    };

    await expect(adapter.apply(await adapter.plan(next), authorization)).rejects.toMatchObject({
      code: 'WINDOWS_FOREIGN_RESOURCE',
    });
    expect(await store.read('environment')).toEqual(prior.desired);
  });

  it('rejects prior-owned authority for a different current owner', async () => {
    const next: OwnedResourceSpec = {
      kind: 'user-environment',
      target: 'environment',
      ownershipKey: 'mpx',
      desired: { owner: 'mpx', MPX_NODE_ENTRY: 'new' },
    };
    const foreign = { owner: 'other', MPX_EXECUTABLE: 'old' };
    const store = new FakeJsonResourceStore({ environment: foreign });
    const adapter = new OwnedJsonResourceAdapter(store),
      inspection = await adapter.inspect(next);

    await expect(
      adapter.apply(await adapter.plan(next), {
        kind: next.kind,
        target: next.target,
        ownershipKey: next.ownershipKey,
        desiredDigest: inspection.digest!,
      }),
    ).rejects.toMatchObject({ code: 'WINDOWS_FOREIGN_RESOURCE' });
    expect(await store.read('environment')).toEqual(foreign);
  });

  it('rejects prior-owned authority when a newly desired value already exists', async () => {
    const prior: OwnedResourceSpec = {
      kind: 'user-environment',
      target: 'environment',
      ownershipKey: 'mpx',
      desired: { owner: 'mpx', MPX_EXECUTABLE: 'old' },
    };
    const next: OwnedResourceSpec = {
      ...prior,
      desired: { ...prior.desired, MPX_NODE_ENTRY: 'owned-next' },
    };
    const store = new FakeJsonResourceStore({
      environment: { ...prior.desired, MPX_NODE_ENTRY: 'foreign-existing' },
    });
    const adapter = new OwnedJsonResourceAdapter(store);
    const priorDigest = (
      await new OwnedJsonResourceAdapter(
        new FakeJsonResourceStore({ environment: prior.desired }),
      ).inspect(prior)
    ).digest!;

    await expect(
      adapter.apply(await adapter.plan(next), {
        kind: prior.kind,
        target: prior.target,
        ownershipKey: prior.ownershipKey,
        desiredDigest: priorDigest,
      }),
    ).rejects.toMatchObject({ code: 'WINDOWS_FOREIGN_RESOURCE' });
    await expect(store.read('environment')).resolves.toMatchObject({
      MPX_NODE_ENTRY: 'foreign-existing',
    });
  });

  it('checks plan/apply observation changes before prior-owned authority', async () => {
    const prior: OwnedResourceSpec = {
      kind: 'user-environment',
      target: 'environment',
      ownershipKey: 'mpx',
      desired: { owner: 'mpx', MPX_EXECUTABLE: 'old' },
    };
    const next: OwnedResourceSpec = {
      ...prior,
      desired: { ...prior.desired, MPX_NODE_ENTRY: 'new' },
    };
    const store = new FakeJsonResourceStore({ environment: prior.desired });
    const adapter = new OwnedJsonResourceAdapter(store),
      plan = await adapter.plan(next),
      priorDigest = (await adapter.inspect(prior)).digest!;
    await store.write('environment', { ...prior.desired, MPX_EXECUTABLE: 'changed' });

    await expect(
      adapter.apply(plan, {
        kind: prior.kind,
        target: prior.target,
        ownershipKey: prior.ownershipKey,
        desiredDigest: priorDigest,
      }),
    ).rejects.toMatchObject({ code: 'WINDOWS_OBSERVATION_CHANGED' });
  });

  it.each([
    {
      name: 'owner',
      changed: { owner: 'other', MPX_EXECUTABLE: 'old' },
    },
    {
      name: 'owned value',
      changed: { owner: 'mpx', MPX_EXECUTABLE: 'changed' },
    },
  ])('rejects a changed $name on the merge read without writing', async ({ changed }) => {
    const prior: OwnedResourceSpec = {
      kind: 'user-environment',
      target: 'environment',
      ownershipKey: 'mpx',
      desired: { owner: 'mpx', MPX_EXECUTABLE: 'old' },
    };
    const next: OwnedResourceSpec = {
      ...prior,
      desired: { ...prior.desired, MPX_NODE_ENTRY: 'new' },
    };
    const initial = { TEMP: 'preserved', ...prior.desired };
    const priorDigest = (
      await new OwnedJsonResourceAdapter(
        new FakeJsonResourceStore({ environment: initial }),
      ).inspect(prior)
    ).digest!;
    const store = new SequencedJsonResourceStore([initial, initial, changed]);
    const adapter = new OwnedJsonResourceAdapter(store);

    await expect(
      adapter.apply(await adapter.plan(next), {
        kind: prior.kind,
        target: prior.target,
        ownershipKey: prior.ownershipKey,
        desiredDigest: priorDigest,
      }),
    ).rejects.toMatchObject({ code: 'WINDOWS_OBSERVATION_CHANGED' });
    expect(store.writes).toEqual([]);
  });

  it('rejects a changed Terminal profile on the merge read without writing', async () => {
    const guid = deterministicTerminalProfileGuid('MPX transition race');
    const prior: OwnedResourceSpec = {
      kind: 'terminal-profile',
      target: 'terminal',
      ownershipKey: guid,
      desired: { guid, name: 'MPX', commandline: 'old' },
    };
    const next: OwnedResourceSpec = {
      ...prior,
      desired: { ...prior.desired, commandline: 'new' },
    };
    const initial = { profiles: [{ guid: 'foreign' }, prior.desired] };
    const changed = {
      profiles: [{ guid: 'foreign' }, { ...prior.desired, commandline: 'changed' }],
    };
    const priorDigest = (
      await new OwnedJsonResourceAdapter(new FakeJsonResourceStore({ terminal: initial })).inspect(
        prior,
      )
    ).digest!;
    const store = new SequencedJsonResourceStore([initial, initial, changed]);
    const adapter = new OwnedJsonResourceAdapter(store);

    await expect(
      adapter.apply(await adapter.plan(next), {
        kind: prior.kind,
        target: prior.target,
        ownershipKey: prior.ownershipKey,
        desiredDigest: priorDigest,
      }),
    ).rejects.toMatchObject({ code: 'WINDOWS_OBSERVATION_CHANGED' });
    expect(store.writes).toEqual([]);
  });

  it('rejects a resource appearing on the merge read after an absent observation', async () => {
    const spec: OwnedResourceSpec = {
      kind: 'user-environment',
      target: 'environment',
      ownershipKey: 'mpx',
      desired: { owner: 'mpx', MPX_EXECUTABLE: 'new' },
    };
    const absent = { TEMP: 'preserved' };
    const store = new SequencedJsonResourceStore([
      absent,
      absent,
      { ...absent, owner: 'other', MPX_EXECUTABLE: 'foreign' },
    ]);
    const adapter = new OwnedJsonResourceAdapter(store);

    await expect(adapter.apply(await adapter.plan(spec))).rejects.toMatchObject({
      code: 'WINDOWS_OBSERVATION_CHANGED',
    });
    expect(store.writes).toEqual([]);
  });

  it.each(['user-environment', 'shortcut'] as const)(
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
});
