@echo off
setlocal
cd /d "%~dp0"
if not exist "apps\browser\out\main\index.js" goto :missing
if not exist "apps\browser\out\editors\docs\index.html" goto :missing
if not exist "node_modules\.bin\electron.cmd" goto :missing
call node_modules\.bin\electron.cmd apps\browser %*
if errorlevel 1 pause
exit /b
:missing
echo The browser build is missing. Run setup-windows.cmd first.
echo For text-only editing without npm or Rust, run "Start Nawa Source Only.cmd".
pause
exit /b 1
