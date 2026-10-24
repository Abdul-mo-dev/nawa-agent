#Requires -Version 5.1

<#
.SYNOPSIS
  Approve a Nawa device request using your existing administrator signing key.
.DESCRIPTION
  Run without arguments for guided prompts, or provide -RequestPath and -Licensee
  to issue a license directly. The license is saved beside the request unless
  -OutputPath is supplied. Use the Windows account that owns the signing key.
  Requires Node.js 22.12 or newer; npm install and an app build are not needed.
  This script never creates or replaces an approval authority.
.PARAMETER RequestPath
  The .nawa-request file received from the target PC.
.PARAMETER Licensee
  Your label for the approved owner and PC, for example Ahmed / PC-01.
.PARAMETER ExpiresAt
  Optional future date: yyyy-MM-dd (through 23:59:59.999 UTC on that day), or
  an ISO timestamp with an explicit Z or UTC offset. Omit for no expiry.
.PARAMETER OutputPath
  Where to save the .nawa-license file, or .pem file when using -BackupKey.
  Existing files are preserved. The destination folder must already exist.
.PARAMETER AllowSoftwareKey
  Explicitly allow a software-backed request when the target PC cannot use TPM.
.PARAMETER List
  Show the existing authority's issuance ledger without approving another PC.
.PARAMETER BackupKey
  Export a password-encrypted signing-key backup outside the project. The
  underlying administrator tool prompts for and confirms a hidden password.
.PARAMETER AdminDirectory
  Optional existing key directory; defaults to LOCALAPPDATA\Nawa-License-Authority.
.PARAMETER NonInteractive
  Fail instead of prompting for missing inputs. Not available for key backup.
.EXAMPLE
  .\Approve-NawaPC.ps1
.EXAMPLE
  .\Approve-NawaPC.ps1 -RequestPath "$env:USERPROFILE\Downloads\PC-01.nawa-request" -Licensee "Ahmed / PC-01"
.EXAMPLE
  .\Approve-NawaPC.ps1 -RequestPath .\PC-01.nawa-request -Licensee "Ahmed / PC-01" -ExpiresAt 2027-12-31
.EXAMPLE
  .\Approve-NawaPC.ps1 -List
.EXAMPLE
  .\Approve-NawaPC.ps1 -BackupKey -OutputPath "$env:USERPROFILE\Nawa-approval-key-backup.pem"
