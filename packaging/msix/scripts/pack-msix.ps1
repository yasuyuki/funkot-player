# Pack an unsigned MSIX for Funkot (Microsoft Store / Partner Center upload).
#
# Prerequisites (Windows):
#   - Node.js + npm deps (`npm ci` in repo root)
#   - Rust toolchain able to `npm run tauri -- build --no-bundle`
#   - Windows 10 SDK (makeappx.exe under "Windows Kits\10\bin")
#
# Usage (from repo root, PowerShell):
#   .\packaging\msix\scripts\pack-msix.ps1
#   .\packaging\msix\scripts\pack-msix.ps1 -SkipBuild   # use existing release exe
#
# Output (unsigned):
#   packaging\msix\out\Funkot_0.6.0.0_x64.msix
#
# Notes:
#   - Build uses --no-bundle so WiX/NSIS icons are not required; MSIX is packed
#     separately with makeappx.
#   - Release builds use crt-static (src-tauri/.cargo/config.toml); extra VC++
#     runtime DLLs are generally not required beside the exe.
#   - WebView2 is a system dependency (Evergreen Runtime). Do not ship the
#     full runtime inside the MSIX; ensure the Store / device has WebView2.
#   - Replace Identity Name / Publisher in Package.appxmanifest before Store
#     submission (see packaging/msix/README.md).

[CmdletBinding()]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$MsixRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ManifestSrc = Join-Path $MsixRoot "Package.appxmanifest"
$IconsDir = Join-Path $RepoRoot "src-tauri\icons"
$ReleaseDir = Join-Path $RepoRoot "src-tauri\target\release"
$ExeName = "funkot-player.exe"
$PackageVersion = "0.6.0.0"
$OutDir = Join-Path $MsixRoot "out"
$OutMsix = Join-Path $OutDir "Funkot_${PackageVersion}_x64.msix"
$StagingDir = Join-Path $MsixRoot "staging"

function Find-MakeAppx {
    $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    if (-not (Test-Path $kitsRoot)) {
        throw "Windows Kits not found at $kitsRoot (install Windows 10/11 SDK)."
    }
    $candidates = Get-ChildItem -Path $kitsRoot -Recurse -Filter "makeappx.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\makeappx\.exe$' } |
        Sort-Object FullName -Descending
    if (-not $candidates) {
        $candidates = Get-ChildItem -Path $kitsRoot -Recurse -Filter "makeappx.exe" -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending
    }
    if (-not $candidates) {
        throw "makeappx.exe not found under $kitsRoot"
    }
    return $candidates[0].FullName
}

function Get-ManifestLanguages([string]$Xml) {
    [regex]::Matches($Xml, '<Resource Language="([^"]+)"') |
        ForEach-Object { $_.Groups[1].Value }
}

function Get-PackedAppxManifestXml([string]$MsixPath) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($MsixPath)
    try {
        $entry = $zip.GetEntry("AppxManifest.xml")
        if (-not $entry) {
            throw "packed MSIX has no AppxManifest.xml: $MsixPath"
        }
        $stream = $entry.Open()
        try {
            $reader = New-Object System.IO.StreamReader($stream)
            try {
                return $reader.ReadToEnd()
            } finally {
                $reader.Dispose()
            }
        } finally {
            $stream.Dispose()
        }
    } finally {
        $zip.Dispose()
    }
}

function Assert-PackedPackageLanguages {
    $srcXml = Get-Content -Raw -LiteralPath $ManifestSrc
    $src = @(Get-ManifestLanguages $srcXml)
    $packedXml = Get-PackedAppxManifestXml $OutMsix
    $got = @(Get-ManifestLanguages $packedXml)
    $srcKey = ($src | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object) -join ","
    $gotKey = ($got | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object) -join ","
    if ($srcKey -ne $gotKey) {
        throw "packed AppxManifest languages ($($got -join ', ')) != source ($($src -join ', '))"
    }
    if (-not $got) {
        throw "packed AppxManifest.xml has no Resource Language entries"
    }
    Write-Host "Packed package languages: $($got -join ', ')"
}

Push-Location $RepoRoot
try {
    if (-not $SkipBuild) {
        Write-Host "Building release exe (npm run tauri -- build --no-bundle)..."
        npm run tauri -- build --no-bundle
        if ($LASTEXITCODE -ne 0) {
            throw "tauri build failed with exit code $LASTEXITCODE"
        }
    } else {
        Write-Host "SkipBuild: using existing release under $ReleaseDir"
    }

    $ExePath = Join-Path $ReleaseDir $ExeName
    if (-not (Test-Path $ExePath)) {
        throw "Missing $ExePath. Run without -SkipBuild, or build first with: npm run tauri -- build"
    }
    if (-not (Test-Path $ManifestSrc)) {
        throw "Missing manifest: $ManifestSrc"
    }
    if (-not (Test-Path $IconsDir)) {
        throw "Missing icons dir: $IconsDir"
    }

    if (Test-Path $StagingDir) {
        Remove-Item -Recurse -Force $StagingDir
    }
    $AssetsDir = Join-Path $StagingDir "Assets"
    New-Item -ItemType Directory -Path $AssetsDir -Force | Out-Null
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

    # makeappx requires the footprint name AppxManifest.xml inside the package root.
    Copy-Item -Path $ManifestSrc -Destination (Join-Path $StagingDir "AppxManifest.xml")
    Copy-Item -Path $ExePath -Destination (Join-Path $StagingDir $ExeName)

    # Optional sidecars (usually none with crt-static; WebView2Loader.dll if present).
    Get-ChildItem -Path $ReleaseDir -Filter "*.dll" -File -ErrorAction SilentlyContinue |
        ForEach-Object { Copy-Item $_.FullName -Destination $StagingDir }

    $logoFiles = @(
        "StoreLogo.png",
        "Square44x44Logo.png",
        "Square71x71Logo.png",
        "Square150x150Logo.png"
    )
    foreach ($name in $logoFiles) {
        $src = Join-Path $IconsDir $name
        if (-not (Test-Path $src)) {
            throw "Missing icon $src (expected under src-tauri/icons; regenerate with tauri icon if needed)"
        }
        Copy-Item -Path $src -Destination (Join-Path $AssetsDir $name)
    }

    $MakeAppx = Find-MakeAppx
    Write-Host "Using makeappx: $MakeAppx"
    if (Test-Path $OutMsix) {
        Remove-Item -Force $OutMsix
    }

    & $MakeAppx pack /d $StagingDir /p $OutMsix /o
    if ($LASTEXITCODE -ne 0) {
        throw "makeappx pack failed with exit code $LASTEXITCODE"
    }

    Assert-PackedPackageLanguages

    Write-Host "Wrote unsigned MSIX: $OutMsix"
    Write-Host "Upload this file in Partner Center (or self-sign for local sideload — see README)."
}
finally {
    Pop-Location
}
