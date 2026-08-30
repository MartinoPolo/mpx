import path from 'node:path';
import { MpxError, parseStrictJson } from '@mpx/core';
import { NativePowerShellRunner, type PowerShellRunner, type PowerShellResult } from './adapter.js';

export type ScheduledTaskLogonType = 'InteractiveToken';
export type ScheduledTaskRunLevel = 'LeastPrivilege' | 'Highest';
export type ScheduledTaskMultipleInstances = 'IgnoreNew' | 'Parallel' | 'Queue' | 'StopExisting';
export interface ScheduledTaskSpec {
  taskPath: string;
  taskName: string;
  action: { executable: string; argv: readonly string[] };
  principal: { userId: string; logonType: ScheduledTaskLogonType; runLevel: ScheduledTaskRunLevel };
  trigger: { cadenceMinutes: number };
  settings: {
    startWhenAvailable: boolean;
    multipleInstances: ScheduledTaskMultipleInstances;
    executionTimeLimitSeconds: number;
    hidden: boolean;
    enabled: boolean;
  };
}
export interface ScheduledTaskInspection extends ScheduledTaskSpec {
  exists: true;
  lastResult?: number;
  lastRunAt?: string;
  nextRunAt?: string;
}
export interface ScheduledTaskAdapter {
  readonly available: boolean;
  inspect(taskPath: string, taskName: string): Promise<ScheduledTaskInspection | undefined>;
  install(spec: ScheduledTaskSpec): Promise<void>;
  remove(taskPath: string, taskName: string): Promise<void>;
}
export interface WindowsScheduledTaskAdapterOptions {
  platform?: NodeJS.Platform;
  runner?: PowerShellRunner;
}

const INSTALL = String.raw`$d = ConvertFrom-Json $env:MPX_SCHEDULED_TASK_JSON
$a = New-ScheduledTaskAction -Execute $d.action.executable -Argument $d.action.arguments
$t = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $d.trigger.cadenceMinutes)
$runLevel = if($d.principal.runLevel -eq 'LeastPrivilege'){'Limited'}else{'Highest'}
$p = New-ScheduledTaskPrincipal -UserId $d.principal.userId -LogonType Interactive -RunLevel $runLevel
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable:$d.settings.startWhenAvailable -MultipleInstances $d.settings.multipleInstances -ExecutionTimeLimit (New-TimeSpan -Seconds $d.settings.executionTimeLimitSeconds) -Hidden:$d.settings.hidden
Register-ScheduledTask -TaskPath $d.taskPath -TaskName $d.taskName -Action $a -Trigger $t -Principal $p -Settings $s -Force -ErrorAction Stop | Out-Null
if(-not [bool]$d.settings.enabled){ Disable-ScheduledTask -TaskPath $d.taskPath -TaskName $d.taskName -ErrorAction Stop | Out-Null }
@{ok=$true} | ConvertTo-Json -Compress`;
const INSPECT = String.raw`$d = ConvertFrom-Json $env:MPX_SCHEDULED_TASK_JSON
try { $t = Get-ScheduledTask -TaskPath $d.taskPath -TaskName $d.taskName -ErrorAction Stop }
catch { if($_.Exception.HResult -eq -2147024894 -or $_.CategoryInfo.Category -eq 'ObjectNotFound'){ $null | ConvertTo-Json -Compress; exit 0 }; throw }
$i = Get-ScheduledTaskInfo -TaskPath $d.taskPath -TaskName $d.taskName -ErrorAction Stop
$a = @($t.Actions)[0]; $g = @($t.Triggers)[0]
[ordered]@{exists=$true;taskPath=[string]$t.TaskPath;taskName=[string]$t.TaskName;action=@{executable=[string]$a.Execute;arguments=[string]$a.Arguments};principal=@{userId=[string]$t.Principal.UserId;logonType=[string]$t.Principal.LogonType;runLevel=[string]$t.Principal.RunLevel};trigger=@{cadenceMinutes=[int]$g.Repetition.Interval.TotalMinutes};settings=@{startWhenAvailable=[bool]$t.Settings.StartWhenAvailable;multipleInstances=[string]$t.Settings.MultipleInstances;executionTimeLimitSeconds=[int]$t.Settings.ExecutionTimeLimit.TotalSeconds;hidden=[bool]$t.Settings.Hidden;enabled=[bool]$t.Settings.Enabled};lastResult=[int]$i.LastTaskResult;lastRunAt=if($i.LastRunTime){$i.LastRunTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}else{$null};nextRunAt=if($i.NextRunTime){$i.NextRunTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}else{$null}} | ConvertTo-Json -Compress -Depth 6`;
const REMOVE = String.raw`$d = ConvertFrom-Json $env:MPX_SCHEDULED_TASK_JSON
try { Unregister-ScheduledTask -TaskPath $d.taskPath -TaskName $d.taskName -Confirm:$false -ErrorAction Stop }
catch { if($_.Exception.HResult -ne -2147024894 -and $_.CategoryInfo.Category -ne 'ObjectNotFound'){ throw } }
@{ok=$true} | ConvertTo-Json -Compress`;

