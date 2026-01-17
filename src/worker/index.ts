import { Worker, Queue } from 'bullmq'
import { VideoProcessingJob, AssetProcessingJob, ClientFileProcessingJob, ProjectFileProcessingJob, ProjectEmailProcessingJob, AlbumPhotoSocialJob, AlbumPhotoZipJob } from '../lib/queue'
import { initStorage } from '../lib/storage'
import { runCleanup } from '../lib/upload-cleanup'
import { getRedisForQueue, closeRedisConnection } from '../lib/redis'
import { prisma } from '../lib/db'
import os from 'os'
import { processVideo } from './video-processor'
import { processAsset } from './asset-processor'
import { processClientFile } from './client-file-processor'
import { processProjectFile } from './project-file-processor'
import { processProjectEmail } from './project-email-processor'
import { processAlbumPhotoSocial } from './album-photo-social-processor'
import { processAlbumPhotoZip } from './album-photo-zip-processor'
import { processAdminNotifications } from './admin-notifications'
import { processClientNotifications } from './client-notifications'
import { processInternalCommentNotifications } from './internal-comment-notifications'
import { cleanupOldTempFiles, ensureTempDir } from './cleanup'
import { refreshQuickBooksAccessToken } from '@/lib/quickbooks/qbo'
import { processAutoCloseApprovedProjects } from './auto-close-projects'
import { processProjectKeyDateReminders } from './project-key-date-reminders'
import { processUserKeyDateReminders } from './user-key-date-reminders'
import { processSalesReminders } from './sales-reminders'
import { getQuickBooksDailyPullSettings, parseDailyTimeToCronPattern, recordQuickBooksDailyPullAttempt } from '@/lib/quickbooks/integration-settings'
import { runQuickBooksDailyPull } from '@/lib/quickbooks/daily-pull-runner'

const DEBUG = process.env.DEBUG_WORKER === 'true'
const ONE_HOUR_MS = 60 * 60 * 1000
const SIX_HOURS_MS = 6 * 60 * 60 * 1000
const NOTIFICATION_RETRY_DELAY_MS = 2 * 60 * 1000

