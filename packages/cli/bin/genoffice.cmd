@echo off
rem genoffice launcher for the packaged Windows app: <install>\resources\cli\genoffice.cmd
setlocal
set "ELECTRON_RUN_AS_NODE=1"
if exist "%~dp0..\..\Nawa.exe" (
  "%~dp0..\..\Nawa.exe" "%~dp0genoffice.cjs" %*
) else if exist "%~dp0..\..\GenOffice.exe" (
  "%~dp0..\..\GenOffice.exe" "%~dp0genoffice.cjs" %*
) else if exist "%~dp0genoffice.cjs" (
  node "%~dp0genoffice.cjs" %*
) else (
  node "%~dp0..\dist\genoffice.cjs" %*
)
endlocal & exit /b %errorlevel%
