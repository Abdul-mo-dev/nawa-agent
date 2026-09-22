@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is missing. Install Node.js 22.12 or newer, then run this file again.
  pause
  exit /b 1
)
node tools\browser\check-prerequisites.mjs
if errorlevel 1 goto :failed
call npm ci
if errorlevel 1 goto :failed
call npm run browser:test
if errorlevel 1 goto :failed
call npm run browser:build
if errorlevel 1 goto :failed
echo.
echo Setup completed. Double-click "Start GenOffice.cmd".
pause
exit /b 0
:failed
echo.
echo Setup failed. Read the first error above. See BROWSER-README.md.
pause
exit /b 1