async function hasRetriableNotificationFailures(): Promise<boolean> {
  const count = await prisma.notificationQueue.count({
    where: {
      OR: [
        {
          type: { in: ['CLIENT_COMMENT', 'INTERNAL_COMMENT'] },
          sentToAdmins: false,
          adminFailed: false,
          adminAttempts: { lt: 3 },
          lastError: { not: null },
        },
        {
          type: 'ADMIN_REPLY',
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

  // Create project email processing worker
  const projectEmailWorker = new Worker<ProjectEmailProcessingJob>('project-email-processing', processProjectEmail, {
    connection: getRedisForQueue(),
    concurrency: Math.max(1, concurrency * 2),
  })

  projectEmailWorker.on('completed', (job) => {
    console.log(`[WORKER] Project email job ${job.id} completed successfully`)
  })

  projectEmailWorker.on('failed', (job, err) => {
    console.error(`[WORKER ERROR] Project email job ${job?.id} failed:`, err)
    if (DEBUG) {
      console.error('[WORKER DEBUG] Project email job failure details:', {
        jobId: job?.id,
        jobData: job?.data,
        error: err instanceof Error ? err.stack : err,
      })
    }
  })

  console.log('[WORKER] Project email processing worker started')

  // Create album photo social derivative worker
  const albumPhotoSocialWorker = new Worker<AlbumPhotoSocialJob>('album-photo-social', processAlbumPhotoSocial, {
    connection: getRedisForQueue(),
    // Image resizes can be CPU-intensive; keep this modest.
    concurrency: Math.max(1, concurrency),
  })

  albumPhotoSocialWorker.on('completed', (job) => {
    console.log(`[WORKER] Album photo social job ${job.id} completed successfully`)
  })

  albumPhotoSocialWorker.on('failed', (job, err) => {
    console.error(`[WORKER ERROR] Album photo social job ${job?.id} failed:`, err)
    if (DEBUG) {
      console.error('[WORKER DEBUG] Album photo social job failure details:', {
        jobId: job?.id,
        jobData: job?.data,
        error: err instanceof Error ? err.stack : err,
      })
    }
  })

  console.log('[WORKER] Album photo social derivative worker started')

  // Create album photo ZIP generation worker
  const albumPhotoZipWorker = new Worker<AlbumPhotoZipJob>('album-photo-zip', processAlbumPhotoZip, {
    connection: getRedisForQueue(),
    // ZIP creation is mostly I/O; keep modest.
    concurrency: Math.max(1, concurrency),
  })

  albumPhotoZipWorker.on('completed', (job) => {
    console.log(`[WORKER] Album photo ZIP job ${job.id} completed successfully`)
  })

  albumPhotoZipWorker.on('failed', (job, err) => {
    console.error(`[WORKER ERROR] Album photo ZIP job ${job?.id} failed:`, err)
    if (DEBUG) {
      console.error('[WORKER DEBUG] Album photo ZIP job failure details:', {
        jobId: job?.id,
        jobData: job?.data,
        error: err instanceof Error ? err.stack : err,
      })
    }
  })

  console.log('[WORKER] Album photo ZIP generation worker started')

  // Create notification processing queue with repeatable job
  console.log('Setting up notification processing...')
  const notificationQueue = new Queue('notification-processing', {
    connection: getRedisForQueue(),
  })

  // Clean up any existing repeatable notification processor jobs (e.g. old every-minute schedule)
  try {
    const repeatables = await notificationQueue.getRepeatableJobs()
    const toRemove = repeatables.filter((job) => {
      // Keep this targeted so we don't accidentally remove unrelated every-minute schedules.
      if (job.name === 'process-notifications') return true
      if (job.name === 'project-key-date-reminders') return true
      if (job.name === 'user-key-date-reminders') return true
      return false
    })

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

  // Key date reminders are set in 15-minute intervals.
  await notificationQueue.add(
    'project-key-date-reminders',
    {},
    {
      repeat: {
        pattern: '*/15 * * * *',
      },
      jobId: 'project-key-date-reminders',
      removeOnComplete: true,
      removeOnFail: true,
    }
  )

  await notificationQueue.add(
    'user-key-date-reminders',
    {},
    {
      repeat: {
        pattern: '*/15 * * * *',
      },
      jobId: 'user-key-date-reminders',
      removeOnComplete: true,
      removeOnFail: true,
    }
  )

  // Sales reminder emails (weekdays @ 9am server/container time)
  await notificationQueue.add(
    'sales-reminders',
    {},
    {
      repeat: {
        pattern: '0 9 * * 1-5',
      },
      jobId: 'sales-reminders',
      removeOnComplete: true,
      removeOnFail: true,
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

  // Add repeatable daily job to refresh QuickBooks token (if configured)
  // Runs at 03:15 server/container time (see TZ env var)
  await notificationQueue.add(
    'quickbooks-refresh-token',
    {},
    {
      repeat: {
        pattern: '15 3 * * *',
      },
      jobId: 'quickbooks-refresh-token',
      removeOnComplete: true,
      removeOnFail: true,
    }
  )

  // Add repeatable daily job to pull QuickBooks data (if enabled)
  // Note: Schedule is configurable via Sales > Settings > QuickBooks.
  // Runs at the configured HH:MM server/container time (see TZ env var).
  try {
    const repeatables = await notificationQueue.getRepeatableJobs()
    const toRemove = repeatables.filter((job) => job.name === 'quickbooks-daily-pull')
    for (const job of toRemove) {
      await notificationQueue.removeRepeatableByKey(job.key)
    }

    const qbSettings = await getQuickBooksDailyPullSettings()
    if (qbSettings.dailyPullEnabled) {
      const cron = parseDailyTimeToCronPattern(qbSettings.dailyPullTime)
      await notificationQueue.add(
        'quickbooks-daily-pull',
        {},
        {
          repeat: {
            pattern: cron.pattern,
          },
          jobId: 'quickbooks-daily-pull',
          removeOnComplete: true,
          removeOnFail: true,
        }
      )
      console.log('[QBO] Scheduled daily pull job', { time: qbSettings.dailyPullTime, pattern: cron.pattern })
    } else {
      console.log('[QBO] Daily pull disabled; job not scheduled')
    }
  } catch (e) {
    console.warn('[QBO] Failed to schedule daily pull job (continuing):', e instanceof Error ? e.message : e)
  }

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

      if (job.name === 'sales-reminders') {
        try {
          console.log('[SALES] Running scheduled sales reminders...')
          await processSalesReminders()
          console.log('[SALES] Sales reminders run completed')
        } catch (e) {
          console.warn('[SALES] Sales reminders failed (continuing):', e instanceof Error ? e.message : e)
        }
        return
      }

      if (job.name === 'quickbooks-refresh-token') {
        try {
          console.log('[QBO] Running scheduled token refresh...')
          const result = await refreshQuickBooksAccessToken()
          console.log('[QBO] Token refresh ok', {
            refreshTokenSource: result.refreshTokenSource,
            refreshTokenPersisted: result.refreshTokenPersisted,
            rotated: !!result.rotatedRefreshToken,
          })
        } catch (e) {
          // Non-fatal: integration is optional
          console.warn('[QBO] Token refresh skipped/failed:', e instanceof Error ? e.message : e)
        }
        return
      }

      if (job.name === 'quickbooks-daily-pull') {
        const attemptedAt = new Date()
        try {
          const qbSettings = await getQuickBooksDailyPullSettings()
          if (!qbSettings.dailyPullEnabled) {
            console.log('[QBO] Daily pull disabled; skipping run')
            return
          }

          console.log('[QBO] Running scheduled daily pull...', {
            time: qbSettings.dailyPullTime,
            lookbackDays: qbSettings.pullLookbackDays,
          })

          // Run the 4 pulls in order, spaced by 1 minute.
          // (This avoids bursts and gives QBO time between large pulls.)
          const pullResult = await runQuickBooksDailyPull(qbSettings.pullLookbackDays, { sleepBetweenStepsMs: 60 * 1000 })
          if (!pullResult.ok) {
            await recordQuickBooksDailyPullAttempt({ attemptedAt, succeeded: false, message: pullResult.message })
            console.warn('[QBO] Daily pull failed:', pullResult.message)
            return
          }

          await recordQuickBooksDailyPullAttempt({
            attemptedAt,
            succeeded: true,
            message: pullResult.message,
          })
          console.log('[QBO] Daily pull ok', { message: pullResult.message })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          await recordQuickBooksDailyPullAttempt({ attemptedAt, succeeded: false, message: msg })
          console.warn('[QBO] Daily pull errored:', msg)
        }
        return
      }

      if (job.name === 'project-key-date-reminders') {
        await processProjectKeyDateReminders()
        return
      }

      if (job.name === 'user-key-date-reminders') {
        await processUserKeyDateReminders()
        return
      }

      const [pendingAdminCommentSummaries, pendingClientSummaries, pendingInternalCommentSummaries] =
        await Promise.all([
          prisma.notificationQueue.count({
            where: {
              type: 'CLIENT_COMMENT',
              sentToAdmins: false,
              adminFailed: false,
              adminAttempts: { lt: 3 },
            },
          }),
          prisma.notificationQueue.count({
            where: {
              type: 'ADMIN_REPLY',
              sentToClients: false,
              clientFailed: false,
              clientAttempts: { lt: 3 },
            },
          }),
          prisma.notificationQueue.count({
            where: {
              type: 'INTERNAL_COMMENT',
              sentToAdmins: false,
              adminFailed: false,
              adminAttempts: { lt: 3 },
            },
          }),
        ])

      console.log(
        `Running scheduled notification check... (adminComment=${pendingAdminCommentSummaries}, client=${pendingClientSummaries}, internalComment=${pendingInternalCommentSummaries})`
      )

      await Promise.all([
        processAdminNotifications(),
        processClientNotifications(),
        processInternalCommentNotifications(),
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
      albumPhotoSocialWorker.close(),
      albumPhotoZipWorker.close(),
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
      albumPhotoSocialWorker.close(),
      albumPhotoZipWorker.close(),
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
