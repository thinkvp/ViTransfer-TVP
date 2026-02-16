#!/bin/bash
# ViTransfer-TVP Setup Script
# Generates .env file with secure random secrets and prompts for admin credentials

set -e

echo "=================================================="
echo "  ViTransfer-TVP Setup Script"
echo "=================================================="
echo ""

# Check if .env already exists
if [ -f .env ]; then
    echo "⚠️  WARNING: .env file already exists!"
    echo ""
    echo "Overwriting will replace ALL secrets and credentials."
    echo "This could lock you out if your database is already initialized."
    echo ""
    echo "RECOMMENDED: Back up your current .env file first:"
    echo "  cp .env .env.backup"
    echo ""
    read -p "Do you want to overwrite it? (yes/no): " overwrite
    if [ "$overwrite" != "yes" ]; then
        echo "Setup cancelled. Your existing .env file was not modified."
        exit 0
    fi
    echo ""
fi

# Check if .env.example exists
if [ ! -f .env.example ]; then
    echo "❌ ERROR: .env.example file not found!"
    echo "Please run this script from the ViTransfer-TVP root directory."
    exit 1
fi

# Check for openssl
if ! command -v openssl &> /dev/null; then
    echo "❌ ERROR: openssl is not installed!"
    echo "Please install openssl and try again."
    exit 1
fi

echo "Generating secure random secrets..."
echo ""

# Generate secrets
POSTGRES_PASSWORD=$(openssl rand -hex 32)
REDIS_PASSWORD=$(openssl rand -hex 32)
# NOTE: openssl base64 output may wrap lines depending on platform/build.
# Strip CR/LF to ensure values are single-line (required for .env parsing).
ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\r\n')
JWT_SECRET=$(openssl rand -base64 64 | tr -d '\r\n')
JWT_REFRESH_SECRET=$(openssl rand -base64 64 | tr -d '\r\n')
SHARE_TOKEN_SECRET=$(openssl rand -base64 64 | tr -d '\r\n')

echo "✓ Secrets generated"
echo ""

# Prompt for admin credentials
echo "=================================================="
echo "  Admin Account Setup"
echo "=================================================="
echo ""

