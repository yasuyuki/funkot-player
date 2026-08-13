# Build funkot-player for Windows (no MSIX) and/or deploy to C:\funkot-player-test.
param(
    [switch]$Launch,
    [switch]$BuildOnly,
    [switch]$DeployOnly
)

$ErrorActionPreference = 'Stop'

if ($BuildOnly -and $DeployOnly) {
    throw 'Specify at most one of -BuildOnly / -DeployOnly'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseDir = Join-Path $repoRoot 'src-tauri\target\release'
$exe = Join-Path $releaseDir 'funkot-player.exe'
$dest = 'C:\funkot-player-test'
$deployed = Join-Path $dest 'funkot-player.exe'

function Invoke-Deploy {
    if (-not (Test-Path -LiteralPath $exe)) {
        throw "build output missing: $exe"
    }

    New-Item -ItemType Directory -Force -Path $dest | Out-Null

    # Running exe locks the destination file; stop our deploy target before copy.
    Get-Process -Name 'funkot-player' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and ($_.Path -ieq $deployed) } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 200

    Copy-Item -LiteralPath $exe -Destination $dest -Force
    Get-ChildItem -LiteralPath $releaseDir -Filter '*.dll' -File -ErrorAction SilentlyContinue |
        Copy-Item -Destination $dest -Force

    Write-Host "OK: deployed to $deployed"

    if ($Launch) {
        Start-Process -FilePath $deployed
    }
}

if (-not $DeployOnly) {
    # A WSL-launched build can inherit a remapped USERPROFILE from its parent
    # process tree, pointing rustup at an empty home with no toolchains.
    # GetFolderPath reads the profile from the user token, so it survives that.
    $realProfile = [Environment]::GetFolderPath('UserProfile')
    if (-not $realProfile) { $realProfile = Join-Path $env:HOMEDRIVE $env:HOMEPATH }
    $env:RUSTUP_HOME = Join-Path $realProfile '.rustup'
    $env:CARGO_HOME  = Join-Path $realProfile '.cargo'

    # WSL-launched powershell often misses User PATH; put tool bins first.
    $env:Path = @(
        (Join-Path $env:CARGO_HOME 'bin'),
        'C:\Program Files\Git\cmd',
        'C:\Program Files\nodejs',
        $env:Path
    ) -join ';'

    $vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
    if (-not (Test-Path -LiteralPath $vcvars)) {
        throw "vcvars64.bat not found: $vcvars"
    }

    # Import MSVC env into this process (need `call` so `set` runs after the bat).
    cmd /c "call `"$vcvars`" && set" | ForEach-Object {
        if ($_ -match '^(.*?)=(.*)$') {
            Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
        }
    }

    Write-Host "rustup home: $env:RUSTUP_HOME"

    if (-not (Get-Command link.exe -ErrorAction SilentlyContinue)) {
        throw 'link.exe not found after vcvars; MSVC Build Tools env was not applied'
    }

    # bindgen (signalsmith-stretch) needs libclang.dll via LIBCLANG_PATH.
    $libclangOk = $env:LIBCLANG_PATH -and (Test-Path -LiteralPath (Join-Path $env:LIBCLANG_PATH 'libclang.dll'))
    if (-not $libclangOk) {
        $libclangBin = @(
            'C:\Program Files\LLVM\bin',
            'C:\Program Files (x86)\LLVM\bin'
        ) | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'libclang.dll') } | Select-Object -First 1
        if (-not $libclangBin) {
            throw @"
libclang.dll not found (needed for bindgen / signalsmith-stretch).
Install LLVM once on Windows, then re-run ./scripts/win-run.sh:

  winget install --id LLVM.LLVM -e
"@
        }
        $env:LIBCLANG_PATH = $libclangBin
    }

    $siblingCore = Join-Path $repoRoot '..\funkot-autodj-for-ui\funkot-core'
    if (-not (Test-Path -LiteralPath $siblingCore)) {
        throw "sibling funkot-core missing: $siblingCore"
    }

    Set-Location -LiteralPath $repoRoot

    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules'))) {
        npm ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
    }

    npm run tauri -- build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed with exit code $LASTEXITCODE" }

    if (-not (Test-Path -LiteralPath $exe)) {
        throw "build output missing: $exe"
    }
    Write-Host "OK: built $exe"
}

if (-not $BuildOnly) {
    Invoke-Deploy
}
