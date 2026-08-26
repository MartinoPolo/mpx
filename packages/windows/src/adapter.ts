import { execFile as execFileCallback } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import path from "node:path";
import { MpxError, parseStrictJson } from "@mpx/core";
import type { ListenerInfo, PortHold, PortPlatformAdapter, ProcessFingerprint, ProcessInfo } from "@mpx/ports";

export interface PowerShellResult { stdout: string; stderr: string; exitCode: number }
export interface PowerShellRunner { run(script: string, parameters?: Readonly<Record<string, string>>): Promise<PowerShellResult> }
export interface SocketBinding { release(): Promise<void> }
export interface SocketBinder { bind(port: number, host: "127.0.0.1" | "::1"): Promise<SocketBinding> }
export interface WindowsPortPlatformAdapterOptions { runner?: PowerShellRunner; binder?: SocketBinder }

const execFile = promisify(execFileCallback);
function nativePowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new MpxError({ code: "WINDOWS_POWERSHELL_UNAVAILABLE", message: "SystemRoot must identify an absolute Windows installation root." });
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export class NativePowerShellRunner implements PowerShellRunner {
  async run(script: string, parameters: Readonly<Record<string, string>> = {}): Promise<PowerShellResult> {
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
    const names: Readonly<Record<string, string>> = { PortsJson: "MPX_PORTS_JSON", PidValue: "MPX_PID_VALUE", StartedAt: "MPX_STARTED_AT", ScheduledTaskJson: "MPX_SCHEDULED_TASK_JSON" };
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) if (Object.values(names).includes(key.toUpperCase())) delete environment[key];
    for (const [name, value] of Object.entries(parameters)) {
      const environmentName = names[name];
      if (!environmentName) throw new Error("Unsupported PowerShell parameter");
      environment[environmentName] = value;
    }
    try {
      const { stdout, stderr } = await execFile(nativePowerShellExecutable(), args, { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: environment });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: typeof failure.code === "number" ? failure.code : 1 };
    }
  }
}

export class NodeSocketBinder implements SocketBinder {
  async bind(port: number, host: "127.0.0.1" | "::1"): Promise<SocketBinding> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.removeListener("listening", listening); reject(error); };
      const listening = () => { server.removeListener("error", failed); resolve(); };
      server.once("error", failed);
      server.once("listening", listening);
      server.listen({ port, host, exclusive: true, ...(host === "::1" ? { ipv6Only: true } : {}) });
    });
    let released = false;
    return { release: async () => {
      if (released) return;
      released = true;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } };
  }
}

const LISTENERS_SCRIPT = String.raw`$PortsJson = $env:MPX_PORTS_JSON
$wanted = @(); if ($PortsJson) { $wanted = ConvertFrom-Json $PortsJson }
$connections = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
if ($wanted.Count -gt 0) { $connections = @($connections | Where-Object { $wanted -contains $_.LocalPort }) }
$pids = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
$byPid = @{}; if ($pids.Count -gt 0) { Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $pids -contains $_.ProcessId } | ForEach-Object { $byPid[[int]$_.ProcessId] = $_ } }
@($connections | ForEach-Object {
  $p = $byPid[[int]$_.OwningProcess]
  [ordered]@{ LocalPort=[int]$_.LocalPort; LocalAddress=[string]$_.LocalAddress; OwningProcess=[int]$_.OwningProcess; Name=if($p){[string]$p.Name}else{$null}; ExecutablePath=if($p){[string]$p.ExecutablePath}else{$null}; StartedAt=if($p -and $p.CreationDate){$p.CreationDate.ToUniversalTime().ToString('o')}else{$null} }
}) | ConvertTo-Json -Compress -Depth 3`;

const PROCESS_SCRIPT = String.raw`$PidValue = [int]$env:MPX_PID_VALUE
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$PidValue" -ErrorAction Stop
if ($null -eq $p) { $null | ConvertTo-Json -Compress } else { [ordered]@{ ProcessId=[int]$p.ProcessId; Name=[string]$p.Name; ExecutablePath=[string]$p.ExecutablePath; StartedAt=if($p.CreationDate){$p.CreationDate.ToUniversalTime().ToString('o')}else{$null} } | ConvertTo-Json -Compress }`;

