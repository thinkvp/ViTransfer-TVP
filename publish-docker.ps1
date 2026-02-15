param(
  [string]$DockerHubUser = $(if ($env:DOCKERHUB_USERNAME) { $env:DOCKERHUB_USERNAME } else { 'thinkvp' }),
  [string]$Version = $(if ($env:VERSION) { $env:VERSION } elseif (Test-Path -LiteralPath "VERSION") { ((Get-Content -LiteralPath "VERSION" | Select-Object -First 1) -as [string]).Trim() } else { 'latest' }),
  [switch]$Dev,
  [switch]$NoLatest,
  [switch]$NoCache,
  [string]$Platforms = 'linux/amd64',
  [string]$Builder
)

$ErrorActionPreference = 'Stop'

$appRepo = "$DockerHubUser/vitransfer-tvp-app"
$workerRepo = "$DockerHubUser/vitransfer-tvp-worker"

if ($Dev) {
  $Version = 'dev'
}

# Tag selection
$appTags = @()
$workerTags = @()
$shouldCreateLatest = $false
$latestOnly = $false

if ($Version -like 'dev-*') {
  $appTags += "${appRepo}:$Version"
  $workerTags += "${workerRepo}:$Version"
} elseif ($Version -eq 'dev') {
  $appTags += "${appRepo}:dev"
  $workerTags += "${workerRepo}:dev"
} elseif ($Version -eq 'latest') {
  $appTags += "${appRepo}:latest"
  $workerTags += "${workerRepo}:latest"
  $latestOnly = $true
} else {
  $appTags += "${appRepo}:$Version"
  $workerTags += "${workerRepo}:$Version"
  $shouldCreateLatest = (-not $NoLatest)
}

Write-Host "Publishing ViTransfer images" -ForegroundColor Cyan
Write-Host "  App:    $appRepo" 
Write-Host "  Worker: $workerRepo" 
Write-Host "  Version: $Version" 
Write-Host "  Platforms: $Platforms" 
Write-Host ""

# Verify buildx
& docker buildx version | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "docker buildx is not available (exit code $LASTEXITCODE)"
}

# Prefer using the current/desktop builder (avoids extra buildkit container DNS flakiness)
$builders = & docker buildx ls | Out-String
if ($Builder) {
  Write-Host "Using buildx builder: $Builder" -ForegroundColor Yellow
  & docker buildx use $Builder | Out-Null
} elseif ($builders -match "desktop-linux") {
  & docker buildx use desktop-linux | Out-Null
} else {
  & docker buildx use default | Out-Null
}

if ($LASTEXITCODE -ne 0) {
  throw "docker buildx use failed (exit code $LASTEXITCODE)"
}

& docker buildx inspect --bootstrap | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "docker buildx inspect --bootstrap failed (exit code $LASTEXITCODE)"
}

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

  if ($LASTEXITCODE -ne 0) {
    throw "docker buildx build failed for target '$target' (exit code $LASTEXITCODE)"
  }
}

function RetagLatestFromVersion([string]$repo, [string]$versionTag, [int]$maxRetries = 30, [int]$sleepSeconds = 3) {
  $src = "${repo}:$versionTag"
  $dst = "${repo}:latest"

  for ($i = 1; $i -le $maxRetries; $i++) {
    try {
      Write-Host "Retagging $dst -> $src (attempt $i/$maxRetries)" -ForegroundColor Yellow
      & docker buildx imagetools create --tag $dst $src | Out-Null
      if ($LASTEXITCODE -ne 0) {
        throw "docker buildx imagetools create failed (exit code $LASTEXITCODE)"
      }
      Write-Host "Updated $dst" -ForegroundColor Green
      return
    } catch {
      if ($i -eq $maxRetries) { throw }
      Start-Sleep -Seconds $sleepSeconds
    }
  }
}

BuildPushTarget -target 'app' -tags $appTags
BuildPushTarget -target 'worker' -tags $workerTags

if ($shouldCreateLatest -and (-not $latestOnly) -and ($Version -ne 'dev') -and ($Version -notlike 'dev-*')) {
  RetagLatestFromVersion -repo $appRepo -versionTag $Version
  RetagLatestFromVersion -repo $workerRepo -versionTag $Version
}

Write-Host "" 
Write-Host "Pushed tags:" -ForegroundColor Green
$appTags | ForEach-Object { Write-Host "  $_" }
$workerTags | ForEach-Object { Write-Host "  $_" }

if ($shouldCreateLatest -and (-not $latestOnly) -and ($Version -ne 'dev') -and ($Version -notlike 'dev-*')) {
  Write-Host "  ${appRepo}:latest" 
  Write-Host "  ${workerRepo}:latest" 
}
