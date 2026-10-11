@echo off
setlocal
cd /d "%~dp0"
if not exist "apps\browser\out\main\index.js" goto :missing
if not exist "apps\browser\out\preload\empty.js" goto :missing
for %%E in (docs sheets slides pdf markdown html) do if not exist "apps\browser\out\editors\%%E\index.html" goto :missing
if not exist "apps\sheets\native\xlsx-engine\target\release\xlsx-sidecar.exe" goto :missing
if not exist "node_modules\.bin\electron.cmd" goto :missing
call node_modules\.bin\electron.cmd apps\browser %*
set "NAWA_EXIT_CODE=%errorlevel%"
if not "%NAWA_EXIT_CODE%"=="0" pause
exit /b %NAWA_EXIT_CODE%
:missing
echo The browser build is missing. Run setup-windows.cmd first.
echo For text-only editing without npm or Rust, run "Start Nawa Source Only.cmd".
pause
exit /b 1
