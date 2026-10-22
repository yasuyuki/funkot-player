[CmdletBinding()]
param(
    [switch]$Launch, [switch]$BuildOnly, [switch]$DeployOnly,
    [string]$Receipt, [string]$Destination = 'C:\funkot-player-test',
    [string]$OwnerPython = $env:FUNKOT_OWNER_PYTHON,
    [switch]$Complete, [switch]$UsersReleased, [string]$ResultRef
)
$ErrorActionPreference = 'Stop'

function Invoke-CheckedOutput {
    param([string]$Command, [string[]]$Arguments)
    $result = & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
    return ($result -join [Environment]::NewLine).Trim()
}

function Invoke-Owner {
    param([string]$Python, [string]$Repo, [string[]]$Arguments)
    $result = & $Python (Join-Path $Repo 'scripts\win-build-owner.py') @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($result -join [Environment]::NewLine) }
    return ($result -join [Environment]::NewLine) | ConvertFrom-Json
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
    $oldTarget = $env:CARGO_TARGET_DIR
    try {
        $env:FUNKOT_CORE_REPO = $core
        Invoke-CheckedOutput $bash @((Join-Path $Repo 'scripts\check-funkot-core-commit.sh')) | Out-Null
        $env:CARGO_TARGET_DIR = Join-Path $Repo 'src-tauri\target'
        $metadata = (Invoke-CheckedOutput cargo @('metadata', '--no-deps', '--format-version', '1',
            '--manifest-path', (Join-Path $Repo 'src-tauri\Cargo.toml'))) | ConvertFrom-Json
    } finally {
        $env:FUNKOT_CORE_REPO = $oldCore
        $env:CARGO_TARGET_DIR = $oldTarget
    }
    if (-not $metadata.build_directory) { throw 'Cargo metadata must expose the effective shared build_directory' }
    $sources = [ordered]@{}
    $names = & git -C $Repo ls-files --cached --others --exclude-standard
    if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate player inputs' }
    foreach ($name in ($names | Sort-Object -Unique)) {
        if ($name -match '(^|/)HANDOFF\.md$') { continue }
        $file = Join-Path $Repo $name
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Player input missing: $name" }
        $sources[$name] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    }
    $configurations = [ordered]@{}
    foreach ($file in @((Join-Path $env:CARGO_HOME 'config'), (Join-Path $env:CARGO_HOME 'config.toml'),
        (Join-Path $Repo '.cargo\config.toml'), (Join-Path $Repo 'src-tauri\.cargo\config.toml'))) {
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            $configurations[$file] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
        }
    }
    $flags = [ordered]@{}
    Get-ChildItem Env: | Where-Object {
        $_.Name -match '^(CARGO_(BUILD|PROFILE|TARGET|ENCODED_RUSTFLAGS)|RUSTFLAGS|RUSTUP_TOOLCHAIN|CC$|CXX$|LIBCLANG_PATH$|INCLUDE$|LIB$|LIBPATH$|VCToolsVersion$|WindowsSDKVersion$)'
    } | Sort-Object Name | ForEach-Object { $flags[$_.Name] = $_.Value }
    $flags.Remove('CARGO_TARGET_DIR')
    return [ordered]@{
        source_revision = Invoke-CheckedOutput git @('-C', $Repo, 'rev-parse', 'HEAD')
        sources = $sources; core = $core
        core_revision = Invoke-CheckedOutput git @('-C', $core, 'rev-parse', 'HEAD')
        core_pin = (Get-Content -LiteralPath (Join-Path $Repo 'funkot-core.commit') -Raw).Trim()
        candidate = $env:FUNKOT_CORE_CANDIDATE_SHA
        cargo = Invoke-CheckedOutput cargo @('--version')
        rustc = Invoke-CheckedOutput rustc @('-vV')
        npm = Invoke-CheckedOutput npm.cmd @('--version')
        tauri = Invoke-CheckedOutput npm.cmd @('run', 'tauri', '--', '--version')
        build_directory = [IO.Path]::GetFullPath($metadata.build_directory)
        target_directory = [IO.Path]::GetFullPath($metadata.target_directory)
        configurations = $configurations; flags = $flags
        recipe = @('npm', 'run', 'tauri', '--', 'build', '--no-bundle'); profile = 'release'
    }
}

function Invoke-NativeCompile {
    npm.cmd run tauri -- build --no-bundle | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed with exit code $LASTEXITCODE" }
}

