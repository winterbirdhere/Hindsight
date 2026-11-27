param([string] $OfflinePackageCache)
$ErrorActionPreference = 'Stop'
$media = Join-Path $PSScriptRoot '..\..\resources\clip-media'
$restore = Join-Path $media 'restore.cjs'
$destination = Join-Path $media 'win-x64'
if ($OfflinePackageCache) {
    & node $restore $destination $OfflinePackageCache
} else {
    & node $restore $destination
}
exit $LASTEXITCODE
