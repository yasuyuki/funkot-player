[CmdletBinding()]
param([string]$OwnerPython = $env:FUNKOT_OWNER_PYTHON)
$ErrorActionPreference = 'Stop'
if (-not $OwnerPython) {
    if ($env:WORKSPACE_LIFECYCLE_CONTEXT) {
        $OwnerPython = ($env:WORKSPACE_LIFECYCLE_CONTEXT | ConvertFrom-Json).owner_receipt_argv[0]
    } else { $OwnerPython = (Get-Command python.exe -ErrorAction Stop).Source }
}
& $OwnerPython (Join-Path $PSScriptRoot 'win-build-owner.test.py')
if ($LASTEXITCODE -ne 0) { throw 'Native owner regression failed' }
. (Join-Path $PSScriptRoot 'win-build.ps1') -OwnerPython $OwnerPython

$script:checkedOutput = (Get-Item Function:Invoke-CheckedOutput).ScriptBlock
$script:stops = 0
$script:launches = 0
$script:compileFailure = $false
$script:changeInput = $false
$script:raceAttempt = $false
$script:raceBlocked = $false
function Initialize-BuildEnvironment {}
function Invoke-CheckedOutput {
    param([string]$Command, [string[]]$Arguments)
    if ($Command -eq 'cargo' -and $Arguments[0] -eq 'metadata') {
        return (@{ build_directory = $script:cache; target_directory = $env:CARGO_TARGET_DIR } | ConvertTo-Json -Compress)
    }
    if ($Command -in @('cargo', 'rustc', 'npm.cmd')) { return "$Command fixture toolchain" }
    return & $script:checkedOutput $Command $Arguments
}
function Invoke-NativeCompile {
    if ($script:compileFailure) { throw 'Deliberate compile failure' }
    $release = Join-Path $env:CARGO_TARGET_DIR 'release'
    New-Item -ItemType Directory -Path $release -Force | Out-Null
    $linkedBinary = Join-Path $script:cache 'linked-final.exe'
    [IO.File]::WriteAllText($linkedBinary, 'tiny successful exe')
    New-Item -ItemType HardLink -Path (Join-Path $release 'funkot-player.exe') -Target $linkedBinary | Out-Null
    [IO.File]::WriteAllText((Join-Path $release 'support.dll'), 'tiny successful dll')
    New-Item -ItemType Directory -Path (Join-Path (Get-Location) 'dist') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path (Get-Location) 'dist\index.html'), 'fixture frontend')
    if ($script:changeInput) { Add-Content -LiteralPath (Join-Path (Get-Location) 'source.txt') -Value changed }
}
function Stop-DeployTarget {
    param([string]$Deployed)
    $script:stops++
    if ($script:raceAttempt) {
        try { [IO.File]::WriteAllText($script:activeArtifact, 'wrong artifact') }
        catch [IO.IOException] { $script:raceBlocked = $true }
    }
}
function Start-DeployTarget { param([string]$Deployed); $script:launches++ }
function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}
function Assert-Rejected {
    param([scriptblock]$Action, [string]$Message, [string]$ExpectedError)
    $stopsBefore = $script:stops
    $launchesBefore = $script:launches
    $before = if (Test-Path -LiteralPath $script:dest) {
        @(Get-ChildItem -LiteralPath $script:dest -File | ForEach-Object { $_.Name + ':' + (Get-FileHash -LiteralPath $_.FullName).Hash }) -join '|'
    } else { '' }
    $rejected = $false
    try { & $Action | Out-Null } catch {
        $rejected = $true
        if ($ExpectedError -and $_.Exception.Message -notmatch $ExpectedError) {
            throw "$Message failed at the wrong boundary, $($_.Exception.Message)"
        }
        Write-Verbose ($_ | Out-String)
    }
    Assert-True $rejected $Message
    Assert-True ($script:stops -eq $stopsBefore -and $script:launches -eq $launchesBefore) "$Message changed process state"
    $after = if (Test-Path -LiteralPath $script:dest) {
        @(Get-ChildItem -LiteralPath $script:dest -File | ForEach-Object { $_.Name + ':' + (Get-FileHash -LiteralPath $_.FullName).Hash }) -join '|'
    } else { '' }
    Assert-True ($before -eq $after) "$Message changed deployment"
}
$originalContext = $env:WORKSPACE_LIFECYCLE_CONTEXT
$originalCargoHome = $env:CARGO_HOME
$originalCore = $env:FUNKOT_CORE_REPO
$originalCandidate = $env:FUNKOT_CORE_CANDIDATE_SHA
$originalLocation = Get-Location
$temp = Join-Path ([IO.Path]::GetTempPath()) ('funkot-native-test-' + [Guid]::NewGuid().ToString('N'))
try {
    $env:WORKSPACE_LIFECYCLE_CONTEXT = $null
    $env:FUNKOT_CORE_REPO = $null
    $env:FUNKOT_CORE_CANDIDATE_SHA = $null
    $env:CARGO_HOME = Join-Path $temp 'cargo-home'
    $script:cache = Join-Path $temp 'shared-build'
    $repo = Join-Path $temp 'player'
    $core = Join-Path $temp 'funkot-autodj-for-ui'
    $script:dest = Join-Path $temp 'deploy'
    foreach ($directory in @($repo, $core, $script:cache, $env:CARGO_HOME, (Join-Path $repo 'scripts'),
        (Join-Path $repo 'src-tauri'), (Join-Path $repo 'node_modules'))) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    [IO.File]::WriteAllText((Join-Path $script:cache 'dependency'), 'retain shared cache')
    [IO.File]::WriteAllText((Join-Path $temp 'other-task.exe'), 'retain other task')
    foreach ($scriptName in @('win-build-owner.py', 'check-funkot-core-commit.sh')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $scriptName) -Destination (Join-Path $repo 'scripts')
    }
    [IO.File]::WriteAllText((Join-Path $repo '.gitignore'), (@('/src-tauri/target/', '/dist/', '/node_modules/') -join [Environment]::NewLine))
    [IO.File]::WriteAllText((Join-Path $repo 'source.txt'), 'player input')
    [IO.File]::WriteAllText((Join-Path $core 'core.txt'), 'core input')
    foreach ($gitRepo in @($core, $repo)) {
        Invoke-CheckedOutput git @('-C', $gitRepo, 'init', '-q') | Out-Null
        Invoke-CheckedOutput git @('-C', $gitRepo, 'config', 'user.name', 'fixture') | Out-Null
        Invoke-CheckedOutput git @('-C', $gitRepo, 'config', 'user.email', 'fixture@example.invalid') | Out-Null
    }
    Invoke-CheckedOutput git @('-C', $core, 'add', 'core.txt') | Out-Null
    Invoke-CheckedOutput git @('-C', $core, 'commit', '-qm', 'fixture') | Out-Null
    $pin = Invoke-CheckedOutput git @('-C', $core, 'rev-parse', 'HEAD')
    [IO.File]::WriteAllText((Join-Path $repo 'funkot-core.commit'), $pin)
    Invoke-CheckedOutput git @('-C', $repo, 'add', '.') | Out-Null
    Invoke-CheckedOutput git @('-C', $repo, 'commit', '-qm', 'fixture') | Out-Null
    $buildArgs = @{ Repo = $repo; Python = $OwnerPython; Destination = $script:dest }
    Assert-Rejected { Invoke-WindowsBuild @buildArgs -BuildOnly -Launch } 'BuildOnly launch conflict' 'Conflicting'
    $first = Invoke-WindowsBuild @buildArgs -BuildOnly
    Assert-True ($script:stops -eq 0 -and -not (Test-Path -LiteralPath $script:dest)) 'BuildOnly touched deployment'
    Assert-True ([bool]($first.receipt -and $first.generation)) 'BuildOnly did not return exact identity'
    $script:activeArtifact = Join-Path $first.output 'release\funkot-player.exe'
    $script:raceAttempt = $true
    Invoke-WindowsBuild @buildArgs -DeployOnly -Receipt $first.receipt -Launch | Out-Null
    Assert-True ($script:raceBlocked -and $script:stops -eq 1 -and $script:launches -eq 1) 'Deploy did not pin source or route selected process'
    Assert-True ((Get-FileHash -LiteralPath (Join-Path $script:dest 'funkot-player.exe')).Hash -eq
        (Get-FileHash -LiteralPath $script:activeArtifact).Hash) 'Deploy readback differs'
    $script:raceAttempt = $false
    [IO.File]::WriteAllText((Join-Path $repo 'funkot-core.commit'), ('0' * 40))
    Assert-Rejected { Invoke-WindowsBuild @buildArgs -DeployOnly -Receipt $first.receipt } 'Core pin mismatch accepted' 'bash.exe failed'
    Assert-Rejected { Invoke-WindowsBuild @buildArgs -BuildOnly } 'Core pin mismatch compiled' 'bash.exe failed'
    [IO.File]::WriteAllText((Join-Path $repo 'funkot-core.commit'), $pin)
    Assert-Rejected { Invoke-WindowsBuild @buildArgs -DeployOnly } 'Preflight failure left an implicit old selection' 'no successful'
    foreach ($artifact in @($script:activeArtifact, (Join-Path $first.output 'release\support.dll'), (Join-Path $repo 'dist\index.html'))) {
        $bytes = [IO.File]::ReadAllBytes($artifact)
        [IO.File]::WriteAllText($artifact, 'tampered artifact')
        Assert-Rejected { Invoke-WindowsBuild @buildArgs -DeployOnly -Receipt $first.receipt } 'Tampered artifact accepted' 'tree changed|generated dist changed'
        [IO.File]::WriteAllBytes($artifact, $bytes)
    }
    $script:compileFailure = $true
    Assert-Rejected { Invoke-WindowsBuild @buildArgs -BuildOnly } 'Compile failure accepted' 'Deliberate compile failure'
    $script:compileFailure = $false
    Assert-Rejected { Invoke-WindowsBuild @buildArgs -DeployOnly } 'Failed build selected old latest artifact' 'no successful'
    Assert-True (Test-Path -LiteralPath $script:activeArtifact) 'Failed build deleted earlier artifact'
    $unknown = Join-Path $temp 'preexisting-deploy'
    New-Item -ItemType Directory -Path $unknown | Out-Null
    [IO.File]::WriteAllText((Join-Path $unknown 'funkot-player.exe'), 'protected existing exe')
    Assert-Rejected { Invoke-WindowsBuild -Repo $repo -Python $OwnerPython -Destination $unknown -DeployOnly -Receipt $first.receipt } 'Unproved preexisting deployment accepted' 'no native owner receipt'
    Assert-True ([IO.File]::ReadAllText((Join-Path $unknown 'funkot-player.exe')) -eq 'protected existing exe') 'Unproved deployment changed'
    Assert-Rejected { Invoke-WindowsBuild @buildArgs -Complete -Receipt $first.receipt -ResultRef 'fixture-result' } 'Unreleased output reclaimed' 'explicit final-user release'
    $sharedHandle = [IO.File]::Open($script:activeArtifact, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        Assert-Rejected { Invoke-WindowsBuild @buildArgs -Complete -Receipt $first.receipt -UsersReleased -ResultRef 'fixture-result' } 'Sharing conflict reported reclaimed' 'shared by another user'
        $pending = Get-Content -LiteralPath $first.receipt -Raw | ConvertFrom-Json
        Assert-True ($pending.state -eq 'cleanup_pending') "Sharing conflict lost durable pending state, actual $($pending.state)"
        Assert-True (Test-Path -LiteralPath $first.output) 'Sharing conflict deleted output'
    } finally { $sharedHandle.Dispose() }
    $released = Invoke-WindowsBuild @buildArgs -Complete -Receipt $first.receipt -UsersReleased -ResultRef 'fixture-result'
    Assert-True ($released.reclaimed -and -not (Test-Path -LiteralPath $first.output)) 'Released dedicated output retained'
    Assert-True ([IO.File]::ReadAllText((Join-Path $script:cache 'dependency')) -eq 'retain shared cache') 'Shared cache changed'
    Assert-True ([IO.File]::ReadAllText((Join-Path $script:cache 'linked-final.exe')) -eq 'tiny successful exe') 'Cargo hardlink source changed'
    Assert-True ([IO.File]::ReadAllText((Join-Path $temp 'other-task.exe')) -eq 'retain other task') 'Other task changed'
    $script:changeInput = $true
    Assert-Rejected { Invoke-WindowsBuild @buildArgs -BuildOnly } 'Changed build input sealed' 'inputs changed'
    Write-Host 'Windows native build/deploy regression PASS'
} finally {
    $env:WORKSPACE_LIFECYCLE_CONTEXT = $originalContext
    $env:CARGO_HOME = $originalCargoHome
    $env:FUNKOT_CORE_REPO = $originalCore
    $env:FUNKOT_CORE_CANDIDATE_SHA = $originalCandidate
    Set-Location -LiteralPath $originalLocation
    $resolvedTemp = [IO.Path]::GetFullPath($temp)
    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup path' }
    if (Test-Path -LiteralPath $resolvedTemp) { Remove-Item -LiteralPath $resolvedTemp -Recurse -Force }
}