#>
[CmdletBinding(DefaultParameterSetName = 'Issue', SupportsShouldProcess = $true)]
param(
  [Parameter(ParameterSetName = 'Issue', Position = 0)]
  [Alias('Request')]
  [string]$RequestPath,

  [Parameter(ParameterSetName = 'Issue')]
  [string]$Licensee,

  [Parameter(ParameterSetName = 'Issue')]
  [string]$ExpiresAt,

  [Parameter(ParameterSetName = 'Issue')]
  [Parameter(ParameterSetName = 'Backup')]
  [Alias('Out')]
  [string]$OutputPath,

  [Parameter(ParameterSetName = 'Issue')]
  [switch]$AllowSoftwareKey,

  [Parameter(Mandatory = $true, ParameterSetName = 'List')]
  [switch]$List,

  [Parameter(Mandatory = $true, ParameterSetName = 'Backup')]
  [switch]$BackupKey,

  [string]$AdminDirectory,
  [switch]$NonInteractive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-ApprovalInput([string]$Prompt) {
  if ($NonInteractive) { throw "Missing input: $Prompt. Provide it as a script parameter." }
  return Read-Host $Prompt
}

function Resolve-ApprovalPath([string]$Candidate) {
  $candidateText = $Candidate.Trim()
  # Pasted and dragged paths commonly include surrounding quotes.
  if ($candidateText.Length -ge 2) {
    $first = $candidateText.Substring(0, 1)
    $last = $candidateText.Substring($candidateText.Length - 1, 1)
    if (($first -eq '"' -or $first -eq "'") -and $first -eq $last) {
      $candidateText = $candidateText.Substring(1, $candidateText.Length - 2)
    }
  }
  if ([string]::IsNullOrWhiteSpace($candidateText)) { throw 'A file path is required.' }
  return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($candidateText)
}

function Assert-NewApprovalFile([string]$File, [string]$Extension) {
  if ([IO.Path]::GetExtension($File) -ine $Extension) {
    throw "The output filename must end in $Extension."
  }
  if (Test-Path -LiteralPath $File) {
    throw "Output already exists and was preserved: $File. Choose another -OutputPath."
  }
  $parentDirectory = [IO.Path]::GetDirectoryName($File)
  if (-not (Test-Path -LiteralPath $parentDirectory -PathType Container)) {
    throw "The output folder does not exist: $parentDirectory. Choose an existing folder."
  }
}

function ConvertTo-ApprovalExpiry([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $valueText = $Value.Trim()
  $culture = [Globalization.CultureInfo]::InvariantCulture
  $expiry = [DateTimeOffset]::MinValue
  if ($valueText -match '^\d{4}-\d{2}-\d{2}$') {
    $day = [DateTime]::MinValue
    if (-not [DateTime]::TryParseExact($valueText, 'yyyy-MM-dd', $culture, [Globalization.DateTimeStyles]::None, [ref]$day)) {
      throw 'Expiry is not a valid date. Use yyyy-MM-dd.'
    }
    $utcDay = [DateTime]::SpecifyKind($day, [DateTimeKind]::Utc)
    $expiry = [DateTimeOffset]::new($utcDay.AddDays(1).AddMilliseconds(-1))
  } else {
    if ($valueText -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$' -or
      -not [DateTimeOffset]::TryParse($valueText, $culture, [Globalization.DateTimeStyles]::None, [ref]$expiry)) {
      throw 'Use yyyy-MM-dd or an ISO timestamp with a timezone, such as 2027-12-31T23:59:59.000Z.'
    }
  }
  if ($expiry -le [DateTimeOffset]::UtcNow) { throw 'Expiry must be in the future.' }
  return $expiry.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", $culture)
}

function Invoke-ApprovalAdmin([string[]]$Arguments) {
  # Windows PowerShell 5.1 drops embedded quotes in native argument arrays.
  # Transfer only the argument data as JSON; execute a fixed launcher program.
  # Passwords and private key material never enter this environment variable.
  $previousArguments = [Environment]::GetEnvironmentVariable('NAWA_APPROVAL_ARGUMENTS_JSON')
  $launcher = 'const args = JSON.parse(process.env.NAWA_APPROVAL_ARGUMENTS_JSON); delete process.env.NAWA_APPROVAL_ARGUMENTS_JSON; process.argv = [process.execPath, process.argv[1], ...args]; require(process.argv[1]);'
  try {
    [Environment]::SetEnvironmentVariable('NAWA_APPROVAL_ARGUMENTS_JSON', (ConvertTo-Json -InputObject $Arguments -Compress))
    & $nodePath -e $launcher $adminTool
    if ($LASTEXITCODE -ne 0) { throw "Administrator tool failed (exit $LASTEXITCODE). See its message above." }
  } finally {
    [Environment]::SetEnvironmentVariable('NAWA_APPROVAL_ARGUMENTS_JSON', $previousArguments)
  }
}

try {
  if ($env:OS -ne 'Windows_NT') { throw 'The administrator key store requires Windows.' }
  $adminTool = Join-Path $PSScriptRoot 'tools\licensing\admin.cjs'
  if (-not (Test-Path -LiteralPath $adminTool -PathType Leaf)) {
    throw 'Keep this script in the Nawa project folder beside tools\licensing\admin.cjs.'
  }
  $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
  if (-not $nodeCommand) { throw 'Node.js 22.12 or newer is required. Install Node.js, then reopen PowerShell.' }
  $nodePath = $nodeCommand.Source
  $versionText = (& $nodePath --version).Trim().TrimStart('v')
  if ($LASTEXITCODE -ne 0 -or [version]$versionText -lt [version]'22.12.0') {
    throw 'Node.js 22.12 or newer is required.'
  }
  if ([string]::IsNullOrWhiteSpace($AdminDirectory)) {
    $AdminDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Nawa-License-Authority'
  }
  $keyDirectory = Resolve-ApprovalPath $AdminDirectory
  $keyFile = Join-Path $keyDirectory 'issuer-private.dpapi'
  if (-not (Test-Path -LiteralPath $keyFile -PathType Leaf)) {
    throw "No existing signing key at $keyFile. Use the original administrator PC/account or restore your encrypted backup; see Approve-NawaPC.md."
  }

  if ($List) {
    Invoke-ApprovalAdmin @('list', '--admin-dir', $keyDirectory)
    exit 0
  }
  if ($BackupKey) {
    if ($NonInteractive) { throw 'Key backup requires an interactive terminal for the hidden password prompt.' }
    if ([string]::IsNullOrWhiteSpace($OutputPath)) {
      $OutputPath = Read-ApprovalInput 'Backup .pem path outside the project'
    }
    $backupFile = Resolve-ApprovalPath $OutputPath
    Assert-NewApprovalFile $backupFile '.pem'
    if ($PSCmdlet.ShouldProcess($backupFile, 'Export a password-encrypted backup of the existing signing key')) {
      Invoke-ApprovalAdmin @('backup', '--out', $backupFile, '--admin-dir', $keyDirectory)
      exit 0
    }
    exit 0
  }

  $guided = [string]::IsNullOrWhiteSpace($RequestPath)
  if ($guided) {
    Write-Host 'Nawa PC approval - use the request received from the target PC.' -ForegroundColor Cyan
    $RequestPath = Read-ApprovalInput 'Path to the .nawa-request file'
  }
  $requestFile = Resolve-ApprovalPath $RequestPath
  if ([IO.Path]::GetExtension($requestFile) -ine '.nawa-request' -or
    -not (Test-Path -LiteralPath $requestFile -PathType Leaf)) {
    throw "Request file not found or not a .nawa-request file: $requestFile"
  }
  if ([string]::IsNullOrWhiteSpace($Licensee)) {
    $Licensee = Read-ApprovalInput 'Owner / PC label (for example Ahmed / PC-01)'
  }
  $Licensee = $Licensee.Trim()
  if ([string]::IsNullOrWhiteSpace($Licensee) -or $Licensee.Length -gt 200) {
    throw 'The owner / PC label must contain 1 to 200 characters.'
  }
  if ($guided -and -not $PSBoundParameters.ContainsKey('ExpiresAt')) {
    $ExpiresAt = Read-ApprovalInput 'Optional expiry yyyy-MM-dd (Enter = no expiry)'
  }
  $expiry = ConvertTo-ApprovalExpiry $ExpiresAt
  if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = [IO.Path]::ChangeExtension($requestFile, '.nawa-license')
  }
  $licenseFile = Resolve-ApprovalPath $OutputPath
  Assert-NewApprovalFile $licenseFile '.nawa-license'
  $adminArguments = @('issue', '--request', $requestFile, '--licensee', $Licensee, '--out', $licenseFile, '--admin-dir', $keyDirectory)
  if ($expiry) { $adminArguments += @('--expires', $expiry) }
  if ($AllowSoftwareKey) { $adminArguments += '--allow-software' }

  Write-Host "Request: $requestFile"
  Write-Host "Label:   $Licensee"
  if ($expiry) { Write-Host "Expiry:  $expiry (UTC)" } else { Write-Host 'Expiry:  none' }
  Write-Host "Output:  $licenseFile"
  if ($PSCmdlet.ShouldProcess($requestFile, "Approve '$Licensee' and issue a signed Nawa license")) {
    Invoke-ApprovalAdmin $adminArguments
    Write-Host 'Send this .nawa-license file back to the user. They choose Import license in Nawa setup.' -ForegroundColor Green
  }
  exit 0
} catch {
  [Console]::Error.WriteLine(('Nawa PC approval: ' + $_.Exception.Message))
  exit 1
}
