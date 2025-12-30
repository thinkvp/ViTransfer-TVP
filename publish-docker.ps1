param(
  [string]$DockerHubUser = $(if ($env:DOCKERHUB_USERNAME) { $env:DOCKERHUB_USERNAME } else { 'simbamcsimba' }),
  [string]$Version = $(if ($env:VERSION) { $env:VERSION } elseif (Test-Path -LiteralPath "VERSION") { (Get-Content -LiteralPath "VERSION" -Raw).Trim() } else { 'latest' }),
  [switch]$Dev,
  [switch]$NoLatest,
  [switch]$NoCache,
  [string]$Platforms = 'linux/amd64,linux/arm64'
)

$ErrorActionPreference = 'Stop'

$appRepo = "$DockerHubUser/vitransfer-app"
$workerRepo = "$DockerHubUser/vitransfer-worker"

if ($Dev) {
  $Version = 'dev'
}

# Tag selection
$appTags = @()
$workerTags = @()

if ($Version -like 'dev-*') {
  $appTags += "$appRepo:$Version"
  $workerTags += "$workerRepo:$Version"
} elseif ($Version -eq 'dev') {
  $appTags += "$appRepo:dev"
  $workerTags += "$workerRepo:dev"
} elseif ($Version -eq 'latest') {
  $appTags += "$appRepo:latest"
  $workerTags += "$workerRepo:latest"
} else {
  $appTags += "$appRepo:$Version"
  $workerTags += "$workerRepo:$Version"
  if (-not $NoLatest) {
    $appTags += "$appRepo:latest"
    $workerTags += "$workerRepo:latest"
  }
}

Write-Host "Publishing ViTransfer images" -ForegroundColor Cyan
Write-Host "  App:    $appRepo" 
Write-Host "  Worker: $workerRepo" 
Write-Host "  Version: $Version" 
Write-Host "  Platforms: $Platforms" 
Write-Host ""

# Verify buildx
& docker buildx version | Out-Null

# Ensure a buildx builder exists/selected
$builderName = 'multiarch-builder'
$builders = & docker buildx ls | Out-String
if ($builders -notmatch [regex]::Escape($builderName)) {
  Write-Host "Creating buildx builder: $builderName" -ForegroundColor Yellow
  & docker buildx create --name $builderName --driver docker-container --use | Out-Null
} else {
  & docker buildx use $builderName | Out-Null
}

& docker buildx inspect --bootstrap | Out-Null

$noCacheFlag = @()
if ($NoCache) { $noCacheFlag = @('--no-cache') }

function BuildPushTarget([string]$target, [string[]]$tags) {
  $tagArgs = @()
  foreach ($t in $tags) { $tagArgs += @('--tag', $t) }

  Write-Host "Building + pushing target '$target'..." -ForegroundColor Cyan

  & docker buildx build `
    --platform $Platforms `
    --build-arg APP_VERSION=$Version `
    --target $target `
    @tagArgs `
    @noCacheFlag `
    --push `
    .
}

BuildPushTarget -target 'app' -tags $appTags
BuildPushTarget -target 'worker' -tags $workerTags

Write-Host "" 
Write-Host "Pushed tags:" -ForegroundColor Green
$appTags | ForEach-Object { Write-Host "  $_" }
$workerTags | ForEach-Object { Write-Host "  $_" }
