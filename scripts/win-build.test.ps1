[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'win-build.ps1')

$script:checkedOutput = (Get-Item Function:Invoke-CheckedOutput).ScriptBlock
$script:stops = 0
$script:launches = 0
$script:compileFailure = $false
$script:changeInput = $false
$script:withDll = $true
function Initialize-BuildEnvironment {}
function Invoke-NativeCompile {
    if ($script:compileFailure) { throw 'Deliberate compile failure' }
    $release = Join-Path $env:CARGO_TARGET_DIR 'release'
    New-Item -ItemType Directory -Path $release -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $release 'funkot-player.exe'), 'tiny successful exe ' + [Guid]::NewGuid())
    $dll = Join-Path $release 'support.dll'
    if ($script:withDll) { [IO.File]::WriteAllText($dll, 'tiny successful dll') }
    elseif (Test-Path -LiteralPath $dll) { Remove-Item -LiteralPath $dll }
    if ($script:changeInput) { Add-Content -LiteralPath (Join-Path (Get-Location) 'source.txt') -Value changed }
}
function Stop-DeployTarget { param([string]$Deployed); $script:stops++ }
function Start-DeployTarget { param([string]$Deployed); $script:launches++ }
function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}
function Get-Snapshot {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    return @(Get-ChildItem -LiteralPath $Path -File | ForEach-Object { $_.Name + ':' + (Get-FileHash -LiteralPath $_.FullName).Hash }) -join '|'
}
function Assert-Rejected {
    param([scriptblock]$Action, [string]$Message, [string]$ExpectedError)
    $stopsBefore = $script:stops
    $launchesBefore = $script:launches
    $before = Get-Snapshot $script:dest
    $rejected = $false
    try { & $Action | Out-Null } catch {
        $rejected = $true
        if ($ExpectedError -and $_.Exception.Message -notmatch $ExpectedError) {
            throw "$Message failed at the wrong boundary, $($_.Exception.Message)"
        }
    }
    Assert-True $rejected $Message
    Assert-True ($script:stops -eq $stopsBefore -and $script:launches -eq $launchesBefore) "$Message changed process state"
    Assert-True ($before -eq (Get-Snapshot $script:dest)) "$Message changed deployment"
}

