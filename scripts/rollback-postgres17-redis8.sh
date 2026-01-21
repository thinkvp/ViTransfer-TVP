#!/bin/bash
#
# ViTransfer Database Rollback Script
# Rollback PostgreSQL 17 → 16 and Redis 8 → 7
# For TrueNAS Scale with Dockge
#
# USAGE: sudo bash rollback-postgres17-redis8.sh [TIMESTAMP]
#        Example: sudo bash rollback-postgres17-redis8.sh 20260121-143052
#

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration - MUST MATCH upgrade script
DATA_ROOT="/mnt/tank/apps/vitransfer"
BACKUP_ROOT="/mnt/tank/backups/vitransfer"
CONTAINER_PREFIX="vitransfer"

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
    read -p "$(echo -e ${YELLOW}$1${NC}) [y/N] " -n 1 -r
    echo
    [[ $REPLY =~ ^[Yy]$ ]]
}

press_enter() {
    echo ""
    read -p "$(echo -e ${BLUE}Press Enter to continue...${NC})"
}

# Header
log_error "ViTransfer Database ROLLBACK Script"
log_error "This will UNDO the PostgreSQL 17 / Redis 8 upgrade"
echo "================================================================"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    log_error "This script must be run as root (use sudo)"
    exit 1
fi

# Get backup timestamp
if [ -z "$1" ]; then
    log_info "Available backups:"
    ls -1 "${BACKUP_ROOT}" 2>/dev/null || echo "  (none found)"
    echo ""
    read -p "Enter backup timestamp to restore: " TIMESTAMP
else
    TIMESTAMP="$1"
fi

BACKUP_DIR="${BACKUP_ROOT}/${TIMESTAMP}"

# Validate backup directory
if [ ! -d "${BACKUP_DIR}" ]; then
    log_error "Backup directory not found: ${BACKUP_DIR}"
    log_info "Available backups:"
    ls -1 "${BACKUP_ROOT}" 2>/dev/null || echo "  (none found)"
    exit 1
fi

# Check for required backup files
if [ ! -f "${BACKUP_DIR}/postgres-data.tar.gz" ]; then
    log_error "PostgreSQL backup not found: ${BACKUP_DIR}/postgres-data.tar.gz"
    exit 1
fi

if [ ! -f "${BACKUP_DIR}/redis-data.tar.gz" ]; then
    log_error "Redis backup not found: ${BACKUP_DIR}/redis-data.tar.gz"
    exit 1
fi

# Show what will be restored
log_info "Rollback configuration:"
echo "  Backup Dir:    ${BACKUP_DIR}"
echo "  Data Root:     ${DATA_ROOT}"
echo ""
echo "Backup contents:"
ls -lh "${BACKUP_DIR}"
echo ""

log_warn "This will:"
echo "  1. STOP your ViTransfer stack"
echo "  2. DELETE current PostgreSQL 17 data"
echo "  3. DELETE current Redis 8 data"
echo "  4. RESTORE PostgreSQL 16 data from backup"
echo "  5. RESTORE Redis 7 data from backup"
echo "  6. REVERT Docker Compose to version 16/7"
echo ""

if ! confirm "Are you ABSOLUTELY SURE you want to rollback?"; then
    log_warn "Rollback cancelled"
    exit 0
fi

echo ""

# Check for running containers
log_info "Checking for running containers..."
RUNNING_CONTAINERS=$(docker ps --filter "name=${CONTAINER_PREFIX}" --format "{{.Names}}" | wc -l)
if [ "$RUNNING_CONTAINERS" -gt 0 ]; then
    log_warn "Found ${RUNNING_CONTAINERS} running ViTransfer containers"
    docker ps --filter "name=${CONTAINER_PREFIX}" --format "table {{.Names}}\t{{.Status}}"
    echo ""
    log_warn "You must stop the stack in Dockge first!"
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

# Step 1: Remove current data
log_info "Step 1: Removing current PostgreSQL 17 and Redis 8 data..."
echo ""

log_warn "About to delete:"
echo "  ${DATA_ROOT}/postgres/*"
echo "  ${DATA_ROOT}/redis/*"
echo ""

