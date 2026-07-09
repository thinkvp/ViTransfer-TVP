/**
 * Centralized Redis Connection
 *
 * Single source of truth for all Redis connections across the application.
 * Used by: video-access, rate-limit, session-invalidation, token-revocation, OTP, etc.
 *
 * Features:
 * - Singleton pattern (reuses same connection)
 * - Lazy connection (connects on first use)
 * - Automatic retry with backoff
 * - Proper error handling
 * - Production-ready configuration
 */

import IORedis from 'ioredis'

let redis: IORedis | null = null
let redisForQueue: IORedis | null = null
let redisSubscriber: IORedis | null = null

/**
 * Get or create Redis connection
 * Throws error if Redis is not configured
 */
export function getRedis(): IORedis {
  if (redis) return redis

  if (!process.env.REDIS_HOST) {
    throw new Error('REDIS_HOST environment variable is required')
  }

  redis = new IORedis({
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
    // Allow generous per-command retries; commands issued while the socket is
    // briefly down are retried instead of failing outright.
    maxRetriesPerRequest: 20,
    enableReadyCheck: true,
    lazyConnect: true,
    // TCP keep-alive so a silently dropped link (e.g. worker on the NAS ↔ Redis
    // on the VPS) is detected promptly rather than lingering as a half-open socket.
    keepAlive: 10000,
    // Never permanently give up. Previously this returned null after 3 attempts,
    // which parked the connection in a "closed" state forever — fine on a single
    // host, but fatal once the worker reaches Redis across a network that can
    // blip. Retry indefinitely with a capped backoff so drops self-heal.
    retryStrategy: (times) => {
      // Don't retry during the production build (no live Redis expected).
      if (process.env.NEXT_PHASE === 'phase-production-build') {
        return null
      }
      return Math.min(times * 200, 5000)
    },
    // Force a reconnect on errors that indicate the connection is unusable.
    reconnectOnError: (error) => {
      const message = error.message || ''
      if (message.includes('READONLY') || message.includes('ETIMEDOUT') || message.includes('ECONNRESET')) {
        return true
      }
      return false
    }
  })

  redis.on('error', (error) => {
    console.error('Redis error:', error.message)
  })

  redis.on('connect', () => {
    console.log('Redis connected successfully')
  })

  return redis
}

/**
 * Ensure an ioredis client is ready without calling connect() redundantly.
 * Avoids "Redis is already connecting/connected" during concurrent startup requests.
 */
export async function ensureRedisReady(client: IORedis): Promise<void> {
  if (client.status === 'ready') return

  if (client.status === 'wait') {
    await client.connect()
    return
  }

  if (client.status === 'connecting' || client.status === 'connect' || client.status === 'reconnecting') {
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        cleanup()
        resolve()
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const cleanup = () => {
        client.off('ready', onReady)
        client.off('error', onError)
      }

      client.once('ready', onReady)
      client.once('error', onError)
    })
    return
  }

  // Covers states like "close"/"end".
  await client.connect()
}

/**
 * Get or create Redis connection optimized for BullMQ
 * BullMQ requires specific configuration: maxRetriesPerRequest: null, enableReadyCheck: false
 *
 * Note: Return type uses `any` cast because top-level ioredis and bullmq's
 * bundled ioredis can drift on minor type details (e.g. AbstractConnector).
 * The runtime instances are fully compatible; only the TypeScript declarations diverge.
 */
export function getRedisForQueue(): any {
  if (redisForQueue) return redisForQueue

  if (!process.env.REDIS_HOST) {
    throw new Error('REDIS_HOST environment variable is required')
  }

  redisForQueue = new IORedis({
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,     // Required by BullMQ
    lazyConnect: true,
    // Detect a silently dropped NAS ↔ VPS link promptly (same rationale as getRedis).
    keepAlive: 10000,
    retryStrategy: (times) => {
      // Only retry in production/runtime, not during build
      if (process.env.NEXT_PHASE === 'phase-production-build') {
        return null // Don't retry during build
      }
      const delay = Math.min(times * 50, 2000)
      return delay
    }
  })

  redisForQueue.on('error', (error) => {
    console.error('Redis (Queue) error:', error.message)
  })

  redisForQueue.on('connect', () => {
    console.log('Redis (Queue) connected successfully')
  })

  return redisForQueue
}

/**
 * Get or create a dedicated Redis connection for pub/sub SUBSCRIBE usage.
 *
 * A connection placed into subscriber mode can no longer run ordinary commands,
 * so subscriptions must not share the general-purpose connection. Publishing is
 * done on `getRedis()`; only SUBSCRIBE/UNSUBSCRIBE run on this one. A single
 * shared subscriber with in-process fan-out (see `project-events.ts`) keeps the
 * number of Redis connections flat regardless of how many SSE clients are open.
 */
export function getRedisSubscriber(): IORedis {
  if (redisSubscriber) return redisSubscriber

  if (!process.env.REDIS_HOST) {
    throw new Error('REDIS_HOST environment variable is required')
  }

  redisSubscriber = new IORedis({
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
    keepAlive: 10000,
    retryStrategy: (times) => {
      if (process.env.NEXT_PHASE === 'phase-production-build') {
        return null
      }
      return Math.min(times * 200, 5000)
    },
    reconnectOnError: (error) => {
      const message = error.message || ''
      if (message.includes('READONLY') || message.includes('ETIMEDOUT') || message.includes('ECONNRESET')) {
        return true
      }
      return false
    },
  })

  redisSubscriber.on('error', (error) => {
    console.error('Redis (Sub) error:', error.message)
  })

  return redisSubscriber
}

/**
 * Close Redis connection gracefully
 * Should be called on application shutdown
 */
export async function closeRedisConnection(): Promise<void> {
  if (redis) {
    await redis.quit()
    redis = null
  }
  if (redisForQueue) {
    await redisForQueue.quit()
    redisForQueue = null
  }
  if (redisSubscriber) {
    await redisSubscriber.quit()
    redisSubscriber = null
  }
}
