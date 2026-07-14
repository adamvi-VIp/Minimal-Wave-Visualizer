param(
  [switch]$SelfCheck
)

$ErrorActionPreference = "Stop"
$installDir = Join-Path $env:LOCALAPPDATA "MinimalWaveVisualizer"
$helperExe = Join-Path $installDir "MinimalWaveBassHelper.exe"
$stateFile = Join-Path $installDir "install-state.json"
$runKey = "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run"
$protocolSubKey = "Software\Classes\spotify\shell\open\command"
$storeShortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Spotify (Minimal Wave Visualizer).lnk"

function Test-HelperCommand([string]$value) {
  return $value -and $value.IndexOf($helperExe, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-InstalledHelperProcesses {
  if (-not (Test-Path -LiteralPath $helperExe)) {
    return @()
  }
  $expected = [IO.Path]::GetFullPath($helperExe)
  return @(Get-Process -Name "MinimalWaveBassHelper" -ErrorAction SilentlyContinue | Where-Object {
    try {
      $_.Path -and [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($_.Path), $expected)
    } catch {
      $false
    }
  })
}

function Restore-Shortcut($snapshot) {
  if (-not $snapshot.Exists) {
    return
  }

  $shell = New-Object -ComObject WScript.Shell
  try {
    if (-not (Test-Path -LiteralPath $snapshot.Path)) {
      return
    }
    $shortcut = $shell.CreateShortcut([string]$snapshot.Path)
    try {
      if (-not (Test-HelperCommand ([string]$shortcut.TargetPath))) {
        return
      }
      $shortcut.TargetPath = [string]$snapshot.TargetPath
      $shortcut.Arguments = [string]$snapshot.Arguments
      $shortcut.WorkingDirectory = [string]$snapshot.WorkingDirectory
      $shortcut.IconLocation = [string]$snapshot.IconLocation
      $shortcut.Save()
    } finally {
      [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
  }
}

function Restore-Protocol($state) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($protocolSubKey, $true)
  if (-not $key) {
    return
  }
  try {
    $current = [string]$key.GetValue("")
    if (-not (Test-HelperCommand $current)) {
      return
    }
    if ($state.ProtocolPresent) {
      $key.SetValue("", [string]$state.ProtocolValue, [Microsoft.Win32.RegistryValueKind]::String)
    } else {
      $key.DeleteValue("", $false)
    }
  } finally {
    $key.Dispose()
  }
}

function Invoke-SelfCheck {
  if (-not (Test-HelperCommand ('"{0}" --launch-spotify' -f $helperExe)) -or
      (Test-HelperCommand '"C:\Other\Helper.exe" --launch-spotify')) {
    throw "Native uninstaller command ownership self-check failed."
  }
  Write-Host "Native uninstaller self-check passed."
}

if ($SelfCheck) {
  Invoke-SelfCheck
  exit 0
}

if (-not (Test-Path -LiteralPath $stateFile)) {
  Write-Host "Minimal Wave Visualizer native FFT is not installed."
  exit 0
}

$state = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
$runningHelpers = Get-InstalledHelperProcesses
if ($runningHelpers.Count) {
  $runningHelpers | Stop-Process -Force
  $runningHelpers | Wait-Process -Timeout 5 -ErrorAction SilentlyContinue
}

foreach ($snapshot in @($state.Shortcuts)) {
  Restore-Shortcut $snapshot
}

if ($state.StoreShortcutCreated -and (Test-Path -LiteralPath $storeShortcut)) {
  $shell = New-Object -ComObject WScript.Shell
  try {
    $shortcut = $shell.CreateShortcut($storeShortcut)
    try {
      if (Test-HelperCommand ([string]$shortcut.TargetPath)) {
        Remove-Item -LiteralPath $storeShortcut -Force
      }
    } finally {
      [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
  }
}

if (Test-Path -LiteralPath $runKey) {
  $currentRun = Get-ItemPropertyValue -LiteralPath $runKey -Name "Spotify" -ErrorAction SilentlyContinue
  if (Test-HelperCommand ([string]$currentRun)) {
    if ($state.RunPresent) {
      Set-ItemProperty -LiteralPath $runKey -Name "Spotify" -Value ([string]$state.RunValue)
    } else {
      Remove-ItemProperty -LiteralPath $runKey -Name "Spotify" -ErrorAction SilentlyContinue
    }
  }
}

Restore-Protocol $state
Remove-Item -LiteralPath $installDir -Recurse -Force
Write-Host "Minimal Wave Visualizer native FFT uninstalled and Spotify launch settings restored."