if ! confirm "Proceed with deletion?"; then
    log_warn "Rollback cancelled"
    exit 0
fi

rm -rf "${DATA_ROOT}/postgres/"*
log_success "PostgreSQL data removed"

rm -rf "${DATA_ROOT}/redis/"*
log_success "Redis data removed"

echo ""
press_enter

# Step 2: Restore from backup
log_info "Step 2: Restoring data from backup..."
echo ""

log_info "Restoring PostgreSQL 16 data..."
tar -xzf "${BACKUP_DIR}/postgres-data.tar.gz" -C "${DATA_ROOT}/"
log_success "PostgreSQL data restored"

log_info "Restoring Redis 7 data..."
tar -xzf "${BACKUP_DIR}/redis-data.tar.gz" -C "${DATA_ROOT}/"
log_success "Redis data restored"

# Verify restoration
if [ ! -d "${DATA_ROOT}/postgres/base" ]; then
    log_error "PostgreSQL restoration failed - data directory is invalid"
    exit 1
fi

log_success "Data restored successfully"
echo ""
press_enter

# Step 3: Update Docker Compose
log_info "Step 3: Revert Docker Compose file in Dockge"
echo ""
log_warn "MANUAL STEP REQUIRED:"
echo ""
echo "  1. Open Dockge in your browser"
echo "  2. Click on your ViTransfer stack"
echo "  3. Click EDIT"
echo "  4. Find and change these lines:"
echo ""
echo "     FROM: image: postgres:17-alpine"
echo "     TO:   image: postgres:16-alpine"
echo ""
echo "     FROM: image: redis:8-alpine"
echo "     TO:   image: redis:7-alpine"
echo ""
echo "  5. Click SAVE"
echo "  6. Click START"
echo ""
press_enter

# Step 4: Verify
log_info "Step 4: Verifying rollback..."
echo ""

log_info "Waiting for containers to start..."
for i in {1..60}; do
    if docker ps --filter "name=${CONTAINER_PREFIX}-postgres" --filter "status=running" | grep -q postgres; then
        log_success "PostgreSQL container is running"
        break
    fi
    if [ $i -eq 60 ]; then
        log_error "PostgreSQL container failed to start within 60 seconds"
        log_warn "Check Dockge logs for errors"
        exit 1
    fi
    sleep 1
done

# Wait for PostgreSQL to be ready
log_info "Waiting for PostgreSQL to be ready..."
for i in {1..30}; do
    if docker exec ${CONTAINER_PREFIX}-postgres pg_isready -U vitransfer > /dev/null 2>&1; then
        log_success "PostgreSQL is ready"
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

# Check PostgreSQL version
PG_VERSION=$(docker exec ${CONTAINER_PREFIX}-postgres psql -U vitransfer -t -c "SELECT version();" | head -1)
log_info "PostgreSQL version: ${PG_VERSION}"

if echo "$PG_VERSION" | grep -q "PostgreSQL 16"; then
    log_success "PostgreSQL 16 confirmed!"
else
    log_error "PostgreSQL version check failed - may not be version 16"
fi

# Check Redis version
if docker ps --filter "name=${CONTAINER_PREFIX}-redis" --filter "status=running" | grep -q redis; then
    REDIS_VERSION=$(docker exec ${CONTAINER_PREFIX}-redis redis-cli --version)
    log_info "Redis version: ${REDIS_VERSION}"
    
    if echo "$REDIS_VERSION" | grep -q "redis-cli 7"; then
        log_success "Redis 7 confirmed!"
    else
        log_warn "Redis version check inconclusive"
    fi
else
    log_warn "Redis container not found or not running"
fi

# Check all containers
log_info "Container status:"
docker ps --filter "name=${CONTAINER_PREFIX}" --format "table {{.Names}}\t{{.Status}}"

echo ""
log_success "Rollback complete!"
echo ""
log_info "Verify your application:"
echo "  1. Check Dockge - all containers should show 'healthy'"
echo "  2. Open your app: http://YOUR_TRUENAS_IP:4321"
echo "  3. Test login and basic functionality"
echo ""
log_info "Your PostgreSQL 16 and Redis 7 have been restored from backup"
