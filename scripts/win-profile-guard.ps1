# Guard the Windows Funkot profile across a local Store-like test run.
#
# Default -Run:
#   1) backup settings JSON + Music + funkot-cache
#   2) wipe the live profile to an empty first-launch state
#   3) launch the deployed exe (demos seed into empty Music)
#   4) on exit, restore the backup
#
# Usage (from Windows or via scripts/win-profile-guard.sh):
#   .\scripts\win-profile-guard.ps1 -Backup
#   .\scripts\win-profile-guard.ps1 -Restore
#   .\scripts\win-profile-guard.ps1 -Run -ReplaceBackup
#   .\scripts\win-profile-guard.ps1 -Run -InPlace -ReplaceBackup   # mutate live, no wipe
#
# Profile:  %APPDATA%\jp.hatsuboshi.funkotplayer
# Backup:   %APPDATA%\jp.hatsuboshi.funkotplayer.guard-bak
# Exe:      C:\funkot-player-test\funkot-player.exe  (-Exe to override)

param(
    [switch]$Backup,
    [switch]$Restore,
    [switch]$Run,
    [switch]$ReplaceBackup,
    # Keep the live profile as-is during -Run (old behaviour). Default is wipe
    # to empty so UNC / leftover tracks are not visible.
    [switch]$InPlace,
    # Skip funkot-cache in backup/restore (faster; analysis may rebuild).
    [switch]$SkipCache,
    [string]$Exe = 'C:\funkot-player-test\funkot-player.exe'
)

$ErrorActionPreference = 'Stop'

$ProfileName = 'jp.hatsuboshi.funkotplayer'
$Live = Join-Path $env:APPDATA $ProfileName
$Bak = Join-Path $env:APPDATA ($ProfileName + '.guard-bak')
$ManifestName = 'guard-manifest.txt'

# Root-level files that count as "settings / state" for a round-trip test.
$StateFiles = @(
    'settings.json',
    'session.json',
    'queue.json',
    'library.json',
    'flags.json',
    'dismissed.json',
    'meta.json',
    'hash-index.json',
    'demo_seeded'
)

function Assert-LiveProfile {
    if (-not (Test-Path -LiteralPath $Live)) {
        throw "live profile missing: $Live"
    }
}

function Get-FunkotTestProcesses {
    Get-Process -Name 'funkot-player' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and ($_.Path -ieq $Exe) }
}

function Clear-DirectoryContents([string]$Dir) {
    if (-not (Test-Path -LiteralPath $Dir)) { return }
    Get-ChildItem -LiteralPath $Dir -Force | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Recurse -Force
    }
}

function Remove-LiveStateFiles {
    foreach ($name in $StateFiles) {
        $path = Join-Path $Live $name
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Force
        }
    }
}

function Invoke-Backup {
    Assert-LiveProfile

    if ((Get-FunkotTestProcesses)) {
        throw "stop funkot-player ($Exe) before backup"
    }

    if (Test-Path -LiteralPath $Bak) {
        if (-not $ReplaceBackup) {
            throw "backup already exists: $Bak (pass -ReplaceBackup to overwrite)"
        }
        Remove-Item -LiteralPath $Bak -Recurse -Force
    }

    New-Item -ItemType Directory -Force -Path $Bak | Out-Null
    $copied = New-Object System.Collections.Generic.List[string]

    foreach ($name in $StateFiles) {
        $src = Join-Path $Live $name
        if (Test-Path -LiteralPath $src) {
            Copy-Item -LiteralPath $src -Destination (Join-Path $Bak $name) -Force
            $copied.Add($name) | Out-Null
        }
    }

    $musicSrc = Join-Path $Live 'Music'
    if (Test-Path -LiteralPath $musicSrc) {
        Copy-Item -LiteralPath $musicSrc -Destination (Join-Path $Bak 'Music') -Recurse -Force
        $copied.Add('Music/') | Out-Null
    }

    if (-not $SkipCache) {
        $cacheSrc = Join-Path $Live 'funkot-cache'
        if (Test-Path -LiteralPath $cacheSrc) {
            Copy-Item -LiteralPath $cacheSrc -Destination (Join-Path $Bak 'funkot-cache') -Recurse -Force
            $copied.Add('funkot-cache/') | Out-Null
        }
    }

    $manifest = @(
        "created=$(Get-Date -Format o)"
        "live=$Live"
        "skip_cache=$SkipCache"
        "in_place=$InPlace"
        'entries:'
    ) + ($copied | ForEach-Object { "  $_" })
    Set-Content -LiteralPath (Join-Path $Bak $ManifestName) -Value $manifest -Encoding UTF8

    Write-Host "OK: backup -> $Bak"
    $copied | ForEach-Object { Write-Host "  $_" }
}

