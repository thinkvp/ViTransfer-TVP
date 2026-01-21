#!/bin/bash
#
# ViTransfer Database Upgrade Script
# PostgreSQL 16 → 17 and Redis 7 → 8
# For TrueNAS Scale with Dockge
#
# USAGE: sudo bash upgrade-postgres17-redis8.sh
#

set -euo pipefail  # Exit on error / unset vars / pipeline failures

IFS=$'\n\t'

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration - ADJUST THESE FOR YOUR SETUP
#
# This script assumes you are using bind-mounted directories (not named volumes)
# like the sample compose shown in the docs.
DATA_ROOT="/mnt/ssd1/configs/vitransfer"

# If your compose mounts to custom paths, set these explicitly.
# Example (your compose):
#   /mnt/ssd1/configs/vitransfer/postgres-data:/var/lib/postgresql/data
#   /mnt/ssd1/configs/vitransfer/redis-data:/data
POSTGRES_DATA_DIR="${DATA_ROOT}/postgres-data"
REDIS_DATA_DIR="${DATA_ROOT}/redis-data"

BACKUP_ROOT="${DATA_ROOT}/backups"
POSTGRES_USER="vitransfer"
CONTAINER_PREFIX="vitransfer"

# Optional: if your Postgres data directory requires a specific uid:gid
# (TrueNAS often uses 999:999 or 1000:1000). Leave empty to use image default.
POSTGRES_CONTAINER_USER=""

# Timestamps
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="${BACKUP_ROOT}/${TIMESTAMP}"

TEMP_PG_CONTAINER="temp-postgres16-backup-${TIMESTAMP}"

cleanup() {
    if docker ps -a --format "{{.Names}}" | grep -qx "${TEMP_PG_CONTAINER}"; then
        docker stop "${TEMP_PG_CONTAINER}" > /dev/null 2>&1 || true
        docker rm "${TEMP_PG_CONTAINER}" > /dev/null 2>&1 || true
    fi
}

trap cleanup EXIT

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

confirm() {
    read -p "$(echo -e "${YELLOW}${1}${NC}") [y/N] " -n 1 -r
    echo
    [[ $REPLY =~ ^[Yy]$ ]]
}

press_enter() {
    echo ""
    read -p "$(echo -e "${BLUE}Press Enter to continue...${NC}")"
}

require_cmd() {
    command -v "$1" > /dev/null 2>&1 || {
        log_error "Required command not found: $1"
        exit 1
    }
}