const KILL_SCRIPT = String.raw`$PidValue = [int]$env:MPX_PID_VALUE
$StartedAt = $env:MPX_STARTED_AT
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$PidValue" -ErrorAction Stop
if ($null -eq $p) { @{status='missing'} | ConvertTo-Json -Compress; exit 0 }
$actual = if($p.CreationDate){$p.CreationDate.ToUniversalTime().ToString('o')}else{''}
if ($actual -cne $StartedAt) { @{status='mismatch'} | ConvertTo-Json -Compress; exit 0 }
Stop-Process -Id $PidValue -Force -ErrorAction Stop
@{status='killed'} | ConvertTo-Json -Compress`;

const TREE_KILL_SCRIPT = String.raw`$PidValue = [int]$env:MPX_PID_VALUE
$StartedAt = $env:MPX_STARTED_AT
function Get-Fingerprint($Process) { if($Process.CreationDate){$Process.CreationDate.ToUniversalTime().ToString('o')}else{''} }
try {
  # Verify the complete root identity, then stop it before inspecting descendants again.
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $root = $all | Where-Object { $_.ProcessId -eq $PidValue } | Select-Object -First 1
  if ($null -eq $root) { @{status='missing'} | ConvertTo-Json -Compress; exit 0 }
  $actual = Get-Fingerprint $root
  if ($actual -cne $StartedAt) { @{status='mismatch'} | ConvertTo-Json -Compress; exit 0 }
  $rootCurrent = @(Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PidValue) -ErrorAction Stop)
  if ($rootCurrent.Count -eq 0) { @{status='missing'} | ConvertTo-Json -Compress; exit 0 }
  if ($rootCurrent.Count -ne 1 -or (Get-Fingerprint $rootCurrent[0]) -cne $StartedAt) { @{status='mismatch'} | ConvertTo-Json -Compress; exit 0 }
  Stop-Process -Id $PidValue -Force -ErrorAction Stop

  $maxAttempts = 20
  $consecutiveAbsent = 0
  $totalStopped = 1
  for ($attempt = 0; $attempt -lt $maxAttempts; $attempt++) {
    # Every pass uses a fresh complete table; the closure is rooted at the original PID.
    $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $rootCurrent = @($all | Where-Object { $_.ProcessId -eq $PidValue } | Select-Object -First 1)
    if ($rootCurrent.Count -gt 0 -and (Get-Fingerprint $rootCurrent[0]) -cne $StartedAt) { @{status='mismatch'} | ConvertTo-Json -Compress; exit 0 }
    $children = @{}
    foreach($item in $all){ $parent=[int]$item.ParentProcessId; if(!$children.ContainsKey($parent)){$children[$parent]=@()}; $children[$parent] += ,$item }
    $order = New-Object System.Collections.Generic.List[object]
    $visited = @{}
    function Add-Descendants([int]$parent){
      if($visited.ContainsKey($parent)){ return }
      $visited[$parent] = $true
      if(!$children.ContainsKey($parent)){ return }
      foreach($child in @($children[$parent])){ Add-Descendants ([int]$child.ProcessId); $order.Add($child) }
    }
    Add-Descendants $PidValue

    # The post-order closure is leaf-first. Never stop a PID without rechecking its birth fingerprint.
    foreach($child in $order){
      $snapshotFingerprint = Get-Fingerprint $child
      if (!$snapshotFingerprint) { @{status='unknown';reason='descendant-fingerprint-unavailable'} | ConvertTo-Json -Compress; exit 0 }
      $current = @(Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$child.ProcessId) -ErrorAction Stop)
      if ($current.Count -eq 0) { continue }
      if ($current.Count -ne 1 -or (Get-Fingerprint $current[0]) -cne $snapshotFingerprint) { @{status='unknown';reason='descendant-fingerprint-mismatch'} | ConvertTo-Json -Compress; exit 0 }
      Stop-Process -Id ([int]$child.ProcessId) -Force -ErrorAction Stop
      $totalStopped++
    }

    if ($rootCurrent.Count -eq 0 -and $order.Count -eq 0) { $consecutiveAbsent++ } else { $consecutiveAbsent = 0 }
    if ($consecutiveAbsent -ge 2) { @{status='killed';count=$totalStopped} | ConvertTo-Json -Compress; exit 0 }
  }
  @{status='unknown';reason='convergence-not-proven'} | ConvertTo-Json -Compress
} catch {
  @{status='unknown';reason='windows-process-operation-failed'} | ConvertTo-Json -Compress
}`;

