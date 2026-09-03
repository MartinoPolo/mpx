import path from 'node:path';
import { MpxError, parseStrictJson } from '@mpx/core';
import type { JsonResourceStore } from './system-integration.js';
import { NativePowerShellRunner, type PowerShellResult, type PowerShellRunner } from './adapter.js';

const REGISTRY_TARGET = 'HKCU\\Environment';
const SHORTCUT_TARGET = /^[A-Za-z]:\\.+\.lnk$/iu;
const ENV = 'NativeResourceJson';

const REGISTRY_READ = String.raw`$d=ConvertFrom-Json $env:MPX_NATIVE_RESOURCE_JSON
$p=Get-ItemProperty -LiteralPath 'HKCU:\Environment' -ErrorAction SilentlyContinue
if($null-eq $p){$null|ConvertTo-Json -Compress;exit 0}
$o=[ordered]@{};foreach($x in $p.PSObject.Properties){if($x.Name -notmatch '^PS'){$n=if($x.Name-eq'MPX_OWNER'){'owner'}else{$x.Name};$o[$n]=[string]$x.Value}}
if($o.Contains('MPX_PATH_PREPEND')){$o['PathPrepend']=$o['MPX_PATH_PREPEND'];$o.Remove('MPX_PATH_PREPEND')}
$o|ConvertTo-Json -Compress -Depth 5`;
const REGISTRY_WRITE = String.raw`$ErrorActionPreference='Stop'
$d=ConvertFrom-Json $env:MPX_NATIVE_RESOURCE_JSON
if(-not(Test-Path -LiteralPath 'HKCU:\Environment' -PathType Container)){New-Item -Path 'HKCU:\Environment' -ErrorAction Stop|Out-Null}
$key=Get-Item -LiteralPath 'HKCU:\Environment' -ErrorAction Stop
$p=Get-ItemProperty -LiteralPath 'HKCU:\Environment' -ErrorAction Stop
$pathProperty=$p.PSObject.Properties['Path'];$hasPath=$null-ne $pathProperty;$old=if($hasPath){[string]$pathProperty.Value}else{''};$pathType=if($hasPath){$key.GetValueKind('Path')}else{[Microsoft.Win32.RegistryValueKind]::ExpandString};$oldPrefix=[string]$p.MPX_PATH_PREPEND
$wanted=@($d.value.PSObject.Properties|ForEach-Object{if($_.Name-eq'owner'){'MPX_OWNER'}elseif($_.Name-eq'PathPrepend'){'MPX_PATH_PREPEND'}else{$_.Name}});foreach($n in @($p.PSObject.Properties.Name|Where-Object{($_-eq'MPX_OWNER'-or $_-eq'MPX_PATH_PREPEND'-or $_-match'^MPX_')-and $_-notin $wanted})){Remove-ItemProperty -LiteralPath 'HKCU:\Environment' -Name $n -ErrorAction Stop}
foreach($x in $d.value.PSObject.Properties){$n=if($x.Name-eq'owner'){'MPX_OWNER'}elseif($x.Name-eq'PathPrepend'){'MPX_PATH_PREPEND'}else{$x.Name};if($n -eq'MPX_OWNER'-or $n -eq'MPX_PATH_PREPEND'-or $n -match '^MPX_'){Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name $n -Value ([string]$x.Value) -Type String -ErrorAction Stop}}
$prependProperty=$d.value.PSObject.Properties['PathPrepend'];if($null-ne $prependProperty){$prefix=[string]$prependProperty.Value;$parts=if($hasPath){@($old.Split([char]';',[System.StringSplitOptions]::None)|Where-Object{(!$oldPrefix-or $_-cne $oldPrefix)-and $_-cne $prefix})}else{@()};$new=(@($prefix)+$parts)-join';';Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value $new -Type $pathType -ErrorAction Stop}else{$literalPath=$d.value.PSObject.Properties['Path'];if($null-ne $literalPath){Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value ([string]$d.value.Path) -Type $pathType -ErrorAction Stop}elseif($hasPath){Remove-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -ErrorAction Stop}}
@{ok=$true}|ConvertTo-Json -Compress`;
const REGISTRY_REMOVE = String.raw`$ErrorActionPreference='Stop'
$d=ConvertFrom-Json $env:MPX_NATIVE_RESOURCE_JSON
if(-not(Test-Path -LiteralPath 'HKCU:\Environment' -PathType Container)){@{ok=$true}|ConvertTo-Json -Compress;exit 0}
$key=Get-Item -LiteralPath 'HKCU:\Environment' -ErrorAction Stop
$p=Get-ItemProperty -LiteralPath 'HKCU:\Environment' -ErrorAction Stop;if($p){$prefix=[string]$p.MPX_PATH_PREPEND;$pathProperty=$p.PSObject.Properties['Path'];$hasPath=$null-ne $pathProperty;$old=if($hasPath){[string]$pathProperty.Value}else{''};$pathType=if($hasPath){$key.GetValueKind('Path')}else{[Microsoft.Win32.RegistryValueKind]::ExpandString};foreach($x in @($p.PSObject.Properties.Name|Where-Object{$_-eq'MPX_OWNER'-or $_-eq'MPX_PATH_PREPEND'-or $_-match'^MPX_'})){Remove-ItemProperty -LiteralPath 'HKCU:\Environment' -Name $x -ErrorAction Stop};if($prefix-and $hasPath){$remaining=@($old.Split([char]';',[System.StringSplitOptions]::None)|Where-Object{$_-cne $prefix});if($remaining.Count){Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value ($remaining-join';') -Type $pathType -ErrorAction Stop}else{Remove-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -ErrorAction Stop}}}
@{ok=$true}|ConvertTo-Json -Compress`;

