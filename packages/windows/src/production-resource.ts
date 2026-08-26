import path from "node:path";
import { MpxError, parseStrictJson } from "@mpx/core";
import type { JsonResourceStore } from "./system-integration.js";
import { NativePowerShellRunner, type PowerShellResult, type PowerShellRunner } from "./adapter.js";
import { decodeWindowsArgv, encodeWindowsArgv } from "./scheduled-task.js";

const REGISTRY_TARGET = "HKCU\\Environment";
const TASK_TARGET = /^\\MPX\\[^\\]+$/u;
const SHORTCUT_TARGET = /^[A-Za-z]:\\.+\.lnk$/iu;
const ENV = "NativeResourceJson";

const REGISTRY_READ = String.raw`$d=ConvertFrom-Json $env:MPX_NATIVE_RESOURCE_JSON
$p=Get-ItemProperty -LiteralPath 'HKCU:\Environment' -ErrorAction SilentlyContinue
if($null-eq $p){$null|ConvertTo-Json -Compress;exit 0}
$o=[ordered]@{};foreach($x in $p.PSObject.Properties){if($x.Name -notmatch '^PS'){$n=if($x.Name-eq'MPX_OWNER'){'owner'}else{$x.Name};$o[$n]=[string]$x.Value}}
if($o.Contains('MPX_PATH_PREPEND')){$o['PathPrepend']=$o['MPX_PATH_PREPEND'];$o.Remove('MPX_PATH_PREPEND')}
$o|ConvertTo-Json -Compress -Depth 5`;
const REGISTRY_WRITE = String.raw`$d=ConvertFrom-Json $env:MPX_NATIVE_RESOURCE_JSON
New-Item -Path 'HKCU:\Environment' -Force|Out-Null
foreach($x in $d.value.PSObject.Properties){$n=if($x.Name-eq'owner'){'MPX_OWNER'}elseif($x.Name-eq'PathPrepend'){'MPX_PATH_PREPEND'}else{$x.Name};if($n -eq'MPX_OWNER'-or $n -eq'MPX_PATH_PREPEND'-or $n -match '^MPX_'){Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name $n -Value ([string]$x.Value) -Type String}}
if($d.value.PathPrepend){$old=[string](Get-ItemPropertyValue -LiteralPath 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue);$parts=@($old-split';'|Where-Object{$_-and $_-cne [string]$d.value.PathPrepend});Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value ((@([string]$d.value.PathPrepend)+$parts)-join';') -Type ExpandString}
@{ok=$true}|ConvertTo-Json -Compress`;
const REGISTRY_REMOVE = String.raw`$d=ConvertFrom-Json $env:MPX_NATIVE_RESOURCE_JSON
$p=Get-ItemProperty -LiteralPath 'HKCU:\Environment' -ErrorAction SilentlyContinue;if($p){$prefix=[string]$p.MPX_PATH_PREPEND;foreach($x in @($p.PSObject.Properties.Name|Where-Object{$_-eq'MPX_OWNER'-or $_-eq'MPX_PATH_PREPEND'-or $_-match'^MPX_'})){Remove-ItemProperty -LiteralPath 'HKCU:\Environment' -Name $x -ErrorAction SilentlyContinue};if($prefix){$old=[string]$p.Path;Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value ((@($old-split';'|Where-Object{$_-and $_-cne $prefix}))-join';') -Type ExpandString}}
@{ok=$true}|ConvertTo-Json -Compress`;

const SHORTCUT_READ = String.raw`$d=ConvertFrom-Json $env:MPX_NATIVE_RESOURCE_JSON
if(-not(Test-Path -LiteralPath $d.target -PathType Leaf)){$null|ConvertTo-Json -Compress;exit 0}
$s=(New-Object -ComObject WScript.Shell).CreateShortcut([string]$d.target)
$o=if([string]$s.Description -eq'MPX owner=mpx'){[ordered]@{owner='mpx';targetPath=[string]$s.TargetPath;arguments=[string]$s.Arguments;workingDirectory=[string]$s.WorkingDirectory}}else{[ordered]@{owner='foreign';targetPath=[string]$s.TargetPath;arguments=[string]$s.Arguments;workingDirectory=[string]$s.WorkingDirectory}}
$o|ConvertTo-Json -Compress -Depth 4`;
const SHORTCUT_WRITE = String.raw`$d=ConvertFrom-Json $env:MPX_NATIVE_RESOURCE_JSON
$parent=Split-Path -Parent ([string]$d.target);New-Item -ItemType Directory -Path $parent -Force|Out-Null
$s=(New-Object -ComObject WScript.Shell).CreateShortcut([string]$d.target);$s.TargetPath=[string]$d.value.targetPath;$s.Arguments=[string]$d.value.arguments;$s.WorkingDirectory=[string]$d.value.workingDirectory;$s.Description='MPX owner=mpx';$s.Save();@{ok=$true}|ConvertTo-Json -Compress`;
const SHORTCUT_REMOVE = String.raw`$d=ConvertFrom-Json $env:MPX_NATIVE_RESOURCE_JSON
Remove-Item -LiteralPath ([string]$d.target) -Force -ErrorAction SilentlyContinue;@{ok=$true}|ConvertTo-Json -Compress`;

