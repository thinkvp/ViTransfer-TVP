param(
  [ValidateSet('pull', 'build')]
  [string]$Mode = 'pull',

  # Optional override. Examples:
  #   -File docker-compose.yml
  #   -File docker-compose.build.yml
  [string]$File,

  [switch]$Build,
  [switch]$NoPull,
  [switch]$Foreground,
  [switch]$RemoveOrphans
)

$ErrorActionPreference = 'Stop'

Push-Location $PSScriptRoot
try {
  $composeFile = if ($File) {
    $File
  } elseif ($Mode -eq 'build') {
    'docker-compose.build.yml'
  } else {
    'docker-compose.yml'
  }

  if (-not (Test-Path -LiteralPath $composeFile)) {
    throw "Compose file not found: $composeFile"
  }

  if ($Mode -eq 'build') {
    # In build mode, default to doing the thing people expect.
    if (-not $PSBoundParameters.ContainsKey('Build')) { $Build = $true }
    if (-not $PSBoundParameters.ContainsKey('NoPull')) { $NoPull = $true }
  }

  $baseArgs = @('compose', '-f', $composeFile)

  Write-Host "Using compose file: $composeFile" -ForegroundColor DarkCyan

  if (-not $NoPull -and $Mode -ne 'build') {
    Write-Host "Pulling latest images..." -ForegroundColor Cyan
    & docker @baseArgs pull
    if ($LASTEXITCODE -ne 0) { throw "docker compose pull failed (exit code $LASTEXITCODE)" }
  }

  $upArgs = @('up')
  if (-not $Foreground) { $upArgs += '-d' }
  if ($Build) { $upArgs += '--build' }
  if ($RemoveOrphans) { $upArgs += '--remove-orphans' }

  Write-Host ("Starting compose: docker compose {0}" -f ($upArgs -join ' ')) -ForegroundColor Cyan
  & docker @baseArgs @upArgs
  if ($LASTEXITCODE -ne 0) { throw "docker compose up failed (exit code $LASTEXITCODE)" }

  if (-not $Foreground) {
    Write-Host "" 
    & docker @baseArgs ps
  }
} finally {
  Pop-Location
}