function Invoke-ResetToFreshInstall {
    Assert-LiveProfile

    if ((Get-FunkotTestProcesses)) {
        throw "stop funkot-player ($Exe) before reset"
    }

    Remove-LiveStateFiles

    $musicLive = Join-Path $Live 'Music'
    New-Item -ItemType Directory -Force -Path $musicLive | Out-Null
    Clear-DirectoryContents $musicLive

    $cacheLive = Join-Path $Live 'funkot-cache'
    if (Test-Path -LiteralPath $cacheLive) {
        Clear-DirectoryContents $cacheLive
    }

    Write-Host "OK: live profile wiped to empty (no settings / no Music tracks)"
}

function Invoke-Restore {
    Assert-LiveProfile

    if (-not (Test-Path -LiteralPath $Bak)) {
        throw "backup missing: $Bak (run -Backup or -Run first)"
    }
    if ((Get-FunkotTestProcesses)) {
        throw "stop funkot-player ($Exe) before restore"
    }

    # Drop anything the test run created, then put backup entries back.
    Remove-LiveStateFiles
    foreach ($name in $StateFiles) {
        $src = Join-Path $Bak $name
        if (Test-Path -LiteralPath $src) {
            Copy-Item -LiteralPath $src -Destination (Join-Path $Live $name) -Force
        }
    }

    $musicBak = Join-Path $Bak 'Music'
    $musicLive = Join-Path $Live 'Music'
    New-Item -ItemType Directory -Force -Path $musicLive | Out-Null
    Clear-DirectoryContents $musicLive
    if (Test-Path -LiteralPath $musicBak) {
        Get-ChildItem -LiteralPath $musicBak -Force | Copy-Item -Destination $musicLive -Recurse -Force
    }

    $cacheBak = Join-Path $Bak 'funkot-cache'
    $cacheLive = Join-Path $Live 'funkot-cache'
    New-Item -ItemType Directory -Force -Path $cacheLive | Out-Null
    Clear-DirectoryContents $cacheLive
    if (Test-Path -LiteralPath $cacheBak) {
        Get-ChildItem -LiteralPath $cacheBak -Force | Copy-Item -Destination $cacheLive -Recurse -Force
    }

    Write-Host "OK: restored from $Bak"
}

function Invoke-Run {
    if (-not (Test-Path -LiteralPath $Exe)) {
        throw "exe missing: $Exe (deploy with ./scripts/win-run.sh first)"
    }
    if ((Get-FunkotTestProcesses)) {
        throw "funkot-player already running: $Exe"
    }

    Invoke-Backup
    if (-not $InPlace) {
        Invoke-ResetToFreshInstall
    }
    else {
        Write-Host 'OK: -InPlace; launching against the live profile'
    }

    $proc = $null
    try {
        Write-Host "OK: launching $Exe (close the window to restore)"
        $proc = Start-Process -FilePath $Exe -PassThru
        Wait-Process -Id $proc.Id
        Write-Host "OK: process exited (code $($proc.ExitCode))"
    }
    finally {
        Start-Sleep -Milliseconds 400
        if (Get-FunkotTestProcesses) {
            Write-Host 'WARN: process still listed; forcing stop before restore'
            Get-FunkotTestProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 400
        }
        try {
            Invoke-Restore
        }
        catch {
            Write-Host "ERROR: restore failed: $($_.Exception.Message)"
            Write-Host "Backup left at: $Bak"
            throw
        }
    }
}

$modeCount = @($Backup, $Restore, $Run).Where({ $_ }).Count
if ($modeCount -eq 0) {
    throw 'Specify one of -Backup / -Restore / -Run'
}
if ($modeCount -gt 1) {
    throw 'Specify only one of -Backup / -Restore / -Run'
}

if ($Backup) { Invoke-Backup }
elseif ($Restore) { Invoke-Restore }
else { Invoke-Run }