$originalCore = $env:FUNKOT_CORE_REPO
$originalCandidate = $env:FUNKOT_CORE_CANDIDATE_SHA
$originalTauriConfig = $env:TAURI_CONFIG
$originalLocation = Get-Location
$temp = Join-Path ([IO.Path]::GetTempPath()) ('funkot-native-test-' + [Guid]::NewGuid().ToString('N'))
try {
    $env:FUNKOT_CORE_REPO = $null
    $env:FUNKOT_CORE_CANDIDATE_SHA = $null
    $repo = Join-Path $temp 'player'
    $core = Join-Path $temp 'funkot-autodj-for-ui'
    $script:dest = Join-Path $temp 'deploy'
    foreach ($directory in @($repo, $core, (Join-Path $repo 'scripts'), (Join-Path $repo 'node_modules'))) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'check-funkot-core-commit.sh') -Destination (Join-Path $repo 'scripts')
    [IO.File]::WriteAllText((Join-Path $repo '.gitignore'), (@('/src-tauri/target/', '/node_modules/') -join [Environment]::NewLine))
    [IO.File]::WriteAllText((Join-Path $repo 'source.txt'), 'player input')
    [IO.File]::WriteAllText((Join-Path $core 'core.txt'), 'core input')
    foreach ($gitRepo in @($core, $repo)) {
        Invoke-CheckedOutput git @('-C', $gitRepo, 'init', '-q') | Out-Null
        Invoke-CheckedOutput git @('-C', $gitRepo, 'config', 'user.name', 'fixture') | Out-Null
        Invoke-CheckedOutput git @('-C', $gitRepo, 'config', 'user.email', 'fixture@example.invalid') | Out-Null
        Invoke-CheckedOutput git @('-C', $gitRepo, 'config', 'core.autocrlf', 'false') | Out-Null
    }
    Invoke-CheckedOutput git @('-C', $core, 'add', 'core.txt') | Out-Null
    Invoke-CheckedOutput git @('-C', $core, 'commit', '-qm', 'fixture') | Out-Null
    $pin = Invoke-CheckedOutput git @('-C', $core, 'rev-parse', 'HEAD')
    [IO.File]::WriteAllText((Join-Path $repo 'funkot-core.commit'), $pin)
    Invoke-CheckedOutput git @('-C', $repo, 'add', '.') | Out-Null
    Invoke-CheckedOutput git @('-C', $repo, 'commit', '-qm', 'fixture') | Out-Null
    $buildArgs = @{ Repo = $repo; Destination = $script:dest }
    $release = Join-Path $repo 'src-tauri\target\release'

    Assert-Rejected { Invoke-WindowsBuild @buildArgs -BuildOnly -Launch } 'BuildOnly launch conflict' 'Conflicting'
    Assert-Rejected { Invoke-WindowsBuild @buildArgs -DeployOnly } 'Deploy without a build accepted' 'no successful build'

    $env:TAURI_CONFIG = '{"identifier":"test.build.original"}'
    $first = Invoke-WindowsBuild @buildArgs -BuildOnly
    Assert-True ($script:stops -eq 0 -and -not (Test-Path -LiteralPath $script:dest)) 'BuildOnly touched deployment'
    Assert-True (@($first.files).Count -eq 2) 'BuildOnly did not report the exe and DLL'

    $env:TAURI_CONFIG = '{"identifier":"test.build.changed"}'
    Assert-Rejected { Invoke-WindowsBuild @buildArgs -DeployOnly } 'Changed Tauri configuration accepted' 'inputs changed'
    $env:TAURI_CONFIG = '{"identifier":"test.build.original"}'

    Invoke-WindowsBuild @buildArgs -DeployOnly -Launch | Out-Null
    Assert-True ($script:stops -eq 1 -and $script:launches -eq 1) 'Deploy did not stop and launch the deployed process'
    foreach ($name in @('funkot-player.exe', 'support.dll')) {
        Assert-True ((Get-FileHash -LiteralPath (Join-Path $script:dest $name)).Hash -eq
            (Get-FileHash -LiteralPath (Join-Path $release $name)).Hash) "Deployed $name differs"
    }

    [IO.File]::WriteAllText((Join-Path $repo 'funkot-core.commit'), ('0' * 40))
    Assert-Rejected { Invoke-WindowsBuild @buildArgs -DeployOnly } 'Core pin mismatch deployed' 'bash.exe failed'
    Assert-Rejected { Invoke-WindowsBuild @buildArgs -BuildOnly } 'Core pin mismatch compiled' 'bash.exe failed'
    [IO.File]::WriteAllText((Join-Path $repo 'funkot-core.commit'), $pin)

    $built = Join-Path $release 'support.dll'
    $bytes = [IO.File]::ReadAllBytes($built)
    [IO.File]::WriteAllText($built, 'tampered artifact')
    Assert-Rejected { Invoke-WindowsBuild @buildArgs -DeployOnly } 'Tampered build accepted' 'Built files changed'
    [IO.File]::WriteAllBytes($built, $bytes)

    $script:compileFailure = $true
    Assert-Rejected { Invoke-WindowsBuild @buildArgs -BuildOnly } 'Compile failure accepted' 'Deliberate compile failure'
    $script:compileFailure = $false
    Assert-Rejected { Invoke-WindowsBuild @buildArgs -DeployOnly } 'Failed build left an old build deployable' 'no successful build'

    $unknown = Join-Path $temp 'preexisting-deploy'
    New-Item -ItemType Directory -Path $unknown | Out-Null
    [IO.File]::WriteAllText((Join-Path $unknown 'funkot-player.exe'), 'protected existing exe')
    Invoke-WindowsBuild @buildArgs -BuildOnly | Out-Null
    $stopsBefore = $script:stops
    try { Invoke-WindowsBuild -Repo $repo -Destination $unknown -DeployOnly | Out-Null; throw 'Unknown deployment overwritten' }
    catch { Assert-True ($_.Exception.Message -match 'not written by this entry') "Unknown deployment: $($_.Exception.Message)" }
    Assert-True ($script:stops -eq $stopsBefore) 'Unknown deployment stopped a process'
    Assert-True ([IO.File]::ReadAllText((Join-Path $unknown 'funkot-player.exe')) -eq 'protected existing exe') 'Unknown deployment changed'

    $script:withDll = $false
    Invoke-WindowsBuild @buildArgs | Out-Null
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $script:dest 'support.dll'))) 'Stale deployed DLL kept'
    Assert-True ((Get-FileHash -LiteralPath (Join-Path $script:dest 'funkot-player.exe')).Hash -eq
        (Get-FileHash -LiteralPath (Join-Path $release 'funkot-player.exe')).Hash) 'Rebuilt exe not deployed'

    [IO.File]::WriteAllText((Join-Path $script:dest 'funkot-player.exe'), 'edited after deploy')
    Assert-Rejected { Invoke-WindowsBuild @buildArgs -DeployOnly } 'Changed deployment overwritten' 'changed since it was deployed'
    Remove-Item -LiteralPath (Join-Path $script:dest 'funkot-player.exe')

    $script:changeInput = $true
    Assert-Rejected { Invoke-WindowsBuild @buildArgs -BuildOnly } 'Input changed during build accepted' 'changed during the build'
    Write-Host 'Windows native build/deploy regression PASS'
} finally {
    $env:FUNKOT_CORE_REPO = $originalCore
    $env:FUNKOT_CORE_CANDIDATE_SHA = $originalCandidate
    $env:TAURI_CONFIG = $originalTauriConfig
    Set-Location -LiteralPath $originalLocation
    $resolvedTemp = [IO.Path]::GetFullPath($temp)
    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup path' }
    if (Test-Path -LiteralPath $resolvedTemp) { Remove-Item -LiteralPath $resolvedTemp -Recurse -Force }
}
