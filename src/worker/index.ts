import { Worker, Queue } from 'bullmq'
import { VideoProcessingJob, AssetProcessingJob, ClientFileProcessingJob, ProjectFileProcessingJob } from '../lib/queue'
import { initStorage } from '../lib/storage'
import { runCleanup } from '../lib/upload-cleanup'
import { getRedisForQueue, closeRedisConnection } from '../lib/redis'
import { prisma } from '../lib/db'
import os from 'os'
import { processVideo } from './video-processor'
import { processAsset } from './asset-processor'
import { processClientFile } from './client-file-processor'
import { processProjectFile } from './project-file-processor'
import { processAdminNotifications } from './admin-notifications'
import { processClientNotifications } from './client-notifications'
import { cleanupOldTempFiles, ensureTempDir } from './cleanup'
import { processAutoCloseApprovedProjects } from './auto-close-projects'

const DEBUG = process.env.DEBUG_WORKER === 'true'
const ONE_HOUR_MS = 60 * 60 * 1000
const SIX_HOURS_MS = 6 * 60 * 60 * 1000
const NOTIFICATION_RETRY_DELAY_MS = 2 * 60 * 1000

async function hasRetriableNotificationFailures(): Promise<boolean> {
  const count = await prisma.notificationQueue.count({
    where: {
      OR: [
        {
          sentToAdmins: false,
          adminFailed: false,
          adminAttempts: { lt: 3 },
          lastError: { not: null },
        },
        {
          sentToClients: false,
          clientFailed: false,
          clientAttempts: { lt: 3 },
          lastError: { not: null },
        },
      ],
    },
  })

  return count > 0
}

