param(
  [int]$MaxAttempts = 4,
  [int]$SleepSeconds = 8,
  [string]$Version = $(if (Test-Path -LiteralPath "VERSION") { ((Get-Content -LiteralPath "VERSION" | Select-Object -First 1) -as [string]).Trim() } else { "latest" }),
  [string]$DockerHubUser = $(if ($env:DOCKERHUB_USERNAME) { $env:DOCKERHUB_USERNAME } else { 'simbamcsimba' })
)

$ErrorActionPreference = 'Stop'

Write-Host "VERSION: $Version" -ForegroundColor Cyan

try {
  Resolve-DnsName auth.docker.io -ErrorAction Stop | Select-Object -First 1 Name,IPAddress | Format-Table | Out-String | Write-Host
} catch {
  Write-Host "DNS check failed for auth.docker.io (will retry publish anyway)." -ForegroundColor Yellow
}

for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
  Write-Host "`nPublish attempt $attempt/$MaxAttempts" -ForegroundColor Cyan
  try {
    powershell -NoProfile -ExecutionPolicy Bypass -File .\publish-docker.ps1 -DockerHubUser $DockerHubUser -Version $Version
    if ($LASTEXITCODE -ne 0) {
      throw "publish-docker.ps1 failed (exit code $LASTEXITCODE)"
    }
    Write-Host "Publish script completed." -ForegroundColor Green
    break
  } catch {
    Write-Host "Publish failed: $($_.Exception.Message)" -ForegroundColor Yellow
    if ($attempt -eq $MaxAttempts) { throw }
    Start-Sleep -Seconds $SleepSeconds
  }
}

Write-Host "`nVerifying tags on Docker Hub..." -ForegroundColor Cyan

$appRepo = "$DockerHubUser/vitransfer-app"
$workerRepo = "$DockerHubUser/vitransfer-worker"

docker buildx imagetools inspect "${appRepo}:$Version"
docker buildx imagetools inspect "${workerRepo}:$Version"
docker buildx imagetools inspect "${appRepo}:latest"
docker buildx imagetools inspect "${workerRepo}:latest"
