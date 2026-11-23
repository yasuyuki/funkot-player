[CmdletBinding()]
param(
    [switch]$Launch, [switch]$BuildOnly, [switch]$DeployOnly,
    [string]$Destination = 'C:\funkot-player-test'
)
$ErrorActionPreference = 'Stop'

# The build stays in this checkout's src-tauri\target (the wl slot cache).
# A stamp written after a successful build records its inputs and final files;
# a deploy refuses outputs whose stamp, inputs or files no longer agree.
$script:StampName = '.funkot-windows-build.json'
$script:DeploymentManifest = '.funkot-native-generation.json'

function Invoke-CheckedOutput {
    param([string]$Command, [string[]]$Arguments)
    $result = & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
    return ($result -join [Environment]::NewLine).Trim()
}

function Initialize-BuildEnvironment {
    # A WSL parent can remap USERPROFILE; the token profile still identifies rustup.
    $profilePath = [Environment]::GetFolderPath('UserProfile')
    if (-not $profilePath) { $profilePath = Join-Path $env:HOMEDRIVE $env:HOMEPATH }
    $env:RUSTUP_HOME = Join-Path $profilePath '.rustup'
    $env:CARGO_HOME = Join-Path $profilePath '.cargo'
    $env:Path = @((Join-Path $env:CARGO_HOME 'bin'), 'C:\Program Files\Git\cmd',
        'C:\Program Files\nodejs', $env:Path) -join ';'
    $vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
    if (-not (Test-Path -LiteralPath $vcvars)) { throw "vcvars64.bat not found: $vcvars" }
    $msvcEnvironment = cmd /c "call ""$vcvars"" && set"
    if ($LASTEXITCODE -ne 0) { throw 'MSVC environment initialization failed' }
    foreach ($line in $msvcEnvironment) {
        if ($line -match '^(.*?)=(.*)$') { Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2] }
    }
    if (-not (Get-Command link.exe -ErrorAction SilentlyContinue)) { throw 'link.exe not found after vcvars' }
    if (-not ($env:LIBCLANG_PATH -and (Test-Path -LiteralPath (Join-Path $env:LIBCLANG_PATH 'libclang.dll')))) {
        $env:LIBCLANG_PATH = @('C:\Program Files\LLVM\bin', 'C:\Program Files (x86)\LLVM\bin') |
            Where-Object { Test-Path -LiteralPath (Join-Path $_ 'libclang.dll') } | Select-Object -First 1
        if (-not $env:LIBCLANG_PATH) { throw 'libclang.dll not found. Install LLVM before building.' }
    }
}

function Get-BuildInputs {
    param([string]$Repo)
    $core = [IO.Path]::GetFullPath((Join-Path $Repo '..\funkot-autodj-for-ui'))
    if ($env:FUNKOT_CORE_REPO -and ([IO.Path]::GetFullPath($env:FUNKOT_CORE_REPO) -ine $core)) {
        throw 'FUNKOT_CORE_REPO differs from the compiled path dependency'
    }
    $gitPath = (Get-Command git.exe -ErrorAction Stop).Source
    $bash = Join-Path (Split-Path (Split-Path $gitPath)) 'bin\bash.exe'
    if (-not (Test-Path -LiteralPath $bash)) { throw 'Git Bash is required for the existing core adoption check' }
    $oldCore = $env:FUNKOT_CORE_REPO
    try {
        $env:FUNKOT_CORE_REPO = $core
        Invoke-CheckedOutput $bash @((Join-Path $Repo 'scripts\check-funkot-core-commit.sh')) | Out-Null
    } finally { $env:FUNKOT_CORE_REPO = $oldCore }
    $sources = [ordered]@{}
    $names = & git -C $Repo ls-files --cached --others --exclude-standard
    if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate player inputs' }
    foreach ($name in ($names | Sort-Object -Unique)) {
        if ($name -match '(^|/)HANDOFF\.md$') { continue }
        $file = Join-Path $Repo $name
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Player input missing: $name" }
        $sources[$name] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    }
    $flags = [ordered]@{}
    Get-ChildItem Env: | Where-Object {
        $_.Name -match '^(CARGO_(BUILD|PROFILE|ENCODED_RUSTFLAGS)|RUSTFLAGS|RUSTUP_TOOLCHAIN|TAURI_CONFIG$)'
    } | Sort-Object Name | ForEach-Object { $flags[$_.Name] = $_.Value }
    return [ordered]@{
        source_revision = Invoke-CheckedOutput git @('-C', $Repo, 'rev-parse', 'HEAD')
        sources = $sources
        core_revision = Invoke-CheckedOutput git @('-C', $core, 'rev-parse', 'HEAD')
        candidate = $env:FUNKOT_CORE_CANDIDATE_SHA
        flags = $flags
    }
}

