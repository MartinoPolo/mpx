import { describe, expect, it } from 'vitest';
import { MpxError } from '@mpx/core';
import {
  WindowsScheduledTaskAdapter,
  type PowerShellRunner,
  type ScheduledTaskSpec,
} from './scheduled-task.js';

const spec: ScheduledTaskSpec = {
  taskPath: '\\MPX\\',
  taskName: 'Session Capture',
  action: {
    executable: 'C:\\MPX\\runner.exe',
    argv: ['session', 'reconcile', '--capture', 'scheduled', '--json'],
  },
  principal: { userId: 'me', logonType: 'InteractiveToken', runLevel: 'LeastPrivilege' },
  trigger: { cadenceMinutes: 10 },
  settings: {
    startWhenAvailable: true,
    multipleInstances: 'IgnoreNew',
    executionTimeLimitSeconds: 300,
    hidden: true,
    enabled: true,
  },
};

describe('WindowsScheduledTaskAdapter', () => {
  it('passes dynamic task values as JSON environment data, never script interpolation', async () => {
    let call: { script: string; parameters?: Readonly<Record<string, string>> } | undefined;
    const runner: PowerShellRunner = {
      run: async (script, parameters) => {
        call = { script, parameters };
        return { stdout: JSON.stringify({ ok: true }), stderr: '', exitCode: 0 };
      },
    };
    await new WindowsScheduledTaskAdapter({ platform: 'win32', runner }).install({
      ...spec,
      taskName: "x'; Write-Error pwn; '",
    });
    expect(call!.script).not.toContain('Write-Error pwn');
    expect(JSON.parse(call!.parameters!.ScheduledTaskJson)).toMatchObject({
      taskName: "x'; Write-Error pwn; '",
    });
  });
  it('honors disabled settings and round-trips Windows argv', async () => {
    const calls: string[] = [];
    const runner: PowerShellRunner = {
      run: async (script) => {
        calls.push(script);
        if (script.includes('Get-ScheduledTask ')) {
          return {
            stdout: JSON.stringify({
              ...spec,
              action: { executable: spec.action.executable, arguments: '"a b" "c\\\\\\\"d"' },
              principal: { ...spec.principal, logonType: 'Interactive', runLevel: 'Limited' },
              exists: true,
              lastResult: 0,
              lastRunAt: null,
              nextRunAt: null,
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: '', exitCode: 0 };
      },
    };
    const adapter = new WindowsScheduledTaskAdapter({ platform: 'win32', runner });
    await adapter.install({ ...spec, settings: { ...spec.settings, enabled: false } });
    expect(calls[0]).toContain('Disable-ScheduledTask');
    expect((await adapter.inspect(spec.taskPath, spec.taskName))?.action.argv).toEqual([
      'a b',
      'c\\"d',
    ]);
  });
  it('accepts the normalized InteractiveToken logon enum returned by Windows', async () => {
    const runner: PowerShellRunner = {
      run: async () => ({
        stdout: JSON.stringify({
          ...spec,
          exists: true,
          action: { executable: spec.action.executable, arguments: '' },
          principal: { ...spec.principal, logonType: 'InteractiveToken', runLevel: 'Limited' },
          lastResult: 0,
          lastRunAt: null,
          nextRunAt: null,
        }),
        stderr: '',
        exitCode: 0,
      }),
    };
    await expect(
      new WindowsScheduledTaskAdapter({ platform: 'win32', runner }).inspect(
        spec.taskPath,
        spec.taskName,
      ),
    ).resolves.toMatchObject({ principal: { logonType: 'InteractiveToken' } });
  });
  it('rejects malformed inspection fields', async () => {
    const runner: PowerShellRunner = {
      run: async () => ({
        stdout: JSON.stringify({
          ...spec,
          exists: true,
          action: { executable: spec.action.executable, arguments: '' },
          principal: { ...spec.principal, logonType: 'Interactive', runLevel: 'Limited' },
          trigger: { cadenceMinutes: 0 },
          lastResult: 0,
          lastRunAt: null,
          nextRunAt: null,
        }),
        stderr: '',
        exitCode: 0,
      }),
    };
    await expect(
      new WindowsScheduledTaskAdapter({ platform: 'win32', runner }).inspect(
        spec.taskPath,
        spec.taskName,
      ),
    ).rejects.toMatchObject({ code: 'SCHEDULED_TASK_MALFORMED' });
  });
  it('propagates inspection provider failures', async () => {
    const runner: PowerShellRunner = {
      run: async () => ({ stdout: '', stderr: 'access denied', exitCode: 1 }),
    };
    await expect(
      new WindowsScheduledTaskAdapter({ platform: 'win32', runner }).inspect(
        spec.taskPath,
        spec.taskName,
      ),
    ).rejects.toMatchObject({ code: 'SCHEDULED_TASK_FAILED' });
  });
  it('reports unavailable away from Windows', async () => {
    await expect(
      new WindowsScheduledTaskAdapter({ platform: 'linux' }).inspect('\\MPX\\', 'Session Capture'),
    ).rejects.toMatchObject<MpxError>({ code: 'SCHEDULED_TASK_UNAVAILABLE' });
  });
});
