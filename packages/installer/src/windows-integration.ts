import path from "node:path";
import { MpxError } from "@mpx/core";
import { deterministicTerminalProfileGuid, type ManagedLauncherSpec, type OwnedResourceSpec } from "@mpx/windows";

const SHA = /^[a-f0-9]{64}$/u;
function fail(code: string, message: string): never { throw new MpxError({ code, message }); }
function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]; if (!value || !path.win32.isAbsolute(value)) fail("INSTALL_ROOT_UNAVAILABLE", `${name} must be an absolute machine root.`); return path.win32.normalize(value);
}

export function buildManagedLauncherBody(shell: "bash" | "powershell"): string {
  if (shell === "bash") return String.raw`cc() { mpx launch claude --identity personal "$@"; }
ccw() { mpx launch claude --identity work "$@"; }
pi() { mpx launch pi --identity personal "$@"; }
piw() { mpx launch pi --identity work "$@"; }
_mpx_direct_tty_reason() {
  if [[ ! -t 0 || ! -t 1 ]]; then printf '%s\n' 'MPX direct launch requires a TTY.' >&2; return 2; fi
  if [[ -z "\${MPX_DIRECT_REASON:-}" ]]; then printf '%s\n' 'Set MPX_DIRECT_REASON for direct host launch.' >&2; return 2; fi
}
ccd() { _mpx_direct_tty_reason || return; mpx launch claude --identity personal --executor host --reason "$MPX_DIRECT_REASON" "$@"; }
ccwd() { _mpx_direct_tty_reason || return; mpx launch claude --identity work --executor host --reason "$MPX_DIRECT_REASON" "$@"; }
`;
  return String.raw`function cc { & mpx launch claude --identity personal @args }
function ccw { & mpx launch claude --identity work @args }
function pi { & mpx launch pi --identity personal @args }
function piw { & mpx launch pi --identity work @args }
function Test-MpxDirectTtyReason {
  if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { throw 'MPX direct launch requires a TTY.' }
  if ([String]::IsNullOrWhiteSpace($env:MPX_DIRECT_REASON)) { throw 'Set MPX_DIRECT_REASON for direct host launch.' }
}
function ccd { Test-MpxDirectTtyReason; & mpx launch claude --identity personal --executor host --reason $env:MPX_DIRECT_REASON @args }
function ccwd { Test-MpxDirectTtyReason; & mpx launch claude --identity work --executor host --reason $env:MPX_DIRECT_REASON @args }
`;
}

export function buildStableSelectorBody(): string {
  return "@echo off\r\nsetlocal\r\nif not defined LOCALAPPDATA exit /b 2\r\nif not defined MPX_APPS exit /b 2\r\nif not defined MPX_NODE_EXECUTABLE exit /b 2\r\nset /p \"MPX_RELEASE_KEY=\"<\"%LOCALAPPDATA%\\mpx\\active-release\"\r\nif not defined MPX_RELEASE_KEY exit /b 2\r\n\"%MPX_NODE_EXECUTABLE%\" \"%MPX_APPS%\\mpx\\releases\\%MPX_RELEASE_KEY%\\bin\\mpx.mjs\" %*\r\nexit /b %ERRORLEVEL%\r\n";
}

export interface WindowsIntegrationSpecs {
  readonly launchers: readonly ManagedLauncherSpec[];
  readonly terminal: OwnedResourceSpec;
  readonly environment: OwnedResourceSpec;
  readonly shortcuts: readonly OwnedResourceSpec[];
  readonly task: OwnedResourceSpec;
}
export function buildWindowsIntegrationSpecs(environment: NodeJS.ProcessEnv, currentUser: string, releaseKey: string): WindowsIntegrationSpecs {
  if (!currentUser || !SHA.test(releaseKey)) fail("INSTALL_SCHEMA_INVALID", "Windows integration identity or release key is invalid.");
  const apps = required(environment, "MPX_APPS"), appData = required(environment, "APPDATA"), localAppData = required(environment, "LOCALAPPDATA"), userProfile = required(environment, "USERPROFILE");
  const release = path.win32.join(apps, "mpx", "releases", releaseKey);
  const selector = path.win32.join(apps, "mpx", "bin", "mpx.cmd");
  const cli = path.win32.join(release, "bin", "mpx.mjs");
  const node = environment.MPX_NODE_EXECUTABLE ?? process.execPath;
  if (!path.win32.isAbsolute(node)) fail("INSTALL_NODE_UNAVAILABLE", "Scheduled capture requires an absolute Node executable.");
  const roots = Object.fromEntries(Object.entries(environment).filter(([key, value]) => key.startsWith("MPX_") && typeof value === "string"));
  const guid = deterministicTerminalProfileGuid("MPX");
  const shortcut = (target: string): OwnedResourceSpec => ({ kind: "shortcut", target, ownershipKey: "mpx", desired: { owner: "mpx", targetPath: selector, argv: [], workingDirectory: userProfile } });
  return {
    launchers: [
      { shell: "bash", path: path.win32.join(userProfile, ".bashrc"), body: buildManagedLauncherBody("bash") },
      { shell: "powershell", path: path.win32.join(userProfile, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"), body: buildManagedLauncherBody("powershell") },
    ],
    terminal: { kind: "terminal-profile", target: path.win32.join(localAppData, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"), ownershipKey: guid, desired: { guid, name: "MPX", commandline: { executable: selector, argv: ["shell"] }, startingDirectory: userProfile } },
    environment: { kind: "user-environment", target: "HKCU\\Environment", ownershipKey: "mpx", desired: { owner: "mpx", ...roots, MPX_EXECUTABLE: selector, MPX_NODE_EXECUTABLE: node, PathPrepend: path.win32.join(apps, "mpx", "bin") } },
    shortcuts: [shortcut(path.win32.join(userProfile, "Desktop", "MPX.lnk")), shortcut(path.win32.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "MPX.lnk"))],
    task: { kind: "scheduled-task", target: "\\MPX\\Session Capture", ownershipKey: "mpx", desired: { owner: "mpx", executable: node, argv: [cli, "session", "reconcile", "--capture", "scheduled", "--json"], principal: currentUser, logonType: "InteractiveToken", runLevel: "LeastPrivilege" } },
  };
}