async function main() {
  console.log('[WORKER] Initializing video processing worker...')

  if (DEBUG) {
    console.log('[WORKER DEBUG] Debug mode is ENABLED')
    console.log('[WORKER DEBUG] Node version:', process.version)
    console.log('[WORKER DEBUG] Platform:', process.platform)
    console.log('[WORKER DEBUG] Architecture:', process.arch)
    console.log('[WORKER DEBUG] Memory:', {
      total: (os.totalmem() / 1024 / 1024 / 1024).toFixed(2) + ' GB',
      free: (os.freemem() / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    })
  }

  // Ensure temp directory exists
  ensureTempDir()

  // Initialize storage
  if (DEBUG) {
    console.log('[WORKER DEBUG] Initializing storage...')
  }

  await initStorage()

  if (DEBUG) {
    console.log('[WORKER DEBUG] Storage initialized')
  }

  // Calculate optimal concurrency based on available CPU cores
  const cpuCores = os.cpus().length
  let concurrency = 2
  if (cpuCores <= 4) {
    concurrency = 1
  } else if (cpuCores <= 8) {
    concurrency = 2
  } else {
    concurrency = 3
  }

  console.log(`[WORKER] Worker concurrency: ${concurrency} (based on ${cpuCores} CPU cores)`)

  if (DEBUG) {
    console.log('[WORKER DEBUG] CPU details:', {
      cores: cpuCores,
      model: os.cpus()[0]?.model || 'Unknown',
      concurrency
    })
  }

  const worker = new Worker<VideoProcessingJob>('video-processing', processVideo, {
    connection: getRedisForQueue(),
    concurrency,
    limiter: {
      max: concurrency * 10,
      duration: 60000,
    },
  })

  if (DEBUG) {
    console.log('[WORKER DEBUG] BullMQ worker created with config:', {
      queue: 'video-processing',
      concurrency,
      limiter: {
        max: concurrency * 10,
        duration: 60000
      }
    })
  }

  worker.on('completed', (job) => {
    console.log(`[WORKER] Job ${job.id} completed successfully`)
  })

  worker.on('failed', (job, err) => {
    console.error(`[WORKER ERROR] Job ${job?.id} failed:`, err)
    if (DEBUG) {
      console.error('[WORKER DEBUG] Job failure details:', {
        jobId: job?.id,
        jobData: job?.data,
        error: err instanceof Error ? err.stack : err
      })
    }
  })

  console.log('[WORKER] Video processing worker started')

  // Create asset processing worker
  const assetWorker = new Worker<AssetProcessingJob>('asset-processing', processAsset, {
    connection: getRedisForQueue(),
    concurrency: concurrency * 2, // Assets are lighter than videos
  })

  assetWorker.on('completed', (job) => {
    console.log(`[WORKER] Asset job ${job.id} completed successfully`)
  })

  assetWorker.on('failed', (job, err) => {
    console.error(`[WORKER ERROR] Asset job ${job?.id} failed:`, err)
    if (DEBUG) {
      console.error('[WORKER DEBUG] Asset job failure details:', {
        jobId: job?.id,
        jobData: job?.data,
        error: err instanceof Error ? err.stack : err
      })
    }
  })

  console.log('[WORKER] Asset processing worker started')

  // Create client file processing worker
  const clientFileWorker = new Worker<ClientFileProcessingJob>('client-file-processing', processClientFile, {
    connection: getRedisForQueue(),
    concurrency: concurrency * 2,
  })

  clientFileWorker.on('completed', (job) => {
    console.log(`[WORKER] Client file job ${job.id} completed successfully`)
  })

  clientFileWorker.on('failed', (job, err) => {
    console.error(`[WORKER ERROR] Client file job ${job?.id} failed:`, err)
    if (DEBUG) {
      console.error('[WORKER DEBUG] Client file job failure details:', {
        jobId: job?.id,
        jobData: job?.data,
        error: err instanceof Error ? err.stack : err,
      })
    }
  })

  console.log('[WORKER] Client file processing worker started')

  // Create project file processing worker
  const projectFileWorker = new Worker<ProjectFileProcessingJob>('project-file-processing', processProjectFile, {
    connection: getRedisForQueue(),
    concurrency: concurrency * 2,
  })

  projectFileWorker.on('completed', (job) => {
    console.log(`[WORKER] Project file job ${job.id} completed successfully`)
  })

  projectFileWorker.on('failed', (job, err) => {
    console.error(`[WORKER ERROR] Project file job ${job?.id} failed:`, err)
    if (DEBUG) {
      console.error('[WORKER DEBUG] Project file job failure details:', {
        jobId: job?.id,
        jobData: job?.data,
        error: err instanceof Error ? err.stack : err,
      })
    }
  })

  console.log('[WORKER] Project file processing worker started')

  // Create notification processing queue with repeatable job
  console.log('Setting up notification processing...')
  const notificationQueue = new Queue('notification-processing', {
    connection: getRedisForQueue(),
  })

  // Clean up any existing repeatable notification processor jobs (e.g. old every-minute schedule)
  try {
    const repeatables = await notificationQueue.getRepeatableJobs()
    const toRemove = repeatables.filter(
      (job) => job.name === 'process-notifications' || job.pattern === '* * * * *'
    )

    for (const job of toRemove) {
      await notificationQueue.removeRepeatableByKey(job.key)
    }

    if (toRemove.length > 0) {
      console.log(`Removed ${toRemove.length} existing repeatable notification processor job(s)`)
    }

    const remaining = await notificationQueue.getRepeatableJobs()
    if (remaining.length > 0) {
      console.log(
        'Remaining repeatable notification-processing jobs:',
        remaining.map((j) => ({ name: j.name, pattern: j.pattern, key: j.key }))
      )
    }
  } catch (e) {
    console.warn('Failed to clean up repeatable notification jobs (continuing):', e)
  }

  // Add repeatable job to check notification schedules on the hour
  await notificationQueue.add(
    'process-notifications',
    {},
    {
      repeat: {
        pattern: '0 * * * *',
      },
      jobId: 'notification-processor',
    }
  )

  // Add repeatable daily job to auto-close approved projects (if enabled)
  await notificationQueue.add(
    'auto-close-approved-projects',
    {},
    {
      repeat: {
        pattern: '5 0 * * *',
      },
      jobId: 'auto-close-approved-projects',
    }
  )

  // Create worker to process notification jobs
  const notificationWorker = new Worker(
    'notification-processing',
    async (job) => {
      if (job.name === 'auto-close-approved-projects') {
        console.log('Running scheduled auto-close check...')
        const result = await processAutoCloseApprovedProjects()
        console.log(`Auto-close check completed (closed=${result.closedCount})`)
        return
      }

      console.log('Running scheduled notification check...')

      await Promise.all([
        processAdminNotifications(),
        processClientNotifications(),
      ])

      console.log('Notification check completed')

      // Fast retry: only schedule a retry when there are failures and remaining attempts.
      // This keeps the normal cadence hourly, but recovers quickly from transient SMTP/DNS issues.
      if (await hasRetriableNotificationFailures()) {
        try {
          await notificationQueue.add(
            'process-notifications-retry',
            {},
            {
              delay: NOTIFICATION_RETRY_DELAY_MS,
              jobId: 'notification-processor-retry',
              removeOnComplete: true,
              removeOnFail: true,
            }
          )
          console.log(`Scheduled notification retry in ${Math.round(NOTIFICATION_RETRY_DELAY_MS / 60000)} minutes`)
        } catch {
          // Ignore duplicate scheduling (retry job already queued)
        }
      }
    },
    {
      connection: getRedisForQueue(),
      concurrency: 1,
    }
  )

  notificationWorker.on('completed', (job) => {
    console.log(`Notification check ${job.id} completed`)
  })

  notificationWorker.on('failed', (job, err) => {
    console.error(`Notification check ${job?.id} failed:`, err)
  })

  console.log('Notification worker started')
  console.log('  → Checks on the hour for scheduled summaries')
  console.log('  → Retries every 2 minutes when sends fail (max 3 attempts)')
  console.log('  → IMMEDIATE notifications sent instantly (not in batches)')

  // Run cleanup on startup
  console.log('Running initial TUS upload cleanup...')
  await runCleanup().catch((err) => {
    console.error('Initial cleanup failed:', err)
  })

  // Cleanup old temp files on startup
  console.log('Running initial temp file cleanup...')
  await cleanupOldTempFiles()

  // Schedule periodic cleanup every 6 hours (TUS uploads)
  const tusCleanupInterval = setInterval(async () => {
    console.log('Running scheduled TUS upload cleanup...')
    await runCleanup().catch((err) => {
      console.error('Scheduled cleanup failed:', err)
    })
  }, SIX_HOURS_MS)

  // Schedule temp file cleanup every hour
  const tempCleanupInterval = setInterval(async () => {
    console.log('Running scheduled temp file cleanup...')
    await cleanupOldTempFiles()
  }, ONE_HOUR_MS)

  // Handle shutdown gracefully
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing workers...')
    clearInterval(tusCleanupInterval)
    clearInterval(tempCleanupInterval)
    await Promise.all([
      worker.close(),
      assetWorker.close(),
      notificationWorker.close(),
      notificationQueue.close(),
    ])
    await closeRedisConnection()
    console.log('Redis connection closed')
    process.exit(0)
  })

  process.on('SIGINT', async () => {
    console.log('SIGINT received, closing workers...')
    clearInterval(tusCleanupInterval)
    clearInterval(tempCleanupInterval)
    await Promise.all([
      worker.close(),
      assetWorker.close(),
      notificationWorker.close(),
      notificationQueue.close(),
    ])
    await closeRedisConnection()
    console.log('Redis connection closed')
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('Worker error:', err)
  process.exit(1)
})
