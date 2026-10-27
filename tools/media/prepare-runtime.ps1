param([string]$ArchivePath)
$ErrorActionPreference = 'Stop'
$mediaWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$mediaResources = Join-Path $mediaWorkspace 'resources/clip-media'
$mediaManifest = Get-Content -LiteralPath (Join-Path $mediaResources 'runtime.json') -Raw | ConvertFrom-Json
$mediaExe = Join-Path $mediaResources $mediaManifest.executable
if (Test-Path -LiteralPath $mediaExe) {
  if ((Get-FileHash -LiteralPath $mediaExe -Algorithm SHA256).Hash -ieq $mediaManifest.executableSha256) {
    Write-Output "Verified FFmpeg $($mediaManifest.version): $mediaExe"
    exit 0
  }
  throw 'Existing clip media runtime hash differs from the pinned version; preserve and inspect it before replacing it.'
}
$mediaStaging = Join-Path $mediaWorkspace 'tmp/clip-media-runtime'
New-Item -ItemType Directory -Path $mediaStaging -Force | Out-Null
if (-not $ArchivePath) {
  $ArchivePath = Join-Path $mediaStaging 'ffmpeg-9.0.1-essentials_build.zip'
  if (-not (Test-Path -LiteralPath $ArchivePath)) {
    Invoke-WebRequest -Uri $mediaManifest.archiveUrl -OutFile $ArchivePath
  }
}
if ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash -ine $mediaManifest.archiveSha256) {
  throw 'FFmpeg runtime archive failed its pinned SHA-256 check.'
}
$mediaExtract = Join-Path $mediaStaging ('extract-' + [Guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $ArchivePath -DestinationPath $mediaExtract
$mediaSource = Join-Path $mediaExtract 'ffmpeg-9.0.1-essentials_build'
$mediaSourceExe = Join-Path $mediaSource 'bin/ffmpeg.exe'
if ((Get-FileHash -LiteralPath $mediaSourceExe -Algorithm SHA256).Hash -ine $mediaManifest.executableSha256) {
  throw 'Extracted FFmpeg executable failed its pinned SHA-256 check.'
}
New-Item -ItemType Directory -Path (Split-Path -Parent $mediaExe) -Force | Out-Null
Copy-Item -LiteralPath $mediaSourceExe -Destination $mediaExe
Copy-Item -LiteralPath (Join-Path $mediaSource 'LICENSE') -Destination (Join-Path (Split-Path -Parent $mediaExe) 'LICENSE-GPL-3.0.txt')
Copy-Item -LiteralPath (Join-Path $mediaSource 'README.txt') -Destination (Join-Path (Split-Path -Parent $mediaExe) 'UPSTREAM-README.txt')
Write-Output "Prepared verified FFmpeg $($mediaManifest.version): $mediaExe"
