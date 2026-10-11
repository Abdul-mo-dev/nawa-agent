@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.12 or newer first.
  pause
  exit /b 1
)
node apps\browser\server\start.mjs %*
set "NAWA_EXIT_CODE=%errorlevel%"
if not "%NAWA_EXIT_CODE%"=="0" pause
exit /b %NAWA_EXIT_CODE%