const SHORTCUT_READ = String.raw`$d=ConvertFrom-Json $env:MPX_NATIVE_RESOURCE_JSON
if(-not(Test-Path -LiteralPath $d.target -PathType Leaf)){$null|ConvertTo-Json -Compress;exit 0}
$s=(New-Object -ComObject WScript.Shell).CreateShortcut([string]$d.target)
$o=if([string]$s.Description -eq'MPX owner=mpx'){[ordered]@{owner='mpx';targetPath=[string]$s.TargetPath;arguments=[string]$s.Arguments;workingDirectory=[string]$s.WorkingDirectory}}else{[ordered]@{owner='foreign';targetPath=[string]$s.TargetPath;arguments=[string]$s.Arguments;workingDirectory=[string]$s.WorkingDirectory}}
$o|ConvertTo-Json -Compress -Depth 4`;
const SHORTCUT_WRITE = String.raw`$ErrorActionPreference='Stop'
$d=ConvertFrom-Json $env:MPX_NATIVE_RESOURCE_JSON
$parent=Split-Path -Parent ([string]$d.target);New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop|Out-Null
$s=(New-Object -ComObject WScript.Shell).CreateShortcut([string]$d.target);$s.TargetPath=[string]$d.value.targetPath;$s.Arguments=[string]$d.value.arguments;$s.WorkingDirectory=[string]$d.value.workingDirectory;$s.Description='MPX owner=mpx';$s.Save();@{ok=$true}|ConvertTo-Json -Compress`;
const SHORTCUT_REMOVE = String.raw`$ErrorActionPreference='Stop'
$d=ConvertFrom-Json $env:MPX_NATIVE_RESOURCE_JSON
if(Test-Path -LiteralPath ([string]$d.target)){Remove-Item -LiteralPath ([string]$d.target) -Force -ErrorAction Stop};@{ok=$true}|ConvertTo-Json -Compress`;

