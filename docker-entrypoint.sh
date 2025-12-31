#!/bin/bash

# ViTransfer Docker Entrypoint Script (simplified)
# Assumes the container runtime (docker-compose `user:`) controls UID/GID.
# Keeps only service readiness checks + Prisma migrations.

set -e

echo "ViTransfer starting..."
echo "[INFO] Running as UID=$(id -u) GID=$(id -g)"
echo ""


# ========================================
# SERVICE READINESS CHECKS
# ========================================


# Function to wait for postgres to be ready
wait_for_postgres() {
    echo "[WAIT] Waiting for PostgreSQL to be ready..."


    max_attempts=30
    attempt=0


    while [ $attempt -lt $max_attempts ]; do
        if node -e "
            const { PrismaClient } = require('@prisma/client');
            const prisma = new PrismaClient();
            prisma.\$connect()
                .then(() => { console.log('Connected'); process.exit(0); })
                .catch(() => { process.exit(1); });
        " 2>/dev/null; then
            echo "[OK] PostgreSQL is ready!"
            return 0
        fi


        attempt=$((attempt + 1))
        echo "  Attempt $attempt/$max_attempts - waiting..."
        sleep 2
    done


    echo "[ERROR] PostgreSQL is not ready after $max_attempts attempts"
    return 1
}


# Function to wait for Redis to be ready
wait_for_redis() {
    echo "[WAIT] Waiting for Redis to be ready..."


    max_attempts=30
    attempt=0


    while [ $attempt -lt $max_attempts ]; do
        if node -e "
            const Redis = require('ioredis');
            const redis = new Redis({
                host: process.env.REDIS_HOST || 'redis',
                port: parseInt(process.env.REDIS_PORT || '6379'),
                password: process.env.REDIS_PASSWORD || undefined,
                maxRetriesPerRequest: 1,
                retryStrategy: () => null
            });
            redis.ping()
                .then(() => { redis.disconnect(); process.exit(0); })
                .catch(() => { redis.disconnect(); process.exit(1); });
        " 2>/dev/null; then
            echo "[OK] Redis is ready!"
            return 0
        fi


        attempt=$((attempt + 1))
        echo "  Attempt $attempt/$max_attempts - waiting..."
        sleep 2
    done


    echo "[ERROR] Redis is not ready after $max_attempts attempts"
    return 1
}


# Function to wait for app to be fully ready
wait_for_app() {
    echo "[WAIT] Waiting for application to be fully ready..."


    # Configurable hostname and port for different deployment scenarios
    # APP_HOST: Container/service name (default: vitransfer-app)
    # APP_PORT: Application port (default: 4321)
    APP_HOST=${APP_HOST:-vitransfer-app}
    APP_PORT=${APP_PORT:-4321}
    max_attempts=150  # 5 minutes (150 attempts * 2 seconds)
    attempt=0


    echo "  Checking: http://${APP_HOST}:${APP_PORT}/api/health"


    while [ $attempt -lt $max_attempts ]; do
        if curl -s -f http://${APP_HOST}:${APP_PORT}/api/health > /dev/null 2>&1; then
            echo "[OK] Application is ready!"
            return 0
        fi


        attempt=$((attempt + 1))
        echo "  Attempt $attempt/$max_attempts - waiting..."
        sleep 2
    done


    echo "[ERROR] Application is not ready after $max_attempts attempts"
    echo "        Tried: http://${APP_HOST}:${APP_PORT}"
    return 1
}


# ========================================
# DATABASE SETUP (MAIN APP ONLY)
# ========================================


# Only run migrations and initialization for the main app, not the worker
if ([ "$1" = "npm" ] && [ "$2" = "start" ]) || \
    ([ "$1" = "npm" ] && [ "$2" = "run" ] && [ "$3" = "start:standalone" ]) || \
    ([ "$1" = "node" ] && [[ "$2" == *".next/standalone/server.js"* ]]); then
    echo "[SETUP] Running database setup..."
    echo ""


    # Wait for services to be ready
    wait_for_postgres
    wait_for_redis


    echo ""
    echo "[DB]  Running Prisma migrations..."


    # Run migrations automatically
    # - On first run: Creates all tables from scratch (initial_schema migration)
    # - On updates: Applies only new migrations (e.g., when upgrading to v1.1, v1.2, etc.)
    # - Idempotent: Safe to run multiple times, only applies pending migrations
    if npx prisma migrate deploy; then
        echo "[OK] Database migrations completed"
    else
        echo "[ERROR] Database migration failed"
        exit 1
    fi


    echo ""
    echo "[INIT] Database setup complete"
    echo "      Admin initialization will run automatically via instrumentation.ts"
    echo ""
elif [[ "$@" == *"npm run worker"* ]] || [[ "$@" == *"worker"* ]]; then
    echo "[SETUP] Worker initialization..."
    echo ""


    # Workers need to wait for database, Redis, AND the main app to be ready
    wait_for_postgres
    wait_for_redis
    wait_for_app


    echo ""
    echo "[OK] All services ready for worker"
    echo ""
fi


# ========================================
# START APPLICATION
# ========================================


echo "[START] Starting application..."
echo "         Command: $*"
echo ""

# Execute the main command
exec "$@"
