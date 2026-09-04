@echo off
setlocal
if not defined LOCALAPPDATA exit /b 2
for %%V in (MPX_APPS MPX_PROJECTS MPX_WORK MPX_CLONED MPX_ONEDRIVE MPX_AI_GENERATED MPX_OBSIDIAN_VAULT MPX_NODE_EXECUTABLE MPX_PI_EXECUTABLE MPX_CLAUDE_EXECUTABLE) do (
  if not defined %%V for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v "%%V" 2^>nul') do set "%%V=%%B"
)
if not defined MPX_NODE_EXECUTABLE exit /b 2
"%MPX_NODE_EXECUTABLE%" "%~dp0mpx-node.mjs" %*
exit /b %ERRORLEVEL%