function ConvertTo-PrivateFinalFiles {
    param([string]$OutputRoot)
    Assert-PlainPath $OutputRoot
    $directories = @(Get-ChildItem -LiteralPath $OutputRoot -Directory -Recurse -Force)
    foreach ($directory in $directories) {
        Assert-PlainPath $directory.FullName
        if ($directory.Name -in @('deps', 'build', 'incremental', '.fingerprint')) {
            throw 'Cargo intermediate output entered the dedicated final root'
        }
    }
    # Cargo hardlinks final binaries to the shared build cache; copy only finals.
    foreach ($file in @(Get-ChildItem -LiteralPath $OutputRoot -File -Recurse -Force)) {
        Assert-PlainPath $file.FullName
        $temporary = Join-Path $file.DirectoryName ('.native-copy-' + [Guid]::NewGuid().ToString('N'))
        $inputStream = $null
        $outputStream = $null
        try {
            $inputStream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            $outputStream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $inputStream.CopyTo($outputStream)
            $outputStream.Flush($true)
            $outputStream.Dispose(); $outputStream = $null
            $inputStream.Dispose(); $inputStream = $null
            Move-Item -LiteralPath $temporary -Destination $file.FullName -Force
        } finally {
            if ($outputStream) { $outputStream.Dispose() }
            if ($inputStream) { $inputStream.Dispose() }
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
        }
    }
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
            throw 'Native output and deployment paths cannot traverse reparse points'
        }
        $current = Split-Path $current -Parent
    }
}

function Assert-Deployment {
    param($Generation, [string]$Destination)
    Assert-PlainPath $Destination
    $deploymentReceipt = Join-Path $Destination '.funkot-native-generation.json'
    $existing = @(Get-ChildItem -LiteralPath $Destination -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'funkot-player.exe' -or $_.Extension -eq '.dll' })
    if (-not $existing.Count) { return }
    if (-not (Test-Path -LiteralPath $deploymentReceipt -PathType Leaf)) {
        throw 'Existing deployment has no native owner receipt; preserve it until the product owner migrates it'
    }
    $previous = Get-Content -LiteralPath $deploymentReceipt -Raw | ConvertFrom-Json
    if (-not $previous.generation -or -not $previous.receipt -or -not $previous.files) {
        throw 'Existing deployment receipt is incomplete'
    }
    $expectedNames = @($previous.files | ForEach-Object { $_.name } | Sort-Object)
    $actualNames = @($existing | ForEach-Object { $_.Name } | Sort-Object)
    if (($expectedNames -join '|') -ne ($actualNames -join '|')) { throw 'Deployment file set changed' }
    foreach ($file in $previous.files) {
        if ([IO.Path]::GetFileName($file.name) -ne $file.name) { throw 'Unsafe deployment receipt filename' }
        Assert-PlainPath (Join-Path $Destination $file.name)
        if ((Get-FileHash -LiteralPath (Join-Path $Destination $file.name)).Hash -ine $file.sha256) {
            throw 'Existing deployment identity changed'
        }
    }
    $newNames = @($Generation.files | ForEach-Object { $_.name } | Sort-Object)
    if (($newNames -join '|') -ne ($actualNames -join '|')) {
        throw 'Deployment file set differs; release the previous deployment through its owner first'
    }
}

