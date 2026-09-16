@echo off
if not defined MPX_APPS (
  echo MPX requires MPX_APPS to locate Git Bash. 1>&2
  exit /b 1
)
if not exist "%MPX_APPS%\Git\bin\bash.exe" (
  echo MPX requires Git Bash under MPX_APPS\Git. 1>&2
  exit /b 1
)
"%MPX_APPS%\Git\bin\bash.exe" --login "%~dp0mpx" %*
