param(
    [Parameter(Mandatory = $true)][string]$Msix,
    [string]$Version,
    [string]$ProductId,
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).ProviderPath
$packageManifest = Join-Path $repoRoot 'packaging\msix\Package.appxmanifest'
$tauriConf = Join-Path $repoRoot 'src-tauri\tauri.conf.json'
$languages = 'ja', 'en', 'id'

function Get-MsixIdentity {
    param([string]$Path)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entry = $zip.GetEntry('AppxManifest.xml')
        if (-not $entry) { throw "no AppxManifest.xml in $Path" }
        $stream = $entry.Open()
        try {
            $reader = New-Object System.IO.StreamReader($stream)
            $xml = [xml]$reader.ReadToEnd()
        } finally { $stream.Dispose() }
    } finally { $zip.Dispose() }

    return $xml.Package.Identity
}

function Get-LanguageForLocale {
    param([string]$Locale)

    switch -regex ($Locale) {
        '^ja' { return 'ja' }
        '^en' { return 'en' }
        '^id' { return 'id' }
        default { return $null }
    }
}

function Invoke-MsStore {
    param([string[]]$Arguments)

    $output = & msstore @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "msstore $($Arguments -join ' ') failed ($LASTEXITCODE):`n$($output | Out-String)"
    }
    return ($output | Out-String)
}

if (-not (Test-Path -LiteralPath $Msix)) { throw "no package at $Msix" }
$msixPath = (Resolve-Path -LiteralPath $Msix).ProviderPath

if (-not $Version) {
    $Version = (Get-Content -LiteralPath $tauriConf -Raw | ConvertFrom-Json).version
}
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw "unexpected version: $Version" }

$identity = Get-MsixIdentity -Path $msixPath
$expected = ([xml](Get-Content -LiteralPath $packageManifest -Raw)).Package.Identity

if ($identity.Version -ne "$Version.0") {
    throw "package is $($identity.Version), expected $Version.0 -- repack or pass -Version"
}
foreach ($field in 'Name', 'Publisher') {
    if ($identity.$field -ne $expected.$field) {
        throw "package Identity $field is $($identity.$field), expected $($expected.$field)"
    }
}

$notesJson = & node (Join-Path $repoRoot 'scripts\store-notes.mjs') $Version 2>&1
if ($LASTEXITCODE -ne 0) { throw "scripts/store-notes.mjs failed:`n$($notesJson | Out-String)" }
$notes = ($notesJson | Out-String | ConvertFrom-Json).notes

Write-Host "package  $msixPath"
Write-Host "identity $($identity.Name) $($identity.Version)"
foreach ($lang in $languages) {
    Write-Host ''
    Write-Host "what's new [$lang]:"
    Write-Host $notes.$lang
}

if ($DryRun) {
    Write-Host ''
    Write-Host 'OK: dry run -- nothing was sent to Partner Center'
    return
}

Invoke-MsStore -Arguments @('info') | Out-Null

if (-not $ProductId) {
    $apps = Invoke-MsStore -Arguments @('apps', 'list')
    $line = ($apps -split "`n") | Where-Object { $_ -match [regex]::Escape($identity.Name) } | Select-Object -First 1
    if ($line -and $line -match '\b9[A-Z0-9]{11}\b') {
        $ProductId = $Matches[0]
    } else {
        throw "could not find the product id for $($identity.Name); pass -ProductId`n$apps"
    }
}
Write-Host ''
Write-Host "product  $ProductId"

$status = Invoke-MsStore -Arguments @('submission', 'status', $ProductId)
Write-Host "status   $($status.Trim())"

# Heuristic, and deliberately loud: the authoritative state is Partner Center.
# `msstore publish` throws away a pending draft and rebuilds it from the last
# published submission, so anything already staged by hand would be lost.
if (-not $Force -and $status -match '(?i)in ?progress|pending|certification|publishing') {
    throw 'a submission looks pending -- review it in Partner Center. Re-run with -Force only if that draft can be discarded'
}

Write-Host ''
Write-Host 'uploading the package as a draft...'
# The project is Tauri, which `msstore init` does not know, so the app id is
# always passed explicitly and the positional path is just where the package
# sits -- msstore only uses it to look for a project it will not find here.
Invoke-MsStore -Arguments @(
    'publish', (Split-Path -Parent $msixPath),
    '-i', $msixPath, '-id', $ProductId, '--noCommit'
) | Write-Host

$submission = (Invoke-MsStore -Arguments @('submission', 'get', $ProductId)) | ConvertFrom-Json
if (-not $submission.Listings) { throw 'the submission has no Listings to update' }

$applied = @()
foreach ($listing in $submission.Listings.PSObject.Properties) {
    $lang = Get-LanguageForLocale -Locale $listing.Name
    if (-not $lang) { throw "no what's-new block maps to Store locale $($listing.Name)" }
    $listing.Value.BaseListing.ReleaseNotes = $notes.$lang
    $applied += "$($listing.Name) <- $lang"
}

Invoke-MsStore -Arguments @(
    'submission', 'update', $ProductId,
    ($submission | ConvertTo-Json -Depth 100 -Compress)
) | Out-Null

Write-Host ''
foreach ($pair in $applied) { Write-Host "release notes $pair" }
Write-Host ''
Write-Host 'OK: draft is staged and NOT submitted.'
Write-Host 'Review it, then press Submit for certification yourself:'
Write-Host '  https://partner.microsoft.com/dashboard'
