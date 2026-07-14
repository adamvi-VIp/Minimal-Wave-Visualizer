param(
  [switch]$SelfCheck
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repository = "adamvi-VIp/Minimal-Wave-Visualizer"
$assetName = "MinimalWaveBassHelper-win-x64.exe"
$releaseBase = "https://github.com/$repository/releases/latest/download"
$installDir = Join-Path $env:LOCALAPPDATA "MinimalWaveVisualizer"
$helperExe = Join-Path $installDir "MinimalWaveBassHelper.exe"
$stateFile = Join-Path $installDir "install-state.json"
$hashFile = Join-Path $installDir "installed.sha256"
$classicSpotifyExe = Join-Path $env:APPDATA "Spotify\Spotify.exe"
$runKey = "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run"
$protocolSubKey = "Software\Classes\spotify\shell\open\command"
$spotifyFlags = @("--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding")
$knownShortcuts = @(
  (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Spotify.lnk"),
  (Join-Path $env:USERPROFILE "Desktop\Spotify.lnk"),
  (Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Spotify.lnk")
)
$storeShortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Spotify (Minimal Wave Visualizer).lnk"

function Get-StoreSpotifyAumid {
  $package = Get-AppxPackage -Name "SpotifyAB.SpotifyMusic" -ErrorAction SilentlyContinue |
    Sort-Object Version -Descending |
    Select-Object -First 1
  if (-not $package) {
    return $null
  }

  $application = (Get-AppxPackageManifest $package).Package.Applications.Application |
    Where-Object { $_.Executable -match "Spotify" } |
    Select-Object -First 1
  if (-not $application) {
    return $null
  }

  return "{0}!{1}" -f $package.PackageFamilyName, $application.Id
}

function Get-SpotifyTarget {
  if (Test-Path -LiteralPath $classicSpotifyExe) {
    return [pscustomobject]@{ Kind = "classic"; Aumid = $null }
  }

  $aumid = Get-StoreSpotifyAumid
  if ($aumid) {
    return [pscustomobject]@{ Kind = "store"; Aumid = $aumid }
  }

  throw "Spotify was not found. Install Spotify from spotify.com or Microsoft Store first."
}

function Get-HelperLaunchArguments($target, [string[]]$extraArguments = @()) {
  $arguments = [Collections.Generic.List[string]]::new()
  $arguments.Add("--launch-spotify")
  if ($target.Aumid) {
    $arguments.Add('--spotify-aumid="{0}"' -f $target.Aumid)
  }
  foreach ($argument in $extraArguments + $spotifyFlags) {
    if ($argument -and -not $arguments.Contains($argument)) {
      $arguments.Add($argument)
    }
  }
  return @($arguments)
}

function Get-ProtocolCommand($target) {
  $arguments = Get-HelperLaunchArguments $target @('--protocol-uri="%1"')
  return ('"{0}" {1}' -f $helperExe, ($arguments -join " "))
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

function Remove-HelperLaunchPrefix([string]$arguments) {
  return ($arguments -replace '^\s*--launch-spotify(?:\s+|$)', '').Trim()
}

function Convert-LegacyHelperCommand([string]$command, $target) {
  if ($target.Kind -ne "classic" -or -not $command) {
    return $command
  }

  $match = [Regex]::Match(
    $command,
    ('^"?{0}"?(?:\s+|$)' -f [Regex]::Escape($helperExe)),
    [Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
  if (-not $match.Success) {
    return $command
  }

  $arguments = Remove-HelperLaunchPrefix $command.Substring($match.Length)
  return ('"{0}" {1}' -f $classicSpotifyExe, $arguments).Trim()
}

function Get-ShortcutSnapshot([string]$path, $target) {
  if (-not (Test-Path -LiteralPath $path)) {
    return [pscustomobject]@{ Path = $path; Exists = $false }
  }

  $shell = New-Object -ComObject WScript.Shell
  try {
    $shortcut = $shell.CreateShortcut($path)
    try {
      $targetPath = [string]$shortcut.TargetPath
      $arguments = [string]$shortcut.Arguments
      if ($target.Kind -eq "classic" -and
          [StringComparer]::OrdinalIgnoreCase.Equals($targetPath, $helperExe)) {
        $targetPath = $classicSpotifyExe
        $arguments = Remove-HelperLaunchPrefix $arguments
      }
      return [pscustomobject]@{
        Path = $path
        Exists = $true
        TargetPath = $targetPath
        Arguments = $arguments
        WorkingDirectory = [string]$shortcut.WorkingDirectory
        IconLocation = [string]$shortcut.IconLocation
      }
    } finally {
      [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
  }
}

function Get-ProtocolValue {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($protocolSubKey, $false)
  if (-not $key) {
    return [pscustomobject]@{ Exists = $false; Value = $null }
  }
  try {
    return [pscustomobject]@{ Exists = $true; Value = [string]$key.GetValue("") }
  } finally {
    $key.Dispose()
  }
}

function Save-InstallState($target) {
  if (Test-Path -LiteralPath $stateFile) {
    return
  }

  $runPresent = $false
  $runValue = $null
  if (Test-Path -LiteralPath $runKey) {
    $runValue = Get-ItemPropertyValue -LiteralPath $runKey -Name "Spotify" -ErrorAction SilentlyContinue
    $runPresent = $null -ne $runValue
  }
  $protocol = Get-ProtocolValue
  $state = [pscustomobject]@{
    Version = 1
    SpotifyKind = $target.Kind
    StoreAumid = $target.Aumid
    RunPresent = $runPresent
    RunValue = Convert-LegacyHelperCommand ([string]$runValue) $target
    ProtocolPresent = $protocol.Exists
    ProtocolValue = Convert-LegacyHelperCommand ([string]$protocol.Value) $target
    Shortcuts = @($knownShortcuts | ForEach-Object { Get-ShortcutSnapshot $_ $target })
    StoreShortcutCreated = $target.Kind -eq "store" -and -not (Test-Path -LiteralPath $storeShortcut)
  }
  $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $stateFile -Encoding UTF8
}

function Set-Shortcut([string]$path, $target) {
  $shell = New-Object -ComObject WScript.Shell
  try {
    $shortcut = $shell.CreateShortcut($path)
    try {
      $shortcut.TargetPath = $helperExe
      $shortcut.Arguments = (Get-HelperLaunchArguments $target) -join " "
      $shortcut.WorkingDirectory = $installDir
      $shortcut.IconLocation = if (Test-Path -LiteralPath $classicSpotifyExe) { "$classicSpotifyExe,0" } else { "$helperExe,0" }
      $shortcut.Save()
    } finally {
      [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
  }
}

function Update-LaunchIntegration($target) {
  if ($target.Kind -eq "classic") {
    foreach ($path in $knownShortcuts) {
      if (-not (Test-Path -LiteralPath $path)) {
        continue
      }
      $snapshot = Get-ShortcutSnapshot $path
      if ($snapshot.TargetPath -and
          ([StringComparer]::OrdinalIgnoreCase.Equals($snapshot.TargetPath, $classicSpotifyExe) -or
           [StringComparer]::OrdinalIgnoreCase.Equals($snapshot.TargetPath, $helperExe))) {
        Set-Shortcut $path $target
      }
    }
  } else {
    Set-Shortcut $storeShortcut $target
  }

  if (Test-Path -LiteralPath $runKey) {
    $currentRun = Get-ItemPropertyValue -LiteralPath $runKey -Name "Spotify" -ErrorAction SilentlyContinue
    if ($currentRun) {
      $autostart = @("--autostart", "--minimized")
      Set-ItemProperty -LiteralPath $runKey -Name "Spotify" -Value ('"{0}" {1}' -f $helperExe, ((Get-HelperLaunchArguments $target $autostart) -join " "))
    }
  }

  $protocol = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($protocolSubKey, $true)
  try {
    $protocol.SetValue("", (Get-ProtocolCommand $target), [Microsoft.Win32.RegistryValueKind]::String)
  } finally {
    $protocol.Dispose()
  }
}

function Invoke-SelfCheck {
  if ($PSCommandPath -and (Get-Content -LiteralPath $PSCommandPath -Raw) -match '(?im)^\s*\$selfCheck\s*=') {
    throw 'Installer variable shadows the public -SelfCheck switch.'
  }

  $classic = [pscustomobject]@{ Kind = "classic"; Aumid = $null }
  $store = [pscustomobject]@{ Kind = "store"; Aumid = "SpotifyAB.Test!Spotify" }
  $classicArguments = Get-HelperLaunchArguments $classic @("--minimized")
  $storeArguments = Get-HelperLaunchArguments $store @("--minimized")
  if ($classicArguments -join " " -ne "--launch-spotify --minimized --disable-backgrounding-occluded-windows --disable-renderer-backgrounding") {
    throw "Classic launch argument self-check failed."
  }
  if (($storeArguments -join " ") -notmatch '--spotify-aumid="SpotifyAB\.Test!Spotify"') {
    throw "Store AUMID self-check failed."
  }
  if ((Get-ProtocolCommand $store) -notmatch '--protocol-uri="%1"') {
    throw "Protocol command self-check failed."
  }
  $legacy = ('"{0}" --launch-spotify --autostart' -f $helperExe)
  if ((Convert-LegacyHelperCommand $legacy $classic) -ne ('"{0}" --autostart' -f $classicSpotifyExe)) {
    throw "Legacy source-install migration self-check failed."
  }
  Write-Host "Native installer self-check passed."
}

if ($SelfCheck) {
  Invoke-SelfCheck
  exit 0
}

if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Version.Build -lt 20348) {
  throw "Native FFT requires 64-bit Windows build 20348 or newer (Windows 11 recommended)."
}

$target = Get-SpotifyTarget
$downloadDir = Join-Path $env:TEMP ("mwv-native-{0}" -f [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null

try {
  $downloadedExe = Join-Path $downloadDir $assetName
  $downloadedHashes = Join-Path $downloadDir "SHA256SUMS.txt"
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$assetName" -OutFile $downloadedExe
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/SHA256SUMS.txt" -OutFile $downloadedHashes

  $expectedHash = (Get-Content -LiteralPath $downloadedHashes | Where-Object { $_ -match [Regex]::Escape($assetName) } | Select-Object -First 1) -replace '\s+\*?.*$', ''
  $actualHash = (Get-FileHash -LiteralPath $downloadedExe -Algorithm SHA256).Hash
  if (-not $expectedHash -or $actualHash -ne $expectedHash.Trim().ToUpperInvariant()) {
    throw "Native helper checksum verification failed."
  }

  $helperSelfCheckProcess = Start-Process -FilePath $downloadedExe -ArgumentList "--self-check" -Wait -PassThru -WindowStyle Hidden
  if ($helperSelfCheckProcess.ExitCode -ne 0) {
    throw "Native helper self-check failed."
  }

  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  Save-InstallState $target
  $runningHelpers = Get-InstalledHelperProcesses
  if ($runningHelpers.Count) {
    $runningHelpers | Stop-Process -Force
    $runningHelpers | Wait-Process -Timeout 5 -ErrorAction SilentlyContinue
  }
  Copy-Item -LiteralPath $downloadedExe -Destination $helperExe -Force
  Set-Content -LiteralPath $hashFile -Value $actualHash -NoNewline
  Update-LaunchIntegration $target

  if (Get-Process -Name "Spotify" -ErrorAction SilentlyContinue) {
    $attachArguments = if ($target.Aumid) { @('--spotify-aumid="{0}"' -f $target.Aumid) } else { @() }
    Start-Process -FilePath $helperExe -ArgumentList $attachArguments -WorkingDirectory $installDir -WindowStyle Hidden
  }
} finally {
  if (Test-Path -LiteralPath $downloadDir) {
    Remove-Item -LiteralPath $downloadDir -Recurse -Force
  }
}

Write-Host "Minimal Wave Visualizer native FFT installed."
Write-Host "Spotify will use one helper process while running and preview mode when the helper is unavailable."
