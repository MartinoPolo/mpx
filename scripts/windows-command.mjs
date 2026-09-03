const selector = String.raw`@echo off
setlocal
if not defined LOCALAPPDATA exit /b 2
for %%V in (MPX_APPS MPX_PROJECTS MPX_WORK MPX_CLONED MPX_ONEDRIVE MPX_AI_GENERATED MPX_OBSIDIAN_VAULT MPX_NODE_EXECUTABLE MPX_PI_EXECUTABLE MPX_CLAUDE_EXECUTABLE) do (
  if not defined %%V for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v "%%V" 2^>nul') do set "%%V=%%B"
)
if not defined MPX_APPS exit /b 2
if not defined MPX_NODE_EXECUTABLE exit /b 2
set /p "MPX_RELEASE_KEY="<"%LOCALAPPDATA%\mpx\active-release"
if not defined MPX_RELEASE_KEY exit /b 2
"%MPX_NODE_EXECUTABLE%" "%MPX_APPS%\mpx\releases\%MPX_RELEASE_KEY%\bin\mpx.mjs" %*
exit /b %ERRORLEVEL%
`;

export function commandSelectorBytes() {
  return Buffer.from(selector.replace(/\r?\n/gu, '\r\n'), 'utf8');
}