# Admin email validation
while true; do
    read -p "Admin Email: " ADMIN_EMAIL
    if [[ "$ADMIN_EMAIL" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
        break
    else
        echo "❌ Invalid email format. Please try again."
    fi
done

# Admin password validation
while true; do
    read -sp "Admin Password (min 8 characters): " ADMIN_PASSWORD
    echo ""
    if [ ${#ADMIN_PASSWORD} -ge 8 ]; then
        read -sp "Confirm Password: " ADMIN_PASSWORD_CONFIRM
        echo ""
        if [ "$ADMIN_PASSWORD" = "$ADMIN_PASSWORD_CONFIRM" ]; then
            break
        else
            echo "❌ Passwords do not match. Please try again."
        fi
    else
        echo "❌ Password must be at least 8 characters long."
    fi
done

# Admin name (optional)
read -p "Admin Name (optional, default: Admin): " ADMIN_NAME
ADMIN_NAME=${ADMIN_NAME:-Admin}

echo ""
echo "=================================================="
echo "  Optional Configuration"
echo "=================================================="
echo ""

# Port validation
while true; do
    read -p "Application Port (default: 4321): " APP_PORT
    APP_PORT=${APP_PORT:-4321}
    if [[ "$APP_PORT" =~ ^[0-9]+$ ]] && [ "$APP_PORT" -ge 1 ] && [ "$APP_PORT" -le 65535 ]; then
        break
    else
        echo "❌ Invalid port. Must be a number between 1 and 65535."
    fi
done

# Timezone validation
while true; do
    read -p "Timezone (default: UTC, examples: America/New_York, Europe/London): " TZ
    TZ=${TZ:-UTC}
    # Basic validation: should match Region/City or UTC format
    if ! ([[ "$TZ" =~ ^[A-Za-z]+(/[A-Za-z_]+)?$ ]] || [ "$TZ" = "UTC" ]); then
        echo "❌ Invalid timezone format. Use format like 'America/New_York' or 'UTC'."
        echo "   See: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones"
        continue
    fi

    # Best-effort existence check (skip on platforms without zoneinfo files)
    if [ "$TZ" != "UTC" ] && [ -d "/usr/share/zoneinfo" ]; then
        if [ ! -f "/usr/share/zoneinfo/$TZ" ]; then
            echo "❌ Timezone '$TZ' not found on this system."
            echo "   Pick one from: timedatectl list-timezones (Linux)"
            continue
        fi
    fi

    break
done

# HTTPS enabled validation
while true; do
    read -p "Enable HTTPS headers? (true/false, default: true): " HTTPS_ENABLED
    HTTPS_ENABLED=${HTTPS_ENABLED:-true}
    if [ "$HTTPS_ENABLED" = "true" ] || [ "$HTTPS_ENABLED" = "false" ]; then
        break
    else
        echo "❌ Invalid value. Must be exactly 'true' or 'false'."
    fi
done

# PUID/PGID (only relevant on Linux)
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    PUID=$(id -u)
    PGID=$(id -g)
    echo ""
    echo "Detected Linux - Using PUID=$PUID, PGID=$PGID"
else
    PUID=1000
    PGID=1000
fi

echo ""
echo "Creating .env file..."

# Create .env file from .env.example
cp .env.example .env.tmp

# Replace placeholders using awk (more robust than sed for special characters)
awk -v app_port="$APP_PORT" \
    -v puid="$PUID" \
    -v pgid="$PGID" \
    -v tz="$TZ" \
    -v pg_pass="$POSTGRES_PASSWORD" \
    -v redis_pass="$REDIS_PASSWORD" \
    -v enc_key="$ENCRYPTION_KEY" \
    -v jwt_secret="$JWT_SECRET" \
    -v jwt_refresh="$JWT_REFRESH_SECRET" \
    -v share_token="$SHARE_TOKEN_SECRET" \
    -v admin_email="$ADMIN_EMAIL" \
    -v admin_pass="$ADMIN_PASSWORD" \
    -v admin_name="$ADMIN_NAME" \
    -v https_enabled="$HTTPS_ENABLED" \
'
BEGIN { FS="="; OFS="=" }
/^APP_PORT=/ { print $1, app_port; next }
/^PUID=/ { print $1, puid; next }
/^PGID=/ { print $1, pgid; next }
/^TZ=/ { print $1, tz; next }
/^POSTGRES_PASSWORD=/ { print $1, pg_pass; next }
/^REDIS_PASSWORD=/ { print $1, redis_pass; next }
/^ENCRYPTION_KEY=/ { print $1, enc_key; next }
/^JWT_SECRET=/ { print $1, jwt_secret; next }
/^JWT_REFRESH_SECRET=/ { print $1, jwt_refresh; next }
/^SHARE_TOKEN_SECRET=/ { print $1, share_token; next }
/^ADMIN_EMAIL=/ { print $1, admin_email; next }
/^ADMIN_PASSWORD=/ { print $1, admin_pass; next }
/^ADMIN_NAME=/ { print $1, admin_name; next }
/^HTTPS_ENABLED=/ { print $1, https_enabled; next }
{ print }
' .env.tmp > .env

# Clean up temporary file
rm .env.tmp

# Sanity check: ensure placeholders are gone
if grep -q "<<REPLACE_WITH" .env; then
    echo ""
    echo "❌ Setup failed: one or more placeholders remain in .env"
    echo "   Please re-run the script or edit .env manually."
    exit 1
fi

echo ""
echo "=================================================="
echo "  ✓ Setup Complete!"
echo "=================================================="
echo ""
echo "Your .env file has been created with:"
echo "  • 6 secure random secrets"
echo "  • Admin account: $ADMIN_EMAIL"
echo "  • Application port: $APP_PORT"
echo "  • Timezone: $TZ"
echo ""
echo "Next steps:"
echo "  1. Review .env file and adjust any settings"
echo "  2. Run: docker-compose up -d"
echo "  3. Access: http://localhost:$APP_PORT"
echo ""
echo "=================================================="
