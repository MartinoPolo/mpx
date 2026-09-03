import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PowerShellResult, PowerShellRunner } from '../../src/adapter.js';
import { ProductionWindowsResourceStore } from '../../src/production-resource.js';

interface RunnerCall {
  script: string;
  parameters?: Readonly<Record<string, string>>;
}

class Runner implements PowerShellRunner {
  calls: RunnerCall[] = [];
  outputs: string[] = [];
  async run(
    script: string,
    parameters?: Readonly<Record<string, string>>,
  ): Promise<PowerShellResult> {
    this.calls.push(parameters === undefined ? { script } : { script, parameters });
    return { stdout: this.outputs.shift() ?? '{"ok":true}', stderr: '', exitCode: 0 };
  }
}

class StatefulRegistryRunner implements PowerShellRunner {
  unsafeNewItem = false;

  constructor(public state: Record<string, string> | undefined) {}

  async run(
    script: string,
    parameters?: Readonly<Record<string, string>>,
  ): Promise<PowerShellResult> {
    const input = JSON.parse(parameters?.NativeResourceJson ?? '{}') as {
      value?: Record<string, string>;
    };
    if (input.value) {
      const safelyCreates = /if\s*\(\s*-not\s*\(\s*Test-Path[\s\S]*?\)\s*\)\s*\{\s*New-Item/iu.test(
        script,
      );
      if (script.includes('New-Item') && !safelyCreates) {
        this.unsafeNewItem = true;
        this.state = {};
      }
      if (!this.state) {
        if (!safelyCreates) {
          return { stdout: '', stderr: 'registry key missing', exitCode: 1 };
        }
        this.state = {};
      }
      const previousPrefix = this.state.MPX_PATH_PREPEND;
      for (const key of Object.keys(this.state)) {
        const desiredKey =
          key === 'MPX_OWNER' ? 'owner' : key === 'MPX_PATH_PREPEND' ? 'PathPrepend' : key;
        if (
          (key === 'MPX_OWNER' || key === 'MPX_PATH_PREPEND' || key.startsWith('MPX_')) &&
          !(desiredKey in input.value)
        ) {
          delete this.state[key];
        }
      }
      for (const [key, value] of Object.entries(input.value)) {
        if (key === 'owner') {
          this.state.MPX_OWNER = value;
        } else if (key === 'PathPrepend') {
          this.state.MPX_PATH_PREPEND = value;
        } else if (key.startsWith('MPX_')) {
          this.state[key] = value;
        }
      }
      if (input.value.PathPrepend !== undefined) {
        const foreign = (this.state.Path ?? '')
          .split(';')
          .filter((entry) => entry !== previousPrefix && entry !== input.value?.PathPrepend);
        this.state.Path = [input.value.PathPrepend, ...foreign].join(';');
      }
      return { stdout: '{"ok":true}', stderr: '', exitCode: 0 };
    }
    if (script.includes('Remove-ItemProperty')) {
      if (!this.state) {
        const guarded = /if\s*\(\s*-not\s*\(\s*Test-Path[\s\S]*?\)\s*\)\s*\{[\s\S]*?exit 0/iu.test(
          script,
        );
        return guarded
          ? { stdout: '{"ok":true}', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: 'registry key missing', exitCode: 1 };
      }
      const prefix = this.state.MPX_PATH_PREPEND;
      for (const key of Object.keys(this.state)) {
        if (key === 'MPX_OWNER' || key === 'MPX_PATH_PREPEND' || key.startsWith('MPX_')) {
          delete this.state[key];
        }
      }
      if (prefix && this.state.Path) {
        this.state.Path = this.state.Path.split(';')
          .filter((entry) => entry !== prefix)
          .join(';');
      }
      return { stdout: '{"ok":true}', stderr: '', exitCode: 0 };
    }
    const aliases: Record<string, string> | undefined = this.state && {
      ...this.state,
      ...(this.state.MPX_OWNER ? { owner: this.state.MPX_OWNER } : {}),
      ...(this.state.MPX_PATH_PREPEND ? { PathPrepend: this.state.MPX_PATH_PREPEND } : {}),
    };
    if (aliases) {
      delete aliases.MPX_OWNER;
      delete aliases.MPX_PATH_PREPEND;
    }
    return { stdout: JSON.stringify(aliases ?? null), stderr: '', exitCode: 0 };
  }
}

const callAt = (runner: Runner, index: number): RunnerCall => {
  const call = runner.calls[index];
  if (!call) {
    throw new Error(`Expected PowerShell call at index ${index}`);
  }
  return call;
};

const resourceJson = (call: RunnerCall): string => {
  const value = call.parameters?.NativeResourceJson;
  if (value === undefined) {
    throw new Error('Expected NativeResourceJson parameter');
  }
  return value;
};

describe('ProductionWindowsResourceStore', () => {
  it('passes registry values only through structured JSON instead of interpolating shell text', async () => {
    const runner = new Runner();
    runner.outputs.push(
      '{"owner":"mpx","MPX_APPS":"C:\\\\Apps","Path":"C:\\\\Foreign"}',
      '{"ok":true}',
      '{"owner":"mpx","MPX_APPS":"C:\\\\Apps; Write-Host pwn"}',
    );
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });
    expect(await store.read('HKCU\\Environment')).toEqual({
      owner: 'mpx',
      MPX_APPS: 'C:\\Apps',
      Path: 'C:\\Foreign',
    });
    await store.write('HKCU\\Environment', { owner: 'mpx', MPX_APPS: 'C:\\Apps; Write-Host pwn' });
    const writeCall = callAt(runner, 1);
    expect(writeCall.script).not.toContain('Write-Host pwn');
    expect(JSON.parse(resourceJson(writeCall))).toEqual({
      target: 'HKCU\\Environment',
      value: { owner: 'mpx', MPX_APPS: 'C:\\Apps; Write-Host pwn' },
    });
  });

  it('preserves every foreign value and Path when writing an existing environment key', async () => {
    const runner = new StatefulRegistryRunner({
      Path: 'C:\\Foreign;C:\\Tools',
      TEMP: 'C:\\Temp',
      FOREIGN: 'keep',
    });
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });

    await store.write('HKCU\\Environment', {
      owner: 'mpx',
      MPX_APPS: 'C:\\Apps',
      Path: 'C:\\Foreign;C:\\Tools',
      PathPrepend: 'C:\\Apps\\mpx\\bin',
    });

    expect(runner.state).toMatchObject({
      Path: 'C:\\Apps\\mpx\\bin;C:\\Foreign;C:\\Tools',
      TEMP: 'C:\\Temp',
      FOREIGN: 'keep',
    });
  });

  it('creates an absent environment key before writing it', async () => {
    const runner = new StatefulRegistryRunner(undefined);
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });

    await expect(
      store.write('HKCU\\Environment', { owner: 'mpx', MPX_APPS: 'C:\\Apps' }),
    ).resolves.toBeUndefined();
    expect(runner.state).toMatchObject({ MPX_OWNER: 'mpx', MPX_APPS: 'C:\\Apps' });
    expect(runner.unsafeNewItem).toBe(false);
  });

  it('reads and removes idempotently when the environment key is absent', async () => {
    const runner = new StatefulRegistryRunner(undefined);
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });

    await expect(store.read('HKCU\\Environment')).resolves.toBeUndefined();
    await expect(store.remove('HKCU\\Environment')).resolves.toBeUndefined();
    expect(runner.state).toBeUndefined();
  });

  it('treats an absent user Path as empty when prepending the managed path', async () => {
    const runner = new Runner();
    runner.outputs.push(
      '{"ok":true}',
      '{"owner":"mpx","PathPrepend":"C:\\\\Apps\\\\mpx\\\\bin","Path":"C:\\\\Apps\\\\mpx\\\\bin"}',
    );
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });

    await store.write('HKCU\\Environment', {
      owner: 'mpx',
      PathPrepend: 'C:\\Apps\\mpx\\bin',
    });

    const script = callAt(runner, 0).script;
    expect(script).not.toContain('Get-ItemPropertyValue');
    expect(script).toContain("$p.PSObject.Properties['Path']");
  });

  it('recovers a partial environment write when the managed prefix exists but Path is absent', async () => {
    const runner = new Runner();
    runner.outputs.push('{"owner":"mpx","PathPrepend":"C:\\\\Apps"}', '{"ok":true}', '{}');
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });

    await store.remove('HKCU\\Environment');

    const script = callAt(runner, 1).script;
    expect(script).toContain("$p.PSObject.Properties['Path']");
    expect(script).toContain('Remove-ItemProperty');
    expect(script).toContain('$remaining.Count');
  });

  it('leaves an already-unmanaged foreign Path unchanged during repeated removal', async () => {
    const runner = new Runner();
    runner.outputs.push(
      '{"Path":"C:\\\\Foreign;C:\\\\Tools","TEMP":"keep"}',
      '{"ok":true}',
      '{"Path":"C:\\\\Foreign;C:\\\\Tools","TEMP":"keep"}',
    );
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });

    await expect(store.remove('HKCU\\Environment')).resolves.toBeUndefined();
  });

  it('preserves an existing Path registry type and removes only exact managed entries', async () => {
    const runner = new Runner();
    runner.outputs.push(
      '{"ok":true}',
      '{"owner":"mpx","PathPrepend":"C:\\\\Apps","Path":"C:\\\\Apps;C:\\\\Foreign"}',
    );
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });

    await store.write('HKCU\\Environment', {
      owner: 'mpx',
      Path: 'C:\\Foreign',
      PathPrepend: 'C:\\Apps',
    });

    const script = callAt(runner, 0).script;
    expect(script).toContain("GetValueKind('Path')");
    expect(script).toContain('-Type $pathType');
    expect(script).toContain('-cne');
  });

  it('captures raw Path while translating the managed registry aliases', async () => {
    const runner = new Runner();
    runner.outputs.push(
      '{"owner":"mpx","PathPrepend":"C:\\\\Apps","Path":"C:\\\\Foreign;C:\\\\Tools"}',
    );
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });

    await expect(store.read('HKCU\\Environment')).resolves.toMatchObject({
      owner: 'mpx',
      PathPrepend: 'C:\\Apps',
      Path: 'C:\\Foreign;C:\\Tools',
    });
    const script = callAt(runner, 0).script;
    expect(script).not.toContain("$x.Name-ne'Path'");
    expect(script).toContain("$x.Name-eq'MPX_OWNER'");
    expect(script).toContain("$o['PathPrepend']=$o['MPX_PATH_PREPEND']");
  });

  it('verifies a managed prepend semantically while retaining the raw foreign Path', async () => {
    const runner = new Runner();
    runner.outputs.push(
      '{"ok":true}',
      '{"owner":"mpx","PathPrepend":"C:\\\\Apps","Path":"C:\\\\Apps;C:\\\\Foreign;C:\\\\Tools","FOREIGN":"keep"}',
    );
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });

    await expect(
      store.write('HKCU\\Environment', {
        owner: 'mpx',
        Path: 'C:\\Foreign;C:\\Tools',
        PathPrepend: 'C:\\Apps',
      }),
    ).resolves.toBeUndefined();
    const script = callAt(runner, 0).script;
    expect(script).toContain(".Split([char]';',[System.StringSplitOptions]::None)");
    expect(script).toContain("GetValueKind('Path')");
  });

  it('verifies a realistic managed write containing the prior raw Path and desired prepend', async () => {
    const runner = new Runner();
    runner.outputs.push(
      '{"ok":true}',
      '{"owner":"mpx","MPX_APPS":"C:\\\\Apps","PathPrepend":"C:\\\\Apps\\\\mpx\\\\bin","Path":"C:\\\\Apps\\\\mpx\\\\bin;C:\\\\Foreign;C:\\\\Tools","TEMP":"C:\\\\Temp"}',
    );
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });

    await expect(
      store.write('HKCU\\Environment', {
        owner: 'mpx',
        MPX_APPS: 'C:\\Apps',
        Path: 'C:\\Foreign;C:\\Tools',
        TEMP: 'C:\\Temp',
        PathPrepend: 'C:\\Apps\\mpx\\bin',
      }),
    ).resolves.toBeUndefined();
  });

  it('normalizes exact prefix duplicates out of the desired raw Path', async () => {
    const runner = new Runner();
    runner.outputs.push(
      '{"ok":true}',
      '{"owner":"mpx","PathPrepend":"C:\\\\Apps\\\\mpx\\\\bin","Path":"C:\\\\Apps\\\\mpx\\\\bin;C:\\\\Foreign;C:\\\\Tools"}',
    );
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });

    await expect(
      store.write('HKCU\\Environment', {
        owner: 'mpx',
        Path: 'C:\\Apps\\mpx\\bin;C:\\Foreign;C:\\Apps\\mpx\\bin;C:\\Tools',
        PathPrepend: 'C:\\Apps\\mpx\\bin',
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['missing', 'C:\\Apps\\mpx\\bin;C:\\Foreign'],
    ['extra', 'C:\\Apps\\mpx\\bin;C:\\Foreign;C:\\Tools;C:\\Extra'],
    ['reordered', 'C:\\Apps\\mpx\\bin;C:\\Tools;C:\\Foreign'],
    ['changed', 'C:\\Apps\\mpx\\bin;C:\\Foreign;C:\\Other'],
    ['duplicate prefix', 'C:\\Apps\\mpx\\bin;C:\\Foreign;C:\\Apps\\mpx\\bin;C:\\Tools'],
  ])('rejects a %s post-write Path sequence', async (_case, actualPath) => {
    const runner = new Runner();
    runner.outputs.push(
      '{"ok":true}',
      JSON.stringify({
        owner: 'mpx',
        PathPrepend: 'C:\\Apps\\mpx\\bin',
        Path: actualPath,
      }),
    );
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });

    await expect(
      store.write('HKCU\\Environment', {
        owner: 'mpx',
        Path: 'C:\\Foreign;C:\\Tools',
        PathPrepend: 'C:\\Apps\\mpx\\bin',
      }),
    ).rejects.toMatchObject({ code: 'WINDOWS_RESOURCE_VERIFY_FAILED' });
  });

  it.each([
    ['changed desired field', { owner: 'foreign', TEMP: 'keep' }],
    ['unknown MPX-owned field', { owner: 'mpx', TEMP: 'keep', MPX_STALE: 'unexpected' }],
  ])('rejects a %s after a managed registry write', async (_case, actualFields) => {
    const runner = new Runner();
    runner.outputs.push(
      '{"ok":true}',
      JSON.stringify({
        ...actualFields,
        PathPrepend: 'C:\\Apps',
        Path: 'C:\\Apps;C:\\Foreign',
      }),
    );
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });

    await expect(
      store.write('HKCU\\Environment', {
        owner: 'mpx',
        TEMP: 'keep',
        Path: 'C:\\Foreign',
        PathPrepend: 'C:\\Apps',
      }),
    ).rejects.toMatchObject({ code: 'WINDOWS_RESOURCE_VERIFY_FAILED' });
  });

  it('restores a literal snapshot Path exactly or leaves an absent prior Path absent', async () => {
    const runner = new Runner();
    const snapshot = { TEMP: 'C:\\Foreign', Path: 'C:\\Foreign;;C:\\Tools;' };
    runner.outputs.push(
      '{"ok":true}',
      JSON.stringify(snapshot),
      '{"ok":true}',
      '{"TEMP":"C:\\\\Foreign"}',
    );
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });

    await store.write('HKCU\\Environment', snapshot);
    await store.write('HKCU\\Environment', { TEMP: 'C:\\Foreign' });

    const literalScript = callAt(runner, 0).script;
    expect(literalScript).toContain("$d.value.PSObject.Properties['Path']");
    expect(literalScript).toContain('-Value ([string]$d.value.Path)');
    expect(literalScript).toContain(
      "Remove-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name Path",
    );
  });

  it('uses terminating native mutations and verifies desired or absent state', async () => {
    const runner = new Runner();
    runner.outputs.push(
      '{"ok":true}',
      '{"owner":"mpx","MPX_APPS":"C:\\\\Apps"}',
      '{"owner":"mpx","MPX_APPS":"C:\\\\Apps"}',
      '{"ok":true}',
      '{}',
    );
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });
    await store.write('HKCU\\Environment', { owner: 'mpx', MPX_APPS: 'C:\\Apps' });
    await store.remove('HKCU\\Environment');
    expect(callAt(runner, 0).script).toContain("$ErrorActionPreference='Stop'");
    expect(callAt(runner, 3).script).toContain("$ErrorActionPreference='Stop'");
    expect(runner.calls).toHaveLength(5);
  });

  it('uses native shortcut and scheduled-task operations with exact structured identities', async () => {
    const runner = new Runner();
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });
    const shortcut = 'C:\\Users\\me\\Desktop\\MPX.lnk',
      shortcutValue = {
        owner: 'mpx',
        targetPath: 'C:\\Apps\\mpx.cmd',
        argv: [],
        workingDirectory: 'C:\\Users\\me',
      };
    runner.outputs.push(
      '{"ok":true}',
      JSON.stringify({ ...shortcutValue, arguments: '' }),
      '{"ok":true}',
      'null',
    );
    await store.write(shortcut, shortcutValue);
    await store.remove(shortcut);
    const task = '\\MPX\\Session Capture',
      taskValue = {
        owner: 'mpx',
        executable: 'C:\\node.exe',
        argv: ['C:\\Apps\\mpx\\releases\\' + 'a'.repeat(64) + '\\bin\\mpx.mjs', 'session'],
        principal: 'DOMAIN\\me',
        logonType: 'InteractiveToken',
        runLevel: 'LeastPrivilege',
      };
    runner.outputs.push(
      '{"ok":true}',
      JSON.stringify({ ...taskValue, arguments: '"' + taskValue.argv[0] + '" session' }),
      '{"started":true}',
    );
    await store.write(task, taskValue);
    await store.runScheduledTask(task);
    expect(runner.calls.map((call) => JSON.parse(resourceJson(call)).target)).toEqual([
      shortcut,
      shortcut,
      shortcut,
      shortcut,
      task,
      task,
      task,
    ]);
    expect(callAt(runner, 4).script).toContain('Register-ScheduledTask');
    expect(callAt(runner, 6).script).toContain('Start-ScheduledTask');
    expect(
      runner.calls.every(
        (call) => !call.script.includes(shortcut) && !call.script.includes('DOMAIN\\me'),
      ),
    ).toBe(true);
  });

  it('parses production PowerShell scheduled-task fixture with hashes, trigger, and settings', async () => {
    const runner = new Runner();
    runner.outputs.push(
      await readFile(
        fileURLToPath(new URL('../fixtures/powershell-scheduled-task.json', import.meta.url)),
        'utf8',
      ),
    );
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });
    await expect(store.read('\\MPX\\Session Capture')).resolves.toMatchObject({
      executableSha256: 'a'.repeat(64),
      cliSha256: 'b'.repeat(64),
      argv: ['C:\\MPX Apps\\mpx.mjs', 'session', 'reconcile'],
      trigger: { cadenceMinutes: 10 },
      settings: { multipleInstances: 'IgnoreNew', executionTimeLimitSeconds: 300 },
    });
  });

  it('returns structured manual-run status evidence', async () => {
    const runner = new Runner();
    runner.outputs.push(
      '{"exists":true,"state":"Ready","lastResult":0,"lastRunAt":"2025-01-01T00:00:00.000Z"}',
    );
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });
    await expect(store.inspectScheduledTaskStatus('\\MPX\\Session Capture')).resolves.toEqual({
      exists: true,
      state: 'Ready',
      lastResult: 0,
      lastRunAt: '2025-01-01T00:00:00.000Z',
    });
    expect(callAt(runner, 0).script).toContain('Get-ScheduledTaskInfo');
  });

  it('rejects unsupported targets before invoking PowerShell', async () => {
    const runner = new Runner();
    const store = new ProductionWindowsResourceStore({ platform: 'win32', runner });
    await expect(store.read('HKCU\\Software\\Foreign')).rejects.toMatchObject({
      code: 'WINDOWS_RESOURCE_INVALID',
    });
    expect(runner.calls).toHaveLength(0);
  });
});
