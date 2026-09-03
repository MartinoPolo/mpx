import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FakeRegistryStore,
  ManagedLauncherAdapter,
  OwnedJsonResourceAdapter,
  deterministicTerminalProfileGuid,
  type BinaryFileSystem,
  type JsonResourceStore,
  type OwnedResourceSpec,
} from '@mpx/windows';

class NativeFiles implements BinaryFileSystem {
  async read(target: string) {
    try {
      return await readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }
  async create(target: string, body: Buffer) {
    try {
      await writeFile(target, body, { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      throw error;
    }
  }
  async write(target: string, body: Buffer) {
    await writeFile(target, body);
  }
  async remove(target: string) {
    await unlink(target);
  }
}
class NativeJsonFile implements JsonResourceStore {
  constructor(private readonly file: string) {}
  async read(target: string) {
    expect(target).toBe(this.file);
    try {
      return JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }
  async write(target: string, value: unknown) {
    expect(target).toBe(this.file);
    await writeFile(this.file, `${JSON.stringify(value, null, 2)}\n`);
  }
  async remove(target: string) {
    expect(target).toBe(this.file);
    await unlink(this.file);
  }
}

describe.runIf(process.platform === 'win32')('Windows native-resource offline contract', () => {
  it('round-trips uniquely named real profile and Terminal fixtures while registry mutation stays mocked', async () => {
    const root = await mkdtemp(path.join(tmpdir(), `mpx-native-contract-${randomUUID()}-`));
    const profile = path.join(root, `profile-${randomUUID()}.ps1`),
      terminal = path.join(root, `terminal-${randomUUID()}.json`);
    const originalProfile = Buffer.from('# developer-owned before\r\n# developer-owned after\r\n'),
      foreign = { guid: `{${randomUUID()}}`, name: 'Foreign' },
      originalTerminal = {
        $help: 'https://aka.ms/terminal-documentation',
        profiles: { defaults: { opacity: 93 }, list: [foreign] },
        theme: 'system',
      };
    await writeFile(profile, originalProfile);
    await writeFile(terminal, `${JSON.stringify(originalTerminal)}\n`);
    try {
      const launcher = new ManagedLauncherAdapter(new NativeFiles());
      const launcherReceipt = await launcher.apply(
        await launcher.plan({
          shell: 'powershell',
          path: profile,
          body: 'function mpx-fixture { mpx --version }\n',
        }),
      );
      const guid = deterministicTerminalProfileGuid(`MPX acceptance ${randomUUID()}`),
        terminalAdapter = new OwnedJsonResourceAdapter(new NativeJsonFile(terminal));
      const terminalSpec: OwnedResourceSpec = {
        kind: 'terminal-profile',
        target: terminal,
        ownershipKey: guid,
        desired: { guid, name: 'MPX acceptance fixture', commandline: 'C:\\fixture\\mpx.exe' },
      };
      const terminalReceipt = await terminalAdapter.apply(await terminalAdapter.plan(terminalSpec));

      const registry = new FakeRegistryStore({ registry: { owner: 'foreign', TEMP: 'C:\\Temp' } });
      await expect(
        new OwnedJsonResourceAdapter(registry).inspect({
          kind: 'user-environment',
          target: 'registry',
          ownershipKey: 'mpx',
          desired: { owner: 'mpx' },
        }),
      ).resolves.toMatchObject({ status: 'foreign' });

      await terminalAdapter.remove(terminalReceipt);
      await launcher.remove(launcherReceipt);
      expect(await readFile(profile)).toEqual(originalProfile);
      expect(JSON.parse(await readFile(terminal, 'utf8'))).toEqual(originalTerminal);
      expect(await registry.read('registry')).toEqual({ owner: 'foreign', TEMP: 'C:\\Temp' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
