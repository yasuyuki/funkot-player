# Guard the Windows Funkot profile across a local Store-like test run.
#
# Default -Run:
#   1) backup settings JSON + Music + funkot-cache
#   2) move the live profile aside (.guard-stash) and create an empty
#      first-launch directory (do not delete live in place)
#   3) launch the deployed exe (demos seed into empty Music)
#   4) on exit, rename the stash back over the test profile
#
# If PowerShell is killed before step 4, the original files remain in
# .guard-stash. The next -Backup / -Restore / -Run puts that stash back
# before touching backup or live.
#
# Usage (from Windows or via scripts/win-profile-guard.sh):
#   .\scripts\win-profile-guard.ps1 -Backup
#   .\scripts\win-profile-guard.ps1 -Restore
#   .\scripts\win-profile-guard.ps1 -Run -ReplaceBackup
#   .\scripts\win-profile-guard.ps1 -Run -InPlace -ReplaceBackup   # mutate live, no stash
#   .\scripts\win-profile-guard.ps1 -SelfTest
#
# Profile:  %APPDATA%\jp.hatsuboshi.funkotplayer
# Backup:   %APPDATA%\jp.hatsuboshi.funkotplayer.guard-bak
# Stash:    %APPDATA%\jp.hatsuboshi.funkotplayer.guard-stash
# Exe:      C:\funkot-player-test\funkot-player.exe  (-Exe to override)

param(
    [switch]$Backup,
    [switch]$Restore,
    [switch]$Run,
    [switch]$SelfTest,
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
$Stash = Join-Path $env:APPDATA ($ProfileName + '.guard-stash')
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

# Put a leftover .guard-stash back over live. Returns $true if a stash was
# applied. Must run before Invoke-Backup so -ReplaceBackup cannot snapshot an
# empty test profile and discard the previous backup of real data.
function Restore-LiveFromStash {
    if (-not (Test-Path -LiteralPath $Stash)) {
        return $false
    }
    if ((Get-FunkotTestProcesses)) {
        throw "stop funkot-player ($Exe) before restoring stash"
    }
    Write-Host "WARN: leftover profile stash at $Stash; restoring live before continuing"
    if (Test-Path -LiteralPath $Live) {
        Remove-Item -LiteralPath $Live -Recurse -Force
    }
    Move-Item -LiteralPath $Stash -Destination $Live
    Write-Host "OK: live profile restored from stash"
    return $true
}

function Invoke-Backup {
    Restore-LiveFromStash | Out-Null
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

    if (Test-Path -LiteralPath $Stash) {
        throw "stash already exists: $Stash; restore it before creating another empty live profile"
    }

    # Rename the whole live directory aside. In-place deletion is what left
    # AppData empty when -Run was killed before restore. files not listed in
    # $StateFiles (labels.json, history.json, ...) go with the stash too.
    Move-Item -LiteralPath $Live -Destination $Stash
    New-Item -ItemType Directory -Force -Path $Live | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $Live 'Music') | Out-Null

    Write-Host "OK: live profile moved to stash; empty first-launch profile at $Live"
}

function Invoke-RestoreFromBak {
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

function Invoke-Restore {
    if (Restore-LiveFromStash) {
        return
    }
    Invoke-RestoreFromBak
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
            if (Test-Path -LiteralPath $Stash) {
                Write-Host "Original profile left at: $Stash"
            }
            Write-Host "Backup left at: $Bak"
            throw
        }
    }
}

function Assert-SelfTest([bool]$Condition, [string]$Message) {
    if (-not $Condition) {
        throw "selftest failed: $Message"
    }
}

