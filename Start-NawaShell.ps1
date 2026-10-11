#Requires -Version 5.1
<#
.SYNOPSIS
  Build the Nawa shell and launch it with Electron.
.DESCRIPTION
  Builds the shell, all six editors, the spreadsheet sidecar, and the CLI,
  then starts Electron on apps/shell. Requires Node.js, Rust and the Microsoft
  C++ Build Tools for a source build.
.PARAMETER SkipBuild
  Skip the build and launch using complete, existing build outputs.
.EXAMPLE
  .\Start-NawaShell.ps1
.EXAMPLE
  .\Start-NawaShell.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
  [Alias('NoBuild')]
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Fail([string]$message) {
  Write-Host $message -ForegroundColor Red
  exit 1
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$nodeVersionText = (& $node --version).TrimStart('v')
if ($LASTEXITCODE -ne 0 -or [version]$nodeVersionText -lt [version]'22.12.0') {
  Fail 'Node.js 22.12 or newer is required.'
}
if (-not $SkipBuild) {
  & $node tools/browser/check-prerequisites.mjs
  if ($LASTEXITCODE -ne 0) { Fail 'Build prerequisites are missing.' }
}

if (-not (Test-Path 'node_modules/.bin/electron.cmd')) {
  Write-Host 'node_modules missing or incomplete. Running npm ci...' -ForegroundColor Yellow
  & $npm ci
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed.' }
}

if (-not $SkipBuild) {
  Write-Host 'Building Nawa and all editor, spreadsheet and CLI prerequisites...' -ForegroundColor Cyan
  & $npm run build:all
  if ($LASTEXITCODE -ne 0) { Fail 'Nawa build failed.' }
}

$requiredFiles = @(
  'apps/shell/out/main/index.js',
  'apps/shell/out/preload/update.js',
  'apps/shell/out/preload/pdf-password.js',
  'apps/shell/out/renderer/update.html',
  'apps/shell/out/renderer/pdf-password.html',
  'apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar.exe',
  'packages/cli/dist/genoffice.cjs'
)
foreach ($module in @('shell', 'docs', 'sheets', 'slides', 'pdf', 'markdown', 'html')) {
  $requiredFiles += "apps/$module/out/preload/index.js"
  $requiredFiles += "apps/$module/out/renderer/index.html"
}
foreach ($file in $requiredFiles) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    Fail "Required build output is missing: $file. Run without -SkipBuild first."
  }
}

Write-Host 'Starting Nawa shell...' -ForegroundColor Green
& node_modules/.bin/electron.cmd apps/shell
exit $LASTEXITCODE
