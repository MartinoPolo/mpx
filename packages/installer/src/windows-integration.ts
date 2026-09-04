import path from 'node:path';
import { MpxError } from '@mpx/core';
import { type ManagedLauncherSpec, type OwnedResourceSpec } from '@mpx/windows';
import WINDOWS_OWNED_PATHS from './windows-owned-paths.json' with { type: 'json' };
export { buildStableNodeEntryBody } from './stable-node-entry.js';

const SHA = /^[a-f0-9]{64}$/u;
export const WINDOWS_OWNED_PATH_VARIABLES = Object.freeze(WINDOWS_OWNED_PATHS);
const PUBLISHED_MPX_PATHS = WINDOWS_OWNED_PATH_VARIABLES.filter(
  (name) => name !== 'MPX_NODE_EXECUTABLE',
);
function fail(code: string, message: string): never {
  throw new MpxError({ code, message });
}
function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value || !path.win32.isAbsolute(value)) {
    fail('INSTALL_ROOT_UNAVAILABLE', `${name} must be an absolute machine root.`);
  }
  return path.win32.normalize(value);
}

export function buildManagedLauncherBody(shell: 'bash' | 'powershell'): string {
  if (shell === 'bash') {
    return String.raw`mpx() { command mpx.cmd "$@"; }
cc-mpx() { mpx launch claude --identity personal --executor host --workspace direct --reason 'User-approved native Claude compatibility' --approve-host "$@"; }
ccw-mpx() { mpx launch claude --identity work --executor host --workspace direct --reason 'User-approved native Claude compatibility' --approve-host "$@"; }
pi-mpx() { mpx launch pi --identity personal --executor host --workspace direct --reason 'User-approved native Pi compatibility' --approve-host "$@"; }
piw-mpx() { mpx launch pi --identity work --executor host --workspace direct --reason 'User-approved native Pi compatibility' --approve-host "$@"; }
_mpx_direct_tty_reason() {
  if [[ ! -t 0 || ! -t 1 ]]; then printf '%s\n' 'MPX direct launch requires a TTY.' >&2; return 2; fi
  if [[ -z "\${MPX_DIRECT_REASON:-}" ]]; then printf '%s\n' 'Set MPX_DIRECT_REASON for direct host launch.' >&2; return 2; fi
}
ccd-mpx() { _mpx_direct_tty_reason || return; mpx launch claude --identity personal --executor host --reason "$MPX_DIRECT_REASON" --approve-host "$@"; }
ccwd-mpx() { _mpx_direct_tty_reason || return; mpx launch claude --identity work --executor host --reason "$MPX_DIRECT_REASON" --approve-host "$@"; }
`;
  }
  return String.raw`function cc-mpx { & mpx launch claude --identity personal --executor host --workspace direct --reason 'User-approved native Claude compatibility' --approve-host @args }
function ccw-mpx { & mpx launch claude --identity work --executor host --workspace direct --reason 'User-approved native Claude compatibility' --approve-host @args }
function pi-mpx { & mpx launch pi --identity personal --executor host --workspace direct --reason 'User-approved native Pi compatibility' --approve-host @args }
function piw-mpx { & mpx launch pi --identity work --executor host --workspace direct --reason 'User-approved native Pi compatibility' --approve-host @args }
function Test-MpxDirectTtyReason {
  if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { throw 'MPX direct launch requires a TTY.' }
  if ([String]::IsNullOrWhiteSpace($env:MPX_DIRECT_REASON)) { throw 'Set MPX_DIRECT_REASON for direct host launch.' }
}
function ccd-mpx { Test-MpxDirectTtyReason; & mpx launch claude --identity personal --executor host --reason $env:MPX_DIRECT_REASON --approve-host @args }
function ccwd-mpx { Test-MpxDirectTtyReason; & mpx launch claude --identity work --executor host --reason $env:MPX_DIRECT_REASON --approve-host @args }
`;
}

export function buildStableSelectorBody(): string {
  const allowlist = WINDOWS_OWNED_PATH_VARIABLES.join(' ');
  return String.raw`@echo off
setlocal
if not defined LOCALAPPDATA exit /b 2
for %%V in (${allowlist}) do (
  if not defined %%V for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v "%%V" 2^>nul') do set "%%V=%%B"
)
if not defined MPX_NODE_EXECUTABLE exit /b 2
"%MPX_NODE_EXECUTABLE%" "%~dp0mpx-node.mjs" %*
exit /b %ERRORLEVEL%
`.replace(/\r?\n/gu, '\r\n');
}

export interface WindowsIntegrationSpecs {
  readonly launchers: readonly ManagedLauncherSpec[];
  readonly environment: OwnedResourceSpec;
  readonly shortcuts: readonly OwnedResourceSpec[];
}
export function buildWindowsIntegrationSpecs(
  environment: NodeJS.ProcessEnv,
  currentUser: string,
  releaseKey: string,
): WindowsIntegrationSpecs {
  if (!currentUser || !SHA.test(releaseKey)) {
    fail('INSTALL_SCHEMA_INVALID', 'Windows integration identity or release key is invalid.');
  }
  const apps = required(environment, 'MPX_APPS'),
    appData = required(environment, 'APPDATA'),
    userProfile = required(environment, 'USERPROFILE');
  required(environment, 'LOCALAPPDATA');
  const selector = path.win32.join(apps, 'mpx', 'bin', 'mpx.cmd'),
    nodeEntry = path.win32.join(apps, 'mpx', 'bin', 'mpx-node.mjs');
  const node = required(environment, 'MPX_NODE_EXECUTABLE');
  const roots = Object.fromEntries(
    PUBLISHED_MPX_PATHS.flatMap((key) => {
      const value = environment[key];
      if (value === undefined) {
        return [];
      }
      if (!path.win32.isAbsolute(value)) {
        fail('INSTALL_ROOT_UNAVAILABLE', `${key} must be an absolute machine root.`);
      }
      return [[key, path.win32.normalize(value)]];
    }),
  );
  const shortcut = (target: string): OwnedResourceSpec => ({
    kind: 'shortcut',
    target,
    ownershipKey: 'mpx',
    desired: { owner: 'mpx', targetPath: selector, argv: [], workingDirectory: userProfile },
  });
  return {
    launchers: [
      {
        shell: 'bash',
        path: path.win32.join(userProfile, '.bashrc'),
        body: buildManagedLauncherBody('bash'),
      },
      {
        shell: 'powershell',
        path: path.win32.join(
          userProfile,
          'Documents',
          'PowerShell',
          'Microsoft.PowerShell_profile.ps1',
        ),
        body: buildManagedLauncherBody('powershell'),
      },
    ],
    environment: {
      kind: 'user-environment',
      target: 'HKCU\\Environment',
      ownershipKey: 'mpx',
      desired: {
        owner: 'mpx',
        ...roots,
        MPX_EXECUTABLE: selector,
        MPX_NODE_ENTRY: nodeEntry,
        MPX_NODE_EXECUTABLE: node,
        PathPrepend: path.win32.join(apps, 'mpx', 'bin'),
      },
    },
    shortcuts: [
      shortcut(path.win32.join(userProfile, 'Desktop', 'MPX.lnk')),
      shortcut(
        path.win32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'MPX.lnk'),
      ),
    ],
  };
}
