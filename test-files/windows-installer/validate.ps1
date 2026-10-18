param([Parameter(Mandatory = $true)][string]$RunDirectory, [switch]$CleanupOnly, [switch]$Reliability)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$runRoot = [IO.Path]::GetFullPath($RunDirectory)
$taskRoot = [IO.Path]::GetFullPath((Join-Path $workspace '.task')) + [IO.Path]::DirectorySeparatorChar
if (-not $runRoot.StartsWith($taskRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Run directory must be owned scratch data under .task.' }
$manifest = Get-Content -LiteralPath (Join-Path $runRoot 'manifest.json') -Raw | ConvertFrom-Json
$installRoot = [IO.Path]::GetFullPath($manifest.installDirectory)
if (-not $installRoot.StartsWith($runRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Install directory escapes the run directory.' }
$installer = Join-Path $runRoot "package/Nawa-Validation-Setup-$($manifest.version).exe"
if (-not (Test-Path -LiteralPath $installer)) { throw 'Build the validation installer first.' }
$registry = [Microsoft.Win32.Registry]::CurrentUser
$defaults = @()
$report = [ordered]@{ testedAt = [DateTime]::UtcNow.ToString('o'); installed = $false; associations = 0; upgraded = $false; uninstalled = $false; defaultsRestored = $false; pathRestored = $false; passed = $false }

function Read-Value($keyPath, $valueName) {
  $key = $registry.OpenSubKey($keyPath)
  try {
    if ($null -eq $key) { return @{ keyExists = $false; exists = $false; value = $null; kind = $null } }
    $exists = $key.GetValueNames() -contains $valueName
    if (-not $exists) { return @{ keyExists = $true; exists = $false; value = $null; kind = $null } }
    return @{ keyExists = $true; exists = $true; value = $key.GetValue($valueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); kind = $key.GetValueKind($valueName).ToString() }
  } finally { if ($null -ne $key) { $key.Dispose() } }
}
function Restore-Value($keyPath, $valueName, $snapshot) {
  $key = $registry.CreateSubKey($keyPath)
  try {
    if ($snapshot.exists) {
      $value = $snapshot.value
      if ($snapshot.kind -in @('None', 'Binary')) { $value = [byte[]]$value }
      if ($snapshot.kind -eq 'MultiString') { $value = [string[]]$value }
      $key.SetValue($valueName, $value, [Enum]::Parse([Microsoft.Win32.RegistryValueKind], $snapshot.kind))
    }
    else { $key.DeleteValue($valueName, $false) }
  } finally { $key.Dispose() }
}
function Read-Tree($keyPath) {
  $key = $registry.OpenSubKey($keyPath)
  if ($null -eq $key) { return }
  try {
    $values = @($key.GetValueNames() | Sort-Object | ForEach-Object { @{ name = $_; snapshot = (Read-Value $keyPath $_) } })
    $children = @($key.GetSubKeyNames() | Sort-Object)
  } finally { $key.Dispose() }
  @{ path = $keyPath; values = $values }
  foreach ($child in $children) { Read-Tree "$keyPath\$child" }
}
function Remove-EmptyKey($keyPath) {
  $key = $registry.OpenSubKey($keyPath)
  if ($null -eq $key) { return }
  try { $empty = $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0 } finally { $key.Dispose() }
  if ($empty) { $registry.DeleteSubKey($keyPath, $false) }
}
function Run-Installer($file, $arguments) {
  $process = Start-Process -FilePath $file -ArgumentList $arguments -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(180000)) { $process.Kill(); throw "Installer timed out: $file" }
  if ($process.ExitCode -ne 0) { throw "Installer returned $($process.ExitCode): $file" }
}
function Assert-Installed {
  if (-not (Test-Path -LiteralPath (Join-Path $installRoot $manifest.executable))) { throw 'Installed executable is missing.' }
  $uninstall = Read-Value "Software\Microsoft\Windows\CurrentVersion\Uninstall\$($manifest.guid)" 'DisplayName'
  if (-not $uninstall.exists -or -not $uninstall.value.StartsWith($manifest.name)) { throw 'Installed app is missing from the per-user uninstall registry.' }
  foreach ($entry in $manifest.associations) {
    $command = Read-Value "Software\Classes\$($entry.name)\shell\open\command" ''
    $expected = '"' + (Join-Path $installRoot $manifest.executable) + '" "%1"'
    if ($command.value -cne $expected) { throw "Incorrect open command for .$($entry.ext): $($command.value)" }
    $openWith = Read-Value "Software\Classes\.$($entry.ext)\OpenWithProgids" $entry.name
    if (-not $openWith.exists) { throw "Missing OpenWith registration: .$($entry.ext)" }
    $icon = Read-Value "Software\Classes\$($entry.name)\DefaultIcon" ''
    if (-not (Test-Path -LiteralPath $icon.value)) { throw "Missing installed icon for .$($entry.ext): $($icon.value)" }
  }
  foreach ($ext in @('docx', 'xlsx', 'pptx')) {
    $entry = $manifest.associations | Where-Object { $_.ext -eq $ext }
    $template = Read-Value "Software\Classes\.$ext\$($entry.name)\ShellNew" 'FileName'
    if ($template.value -ne (Join-Path $installRoot "resources\shell-new\blank.$ext")) { throw "Invalid .$ext New template registration." }
    if (-not (Test-Path -LiteralPath $template.value)) { throw "Missing .$ext New template." }
  }
  $path = Read-Value 'Environment' 'Path'
  $cliDirectory = Join-Path $installRoot 'resources\cli'
  if (@($path.value.Split(';') | Where-Object { $_ -eq $cliDirectory }).Count -ne 1) { throw 'CLI PATH registration is absent or duplicated.' }
}

$pathBefore = Read-Value 'Environment' 'Path'
if ($CleanupOnly) {
  $backup = Get-Content -LiteralPath (Join-Path $runRoot 'registry-before.json') -Raw | ConvertFrom-Json
  $defaults = @($backup.defaults)
  $pathBefore = $backup.path
  $classTrees = @($backup.classTrees)
} else {
$classTrees = @()
foreach ($entry in $manifest.associations) {
  if (-not $entry.name.StartsWith($manifest.appId + '.') -or -not $manifest.appId.StartsWith('com.nawa.validation.')) { throw 'Refusing a non-validation ProgID.' }
  $key = $registry.OpenSubKey("Software\Classes\$($entry.name)")
  if ($null -ne $key) { $key.Dispose(); throw 'Validation ProgID already exists; use a fresh run directory.' }
  $keyPath = "Software\Classes\.$($entry.ext)"
  $openWith = $registry.OpenSubKey("$keyPath\OpenWithProgids")
  $openWithExisted = $null -ne $openWith
  if ($null -ne $openWith) { $openWith.Dispose() }
  $choice = Read-Value "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.$($entry.ext)\UserChoice" 'ProgId'
  $defaults += @{ ext = $entry.ext; progId = $entry.name; before = (Read-Value $keyPath ''); openWithExisted = $openWithExisted; choice = $choice }
  $classTrees += @(Read-Tree $keyPath)
}
@{ defaults = $defaults; path = $pathBefore; classTrees = $classTrees } | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $runRoot 'registry-before.json') -Encoding UTF8
}
$previousExecutable = $env:NAWA_TEST_EXECUTABLE
try {
  if (-not $CleanupOnly) {
  Run-Installer $installer @('/S', '/currentuser', "/D=$installRoot")
  Assert-Installed
  $report.installed = $true
  $report.associations = $manifest.associations.Count
  $report.extensionDefaultsChangedDuringInstall = @($defaults | Where-Object { (Read-Value "Software\Classes\.$($_.ext)" '').value -ne $_.before.value }).Count
  if ($report.extensionDefaultsChangedDuringInstall -ne 0) { throw 'Installation changed existing extension defaults.' }
  & node (Join-Path $PSScriptRoot 'runtime-smoke.mjs') $runRoot *> (Join-Path $runRoot 'runtime.log')
  if ($LASTEXITCODE -ne 0) { throw 'Packaged runtime checks failed; see runtime.log.' }
  Write-Output 'Installed runtime passed.'
  Run-Installer $installer @('/S', '/currentuser', "/D=$installRoot")
  Assert-Installed
  $report.upgraded = $true
  $env:NAWA_TEST_EXECUTABLE = Join-Path $installRoot $manifest.executable
  if ($Reliability) {
    Push-Location $workspace
    try {
      & node (Join-Path $workspace 'node_modules/@playwright/test/cli.js') test --config e2e/playwright.config.ts reliability.spec.ts *> (Join-Path $runRoot 'reliability.log')
      if ($LASTEXITCODE -ne 0) { throw 'Installed reliability checks failed; see reliability.log.' }
      $report.reliabilityPassed = $true
    } finally { Pop-Location }
  }
  foreach ($driver in @('chat', 'ui')) {
    & node (Join-Path $workspace "test-files/opendocument/$driver-smoke.mjs") *> (Join-Path $runRoot "$driver.log")
    if ($LASTEXITCODE -ne 0) { throw "Packaged OpenDocument $driver checks failed." }
    Copy-Item -LiteralPath (Join-Path $workspace "test-files/opendocument/$driver-report.json") -Destination (Join-Path $runRoot "$driver-report.json")
  }
  }
} catch {
  $report.error = $_.Exception.Message
} finally {
  $env:NAWA_TEST_EXECUTABLE = $previousExecutable
  $uninstaller = Join-Path $installRoot "Uninstall $([IO.Path]::GetFileNameWithoutExtension($manifest.executable)).exe"
  try {
    if (Test-Path -LiteralPath $uninstaller) {
      try { Run-Installer $uninstaller @('/S', '/currentuser', "_?=$installRoot") }
      catch { $report.cleanupError = $_.Exception.Message }
    }
    $report.uninstalled = -not (Test-Path -LiteralPath (Join-Path $installRoot $manifest.executable))
    $remainingInstall = Read-Value "Software\Microsoft\Windows\CurrentVersion\Uninstall\$($manifest.guid)" 'DisplayName'
    $report.uninstallRegistryRemoved = -not $remainingInstall.keyExists
    if (-not $report.uninstallRegistryRemoved) { $report.cleanupError = 'Uninstaller left its application registry entry.' }
    $report.extensionDefaultsDanglingAfterUninstall = @($defaults | Where-Object { (Read-Value "Software\Classes\.$($_.ext)" '').value -eq $_.progId }).Count
    if ($report.extensionDefaultsDanglingAfterUninstall -ne 0 -and -not $CleanupOnly) { $report.cleanupError = 'Uninstall left dangling extension defaults.' }
    foreach ($entry in $defaults) {
      $keyPath = "Software\Classes\.$($entry.ext)"
      $current = Read-Value $keyPath ''
      if ($current.value -eq $entry.progId) { Restore-Value $keyPath '' $entry.before }
      $key = $registry.OpenSubKey("Software\Classes\$($entry.progId)")
      if ($null -ne $key) {
        $key.Dispose()
        $report.cleanupError = "Uninstaller left ProgID $($entry.progId)."
        # Remove only the unique class allocated by this test, then keep restoring.
        $registry.DeleteSubKeyTree("Software\Classes\$($entry.progId)", $false)
      }
      if (-not $entry.openWithExisted) { Remove-EmptyKey "$keyPath\OpenWithProgids" }
      if (-not $entry.before.keyExists) { Remove-EmptyKey $keyPath }
      $after = Read-Value $keyPath ''
      if ($after.exists -ne $entry.before.exists -or $after.value -cne $entry.before.value) { $report.cleanupError = "Extension default was not restored: .$($entry.ext)" }
      $choice = Read-Value "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.$($entry.ext)\UserChoice" 'ProgId'
      if ($choice.value -cne $entry.choice.value) { $report.cleanupError = "Windows UserChoice changed: .$($entry.ext)" }
    }
    $report.defaultsRestored = $true
    $pathAfter = Read-Value 'Environment' 'Path'
    $report.installerPathCleanupPassed = $pathAfter.value -ceq $pathBefore.value
    if (-not $report.installerPathCleanupPassed -or $pathAfter.kind -ne $pathBefore.kind) { Restore-Value 'Environment' 'Path' $pathBefore }
    $report.pathRestored = (Read-Value 'Environment' 'Path').value -ceq $pathBefore.value
  } catch { $report.cleanupError = $_.Exception.Message }
  $report.protectedRegistryValuesPreserved = $true
  foreach ($tree in $classTrees) {
    if ($null -eq $tree) { continue }
    foreach ($saved in $tree.values) {
      $current = Read-Value $tree.path $saved.name
      $same = $current.exists -eq $saved.snapshot.exists -and $current.kind -eq $saved.snapshot.kind -and (ConvertTo-Json -InputObject $current.value -Compress) -ceq (ConvertTo-Json -InputObject $saved.snapshot.value -Compress)
      if (-not $same) {
        $report.protectedRegistryValuesPreserved = $false
        $report.cleanupError = "Existing registry value changed: $($tree.path) / $($saved.name)"
        # Merge back missing values; preserve a concurrent change by another app.
        if (-not $current.exists) { Restore-Value $tree.path $saved.name $saved.snapshot }
      }
    }
  }
  # PATH restoration must run even when another cleanup check reports a failure.
  try {
    $pathAfter = Read-Value 'Environment' 'Path'
    if ($pathAfter.value -cne $pathBefore.value -or $pathAfter.kind -ne $pathBefore.kind) { Restore-Value 'Environment' 'Path' $pathBefore }
    $report.pathRestored = (Read-Value 'Environment' 'Path').value -ceq $pathBefore.value
  } catch { $report.pathCleanupError = $_.Exception.Message }
  # _?= keeps the uninstaller in place until it exits; remove that owned file now.
  if ($report.uninstalled -and (Test-Path -LiteralPath $uninstaller)) { Remove-Item -LiteralPath $uninstaller -Force }
  if ((Test-Path -LiteralPath $installRoot) -and @(Get-ChildItem -LiteralPath $installRoot -Force).Count -eq 0) { Remove-Item -LiteralPath $installRoot }
  $report.installDirectoryRemoved = -not (Test-Path -LiteralPath $installRoot)
  $report.passed = ($CleanupOnly -or ($report.installed -and $report.upgraded)) -and $report.uninstalled -and $report.defaultsRestored -and $report.pathRestored -and -not $report.Contains('error') -and -not $report.Contains('cleanupError')
  $reportFile = if ($CleanupOnly) { 'cleanup-report.json' } else { 'installer-report.json' }
  $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $runRoot $reportFile) -Encoding UTF8
  $report | ConvertTo-Json -Depth 12 | Write-Output
}
if (-not $report.passed) { exit 1 }
