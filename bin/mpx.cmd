@echo off
setlocal
if not defined LOCALAPPDATA exit /b 2
if not defined MPX_APPS exit /b 2
if not defined MPX_NODE_EXECUTABLE exit /b 2
set /p "MPX_RELEASE_KEY="<"%LOCALAPPDATA%\mpx\active-release"
if not defined MPX_RELEASE_KEY exit /b 2
"%MPX_NODE_EXECUTABLE%" "%MPX_APPS%\mpx\releases\%MPX_RELEASE_KEY%\bin\mpx.mjs" %*
exit /b %ERRORLEVEL%
