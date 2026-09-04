import { readFileSync } from 'node:fs';

const WINDOWS_OWNED_PATHS = JSON.parse(
  readFileSync(
    new URL('../packages/installer/src/windows-owned-paths.json', import.meta.url),
    'utf8',
  ),
);

const selector = String.raw`@echo off
setlocal
if not defined LOCALAPPDATA exit /b 2
for %%V in (${WINDOWS_OWNED_PATHS.join(' ')}) do (
  if not defined %%V for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v "%%V" 2^>nul') do set "%%V=%%B"
)
if not defined MPX_NODE_EXECUTABLE exit /b 2
"%MPX_NODE_EXECUTABLE%" "%~dp0mpx-node.mjs" %*
exit /b %ERRORLEVEL%
`;

export function commandSelectorBytes() {
  return Buffer.from(selector.replace(/\r?\n/gu, '\r\n'), 'utf8');
}
