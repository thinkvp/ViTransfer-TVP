# ViTransfer-TVP Setup Script for Windows
# Generates .env file with secure random secrets and prompts for admin credentials

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  ViTransfer-TVP Setup Script" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# Check if .env already exists
if (Test-Path .env) {
    Write-Host "⚠️  WARNING: .env file already exists!" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Overwriting will replace ALL secrets and credentials." -ForegroundColor Yellow
    Write-Host "This could lock you out if your database is already initialized." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "RECOMMENDED: Back up your current .env file first:" -ForegroundColor Cyan
    Write-Host "  Copy-Item .env .env.backup" -ForegroundColor Cyan
    Write-Host ""
    $overwrite = Read-Host "Do you want to overwrite it? (yes/no)"
    if ($overwrite -ne "yes") {
        Write-Host "Setup cancelled. Your existing .env file was not modified." -ForegroundColor Yellow
        exit 0
    }
    Write-Host ""
}

# Check if .env.example exists
if (!(Test-Path .env.example)) {
    Write-Host "❌ ERROR: .env.example file not found!" -ForegroundColor Red
    Write-Host "Please run this script from the ViTransfer-TVP root directory." -ForegroundColor Red
    exit 1
}

Write-Host "Generating secure random secrets..." -ForegroundColor Green
Write-Host ""

# Function to generate random hex string
function Get-RandomHex {
    param([int]$Length)
    -join ((1..$Length) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
}

# Function to generate random base64 string
function Get-RandomBase64 {
    param([int]$Length)
    $bytes = New-Object byte[] $Length
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [Convert]::ToBase64String($bytes)
}

# Generate secrets
$POSTGRES_PASSWORD = Get-RandomHex -Length 32
$REDIS_PASSWORD = Get-RandomHex -Length 32
$ENCRYPTION_KEY = Get-RandomBase64 -Length 32
$JWT_SECRET = Get-RandomBase64 -Length 64
$JWT_REFRESH_SECRET = Get-RandomBase64 -Length 64
$SHARE_TOKEN_SECRET = Get-RandomBase64 -Length 64

Write-Host "✓ Secrets generated" -ForegroundColor Green
Write-Host ""

# Prompt for admin credentials
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  Admin Account Setup" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# Admin email validation
do {
    $ADMIN_EMAIL = Read-Host "Admin Email"
    $emailRegex = "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
    if ($ADMIN_EMAIL -match $emailRegex) {
        $validEmail = $true
    } else {
        Write-Host "❌ Invalid email format. Please try again." -ForegroundColor Red
        $validEmail = $false
    }
} while (-not $validEmail)

# Admin password validation
do {
    $ADMIN_PASSWORD = Read-Host "Admin Password (min 8 characters)" -AsSecureString
    $ADMIN_PASSWORD_Plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ADMIN_PASSWORD)
    )
    
    if ($ADMIN_PASSWORD_Plain.Length -ge 8) {
        $ADMIN_PASSWORD_CONFIRM = Read-Host "Confirm Password" -AsSecureString
        $ADMIN_PASSWORD_CONFIRM_Plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ADMIN_PASSWORD_CONFIRM)
        )
        
        if ($ADMIN_PASSWORD_Plain -eq $ADMIN_PASSWORD_CONFIRM_Plain) {
            $validPassword = $true
        } else {
            Write-Host "❌ Passwords do not match. Please try again." -ForegroundColor Red
            $validPassword = $false
        }
    } else {
        Write-Host "❌ Password must be at least 8 characters long." -ForegroundColor Red
        $validPassword = $false
    }
} while (-not $validPassword)

# Store plain password for .env file
$ADMIN_PASSWORD = $ADMIN_PASSWORD_Plain