const TASK_PARTS = String.raw`$full=[string]$d.target;$at=$full.LastIndexOf('\');$taskPath=$full.Substring(0,$at+1);$taskName=$full.Substring($at+1)`;
const TASK_READ = String.raw`$d=ConvertFrom-Json $env:MPX_NATIVE_RESOURCE_JSON
${TASK_PARTS}
try{$t=Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop}catch{if($_.CategoryInfo.Category-eq'ObjectNotFound'){$null|ConvertTo-Json -Compress;exit 0};throw}
$a=@($t.Actions)[0];$owner=if([string]$t.Description-eq'MPX owner=mpx'){'mpx'}else{'foreign'}
[ordered]@{owner=$owner;executable=[string]$a.Execute;arguments=[string]$a.Arguments;principal=[string]$t.Principal.UserId;logonType='InteractiveToken';runLevel=if([string]$t.Principal.RunLevel-eq'Highest'){'Highest'}else{'LeastPrivilege'}}|ConvertTo-Json -Compress -Depth 4`;
const TASK_WRITE = String.raw`$d=ConvertFrom-Json $env:MPX_NATIVE_RESOURCE_JSON
${TASK_PARTS}
$a=New-ScheduledTaskAction -Execute ([string]$d.value.executable) -Argument ([string]$d.value.arguments)
$tr=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
$level=if($d.value.runLevel-eq'Highest'){'Highest'}else{'Limited'};$p=New-ScheduledTaskPrincipal -UserId ([string]$d.value.principal) -LogonType Interactive -RunLevel $level
$s=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Description 'MPX owner=mpx' -Action $a -Trigger $tr -Principal $p -Settings $s -Force -ErrorAction Stop|Out-Null;@{ok=$true}|ConvertTo-Json -Compress`;
const TASK_REMOVE = String.raw`$d=ConvertFrom-Json $env:MPX_NATIVE_RESOURCE_JSON
${TASK_PARTS}
Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue;@{ok=$true}|ConvertTo-Json -Compress`;
const TASK_RUN = String.raw`$d=ConvertFrom-Json $env:MPX_NATIVE_RESOURCE_JSON
${TASK_PARTS}
Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop;@{started=$true}|ConvertTo-Json -Compress`;
const TASK_STATUS = String.raw`$d=ConvertFrom-Json $env:MPX_NATIVE_RESOURCE_JSON
${TASK_PARTS}
try{$t=Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop;$i=Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop}catch{if($_.CategoryInfo.Category-eq'ObjectNotFound'){@{exists=$false}|ConvertTo-Json -Compress;exit 0};throw}
[ordered]@{exists=$true;state=[string]$t.State;lastResult=[int]$i.LastTaskResult;lastRunAt=if($i.LastRunTime -and $i.LastRunTime.Year -gt 1900){$i.LastRunTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}else{$null};nextRunAt=if($i.NextRunTime -and $i.NextRunTime.Year -gt 1900){$i.NextRunTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}else{$null}}|ConvertTo-Json -Compress`;

export interface ScheduledTaskStatusEvidence { readonly exists: boolean; readonly state?: string; readonly lastResult?: number; readonly lastRunAt?: string; readonly nextRunAt?: string }

