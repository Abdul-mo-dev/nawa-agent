#Requires -Version 5.1
<#
.SYNOPSIS
  Build the Nawa Windows x64 installer from the repository root.
.EXAMPLE
  .\Build-NawaInstaller.ps1
.EXAMPLE
  .\Build-NawaInstaller.ps1 -SkipDependencyInstall -OutputDirectory .task\release
#>
[CmdletBinding()]
param(
  [string]$OutputDirectory = 'release',
  [switch]$SkipDependencyInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'Build-NawaInstaller.ps1 must run on Windows.'
}
if ($env:GENOFFICE_WIN_ARM64 -eq '1') {
  throw 'This script builds x64. Unset GENOFFICE_WIN_ARM64 before running it.'
}

$repoRoot = $PSScriptRoot
$buildDirectory = if ([IO.Path]::IsPathRooted($OutputDirectory)) {
  [IO.Path]::GetFullPath($OutputDirectory)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))
}
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
$null = Get-Command cargo.exe -ErrorAction Stop

$nodeVersionText = (& $node --version).TrimStart('v')
if ($LASTEXITCODE -ne 0 -or [version]$nodeVersionText -lt [version]'22.12.0') {
  throw 'Node.js 22.12 or newer is required.'
}

$previousBuildDirectory = [Environment]::GetEnvironmentVariable('BUILD_DIR', 'Process')
try {
  $env:BUILD_DIR = $buildDirectory
  Push-Location -LiteralPath $repoRoot
  try {
    if (-not $SkipDependencyInstall) {
      Write-Host 'Installing locked npm dependencies...'
      & $npm ci
      if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
    } elseif (-not (Test-Path -LiteralPath 'node_modules/.bin/electron.cmd')) {
      throw 'Dependencies are missing. Run without -SkipDependencyInstall.'
    }

    $shellVersion = (Get-Content -LiteralPath 'apps/shell/package.json' -Raw | ConvertFrom-Json).version
    $installer = Join-Path $buildDirectory "Nawa-Setup-$shellVersion.exe"
    $unpacked = Join-Path $buildDirectory 'win-unpacked'
    $started = [DateTime]::UtcNow

    Write-Host "Building the Windows installer in $buildDirectory..."
    & $npm run dist:win
    if ($LASTEXITCODE -ne 0) { throw "npm run dist:win failed with exit code $LASTEXITCODE." }

    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
      throw "Build finished without an installer: $installer"
    }
    if ((Get-Item -LiteralPath $installer).LastWriteTimeUtc -lt $started.AddSeconds(-2)) {
      throw "Installer was not updated by this build: $installer"
    }
    foreach ($relativePath in @(
      'Nawa.exe',
      'resources/native/xlsx-sidecar.exe',
      'resources/ocr/win-ocr.exe',
      'resources/cli/genoffice.cjs'
    )) {
      $resource = Join-Path $unpacked $relativePath
      if (-not (Test-Path -LiteralPath $resource -PathType Leaf)) {
        throw "Packaged resource is missing: $resource"
      }
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    Write-Host "Installer: $installer" -ForegroundColor Green
    Write-Host "Signature: $($signature.Status)"
  } finally {
    Pop-Location
  }
} finally {
  if ($null -eq $previousBuildDirectory) {
    Remove-Item Env:BUILD_DIR -ErrorAction SilentlyContinue
  } else {
    $env:BUILD_DIR = $previousBuildDirectory
  }
}
