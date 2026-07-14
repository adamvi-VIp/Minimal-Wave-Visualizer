param(
  [switch]$NoRestart,
  [switch]$SkipCheck
)

$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$extensionName = "minimal-wave-visualizer.js"
$source = Join-Path $repositoryRoot $extensionName
$targetDir = Join-Path $env:APPDATA "spicetify\Extensions"
$target = Join-Path $targetDir $extensionName
$helperSourceDir = Join-Path $repositoryRoot "bass-helper"
$helperProject = Join-Path $helperSourceDir "MinimalWaveBassHelper.csproj"
$helperInstallDir = Join-Path $env:LOCALAPPDATA "MinimalWaveVisualizer"
$helperExe = Join-Path $helperInstallDir "MinimalWaveBassHelper.exe"
$helperHashFile = Join-Path $helperInstallDir "source.sha256"
$spotifyExe = Join-Path $env:APPDATA "Spotify\Spotify.exe"
$spotifyLaunchFlags = @(
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding"
)
$spotifyRemovedFeatures = @(
  "CalculateNativeWinOcclusion",
  "ApplyNativeOcclusionToCompositor"
)
$helperLaunchSwitch = "--launch-spotify"
$spotifyProcessArguments = @($spotifyLaunchFlags)
$helperProcessArguments = @($helperLaunchSwitch) + $spotifyProcessArguments
$spotifyShortcutPaths = @(
  (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Spotify.lnk"),
  (Join-Path $env:USERPROFILE "Desktop\Spotify.lnk"),
  (Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Spotify.lnk")
)
$spotifyRunKey = "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run"
$spotifyProtocolSubKey = "Software\Classes\spotify\shell\open\command"

if (-not (Test-Path -LiteralPath $source)) {
  throw "Missing $extensionName next to this script."
}

if (-not (Get-Command spicetify -ErrorAction SilentlyContinue)) {
  throw "spicetify was not found on PATH."
}

if (-not $SkipCheck -and (Get-Command node -ErrorAction SilentlyContinue)) {
  node --check $source
  node $source --self-check
}

function Get-HelperSourceHash {
  $entries = Get-ChildItem -LiteralPath $helperSourceDir -File |
    Where-Object { $_.Extension -in ".cs", ".csproj" } |
    Sort-Object Name |
    ForEach-Object { "{0}:{1}" -f $_.Name, (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($entries -join "|"))
  $sha = [Security.Cryptography.SHA256]::Create()

  try {
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "")
  } finally {
    $sha.Dispose()
  }
}

function Get-InstalledHelperProcesses {
  $installedPath = [IO.Path]::GetFullPath($helperExe)

  return @(Get-Process -Name "MinimalWaveBassHelper" -ErrorAction SilentlyContinue | Where-Object {
    try {
      $_.Path -and [StringComparer]::OrdinalIgnoreCase.Equals(
        [IO.Path]::GetFullPath($_.Path),
        $installedPath
      )
    } catch {
      $false
    }
  })
}

function Add-SpotifyLaunchFlags([string]$arguments) {
  $result = $arguments.Trim()
  foreach ($flag in $spotifyLaunchFlags) {
    if ($result -notmatch ("(?<!\S){0}(?!\S)" -f [Regex]::Escape($flag))) {
      $result = ("{0} {1}" -f $result, $flag).Trim()
    }
  }

  $featurePattern = '(?<!\S)"?--disable-features=(?<value>[^"\s]+)"?(?!\S)'
  $featureMatches = [Regex]::Matches($result, $featurePattern)
  $features = [Collections.Generic.List[string]]::new()
  $seenFeatures = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

  foreach ($match in $featureMatches) {
    foreach ($feature in $match.Groups["value"].Value.Split(",", [StringSplitOptions]::RemoveEmptyEntries)) {
      if ($feature -notin $spotifyRemovedFeatures -and $seenFeatures.Add($feature)) {
        $features.Add($feature)
      }
    }
  }
  for ($index = $featureMatches.Count - 1; $index -ge 0; $index--) {
    $result = $result.Remove($featureMatches[$index].Index, $featureMatches[$index].Length)
  }

  if ($features.Count) {
    $result = ("{0} --disable-features={1}" -f $result.Trim(), ($features -join ",")).Trim()
  }
  return $result.Trim()
}

function Get-SpotifyLaunchArguments([string]$arguments) {
  $result = $arguments.Trim()
  $launcherPattern = ('^{0}(?:\s+|$)' -f [Regex]::Escape($helperLaunchSwitch))
  $launcherMatch = [Regex]::Match($result, $launcherPattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($launcherMatch.Success) {
    $result = $result.Substring($launcherMatch.Length).Trim()
  }
  return Add-SpotifyLaunchFlags $result
}

function Convert-SpotifyLaunchCommand([string]$command, [bool]$useHelper) {
  $spotifyPattern = ('^"?{0}"?(?:\s|$)' -f [Regex]::Escape($spotifyExe))
  $helperPattern = ('^"?{0}"?(?:\s|$)' -f [Regex]::Escape($helperExe))
  $targetMatch = [Regex]::Match($command, $spotifyPattern)
  if (-not $targetMatch.Success) {
    $targetMatch = [Regex]::Match($command, $helperPattern)
  }
  if (-not $targetMatch.Success) {
    return $command
  }

  $arguments = Get-SpotifyLaunchArguments ($command.Substring($targetMatch.Length))
  $target = if ($useHelper) { $helperExe } else { $spotifyExe }
  $launchArguments = if ($useHelper) {
    ("{0} {1}" -f $helperLaunchSwitch, $arguments).Trim()
  } else {
    $arguments
  }
  return ('"{0}" {1}' -f $target, $launchArguments).Trim()
}

function Update-SpotifyShortcuts([bool]$useHelper) {
  $shell = New-Object -ComObject WScript.Shell
  try {
    foreach ($path in $spotifyShortcutPaths) {
      if (-not (Test-Path -LiteralPath $path)) {
        continue
      }

      $shortcut = $shell.CreateShortcut($path)
      try {
        $targetPath = if ($shortcut.TargetPath) { [IO.Path]::GetFullPath($shortcut.TargetPath) } else { "" }
        $isSpotify = [StringComparer]::OrdinalIgnoreCase.Equals($targetPath, [IO.Path]::GetFullPath($spotifyExe))
        $isHelper = [StringComparer]::OrdinalIgnoreCase.Equals($targetPath, [IO.Path]::GetFullPath($helperExe))
        if (-not $isSpotify -and -not $isHelper) {
          continue
        }

        $spotifyArguments = Get-SpotifyLaunchArguments $shortcut.Arguments
        $nextTarget = if ($useHelper) { $helperExe } else { $spotifyExe }
        $nextArguments = if ($useHelper) {
          ("{0} {1}" -f $helperLaunchSwitch, $spotifyArguments).Trim()
        } else {
          $spotifyArguments
        }
        if (-not [StringComparer]::OrdinalIgnoreCase.Equals($targetPath, [IO.Path]::GetFullPath($nextTarget)) -or
            $nextArguments -ne $shortcut.Arguments) {
          $shortcut.TargetPath = $nextTarget
          $shortcut.Arguments = $nextArguments
          $shortcut.WorkingDirectory = Split-Path -Parent $spotifyExe
          $shortcut.IconLocation = "$spotifyExe,0"
          $shortcut.Save()
        }
      } finally {
        [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null
      }
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
  }
}

function Update-SpotifyRegistryLaunches([bool]$useHelper) {
  if (Test-Path -LiteralPath $spotifyRunKey) {
    $runCommand = [string](Get-ItemPropertyValue -LiteralPath $spotifyRunKey -Name "Spotify" -ErrorAction SilentlyContinue)
    $nextRunCommand = Convert-SpotifyLaunchCommand $runCommand $useHelper
    if ($nextRunCommand -ne $runCommand) {
      Set-ItemProperty -LiteralPath $spotifyRunKey -Name "Spotify" -Value $nextRunCommand
    }
  }

  $protocol = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($spotifyProtocolSubKey, $true)
  if ($protocol) {
    try {
      $protocolCommand = [string]$protocol.GetValue("")
      $nextProtocolCommand = Convert-SpotifyLaunchCommand $protocolCommand $useHelper
      if ($nextProtocolCommand -ne $protocolCommand) {
        $protocol.SetValue("", $nextProtocolCommand, [Microsoft.Win32.RegistryValueKind]::String)
      }
    } finally {
      $protocol.Dispose()
    }
  }
}

if (-not $SkipCheck) {
  $launchProbe = Add-SpotifyLaunchFlags "--existing --disable-renderer-backgrounding --disable-features=ExistingFeature,CalculateNativeWinOcclusion,ApplyNativeOcclusionToCompositor"
  foreach ($flag in $spotifyLaunchFlags) {
    if ([Regex]::Matches($launchProbe, ("(?<!\S){0}(?!\S)" -f [Regex]::Escape($flag))).Count -ne 1) {
      throw "Spotify background launch flags should be added exactly once."
    }
  }

  $featureMatches = [Regex]::Matches($launchProbe, '(?<!\S)--disable-features=(?<value>\S+)(?!\S)')
  $featureValues = if ($featureMatches.Count -eq 1) {
    @($featureMatches[0].Groups["value"].Value.Split(",", [StringSplitOptions]::RemoveEmptyEntries))
  } else {
    @()
  }
  if (@($featureValues | Where-Object { $_ -eq "ExistingFeature" }).Count -ne 1 -or
      @($featureValues | Where-Object { $_ -in $spotifyRemovedFeatures }).Count -ne 0) {
    throw "Spotify disabled features should preserve existing values and remove the regressing occlusion exclusions."
  }
  if ((Add-SpotifyLaunchFlags $launchProbe) -ne $launchProbe) {
    throw "Spotify launch flag merging should be idempotent."
  }
  $removedOnlyProbe = Add-SpotifyLaunchFlags "--disable-features=CalculateNativeWinOcclusion,ApplyNativeOcclusionToCompositor"
  if ($removedOnlyProbe -match "--disable-features=" -or $removedOnlyProbe -ne $removedOnlyProbe.Trim() -or
      (Add-SpotifyLaunchFlags $removedOnlyProbe) -ne $removedOnlyProbe) {
    throw "Removing an empty disabled-feature list should remain clean and idempotent."
  }
  $spotifyCommandProbe = ('"{0}" --autostart --minimized' -f $spotifyExe)
  $helperCommandProbe = Convert-SpotifyLaunchCommand $spotifyCommandProbe $true
  if ($helperCommandProbe -notmatch ('^"{0}" {1}(?:\s|$)' -f [Regex]::Escape($helperExe), [Regex]::Escape($helperLaunchSwitch)) -or
      (Convert-SpotifyLaunchCommand $helperCommandProbe $true) -ne $helperCommandProbe) {
    throw "Spotify launch commands should wrap through the helper exactly once."
  }
  $restoredCommandProbe = Convert-SpotifyLaunchCommand $helperCommandProbe $false
  if ($restoredCommandProbe -notmatch ('^"{0}"(?:\s|$)' -f [Regex]::Escape($spotifyExe)) -or
      $restoredCommandProbe -match [Regex]::Escape($helperLaunchSwitch)) {
    throw "Helper launch commands should restore safely to direct Spotify startup."
  }
}

$helperLaunchReady = $false
try {
  if (-not (Test-Path -LiteralPath $helperProject)) {
    throw "Missing bass-helper\MinimalWaveBassHelper.csproj."
  }

  $sourceHash = Get-HelperSourceHash
  $installedHash = if (Test-Path -LiteralPath $helperHashFile) {
    (Get-Content -LiteralPath $helperHashFile -Raw).Trim()
  } else {
    ""
  }
  $needsBuild = -not (Test-Path -LiteralPath $helperExe) -or $installedHash -ne $sourceHash

  if ($needsBuild) {
    if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
      throw ".NET SDK was not found; native FFT will use fallback mode."
    }

    $publishDir = Join-Path $env:TEMP ("mwv-bass-publish-{0}" -f $PID)
    if (Test-Path -LiteralPath $publishDir) {
      Remove-Item -LiteralPath $publishDir -Recurse -Force
    }

    try {
      dotnet publish $helperProject `
        --configuration Release `
        --runtime win-x64 `
        --self-contained true `
        --source https://api.nuget.org/v3/index.json `
        -p:PublishSingleFile=true `
        -p:DebugType=None `
        -p:DebugSymbols=false `
        --output $publishDir
      if ($LASTEXITCODE -ne 0) {
        throw "Native bass helper publish failed."
      }

      $publishedExe = Join-Path $publishDir "MinimalWaveBassHelper.exe"
      if (-not (Test-Path -LiteralPath $publishedExe)) {
        throw "Native bass helper publish did not produce an executable."
      }

      if (-not $SkipCheck) {
        $selfCheck = Start-Process -FilePath $publishedExe -ArgumentList "--self-check" -Wait -PassThru -WindowStyle Hidden
        if ($selfCheck.ExitCode -ne 0) {
          throw "Native bass helper self-check failed."
        }
      }

      $installedProcesses = Get-InstalledHelperProcesses
      if ($installedProcesses.Count) {
        $installedProcesses | Stop-Process -Force
        $installedProcesses | Wait-Process -Timeout 5 -ErrorAction SilentlyContinue
      }

      New-Item -ItemType Directory -Path $helperInstallDir -Force | Out-Null
      Copy-Item -LiteralPath $publishedExe -Destination $helperExe -Force
      Set-Content -LiteralPath $helperHashFile -Value $sourceHash -NoNewline
    } finally {
      if (Test-Path -LiteralPath $publishDir) {
        Remove-Item -LiteralPath $publishDir -Recurse -Force
      }
    }
  }

  if (-not (Get-InstalledHelperProcesses).Count) {
    Start-Process -FilePath $helperExe -WorkingDirectory $helperInstallDir -WindowStyle Hidden
    Start-Sleep -Milliseconds 350
  }

  if (-not (Get-InstalledHelperProcesses).Count) {
    throw "Native bass helper did not stay running."
  }

  $helperLaunchReady = $true
  Write-Host "Native bass helper is running."
} catch {
  Write-Warning ("Native bass helper unavailable: {0}" -f $_.Exception.Message)
  Write-Warning "The visualizer will continue with Spotify-analysis fallback mode."
}

New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Force

try {
  Update-SpotifyShortcuts $helperLaunchReady
  Update-SpotifyRegistryLaunches $helperLaunchReady
} catch {
  Write-Warning ("Spotify launch commands could not be updated: {0}" -f $_.Exception.Message)
}

spicetify config extensions $extensionName
spicetify apply

if (-not $NoRestart) {
  Stop-Process -Name Spotify -ErrorAction SilentlyContinue
  $installedProcesses = Get-InstalledHelperProcesses
  if ($installedProcesses.Count) {
    $installedProcesses | Stop-Process -Force
    $installedProcesses | Wait-Process -Timeout 5 -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
  if ($helperLaunchReady) {
    Start-Process -FilePath $helperExe -ArgumentList $helperProcessArguments -WorkingDirectory $helperInstallDir -WindowStyle Hidden
  } else {
    Start-Process -FilePath $spotifyExe -ArgumentList $spotifyProcessArguments
  }

  # Spotify re-registers its protocol handler asynchronously while starting,
  # which can remove the flags written above. Reassert the launch entries
  # across its short startup window so the final registered value is ours.
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (Get-Process -Name Spotify -ErrorAction SilentlyContinue) {
      break
    }
    Start-Sleep -Milliseconds 100
  }
  try {
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
      Start-Sleep -Milliseconds 500
      Update-SpotifyRegistryLaunches $helperLaunchReady
    }
  } catch {
    Write-Warning ("Spotify post-start launch commands could not be updated: {0}" -f $_.Exception.Message)
  }
}

Write-Host "Applied $extensionName"