function fail(code: string, message: string): never { throw new MpxError({ code, message }); }
function classify(target: string): "registry" | "shortcut" | "task" {
  if (target === REGISTRY_TARGET) return "registry";
  if (SHORTCUT_TARGET.test(target) && path.win32.isAbsolute(target)) return "shortcut";
  if (TASK_TARGET.test(target)) return "task";
  return fail("WINDOWS_RESOURCE_INVALID", "Unsupported native Windows resource target.");
}
export interface ProductionWindowsResourceStoreOptions { readonly platform?: NodeJS.Platform; readonly runner?: PowerShellRunner }
export class ProductionWindowsResourceStore implements JsonResourceStore {
  private readonly runner: PowerShellRunner; private readonly available: boolean;
  constructor(options: ProductionWindowsResourceStoreOptions = {}) { this.available = (options.platform ?? process.platform) === "win32"; this.runner = options.runner ?? new NativePowerShellRunner(); }
  private async invoke(script: string, data: unknown): Promise<unknown> {
    if (!this.available) fail("WINDOWS_RESOURCE_UNAVAILABLE", "Native Windows resources are unavailable.");
    let result: PowerShellResult; try { result = await this.runner.run(script, { [ENV]: JSON.stringify(data) }); } catch { return fail("WINDOWS_RESOURCE_FAILED", "Native Windows resource operation failed."); }
    if (result.exitCode !== 0) fail("WINDOWS_RESOURCE_FAILED", "Native Windows resource operation failed.");
    try { return result.stdout.trim() ? parseStrictJson(result.stdout) : null; } catch { return fail("WINDOWS_RESOURCE_MALFORMED", "Native Windows resource operation returned malformed JSON."); }
  }
  async read(target: string): Promise<unknown | undefined> { const kind = classify(target); const value = await this.invoke(kind === "registry" ? REGISTRY_READ : kind === "shortcut" ? SHORTCUT_READ : TASK_READ, { target }); if (value === null) return undefined; if (kind !== "registry" && value && typeof value === "object" && !Array.isArray(value)) { const { arguments: encoded, ...rest } = value as Record<string, unknown>; if (typeof encoded !== "string") fail("WINDOWS_RESOURCE_MALFORMED", "Native Windows resource arguments are malformed."); return { ...rest, argv: decodeWindowsArgv(encoded) }; } return value; }
  async write(target: string, value: unknown): Promise<void> { const kind = classify(target); let encoded = value; if (kind !== "registry" && value && typeof value === "object" && !Array.isArray(value)) { const { argv, ...rest } = value as Record<string, unknown>; if (!Array.isArray(argv) || argv.some(argument => typeof argument !== "string")) fail("WINDOWS_RESOURCE_INVALID", "Native Windows resource arguments are invalid."); encoded = { ...rest, arguments: encodeWindowsArgv(argv as string[]) }; } await this.invoke(kind === "registry" ? REGISTRY_WRITE : kind === "shortcut" ? SHORTCUT_WRITE : TASK_WRITE, { target, value: encoded }); }
  async remove(target: string): Promise<void> { const kind = classify(target); await this.invoke(kind === "registry" ? REGISTRY_REMOVE : kind === "shortcut" ? SHORTCUT_REMOVE : TASK_REMOVE, { target }); }
  async runScheduledTask(target: string): Promise<void> { if (classify(target) !== "task") fail("WINDOWS_RESOURCE_INVALID", "A scheduled task target is required."); await this.invoke(TASK_RUN, { target }); }
  async inspectScheduledTaskStatus(target: string): Promise<ScheduledTaskStatusEvidence> {
    if (classify(target) !== "task") fail("WINDOWS_RESOURCE_INVALID", "A scheduled task target is required.");
    const value = await this.invoke(TASK_STATUS, { target });
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("WINDOWS_RESOURCE_MALFORMED", "Scheduled task status is malformed.");
    const record = value as Record<string, unknown>, keys = Object.keys(record);
    if (record.exists === false && keys.length === 1) return { exists: false };
    if (record.exists !== true || typeof record.state !== "string" || !Number.isSafeInteger(record.lastResult) || keys.some(key => !["exists", "state", "lastResult", "lastRunAt", "nextRunAt"].includes(key))) fail("WINDOWS_RESOURCE_MALFORMED", "Scheduled task status is malformed.");
    const timestamp = (name: "lastRunAt" | "nextRunAt"): string | undefined => { const item = record[name]; if (item === null || item === undefined) return undefined; if (typeof item !== "string" || new Date(item).toISOString() !== item) fail("WINDOWS_RESOURCE_MALFORMED", "Scheduled task status timestamp is malformed."); return item; };
    const lastRunAt = timestamp("lastRunAt"), nextRunAt = timestamp("nextRunAt");
    return { exists: true, state: record.state, lastResult: record.lastResult as number, ...(lastRunAt ? { lastRunAt } : {}), ...(nextRunAt ? { nextRunAt } : {}) };
  }
}