function Invoke-SelfTest {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('funkot-guard-selftest-' + [guid]::NewGuid().ToString('N'))
    $script:Live = Join-Path $root $ProfileName
    $script:Bak = Join-Path $root ($ProfileName + '.guard-bak')
    $script:Stash = Join-Path $root ($ProfileName + '.guard-stash')
    $script:Exe = Join-Path $root 'no-such-funkot-player.exe'
    $script:ReplaceBackup = $true
    $script:SkipCache = $false
    $script:InPlace = $false

    $sentinel = 'guard-selftest-sentinel'
    $settings = Join-Path $Live 'settings.json'
    $labels = Join-Path $Live 'labels.json'
    $musicFile = Join-Path (Join-Path $Live 'Music') 'keep-me.txt'

    try {
        New-Item -ItemType Directory -Force -Path (Join-Path $Live 'Music') | Out-Null
        Set-Content -LiteralPath $settings -Value $sentinel -Encoding UTF8
        Set-Content -LiteralPath $labels -Value $sentinel -Encoding UTF8
        Set-Content -LiteralPath $musicFile -Value $sentinel -Encoding UTF8

        Invoke-Backup
        Assert-SelfTest (Test-Path -LiteralPath (Join-Path $Bak 'settings.json')) 'backup copied settings.json'

        Invoke-ResetToFreshInstall
        Assert-SelfTest (-not (Test-Path -LiteralPath $settings)) 'live settings.json must leave with the stash'
        Assert-SelfTest (-not (Test-Path -LiteralPath $labels)) 'live labels.json must leave with the stash'
        Assert-SelfTest (Test-Path -LiteralPath (Join-Path $Live 'Music')) 'empty live keeps Music/'
        Assert-SelfTest ((Get-ChildItem -LiteralPath (Join-Path $Live 'Music') -Force | Measure-Object).Count -eq 0) 'empty live Music/ must have no tracks'
        Assert-SelfTest (Test-Path -LiteralPath (Join-Path $Stash 'settings.json')) 'stash holds settings.json'
        Assert-SelfTest (Test-Path -LiteralPath (Join-Path $Stash 'labels.json')) 'stash holds labels.json'
        Assert-SelfTest ((Get-Content -LiteralPath (Join-Path $Stash 'settings.json') -Raw) -match $sentinel) 'stash settings.json keeps sentinel'

        # Simulate a killed -Run: do not restore. The next backup must recover
        # stash first so -ReplaceBackup cannot overwrite bak with an empty live.
        Invoke-Backup
        Assert-SelfTest (-not (Test-Path -LiteralPath $Stash)) 'backup recovers leftover stash'
        Assert-SelfTest ((Get-Content -LiteralPath $settings -Raw) -match $sentinel) 'live settings.json returns from stash'
        Assert-SelfTest ((Get-Content -LiteralPath $labels -Raw) -match $sentinel) 'live labels.json returns from stash'
        Assert-SelfTest ((Get-Content -LiteralPath (Join-Path $Bak 'settings.json') -Raw) -match $sentinel) 'bak still has sentinel after recovered -ReplaceBackup'

        Invoke-ResetToFreshInstall
        Invoke-Restore
        Assert-SelfTest (-not (Test-Path -LiteralPath $Stash)) 'restore consumes stash'
        Assert-SelfTest ((Get-Content -LiteralPath $settings -Raw) -match $sentinel) 'restore from stash returns settings.json'
        Assert-SelfTest ((Get-Content -LiteralPath $labels -Raw) -match $sentinel) 'restore from stash returns labels.json'
        Assert-SelfTest ((Get-Content -LiteralPath $musicFile -Raw) -match $sentinel) 'restore from stash returns Music files'

        Write-Host "OK: selftest passed ($root)"
    }
    finally {
        if (Test-Path -LiteralPath $root) {
            Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

$modeCount = @($Backup, $Restore, $Run, $SelfTest).Where({ $_ }).Count
if ($modeCount -eq 0) {
    throw 'Specify one of -Backup / -Restore / -Run / -SelfTest'
}
if ($modeCount -gt 1) {
    throw 'Specify only one of -Backup / -Restore / -Run / -SelfTest'
}

if ($Backup) { Invoke-Backup }
elseif ($Restore) { Invoke-Restore }
elseif ($SelfTest) { Invoke-SelfTest }
else { Invoke-Run }