function Invoke-ExactDeploy {
    param($Generation, [string]$Destination, [switch]$Launch)
    $handles = @()
    $destinationHandles = @()
    $deployLock = $null
    try {
        # Read-sharing pins each exact source object against writers and deletion.
        foreach ($file in $Generation.files) {
            Assert-PlainPath $file.path
            $stream = [IO.File]::Open($file.path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            $handles += $stream
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $digest = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
            finally { $sha.Dispose() }
            if ($digest -ne $file.sha256.ToLowerInvariant()) { throw 'Deploy source changed before its read handle was acquired' }
            $stream.Position = 0
        }
        $deployed = Join-Path $Destination 'funkot-player.exe'
        $deploymentReceipt = Join-Path $Destination '.funkot-native-generation.json'
        Assert-Deployment $Generation $Destination
        New-Item -ItemType Directory -Force -Path $Destination | Out-Null
        $lockPath = Join-Path $Destination '.funkot-native-deploy.lock'
        Assert-PlainPath $lockPath
        $deployLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        Assert-Deployment $Generation $Destination
        Stop-DeployTarget $deployed
        for ($index = 0; $index -lt $handles.Count; $index++) {
            $target = Join-Path $Destination $Generation.files[$index].name
            $output = [IO.File]::Open($target, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $destinationHandles += $output
            $handles[$index].CopyTo($output)
            $output.Flush($true)
            $output.Position = 0
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $digest = [BitConverter]::ToString($sha.ComputeHash($output)).Replace('-', '').ToLowerInvariant() }
            finally { $sha.Dispose() }
            if ($digest -ne $Generation.files[$index].sha256.ToLowerInvariant()) { throw 'Deployed artifact readback mismatch' }
        }
        $deployment = @{ generation = $Generation.generation; receipt = $Generation.receipt; files = $Generation.files }
        [IO.File]::WriteAllText($deploymentReceipt, ($deployment | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
        foreach ($stream in $destinationHandles) { $stream.Dispose() }
        $destinationHandles = @()
        if ($Launch) { Start-DeployTarget $deployed }
    } finally {
        foreach ($stream in $destinationHandles) { $stream.Dispose() }
        foreach ($stream in $handles) { $stream.Dispose() }
        if ($deployLock) { $deployLock.Dispose() }
    }
    Write-Host "OK: deployed generation $($Generation.generation) to $deployed"
}

function Invoke-WindowsBuild {
    param([string]$Repo, [string]$Python, [string]$Destination, [string]$Receipt,
        [switch]$BuildOnly, [switch]$DeployOnly, [switch]$Launch,
        [switch]$Complete, [switch]$UsersReleased, [string]$ResultRef)
    if (($BuildOnly -and $DeployOnly) -or ($BuildOnly -and $Launch) -or
        ($Complete -and ($BuildOnly -or $DeployOnly -or $Launch))) { throw 'Conflicting build/deploy/completion options' }
    if (-not $Python) {
        if ($env:WORKSPACE_LIFECYCLE_CONTEXT) {
            $context = $env:WORKSPACE_LIFECYCLE_CONTEXT | ConvertFrom-Json
            $Python = $context.owner_receipt_argv[0]
        } else { $Python = (Get-Command python.exe -ErrorAction Stop).Source }
    }
    $oldLocation = Get-Location
    $oldTarget = $env:CARGO_TARGET_DIR
    $operationLock = $null
    $inputsFile = $null
    try {
        Set-Location -LiteralPath $Repo
        Invoke-Owner $Python $Repo @('resume', '--repo', $Repo) | Out-Null
        if ($Complete) {
            if (-not $Receipt -or -not $UsersReleased -or -not $ResultRef) {
                throw 'Completion requires an exact receipt, result reference and explicit final-user release'
            }
            return Invoke-Owner $Python $Repo @('complete', '--receipt', $Receipt,
                '--result-ref', $ResultRef, '--users-released')
        }
        $paths = Invoke-Owner $Python $Repo @('paths', '--repo', $Repo)
        $operationLock = [IO.File]::Open($paths.lock, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        if (-not $DeployOnly) { Invoke-Owner $Python $Repo @('invalidate', '--repo', $Repo) | Out-Null }
        Initialize-BuildEnvironment
        if (-not $DeployOnly -and -not (Test-Path -LiteralPath (Join-Path $Repo 'node_modules'))) {
            npm.cmd ci | Out-Host
            if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
        }
        $inputsFile = Join-Path (Split-Path $paths.lock) ('inputs-' + [Guid]::NewGuid().ToString('N') + '.json')
        $inputs = Get-BuildInputs $Repo
        [IO.File]::WriteAllText($inputsFile, ($inputs | ConvertTo-Json -Depth 30 -Compress), [Text.UTF8Encoding]::new($false))
        if (-not $DeployOnly) {
            $generation = Invoke-Owner $Python $Repo @('begin', '--repo', $Repo, '--inputs', $inputsFile)
            $Receipt = $generation.receipt
            $env:CARGO_TARGET_DIR = $generation.output
            try {
                Invoke-NativeCompile
                ConvertTo-PrivateFinalFiles $generation.output
                $inputs = Get-BuildInputs $Repo
                [IO.File]::WriteAllText($inputsFile, ($inputs | ConvertTo-Json -Depth 30 -Compress), [Text.UTF8Encoding]::new($false))
                Invoke-Owner $Python $Repo @('seal', '--receipt', $Receipt, '--inputs', $inputsFile) | Out-Null
            } catch {
                $buildError = $_
                try { ConvertTo-PrivateFinalFiles $generation.output }
                catch { Write-Warning 'Failed build output could not be separated from cache links; preserve it for owner recovery' }
                Invoke-Owner $Python $Repo @('fail', '--receipt', $Receipt) | Out-Null
                throw $buildError
            }
        } elseif (-not $Receipt) { $Receipt = (Invoke-Owner $Python $Repo @('latest', '--repo', $Repo)).receipt }
        $generation = Invoke-Owner $Python $Repo @('verify', '--receipt', $Receipt, '--repo', $Repo, '--inputs', $inputsFile)
        if (-not $BuildOnly) { Invoke-ExactDeploy $generation $Destination -Launch:$Launch }
        return $generation
    } finally {
        if ($inputsFile -and (Test-Path -LiteralPath $inputsFile)) { Remove-Item -LiteralPath $inputsFile }
        if ($operationLock) { $operationLock.Dispose() }
        $env:CARGO_TARGET_DIR = $oldTarget
        Set-Location -LiteralPath $oldLocation
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $arguments = @{
        Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
        Python = $OwnerPython; Destination = $Destination; Receipt = $Receipt
        BuildOnly = $BuildOnly; DeployOnly = $DeployOnly; Launch = $Launch
        Complete = $Complete; UsersReleased = $UsersReleased; ResultRef = $ResultRef
    }
    Invoke-WindowsBuild @arguments | ConvertTo-Json -Depth 30
}