function fail(code: string, message: string): never {
  throw new MpxError({ code, message });
}
function identity(taskPath: string, taskName: string): void {
  if (!/^\\(?:[^\\]+\\)*$/.test(taskPath) || taskPath.length > 240) {
    fail('SCHEDULED_TASK_INVALID', 'Invalid task path.');
  }
  if (!taskName || taskName.length > 200 || /[\\/\0-\x1f]/.test(taskName)) {
    fail('SCHEDULED_TASK_INVALID', 'Invalid task name.');
  }
}
function validate(spec: ScheduledTaskSpec): void {
  identity(spec.taskPath, spec.taskName);
  if (!path.win32.isAbsolute(spec.action.executable) || spec.action.executable.includes('\0')) {
    fail('SCHEDULED_TASK_INVALID', 'The action executable must be absolute.');
  }
  if (
    !Array.isArray(spec.action.argv) ||
    spec.action.argv.length > 128 ||
    spec.action.argv.some((x) => typeof x !== 'string' || x.length > 8192 || x.includes('\0'))
  ) {
    fail('SCHEDULED_TASK_INVALID', 'Invalid action arguments.');
  }
  if (
    !spec.principal.userId ||
    spec.principal.userId.length > 256 ||
    spec.principal.logonType !== 'InteractiveToken' ||
    !['LeastPrivilege', 'Highest'].includes(spec.principal.runLevel)
  ) {
    fail('SCHEDULED_TASK_INVALID', 'Invalid principal.');
  }
  if (
    !Number.isInteger(spec.trigger.cadenceMinutes) ||
    spec.trigger.cadenceMinutes < 1 ||
    spec.trigger.cadenceMinutes > 1440
  ) {
    fail('SCHEDULED_TASK_INVALID', 'Invalid cadence.');
  }
  if (
    typeof spec.settings.startWhenAvailable !== 'boolean' ||
    typeof spec.settings.hidden !== 'boolean' ||
    typeof spec.settings.enabled !== 'boolean' ||
    !['IgnoreNew', 'Parallel', 'Queue', 'StopExisting'].includes(spec.settings.multipleInstances)
  ) {
    fail('SCHEDULED_TASK_INVALID', 'Invalid settings.');
  }
  if (
    !Number.isInteger(spec.settings.executionTimeLimitSeconds) ||
    spec.settings.executionTimeLimitSeconds < 1 ||
    spec.settings.executionTimeLimitSeconds > 86400
  ) {
    fail('SCHEDULED_TASK_INVALID', 'Invalid execution limit.');
  }
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const item = value as Record<string, unknown>;
  return Object.keys(item).sort().join('\0') === [...keys].sort().join('\0') ? item : undefined;
}
function canonicalOptionalTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    fail('SCHEDULED_TASK_MALFORMED', 'ScheduledTasks returned an invalid timestamp.');
  }
  return value;
}
export function encodeWindowsArgv(argv: readonly string[]): string {
  return argv
    .map((a) =>
      !a || /[\s"]/u.test(a)
        ? `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
        : a,
    )
    .join(' ');
}
export function decodeWindowsArgv(command: string): string[] {
  const out: string[] = [];
  let value = '',
    quote = false,
    slash = 0;
  const pushSlash = () => {
    value += '\\'.repeat(slash);
    slash = 0;
  };
  for (let i = 0; i <= command.length; i++) {
    const c = command[i];
    if (c === '\\') {
      slash++;
      continue;
    }
    if (c === '"') {
      value += '\\'.repeat(Math.floor(slash / 2));
      if (slash % 2) {
        value += '"';
      } else {
        quote = !quote;
      }
      slash = 0;
      continue;
    }
    pushSlash();
    if (c === undefined || (!quote && /\s/.test(c))) {
      if (value || c === undefined) {
        out.push(value);
        value = '';
      }
      while (command[i + 1] && /\s/.test(command[i + 1]!)) {
        i++;
      }
      continue;
    }
    value += c;
  }
  return out.filter((x, i) => x.length > 0 || i < out.length - 1);
}

export class WindowsScheduledTaskAdapter implements ScheduledTaskAdapter {
  readonly available: boolean;
  private readonly runner: PowerShellRunner;
  constructor(options: WindowsScheduledTaskAdapterOptions = {}) {
    this.available = (options.platform ?? process.platform) === 'win32';
    this.runner = options.runner ?? new NativePowerShellRunner();
  }
  private async invoke(script: string, data: unknown): Promise<unknown> {
    if (!this.available) {
      fail('SCHEDULED_TASK_UNAVAILABLE', 'Windows ScheduledTasks capability is unavailable.');
    }
    let r: PowerShellResult;
    try {
      r = await this.runner.run(script, { ScheduledTaskJson: JSON.stringify(data) });
    } catch {
      fail('SCHEDULED_TASK_FAILED', 'Scheduled task operation failed.');
    }
    if (r.exitCode !== 0) {
      fail('SCHEDULED_TASK_FAILED', 'Scheduled task operation failed.');
    }
    try {
      return r.stdout.trim() ? parseStrictJson(r.stdout) : null;
    } catch {
      fail('SCHEDULED_TASK_MALFORMED', 'ScheduledTasks returned malformed JSON.');
    }
  }
  async install(spec: ScheduledTaskSpec): Promise<void> {
    validate(spec);
    await this.invoke(INSTALL, {
      ...spec,
      action: { ...spec.action, arguments: encodeWindowsArgv(spec.action.argv) },
    });
  }
  async inspect(taskPath: string, taskName: string): Promise<ScheduledTaskInspection | undefined> {
    identity(taskPath, taskName);
    const x = await this.invoke(INSPECT, { taskPath, taskName });
    if (x === null) {
      return undefined;
    }
    const r = record(x, [
        'exists',
        'taskPath',
        'taskName',
        'action',
        'principal',
        'trigger',
        'settings',
        'lastResult',
        'lastRunAt',
        'nextRunAt',
      ]),
      action = record(r?.action, ['executable', 'arguments']),
      principal = record(r?.principal, ['userId', 'logonType', 'runLevel']),
      trigger = record(r?.trigger, ['cadenceMinutes']),
      settings = record(r?.settings, [
        'startWhenAvailable',
        'multipleInstances',
        'executionTimeLimitSeconds',
        'hidden',
        'enabled',
      ]);
    if (
      !r ||
      r.exists !== true ||
      typeof r.taskPath !== 'string' ||
      typeof r.taskName !== 'string' ||
      !action ||
      typeof action.executable !== 'string' ||
      typeof action.arguments !== 'string' ||
      !principal ||
      typeof principal.userId !== 'string' ||
      !['Interactive', 'InteractiveToken'].includes(String(principal.logonType)) ||
      !['Limited', 'Highest'].includes(String(principal.runLevel)) ||
      !trigger ||
      !settings ||
      typeof r.lastResult !== 'number' ||
      !Number.isSafeInteger(r.lastResult)
    ) {
      fail('SCHEDULED_TASK_MALFORMED', 'ScheduledTasks returned malformed JSON.');
    }
    const lastRunAt = canonicalOptionalTimestamp(r.lastRunAt),
      nextRunAt = canonicalOptionalTimestamp(r.nextRunAt);
    const result: ScheduledTaskInspection = {
      exists: true,
      taskPath: r.taskPath,
      taskName: r.taskName,
      action: { executable: action.executable, argv: decodeWindowsArgv(action.arguments) },
      principal: {
        userId: principal.userId,
        logonType: 'InteractiveToken',
        runLevel: principal.runLevel === 'Limited' ? 'LeastPrivilege' : 'Highest',
      },
      trigger: { cadenceMinutes: trigger.cadenceMinutes as number },
      settings: {
        startWhenAvailable: settings.startWhenAvailable as boolean,
        multipleInstances: settings.multipleInstances as ScheduledTaskMultipleInstances,
        executionTimeLimitSeconds: settings.executionTimeLimitSeconds as number,
        hidden: settings.hidden as boolean,
        enabled: settings.enabled as boolean,
      },
      lastResult: r.lastResult,
      ...(lastRunAt === undefined ? {} : { lastRunAt }),
      ...(nextRunAt === undefined ? {} : { nextRunAt }),
    };
    try {
      validate(result);
    } catch {
      fail('SCHEDULED_TASK_MALFORMED', 'ScheduledTasks returned malformed fields.');
    }
    return result;
  }
  async remove(taskPath: string, taskName: string): Promise<void> {
    identity(taskPath, taskName);
    await this.invoke(REMOVE, { taskPath, taskName });
  }
}