wipe_dir_contents() {
    local target_dir="$1"

    if [ -z "${target_dir}" ] || [ "${target_dir}" = "/" ]; then
        log_error "Refusing to wipe unsafe path: '${target_dir}'"
        exit 1
    fi

    if [ ! -d "${target_dir}" ]; then
        log_error "Directory not found: ${target_dir}"
        exit 1
    fi

    shopt -s nullglob dotglob
    rm -rf "${target_dir}"/*
    shopt -u nullglob dotglob
}

# Pre-flight checks
log_info "ViTransfer PostgreSQL 16→17 & Redis 7→8 Upgrade Script"
echo "================================================================"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    log_error "This script must be run as root (use sudo)"
    exit 1
fi

# Required tools
require_cmd docker
require_cmd tar
require_cmd grep
require_cmd wc
require_cmd du

# Check Docker access
if ! docker info > /dev/null 2>&1; then
    log_error "Docker is not available (daemon not running or permission denied)"
    exit 1
fi

# Check if data directories exist
if [ ! -d "${POSTGRES_DATA_DIR}" ]; then
    log_error "PostgreSQL data directory not found: ${POSTGRES_DATA_DIR}"
    exit 1
fi

if [ ! -d "${REDIS_DATA_DIR}" ]; then
    log_error "Redis data directory not found: ${REDIS_DATA_DIR}"
    exit 1
fi

# Try to detect on-disk Postgres major version (safety check)
if [ -f "${POSTGRES_DATA_DIR}/PG_VERSION" ]; then
    DISK_PG_VERSION=$(cat "${POSTGRES_DATA_DIR}/PG_VERSION" | tr -d ' \t\r\n')
    log_info "Detected Postgres data directory version: ${DISK_PG_VERSION}"
    if [ "${DISK_PG_VERSION}" != "16" ]; then
        log_warn "Expected PG_VERSION=16 but found '${DISK_PG_VERSION}'."
        if ! confirm "Continue anyway?"; then
            log_warn "Aborted by user"
            exit 0
        fi
    fi
else
    log_warn "Could not find ${POSTGRES_DATA_DIR}/PG_VERSION to verify current major version"
fi

# Show configuration
log_info "Configuration:"
echo "  Data Root:     ${DATA_ROOT}"
echo "  PG Data Dir:   ${POSTGRES_DATA_DIR}"
echo "  Redis Data:    ${REDIS_DATA_DIR}"
echo "  Backup Root:   ${BACKUP_ROOT}"
echo "  Backup Dir:    ${BACKUP_DIR}"
echo "  PG User:       ${POSTGRES_USER}"
if [ -n "${POSTGRES_CONTAINER_USER}" ]; then
    echo "  PG UID:GID:    ${POSTGRES_CONTAINER_USER}"
fi
echo ""

if ! confirm "Does this configuration look correct?"; then
    log_warn "Aborted by user"
    exit 0
fi

# Check for existing containers
log_info "Checking for running containers..."
RUNNING_CONTAINERS=$(docker ps --filter "name=${CONTAINER_PREFIX}" --format "{{.Names}}" | wc -l)
if [ "$RUNNING_CONTAINERS" -gt 0 ]; then
    log_warn "Found ${RUNNING_CONTAINERS} running ViTransfer containers"
    docker ps --filter "name=${CONTAINER_PREFIX}" --format "table {{.Names}}\t{{.Status}}"
    echo ""
    log_warn "You must stop the stack in Dockge before continuing!"
    echo ""
    echo "Steps:"
    echo "  1. Open Dockge in your browser"
    echo "  2. Find your ViTransfer stack"
    echo "  3. Click the STOP button"
    echo "  4. Wait for all containers to stop"
    echo "  5. Come back here and press Enter"
    press_enter
    
    # Re-check
    RUNNING_CONTAINERS=$(docker ps --filter "name=${CONTAINER_PREFIX}" --format "{{.Names}}" | wc -l)
    if [ "$RUNNING_CONTAINERS" -gt 0 ]; then
        log_error "Containers are still running. Please stop them first."
        exit 1
    fi
fi

log_success "No running containers found"
echo ""

# Prompt for PostgreSQL password
echo ""
log_info "Enter your PostgreSQL password (from your .env file)"
read -s -p "PostgreSQL Password: " POSTGRES_PASSWORD
echo ""
echo ""

if [ -z "$POSTGRES_PASSWORD" ]; then
    log_error "Password cannot be empty"
    exit 1
fi

# Create backup directory
log_info "Creating backup directory: ${BACKUP_DIR}"
mkdir -p "${BACKUP_DIR}"

# Step 1: Backup data directories
log_info "Step 1: Creating tar backups of data directories..."
echo ""

log_info "Backing up PostgreSQL data..."
tar -czf "${BACKUP_DIR}/postgres-data.tar.gz" -C "$(dirname "${POSTGRES_DATA_DIR}")" "$(basename "${POSTGRES_DATA_DIR}")"
POSTGRES_BACKUP_SIZE=$(du -h "${BACKUP_DIR}/postgres-data.tar.gz" | cut -f1)
log_success "PostgreSQL backup created (${POSTGRES_BACKUP_SIZE})"

log_info "Backing up Redis data..."
tar -czf "${BACKUP_DIR}/redis-data.tar.gz" -C "$(dirname "${REDIS_DATA_DIR}")" "$(basename "${REDIS_DATA_DIR}")"
REDIS_BACKUP_SIZE=$(du -h "${BACKUP_DIR}/redis-data.tar.gz" | cut -f1)
log_success "Redis backup created (${REDIS_BACKUP_SIZE})"

echo ""
press_enter

# Step 2: Create PostgreSQL SQL dump
log_info "Step 2: Creating PostgreSQL SQL dump..."
echo ""

log_info "Starting temporary PostgreSQL 16 container..."
DOCKER_USER_ARGS=()
if [ -z "${POSTGRES_CONTAINER_USER}" ]; then
    # If not explicitly configured, try to match directory ownership (common on TrueNAS)
    if command -v stat > /dev/null 2>&1; then
        DETECTED_USER=$(stat -c '%u:%g' "${POSTGRES_DATA_DIR}" 2>/dev/null || true)
        if [ -n "${DETECTED_USER}" ] && [ "${DETECTED_USER}" != "0:0" ]; then
            DOCKER_USER_ARGS=(--user "${DETECTED_USER}")
            log_info "Using detected uid:gid for temp container: ${DETECTED_USER}"
        fi
    fi
else
    DOCKER_USER_ARGS=(--user "${POSTGRES_CONTAINER_USER}")
fi

docker run -d --name "${TEMP_PG_CONTAINER}" "${DOCKER_USER_ARGS[@]}" \
    -e POSTGRES_USER="${POSTGRES_USER}" \
    -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
    -v "${POSTGRES_DATA_DIR}:/var/lib/postgresql/data" \
    postgres:16-alpine > /dev/null

# Wait for PostgreSQL to be ready
log_info "Waiting for PostgreSQL to start..."
for i in {1..30}; do
    if docker exec "${TEMP_PG_CONTAINER}" pg_isready -U "${POSTGRES_USER}" > /dev/null 2>&1; then
        log_success "PostgreSQL is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        log_error "PostgreSQL failed to start within 30 seconds"
        docker logs "${TEMP_PG_CONTAINER}" || true
        exit 1
    fi
    sleep 1
    echo -n "."
done
echo ""

log_info "Creating SQL dump..."
docker exec "${TEMP_PG_CONTAINER}" pg_dumpall --clean --if-exists -U "${POSTGRES_USER}" > "${BACKUP_DIR}/database.sql"
DUMP_SIZE=$(du -h "${BACKUP_DIR}/database.sql" | cut -f1)
log_success "SQL dump created (${DUMP_SIZE})"

log_info "Stopping temporary container..."
docker stop "${TEMP_PG_CONTAINER}" > /dev/null
docker rm "${TEMP_PG_CONTAINER}" > /dev/null
log_success "Temporary container removed"

# Validate dump
if [ ! -s "${BACKUP_DIR}/database.sql" ]; then
    log_error "SQL dump file is empty!"
    exit 1
fi

DUMP_LINES=$(wc -l < "${BACKUP_DIR}/database.sql")
log_info "SQL dump contains ${DUMP_LINES} lines"

if [ "$DUMP_LINES" -lt 10 ]; then
    log_error "SQL dump seems too small (less than 10 lines)"
    exit 1
fi

echo ""
log_success "All backups created successfully!"
echo ""
echo "Backup location: ${BACKUP_DIR}"
ls -lh "${BACKUP_DIR}"
echo ""

if ! confirm "Ready to proceed with upgrade? This will DELETE the PostgreSQL data directory!"; then
    log_warn "Upgrade aborted by user"
    log_info "Your backups are safe at: ${BACKUP_DIR}"
    exit 0
fi

# Step 3: Remove old PostgreSQL data
log_info "Step 3: Removing old PostgreSQL 16 data..."
echo ""

log_warn "This will delete: ${POSTGRES_DATA_DIR}/*"
if ! confirm "Are you ABSOLUTELY SURE?"; then
    log_warn "Aborted"
    exit 0
fi

wipe_dir_contents "${POSTGRES_DATA_DIR}"
log_success "Old PostgreSQL data removed"

echo ""
press_enter

# Step 4: Update Docker Compose
log_info "Step 4: Update Docker Compose file in Dockge"
echo ""
log_warn "MANUAL STEP REQUIRED:"
echo ""
echo "  1. Open Dockge in your browser"
echo "  2. Click on your ViTransfer stack"
echo "  3. Click EDIT"
echo "  4. Find and change these lines:"
echo ""
echo "     FROM: image: postgres:16-alpine"
echo "     TO:   image: postgres:17-alpine"
echo ""
echo "     FROM: image: redis:7-alpine"
echo "     TO:   image: redis:8-alpine"
echo ""
echo "  5. Click SAVE (do NOT start yet!)"
echo ""
press_enter

# Step 5: Start new stack
log_info "Step 5: Start the stack with PostgreSQL 17 and Redis 8"
echo ""
log_warn "MANUAL STEP REQUIRED:"
echo ""
echo "  1. In Dockge, click START on your ViTransfer stack"
echo "  2. Click on 'vitransfer-postgres' to view logs"
echo "  3. Wait for: 'database system is ready to accept connections'"
echo "  4. Verify it shows 'PostgreSQL 17' in the startup logs"
echo ""
press_enter

# Wait for containers to be ready
log_info "Waiting for containers to start..."
for i in {1..60}; do
    if docker ps --filter "name=${CONTAINER_PREFIX}-postgres" --filter "status=running" | grep -q postgres; then
        log_success "PostgreSQL container is running"
        break
    fi
    if [ $i -eq 60 ]; then
        log_error "PostgreSQL container failed to start within 60 seconds"
        exit 1
    fi
    sleep 1
done

# Wait for PostgreSQL to be healthy
log_info "Waiting for PostgreSQL to be ready..."
for i in {1..30}; do
    if docker exec "${CONTAINER_PREFIX}-postgres" pg_isready -U "${POSTGRES_USER}" > /dev/null 2>&1; then
        log_success "PostgreSQL 17 is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        log_error "PostgreSQL failed to become ready"
        exit 1
    fi
    sleep 1
    echo -n "."
done
echo ""

# Step 6: Restore database
log_info "Step 6: Restoring database from dump..."
echo ""

log_info "Importing SQL dump (this may take a few minutes)..."
docker exec -i "${CONTAINER_PREFIX}-postgres" psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" < "${BACKUP_DIR}/database.sql" > "${BACKUP_DIR}/restore.log" 2>&1

log_success "Database restored!"
log_info "Restore log saved to: ${BACKUP_DIR}/restore.log"

# Check for critical errors (ignore "already exists" which is normal)
if grep -i "fatal\|error" "${BACKUP_DIR}/restore.log" | grep -v "already exists" > /dev/null; then
    log_warn "Some errors were found during restore (check the log)"
    echo "Showing errors (excluding 'already exists'):"
    grep -i "fatal\|error" "${BACKUP_DIR}/restore.log" | grep -v "already exists" | head -10
    echo ""
    if ! confirm "Continue anyway?"; then
        log_error "Restore had issues. Check ${BACKUP_DIR}/restore.log"
        exit 1
    fi
fi

echo ""
press_enter

# Step 7: Verify
log_info "Step 7: Verification"
echo ""

# Check PostgreSQL version
PG_VERSION=$(docker exec "${CONTAINER_PREFIX}-postgres" psql -U "${POSTGRES_USER}" -t -c "SELECT version();" | head -1)
log_info "PostgreSQL version: ${PG_VERSION}"

if echo "$PG_VERSION" | grep -q "PostgreSQL 17"; then
    log_success "PostgreSQL 17 confirmed!"
else
    log_error "PostgreSQL version check failed"
fi

# Check Redis version
if docker ps --filter "name=${CONTAINER_PREFIX}-redis" --filter "status=running" | grep -q redis; then
    REDIS_VERSION=$(docker exec "${CONTAINER_PREFIX}-redis" redis-cli --version)
    log_info "Redis version: ${REDIS_VERSION}"
    
    if echo "$REDIS_VERSION" | grep -q "redis-cli 8"; then
        log_success "Redis 8 confirmed!"
    else
        log_warn "Redis version check inconclusive"
    fi
else
    log_warn "Redis container not found or not running"
fi

# Check all containers are healthy
log_info "Container status:"
docker ps --filter "name=${CONTAINER_PREFIX}" --format "table {{.Names}}\t{{.Status}}"

echo ""
log_info "Final steps:"
echo "  1. Check Dockge - all containers should show 'healthy'"
echo "  2. Open your app: http://YOUR_TRUENAS_IP:4321"
echo "  3. Test login and basic functionality"
echo "  4. Upload a test video to verify workers"
echo ""

log_success "Upgrade complete!"
log_info "Backups are saved at: ${BACKUP_DIR}"
log_warn "Keep these backups for at least 1 week before deleting"
echo ""
echo "To rollback, run: sudo bash rollback-postgres17-redis8.sh ${TIMESTAMP}"