function encodeWindowsArgv(argv: readonly string[]): string {
  return argv
    .map((argument) =>
      !argument || /[\s"]/u.test(argument)
        ? `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
        : argument,
    )
    .join(' ');
}
function decodeWindowsArgv(command: string): string[] {
  const output: string[] = [];
  let value = '',
    quoted = false,
    slashes = 0;
  const pushSlashes = () => {
    value += '\\'.repeat(slashes);
    slashes = 0;
  };
  for (let index = 0; index <= command.length; index++) {
    const character = command[index];
    if (character === '\\') {
      slashes++;
      continue;
    }
    if (character === '"') {
      value += '\\'.repeat(Math.floor(slashes / 2));
      if (slashes % 2) {
        value += '"';
      } else {
        quoted = !quoted;
      }
      slashes = 0;
      continue;
    }
    pushSlashes();
    if (character === undefined || (!quoted && /\s/u.test(character))) {
      if (value || character === undefined) {
        output.push(value);
        value = '';
      }
      while (command[index + 1] && /\s/u.test(command[index + 1]!)) {
        index++;
      }
      continue;
    }
    value += character;
  }
  return output.filter((item, index) => item.length > 0 || index < output.length - 1);
}
function fail(code: string, message: string): never {
  throw new MpxError({ code, message });
}
function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function registryWriteMatches(actual: unknown, desired: unknown): boolean {
  const current = record(actual),
    wanted = record(desired);
  if (!current || !wanted) {
    return false;
  }
  if (typeof wanted.PathPrepend !== 'string') {
    return stable(current) === stable(wanted);
  }
  if (
    Object.entries(wanted).some(
      ([key, value]) => key !== 'Path' && stable(current[key]) !== stable(value),
    ) ||
    Object.keys(current).some(
      (key) =>
        (key === 'owner' || key === 'PathPrepend' || key.startsWith('MPX_')) && !(key in wanted),
    ) ||
    typeof current.Path !== 'string' ||
    (wanted.Path !== undefined && typeof wanted.Path !== 'string')
  ) {
    return false;
  }
  const rawEntries = typeof wanted.Path === 'string' ? wanted.Path.split(';') : [],
    expectedEntries = [
      wanted.PathPrepend,
      ...rawEntries.filter((entry) => entry !== wanted.PathPrepend),
    ];
  return current.Path === expectedEntries.join(';');
}
function registryRemovalExpected(before: unknown): unknown {
  const previous = record(before);
  if (!previous) {
    return before;
  }
  const expected = Object.fromEntries(
      Object.entries(previous).filter(
        ([key]) => key !== 'owner' && key !== 'PathPrepend' && !key.startsWith('MPX_'),
      ),
    ),
    prefix = previous.PathPrepend;
  if (typeof prefix === 'string' && typeof previous.Path === 'string') {
    const remaining = previous.Path.split(';').filter((entry) => entry !== prefix);
    if (remaining.length) {
      expected.Path = remaining.join(';');
    } else {
      delete expected.Path;
    }
  }
  return expected;
}
function classify(target: string): 'registry' | 'shortcut' {
  if (target === REGISTRY_TARGET) {
    return 'registry';
  }
  if (SHORTCUT_TARGET.test(target) && path.win32.isAbsolute(target)) {
    return 'shortcut';
  }
  return fail('WINDOWS_RESOURCE_INVALID', 'Unsupported native Windows resource target.');
}
export interface ProductionWindowsResourceStoreOptions {
  readonly platform?: NodeJS.Platform;
  readonly runner?: PowerShellRunner;
}
export class ProductionWindowsResourceStore implements JsonResourceStore {
  private readonly runner: PowerShellRunner;
  private readonly available: boolean;
  constructor(options: ProductionWindowsResourceStoreOptions = {}) {
    this.available = (options.platform ?? process.platform) === 'win32';
    this.runner = options.runner ?? new NativePowerShellRunner();
  }
  private async invoke(script: string, data: unknown): Promise<unknown> {
    if (!this.available) {
      fail('WINDOWS_RESOURCE_UNAVAILABLE', 'Native Windows resources are unavailable.');
    }
    let result: PowerShellResult;
    try {
      result = await this.runner.run(script, { [ENV]: JSON.stringify(data) });
    } catch {
      return fail('WINDOWS_RESOURCE_FAILED', 'Native Windows resource operation failed.');
    }
    if (result.exitCode !== 0) {
      fail('WINDOWS_RESOURCE_FAILED', 'Native Windows resource operation failed.');
    }
    try {
      return result.stdout.trim() ? parseStrictJson(result.stdout) : null;
    } catch {
      return fail(
        'WINDOWS_RESOURCE_MALFORMED',
        'Native Windows resource operation returned malformed JSON.',
      );
    }
  }
  async read(target: string): Promise<unknown | undefined> {
    const kind = classify(target);
    const value = await this.invoke(kind === 'registry' ? REGISTRY_READ : SHORTCUT_READ, {
      target,
    });
    if (value === null) {
      return undefined;
    }
    if (kind !== 'registry' && value && typeof value === 'object' && !Array.isArray(value)) {
      const { arguments: encoded, ...rest } = value as Record<string, unknown>;
      if (typeof encoded !== 'string') {
        fail('WINDOWS_RESOURCE_MALFORMED', 'Native Windows resource arguments are malformed.');
      }
      return { ...rest, argv: decodeWindowsArgv(encoded) };
    }
    return value;
  }
  async write(target: string, value: unknown): Promise<void> {
    const kind = classify(target);
    let encoded = value;
    if (kind !== 'registry' && value && typeof value === 'object' && !Array.isArray(value)) {
      const { argv, ...rest } = value as Record<string, unknown>;
      if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== 'string')) {
        fail('WINDOWS_RESOURCE_INVALID', 'Native Windows resource arguments are invalid.');
      }
      encoded = { ...rest, arguments: encodeWindowsArgv(argv as string[]) };
    }
    await this.invoke(kind === 'registry' ? REGISTRY_WRITE : SHORTCUT_WRITE, {
      target,
      value: encoded,
    });
    const actual = await this.read(target);
    if (
      kind === 'registry' ? !registryWriteMatches(actual, value) : stable(actual) !== stable(value)
    ) {
      fail(
        'WINDOWS_RESOURCE_VERIFY_FAILED',
        'Native Windows resource did not reach desired state.',
      );
    }
  }
  async remove(target: string): Promise<void> {
    const kind = classify(target),
      before = kind === 'registry' ? await this.read(target) : undefined;
    await this.invoke(kind === 'registry' ? REGISTRY_REMOVE : SHORTCUT_REMOVE, { target });
    const actual = await this.read(target),
      removed =
        kind === 'registry'
          ? stable(actual) === stable(registryRemovalExpected(before))
          : actual === undefined;
    if (!removed) {
      fail('WINDOWS_RESOURCE_VERIFY_FAILED', 'Native Windows resource removal was not confirmed.');
    }
  }
}
