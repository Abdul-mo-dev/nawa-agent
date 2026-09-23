<#Requires -Version 5.1
<#
.SYNOPSIS
  Build the Nawa shell and launch it with Electron.
.DESCRIPTION
  Builds @genoffice/shell (Home, directory chat, shell chrome) into
  apps/shell/out, then starts Electron on apps/shell.

  Editor renderers (apps/*/out) are NOT rebuilt here: the docs rebuild is
  currently broken upstream (generated-images import via ai-search), so a
  full build would fail. Rebuild individual editors only when needed and
  when their build passes.
.PARAMETER SkipBuild
  Skip the build and just launch Electron with the existing apps/shell/out.
.EXAMPLE
  .\Start-NawaShell.ps1
.EXAMPLE
  .\Start-NawaShell.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Fail([string]$message) {
  Write-Host $message -ForegroundColor Red
  exit 1
}

where.exe node 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'Node.js is missing. Install Node.js 22.12 or newer first.' }

if (-not (Test-Path 'node_modules/.bin/electron.cmd')) {
  Write-Host 'node_modules missing or incomplete. Running npm ci...' -ForegroundColor Yellow
  npm ci
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed.' }
}

if (-not $SkipBuild) {
  Write-Host 'Building @genoffice/shell...' -ForegroundColor Cyan
  npm run build -w @genoffice/shell
  if ($LASTEXITCODE -ne 0) { Fail 'Shell build failed.' }
} else {
  if (-not (Test-Path 'apps/shell/out/main/index.js')) {
    Fail 'apps/shell/out is missing. Run without -SkipBuild first.'
  }
}

Write-Host 'Starting Nawa shell...' -ForegroundColor Green
& node_modules/.bin/electron.cmd apps/shell
exit $LASTEXITCODE