function Invoke-NativeCompile {
    npm.cmd run tauri -- build --no-bundle | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed with exit code $LASTEXITCODE" }
}

function Get-ReleaseFiles {
    param([string]$Release)
    $executable = Join-Path $Release 'funkot-player.exe'
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Build produced no $executable" }
    $files = @(Get-Item -LiteralPath $executable) + @(Get-ChildItem -LiteralPath $Release -Filter '*.dll' -File)
    return @($files | ForEach-Object {
        [ordered]@{ name = $_.Name; path = $_.FullName; sha256 = (Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant() }
    })
}

function ConvertTo-Json30 { param($Value) return ($Value | ConvertTo-Json -Depth 30 -Compress) }

function Read-BuildStamp {
    param([string]$Release, $Inputs)
    $stamp = Join-Path $Release $script:StampName
    if (-not (Test-Path -LiteralPath $stamp -PathType Leaf)) {
        throw 'There is no successful build in this checkout; build without -DeployOnly first'
    }
    $recorded = Get-Content -LiteralPath $stamp -Raw | ConvertFrom-Json
    if ((ConvertTo-Json30 $recorded.inputs) -ne (ConvertTo-Json30 ($Inputs | ConvertTo-Json -Depth 30 | ConvertFrom-Json))) {
        throw 'Build inputs changed since the last successful build; rebuild before deploying'
    }
    $current = @(Get-ReleaseFiles $Release)
    $expected = @($recorded.files | ForEach-Object { $_.name + ':' + $_.sha256 }) -join '|'
    $actual = @($current | ForEach-Object { $_.name + ':' + $_.sha256 }) -join '|'
    if ($expected -ne $actual) { throw 'Built files changed since the last successful build; rebuild before deploying' }
    return [ordered]@{ source_revision = $recorded.inputs.source_revision; files = $current }
}

function Stop-DeployTarget {
    param([string]$Deployed)
    Get-Process -Name 'funkot-player' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and ($_.Path -ieq $Deployed) } |
        Stop-Process -Force -ErrorAction Stop
    Start-Sleep -Milliseconds 200
}

function Start-DeployTarget {
    param([string]$Deployed)
    Start-Process -FilePath $Deployed -WindowStyle Hidden
}

function Assert-PlainPath {
    param([string]$Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Deployment paths cannot traverse reparse points'
        }
        $current = Split-Path $current -Parent
    }
}

# Returns the file names the previous deploy wrote. Refuses a destination whose
# executables this entry did not write or that changed since.
function Get-PreviousDeployment {
    param([string]$Destination)
    $manifest = Join-Path $Destination $script:DeploymentManifest
    $existing = @(Get-ChildItem -LiteralPath $Destination -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'funkot-player.exe' -or $_.Extension -eq '.dll' })
    if (-not $existing.Count) { return @() }
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
        throw "Existing deployment in $Destination was not written by this entry; move it aside first"
    }
    $previous = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if (-not $previous.files) { throw 'Existing deployment manifest is incomplete' }
    $expectedNames = @($previous.files | ForEach-Object { $_.name } | Sort-Object)
    $actualNames = @($existing | ForEach-Object { $_.Name } | Sort-Object)
    if (($expectedNames -join '|') -ne ($actualNames -join '|')) { throw 'Existing deployment file set changed' }
    foreach ($file in $previous.files) {
        if ([IO.Path]::GetFileName($file.name) -ne $file.name) { throw 'Unsafe deployment manifest filename' }
        if ((Get-FileHash -LiteralPath (Join-Path $Destination $file.name)).Hash -ine $file.sha256) {
            throw 'Existing deployment changed since it was deployed'
        }
    }
    return $expectedNames
}