export interface OwnedWindowsProcess { pid: number; startFingerprint: string }
export interface WindowsProcessCapabilitiesOptions { runner?: PowerShellRunner }

/** Narrow Windows-native process identity and tree termination boundary. */
export class WindowsProcessCapabilities {
  private readonly runner: PowerShellRunner;
  constructor(options: WindowsProcessCapabilitiesOptions = {}) { this.runner = options.runner ?? new NativePowerShellRunner(); }
  private async invoke(script: string, parameters: Readonly<Record<string, string>>): Promise<unknown> {
    let output: PowerShellResult;
    try { output = await this.runner.run(script, parameters); } catch { throw new MpxError({ code: "WINDOWS_POWERSHELL_FAILED", message: "Windows process operation failed.", retryable: true }); }
    if (output.exitCode !== 0) throw new MpxError({ code: "WINDOWS_POWERSHELL_FAILED", message: "Windows process operation failed.", retryable: true });
    try { return output.stdout.trim() ? parseStrictJson(output.stdout) : null; } catch { throw malformed(); }
  }
  async inspect(pid: number): Promise<OwnedWindowsProcess | undefined> {
    if (!Number.isInteger(pid) || pid < 1) throw new MpxError({ code: "PROCESS_FINGERPRINT_INVALID", message: "A valid PID is required." });
    const parsed = await this.invoke(PROCESS_SCRIPT, { PidValue: String(pid) });
    if (parsed === null) return undefined;
    const item = record(parsed); const actualPid = requiredInteger(item.ProcessId); const startedAt = optionalString(item.StartedAt);
    if (actualPid !== pid || !startedAt) throw malformed();
    return { pid, startFingerprint: startedAt };
  }
  async terminate(process: OwnedWindowsProcess): Promise<void> {
    const parsed = record(await this.invoke(KILL_SCRIPT, { PidValue: String(process.pid), StartedAt: process.startFingerprint }));
    if (parsed.status === "killed") return;
    if (parsed.status === "missing") throw new MpxError({ code: "PROCESS_DISAPPEARED", message: "The process disappeared before it could be terminated." });
    if (parsed.status === "mismatch") throw new MpxError({ code: "PROCESS_FINGERPRINT_MISMATCH", message: "The PID now belongs to a different process." });
    throw malformed();
  }
  async terminateTree(process: OwnedWindowsProcess): Promise<void> {
    const parsed = record(await this.invoke(TREE_KILL_SCRIPT, { PidValue: String(process.pid), StartedAt: process.startFingerprint }));
    if (parsed.status === "killed") return;
    if (parsed.status === "missing") throw new MpxError({ code: "PROCESS_DISAPPEARED", message: "The process disappeared before it could be terminated." });
    if (parsed.status === "mismatch") throw new MpxError({ code: "PROCESS_FINGERPRINT_MISMATCH", message: "The PID now belongs to a different process." });
    if (parsed.status === "unknown") throw new MpxError({ code: "PROCESS_TERMINATION_UNKNOWN", message: "The process tree could not be proven terminated.", retryable: true });
    throw malformed();
  }
}

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): UnknownRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw malformed();
  return value as UnknownRecord;
};
const optionalString = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const requiredInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value)) throw malformed();
  return value;
};
const malformed = () => new MpxError({ code: "WINDOWS_POWERSHELL_MALFORMED", message: "Windows returned malformed process information." });

export class WindowsPortPlatformAdapter implements PortPlatformAdapter {
  private readonly runner: PowerShellRunner;
  private readonly binder: SocketBinder;
  constructor(options: WindowsPortPlatformAdapterOptions = {}) {
    this.runner = options.runner ?? new NativePowerShellRunner();
    this.binder = options.binder ?? new NodeSocketBinder();
  }

