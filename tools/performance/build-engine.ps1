param(
    [string]$DotnetPath,
    [switch]$SkipTests
)
$ErrorActionPreference = 'Stop'
$performanceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$performanceProject = Join-Path $performanceRoot 'engine\RewindPerformance\RewindPerformance.csproj'
$performanceTests = Join-Path $performanceRoot 'engine\RewindPerformance.Tests\RewindPerformance.Tests.csproj'
$performanceStage = [System.IO.Path]::GetFullPath((Join-Path $performanceRoot 'tmp\performance-engine-publish'))
$performanceOutput = [System.IO.Path]::GetFullPath((Join-Path $performanceRoot 'resources\performance-engine'))

if (-not $DotnetPath) {
    $performanceCandidates = @(
        (Join-Path $env:LOCALAPPDATA 'Microsoft\dotnet\dotnet.exe'),
        (Get-Command dotnet -ErrorAction SilentlyContinue).Source
    )
    foreach ($performanceCandidate in $performanceCandidates) {
        if ($performanceCandidate -and (Test-Path -LiteralPath $performanceCandidate)) {
            $performanceSdks = & $performanceCandidate --list-sdks
            if ($performanceSdks -match '^8\.') { $DotnetPath = $performanceCandidate; break }
        }
    }
}
if (-not $DotnetPath) { throw 'A .NET 8 SDK is required. Pass -DotnetPath with its dotnet.exe path.' }
$env:DOTNET_ROOT = Split-Path -Parent $DotnetPath
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'

function Assert-PerformanceOutputPath([string]$Target) {
    if (-not $Target.StartsWith($performanceRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Build output is outside the workspace: $Target"
    }
    $performanceAncestor = $Target
    while ($performanceAncestor -and $performanceAncestor.Length -ge $performanceRoot.Length) {
        $performanceItem = Get-Item -LiteralPath $performanceAncestor -Force -ErrorAction SilentlyContinue
        if ($performanceItem -and ($performanceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw "Build output traverses a reparse point: $performanceAncestor"
        }
        $performanceAncestor = Split-Path -Parent $performanceAncestor
    }
    if (Test-Path -LiteralPath $Target) {
        $performanceDirectories = [System.Collections.Generic.Stack[string]]::new()
        $performanceDirectories.Push($Target)
        while ($performanceDirectories.Count -gt 0) {
            foreach ($performanceChild in Get-ChildItem -LiteralPath $performanceDirectories.Pop() -Force) {
                if ($performanceChild.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                    throw "Build output contains a reparse point: $($performanceChild.FullName)"
                }
                if ($performanceChild.PSIsContainer) { $performanceDirectories.Push($performanceChild.FullName) }
            }
        }
    }
}

$performanceFeed = Join-Path $performanceRoot 'tmp\performance-nuget'
$performancePackages = Join-Path $performanceRoot 'tmp\performance-nuget-packages'
$performanceUserProfile = [Environment]::GetFolderPath('UserProfile')
if ([string]::IsNullOrWhiteSpace($performanceUserProfile)) {
    $performanceUserProfile = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace($performanceUserProfile) -or
        $performanceUserProfile -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)' -or
        -not (Test-Path -LiteralPath $performanceUserProfile -PathType Container)) {
        throw 'Cannot locate the user profile for the read-only NuGet fallback cache.'
    }
    $performanceUserProfile = [System.IO.Path]::GetFullPath($performanceUserProfile)
}
$performanceFallback = Join-Path $performanceUserProfile '.nuget\packages'
& node (Join-Path $PSScriptRoot 'fetch-runtime-packages.mjs') $performanceFeed (Join-Path $performanceRoot 'engine\RewindPerformance\packages.lock.json')
if ($LASTEXITCODE -ne 0) { throw 'Runtime package preparation failed.' }
if (-not $SkipTests) {
    & $DotnetPath run --project $performanceTests -c Release -p:NuGetAudit=false "-p:RestoreSources=$performanceFeed" "-p:RestorePackagesPath=$performancePackages" "-p:RestoreFallbackFolders=$performanceFallback" --no-launch-profile
    if ($LASTEXITCODE -ne 0) { throw 'Native engine regression tests failed.' }
}
Assert-PerformanceOutputPath $performanceStage
if (Test-Path -LiteralPath $performanceStage) { Remove-Item -LiteralPath $performanceStage -Recurse -Force }
& $DotnetPath restore $performanceProject -r win-x64 --source $performanceFeed --packages $performancePackages "-p:RestoreFallbackFolders=$performanceFallback" -p:NuGetAudit=false
if ($LASTEXITCODE -ne 0) { throw 'Native runtime restore failed.' }
& $DotnetPath publish $performanceProject --no-restore -c Release -r win-x64 --self-contained true -p:PublishTrimmed=false -p:PublishSingleFile=false -p:NuGetAudit=false -o $performanceStage
if ($LASTEXITCODE -ne 0) { throw 'Native engine publication failed.' }

& node (Join-Path $PSScriptRoot 'write-notices.mjs') $performanceStage (Join-Path $performanceRoot 'engine\RewindPerformance\obj\project.assets.json')
if ($LASTEXITCODE -ne 0) { throw 'Engine dependency inventory failed.' }
& node (Join-Path $PSScriptRoot 'verify-engine.mjs') (Join-Path $performanceStage 'RewindPerformance.exe')
if ($LASTEXITCODE -ne 0) { throw 'Published engine protocol validation failed.' }

Assert-PerformanceOutputPath $performanceOutput
Assert-PerformanceOutputPath $performanceStage
if (Test-Path -LiteralPath $performanceOutput) { Remove-Item -LiteralPath $performanceOutput -Recurse -Force }
New-Item -ItemType Directory -Path (Split-Path -Parent $performanceOutput) -Force | Out-Null
Move-Item -LiteralPath $performanceStage -Destination $performanceOutput
Write-Output "Published verified native engine to $performanceOutput"