function Invoke-Deploy {
    param($Build, [string]$Destination, [switch]$Launch)
    Assert-PlainPath $Destination
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $previousNames = Get-PreviousDeployment $Destination
    $deployed = Join-Path $Destination 'funkot-player.exe'
    Stop-DeployTarget $deployed
    foreach ($file in $Build.files) {
        $target = Join-Path $Destination $file.name
        Copy-Item -LiteralPath $file.path -Destination $target -Force
        if ((Get-FileHash -LiteralPath $target).Hash -ine $file.sha256) { throw "Deployed $($file.name) readback mismatch" }
    }
    $newNames = @($Build.files | ForEach-Object { $_.name })
    foreach ($name in $previousNames) {
        if ($name -notin $newNames) { Remove-Item -LiteralPath (Join-Path $Destination $name) }
    }
    $manifest = [ordered]@{
        source_revision = $Build.source_revision
        files = @($Build.files | ForEach-Object { [ordered]@{ name = $_.name; sha256 = $_.sha256 } })
    }
    [IO.File]::WriteAllText((Join-Path $Destination $script:DeploymentManifest),
        ($manifest | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    if ($Launch) { Start-DeployTarget $deployed }
    Write-Host "OK: deployed $($Build.source_revision) to $deployed"
}

function Invoke-WindowsBuild {
    param([string]$Repo, [string]$Destination, [switch]$BuildOnly, [switch]$DeployOnly, [switch]$Launch)
    if (($BuildOnly -and $DeployOnly) -or ($BuildOnly -and $Launch)) { throw 'Conflicting build/deploy options' }
    $oldLocation = Get-Location
    $oldTarget = $env:CARGO_TARGET_DIR
    try {
        Set-Location -LiteralPath $Repo
        $target = Join-Path $Repo 'src-tauri\target'
        $release = Join-Path $target 'release'
        $env:CARGO_TARGET_DIR = $target
        if (-not $DeployOnly) {
            Initialize-BuildEnvironment
            if (-not (Test-Path -LiteralPath (Join-Path $Repo 'node_modules'))) {
                npm.cmd ci | Out-Host
                if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
            }
        }
        $inputs = Get-BuildInputs $Repo
        if (-not $DeployOnly) {
            $stamp = Join-Path $release $script:StampName
            if (Test-Path -LiteralPath $stamp) { Remove-Item -LiteralPath $stamp }
            Invoke-NativeCompile
            $after = Get-BuildInputs $Repo
            if ((ConvertTo-Json30 $after) -ne (ConvertTo-Json30 $inputs)) { throw 'Build inputs changed during the build' }
            $files = @(Get-ReleaseFiles $release | ForEach-Object { [ordered]@{ name = $_.name; sha256 = $_.sha256 } })
            [IO.File]::WriteAllText($stamp, (ConvertTo-Json30 ([ordered]@{ inputs = $inputs; files = $files })),
                [Text.UTF8Encoding]::new($false))
        }
        $build = Read-BuildStamp $release $inputs
        if (-not $BuildOnly) { Invoke-Deploy $build $Destination -Launch:$Launch }
        return $build
    } finally {
        $env:CARGO_TARGET_DIR = $oldTarget
        Set-Location -LiteralPath $oldLocation
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $arguments = @{
        Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
        Destination = $Destination; BuildOnly = $BuildOnly; DeployOnly = $DeployOnly; Launch = $Launch
    }
    Invoke-WindowsBuild @arguments | ConvertTo-Json -Depth 30
}