  private async invoke(script: string, parameters?: Readonly<Record<string, string>>): Promise<unknown> {
    let output: PowerShellResult;
    try { output = await this.runner.run(script, parameters); }
    catch { throw new MpxError({ code: "WINDOWS_POWERSHELL_FAILED", message: "Windows process inspection failed.", retryable: true }); }
    if (output.exitCode !== 0) throw new MpxError({ code: "WINDOWS_POWERSHELL_FAILED", message: "Windows process inspection failed.", retryable: true });
    if (!output.stdout.trim()) return null;
    try { return parseStrictJson(output.stdout); }
    catch { throw malformed(); }
  }

  async inspectListeners(ports?: readonly number[]): Promise<readonly ListenerInfo[]> {
    const parsed = await this.invoke(LISTENERS_SCRIPT, ports?.length ? { PortsJson: JSON.stringify(ports) } : undefined);
    const values = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
    return values.map((value): ListenerInfo => {
      const item = record(value); const port = requiredInteger(item.LocalPort); const pid = requiredInteger(item.OwningProcess);
      if (port < 1 || port > 65_535 || pid < 0) throw malformed();
      const address = optionalString(item.LocalAddress); const processName = optionalString(item.Name); const executable = optionalString(item.ExecutablePath); const projectPath = optionalString(item.ProjectPath); const startedAt = optionalString(item.StartedAt);
      return { port, pid, ...(address ? { address } : {}), ...(processName ? { processName } : {}), ...(executable ? { executable } : {}), ...(projectPath ? { projectPath } : {}), ...(startedAt ? { startedAt } : {}) };
    }).sort((a, b) => a.port - b.port || (a.address ?? "").localeCompare(b.address ?? "") || (a.pid ?? 0) - (b.pid ?? 0));
  }

  async inspectProcess(pid: number): Promise<ProcessInfo | undefined> {
    const parsed = await this.invoke(PROCESS_SCRIPT, { PidValue: String(pid) });
    if (parsed === null) return undefined;
    const item = record(parsed); const actualPid = requiredInteger(item.ProcessId); const startedAt = optionalString(item.StartedAt);
    if (actualPid !== pid) throw malformed();
    const processName = optionalString(item.Name); const executable = optionalString(item.ExecutablePath); const projectPath = optionalString(item.ProjectPath);
    return { pid, ...(startedAt ? { startedAt } : {}), ...(processName ? { processName } : {}), ...(executable ? { executable } : {}), ...(projectPath ? { projectPath } : {}) };
  }

  async killProcess(fingerprint: ProcessFingerprint): Promise<void> {
    if (!Number.isInteger(fingerprint.pid) || fingerprint.pid < 1 || typeof fingerprint.startedAt !== "string" || fingerprint.startedAt.length === 0) throw new MpxError({ code: "PROCESS_FINGERPRINT_INVALID", message: "A valid process fingerprint is required for termination." });
    const parsed = record(await this.invoke(KILL_SCRIPT, { PidValue: String(fingerprint.pid), StartedAt: fingerprint.startedAt }));
    if (parsed.status === "killed") return;
    if (parsed.status === "missing") throw new MpxError({ code: "PROCESS_DISAPPEARED", message: "The process disappeared before it could be terminated." });
    if (parsed.status === "mismatch") throw new MpxError({ code: "PROCESS_FINGERPRINT_MISMATCH", message: "The PID now belongs to a different process." });
    throw malformed();
  }

  async holdAvailablePorts(ports: readonly number[]): Promise<PortHold> {
    const bindings: SocketBinding[] = [];
    try {
      for (const port of [...new Set(ports)].sort((a, b) => a - b)) {
        if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid port");
        for (const host of ["127.0.0.1", "::1"] as const) bindings.push(await this.binder.bind(port, host));
      }
    } catch {
      await Promise.allSettled(bindings.reverse().map((binding) => binding.release()));
      throw new MpxError({ code: "PORT_UNAVAILABLE", message: "A loopback port is unavailable.", retryable: true });
    }
    let released = false;
    return { release: async () => {
      if (released) return;
      released = true;
      const outcomes = await Promise.allSettled(bindings.reverse().map((binding) => binding.release()));
      if (outcomes.some(({ status }) => status === "rejected")) throw new MpxError({ code: "PORT_RELEASE_FAILED", message: "A loopback port hold could not be released.", retryable: true });
    } };
  }
}