# Admin name (optional)
$ADMIN_NAME = Read-Host "Admin Name (optional, default: Admin)"
if ([string]::IsNullOrWhiteSpace($ADMIN_NAME)) {
    $ADMIN_NAME = "Admin"
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  Optional Configuration" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# Port validation
do {
    $APP_PORT = Read-Host "Application Port (default: 4321)"
    if ([string]::IsNullOrWhiteSpace($APP_PORT)) {
        $APP_PORT = "4321"
    }
    
    $portNum = 0
    if ([int]::TryParse($APP_PORT, [ref]$portNum) -and $portNum -ge 1 -and $portNum -le 65535) {
        $validPort = $true
    } else {
        Write-Host "❌ Invalid port. Must be a number between 1 and 65535." -ForegroundColor Red
        $validPort = $false
    }
} while (-not $validPort)

# Timezone validation
do {
    $TZ = Read-Host "Timezone (default: UTC, examples: America/New_York, Europe/London)"
    if ([string]::IsNullOrWhiteSpace($TZ)) {
        $TZ = "UTC"
    }
    
    # Basic validation: should match Region/City or UTC format
    if ($TZ -match "^[A-Za-z]+(/[A-Za-z_]+)?$" -or $TZ -eq "UTC") {
        $validTz = $true
    } else {
        Write-Host "❌ Invalid timezone format. Use format like 'America/New_York' or 'UTC'." -ForegroundColor Red
        Write-Host "   See: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones" -ForegroundColor Yellow
        $validTz = $false
    }
} while (-not $validTz)

# HTTPS enabled validation
do {
    $HTTPS_ENABLED = Read-Host "Enable HTTPS headers? (true/false, default: true)"
    if ([string]::IsNullOrWhiteSpace($HTTPS_ENABLED)) {
        $HTTPS_ENABLED = "true"
    }
    
    if ($HTTPS_ENABLED -eq "true" -or $HTTPS_ENABLED -eq "false") {
        $validHttps = $true
    } else {
        Write-Host "❌ Invalid value. Must be exactly 'true' or 'false'." -ForegroundColor Red
        $validHttps = $false
    }
} while (-not $validHttps)

# PUID/PGID (defaults for Windows)
$PUID = "1000"
$PGID = "1000"

Write-Host ""
Write-Host "Creating .env file..." -ForegroundColor Green

# Read .env.example
$envContent = Get-Content .env.example -Raw

# Replace placeholders (using multiline mode with (?m))
$envContent = $envContent -replace "(?m)^APP_PORT=.*$", "APP_PORT=$APP_PORT"
$envContent = $envContent -replace "(?m)^PUID=.*$", "PUID=$PUID"
$envContent = $envContent -replace "(?m)^PGID=.*$", "PGID=$PGID"
$envContent = $envContent -replace "(?m)^TZ=.*$", "TZ=$TZ"
$envContent = $envContent -replace "(?m)^POSTGRES_PASSWORD=.*$", "POSTGRES_PASSWORD=$POSTGRES_PASSWORD"
$envContent = $envContent -replace "(?m)^REDIS_PASSWORD=.*$", "REDIS_PASSWORD=$REDIS_PASSWORD"
$envContent = $envContent -replace "(?m)^ENCRYPTION_KEY=.*$", "ENCRYPTION_KEY=$ENCRYPTION_KEY"
$envContent = $envContent -replace "(?m)^JWT_SECRET=.*$", "JWT_SECRET=$JWT_SECRET"
$envContent = $envContent -replace "(?m)^JWT_REFRESH_SECRET=.*$", "JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET"
$envContent = $envContent -replace "(?m)^SHARE_TOKEN_SECRET=.*$", "SHARE_TOKEN_SECRET=$SHARE_TOKEN_SECRET"
$envContent = $envContent -replace "(?m)^ADMIN_EMAIL=.*$", "ADMIN_EMAIL=$ADMIN_EMAIL"
$envContent = $envContent -replace "(?m)^ADMIN_PASSWORD=.*$", "ADMIN_PASSWORD=$ADMIN_PASSWORD"
$envContent = $envContent -replace "(?m)^ADMIN_NAME=.*$", "ADMIN_NAME=$ADMIN_NAME"
$envContent = $envContent -replace "(?m)^HTTPS_ENABLED=.*$", "HTTPS_ENABLED=$HTTPS_ENABLED"

# Write to .env
$envContent | Set-Content .env -NoNewline

# Sanity check: ensure placeholders are gone
$generatedEnv = Get-Content .env -Raw
if ($generatedEnv -match "<<REPLACE_WITH") {
    Write-Host "" 
    Write-Host "❌ Setup failed: one or more placeholders remain in .env" -ForegroundColor Red
    Write-Host "   Please re-run the script or edit .env manually." -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "  ✓ Setup Complete!" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Your .env file has been created with:"
Write-Host "  • 6 secure random secrets"
Write-Host "  • Admin account: $ADMIN_EMAIL"
Write-Host "  • Application port: $APP_PORT"
Write-Host "  • Timezone: $TZ"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Review .env file and adjust any settings"
Write-Host "  2. Run: docker-compose up -d"
Write-Host "  3. Access: http://localhost:$APP_PORT"
Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
