import { Worker, Queue } from 'bullmq'
import { VideoProcessingJob, AssetProcessingJob, ClientFileProcessingJob, UserFileProcessingJob, ProjectFileProcessingJob, ProjectEmailProcessingJob, AlbumPhotoSocialJob, AlbumPhotoThumbnailJob, AlbumPhotoZipJob, FolderRenameJobPayload, ShareUploadPreviewJob, AssetTimelineJob, UploadTimelineJob, PasswordEmailJob } from '../lib/queue'
import { initStorage } from '../lib/storage'
import { runCleanup } from '../lib/upload-cleanup'
import { getRedisForQueue, closeRedisConnection, getRedis } from '../lib/redis'
import { prisma } from '../lib/db'
import os from 'os'
import { getCpuAllocation, logCpuAllocation, loadCpuConfigOverrides } from '../lib/cpu-config'
import { processVideo } from './video-processor'
import { processAsset } from './asset-processor'
import { processClientFile } from './client-file-processor'
import { processUserFile } from './user-file-processor'
import { processProjectFile } from './project-file-processor'
import { processProjectEmail } from './project-email-processor'
import { processAlbumPhotoSocial } from './album-photo-social-processor'
import { processAlbumPhotoThumbnail } from './album-photo-thumbnail-processor'
import { processAlbumPhotoZip } from './album-photo-zip-processor'
import { processPasswordEmail } from './password-email-processor'
import { processFolderRename } from './folder-rename-processor'
import { processShareUploadPreview, reconcileShareUploadPreviews } from './share-upload-preview-processor'
import { processAdminNotifications } from './admin-notifications'
import { processClientNotifications } from './client-notifications'
import { processInternalCommentNotifications } from './internal-comment-notifications'
import { processTaskCommentNotifications } from './task-comment-notifications'
import { cleanupOldTempFiles, ensureTempDir } from './cleanup'
import { cleanupStaleTrackedDownloads } from '@/lib/download-tracking'
import { processAutoCloseApprovedProjects } from './auto-close-projects'
import { processProjectKeyDateReminders } from './project-key-date-reminders'
import { processUserKeyDateReminders } from './user-key-date-reminders'
import { processSalesReminders } from './sales-reminders'
import { processAutoStartProjectsOnShootingKeyDate } from './auto-start-projects-on-shooting'
import { reconcileAllProjectsStorageTotals } from '@/lib/project-total-bytes'
import { reconcileAccountingFilesBytes } from '@/lib/accounting/file-storage'
import { cleanupProjectStorageOrphans } from '@/lib/project-storage-orphan-cleanup'
import { findDanglingStoredFiles, deleteStoredFilesByIds } from '@/lib/stored-file'
import { upsertOrphanProjectFilesScanNotification, clearOrphanProjectFilesScanNotifications } from '@/lib/orphan-project-files-notification'
import { PINNED_SYSTEM_NOTIFICATION_TYPES } from '@/lib/pinned-system-notifications'
import { processAccountingReminders } from '@/lib/accounting-reminders'
import { isS3Mode, s3AbortIncompleteMultipartUploadsOlderThan } from '@/lib/s3-storage'
import { runS3LocalBackup, getS3LocalBackupSettings, formatBackupResultSummary } from '@/lib/s3-local-backup'
import { upsertS3BackupFailureNotification } from '@/lib/s3-backup-failure-notifications'

const DEBUG = process.env.DEBUG_WORKER === 'true'
const ONE_HOUR_MS = 60 * 60 * 1000
const SIX_HOURS_MS = 6 * 60 * 60 * 1000
const NOTIFICATION_RETRY_DELAY_MS = 2 * 60 * 1000

async function hasRetriableNotificationFailures(): Promise<boolean> {
  const count = await prisma.notificationQueue.count({
    where: {
      OR: [
        {
          type: { in: ['CLIENT_COMMENT', 'INTERNAL_COMMENT', 'TASK_COMMENT'] },
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

  // Load Redis-backed CPU overrides before computing allocation.
  await loadCpuConfigOverrides(getRedis())

  // Centralized CPU allocation coordinates worker concurrency with FFmpeg thread usage.
  const cpuAllocation = getCpuAllocation()
  logCpuAllocation(cpuAllocation)

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

  // Use centralized allocation for video worker concurrency.
  const concurrency = cpuAllocation.videoWorkerConcurrency

  console.log(`[WORKER] Video worker concurrency: ${concurrency} (from CPU allocation)`)

  if (DEBUG) {
    console.log('[WORKER DEBUG] CPU details:', {
      threads: cpuAllocation.effectiveThreads,
      model: os.cpus()[0]?.model || 'Unknown',
      concurrency
    })
  }

  // Large videos (multi-GB, 60+ min) can transcode for a very long time.
  // Use a generous lockDuration so BullMQ doesn't prematurely declare the job
  // stalled while FFmpeg is still running.  Auto-renewal fires every
  // lockDuration / 2 (= 5 min).  stalledInterval controls how often *other*
  // workers check for stalled jobs; maxStalledCount limits restart loops.
  const LOCK_DURATION_MS = 10 * 60 * 1000      // 10 minutes
  const STALLED_INTERVAL_MS = 5 * 60 * 1000     // 5 minutes
  const MAX_STALLED_COUNT = 2

  const worker = new Worker<VideoProcessingJob>('video-processing', processVideo, {
    connection: getRedisForQueue(),
    concurrency,
    lockDuration: LOCK_DURATION_MS,
    stalledInterval: STALLED_INTERVAL_MS,
    maxStalledCount: MAX_STALLED_COUNT,
    limiter: {
      max: concurrency * 10,
      duration: 60000,
    },
  })

  if (DEBUG) {
    console.log('[WORKER DEBUG] BullMQ worker created with config:', {
      queue: 'video-processing',
      concurrency,
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: STALLED_INTERVAL_MS,
      maxStalledCount: MAX_STALLED_COUNT,
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

  // Create user file processing worker
  const userFileWorker = new Worker<UserFileProcessingJob>('user-file-processing', processUserFile, {
    connection: getRedisForQueue(),
    concurrency: concurrency * 2,
  })

  userFileWorker.on('completed', (job) => {
    console.log(`[WORKER] User file job ${job.id} completed successfully`)
  })

  userFileWorker.on('failed', (job, err) => {
    console.error(`[WORKER ERROR] User file job ${job?.id} failed:`, err)
    if (DEBUG) {
      console.error('[WORKER DEBUG] User file job failure details:', {
        jobId: job?.id,
        jobData: job?.data,
        error: err instanceof Error ? err.stack : err,
      })
    }
  })

  console.log('[WORKER] User file processing worker started')

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

  // Create album photo thumbnail derivative worker
  const albumPhotoThumbnailWorker = new Worker<AlbumPhotoThumbnailJob>('album-photo-thumbnail', processAlbumPhotoThumbnail, {
    connection: getRedisForQueue(),
    concurrency: Math.max(1, concurrency),
  })

  albumPhotoThumbnailWorker.on('completed', (job) => {
    console.log(`[WORKER] Album photo thumbnail job ${job.id} completed successfully`)
  })

  albumPhotoThumbnailWorker.on('failed', (job, err) => {
    console.error(`[WORKER ERROR] Album photo thumbnail job ${job?.id} failed:`, err)
    if (DEBUG) {
      console.error('[WORKER DEBUG] Album photo thumbnail job failure details:', {
        jobId: job?.id,
        jobData: job?.data,
        error: err instanceof Error ? err.stack : err,
      })
    }
  })

  console.log('[WORKER] Album photo thumbnail derivative worker started')

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

  // Create password-email worker (staggered share-link password emails enqueued by the notify route)
  const passwordEmailWorker = new Worker<PasswordEmailJob>('password-email', processPasswordEmail, {
    connection: getRedisForQueue(),
    concurrency: 1,
  })

  passwordEmailWorker.on('completed', (job) => {
    console.log(`[WORKER] Password email job ${job.id} completed`)
  })

  passwordEmailWorker.on('failed', (job, err) => {
    console.error(`[WORKER ERROR] Password email job ${job?.id} failed:`, err)
  })

  console.log('[WORKER] Password email worker started')

  // Create folder rename worker (S3 copy + delete for project/client renames)
  const folderRenameWorker = new Worker<FolderRenameJobPayload>('folder-rename', processFolderRename, {
    connection: getRedisForQueue(),
    // Run one rename at a time to avoid saturating S3 bandwidth
    concurrency: 1,
    // Large renames can take many minutes — generous lock duration with auto-renewal
    lockDuration: 10 * 60 * 1000,
    stalledInterval: 5 * 60 * 1000,
    maxStalledCount: 1,
  })

  folderRenameWorker.on('completed', (job) => {
    console.log(`[WORKER] Folder rename job ${job.id} completed successfully`)
  })

  folderRenameWorker.on('failed', (job, err) => {
    console.error(`[WORKER ERROR] Folder rename job ${job?.id} failed:`, err)
  })

  console.log('[WORKER] Folder rename worker started')

  // Create share-upload preview worker
  const shareUploadPreviewWorker = new Worker<ShareUploadPreviewJob>('share-upload-preview', processShareUploadPreview, {
    connection: getRedisForQueue(),
    concurrency: Math.max(1, concurrency),
  })

  shareUploadPreviewWorker.on('completed', (job) => {
    console.log(`[WORKER] Share upload preview job ${job.id} completed successfully`)
  })

  shareUploadPreviewWorker.on('failed', (job, err) => {
    console.error(`[WORKER ERROR] Share upload preview job ${job?.id} failed:`, err instanceof Error ? err.message : err)
  })

  console.log('[WORKER] Share upload preview worker started')

  // Create asset-timeline worker
  const { processAssetTimeline } = await import('./asset-upload-timeline-processor')
  const assetTimelineWorker = new Worker<AssetTimelineJob>('asset-timeline', processAssetTimeline, {
    connection: getRedisForQueue(),
    concurrency: Math.max(1, concurrency),
  })
  assetTimelineWorker.on('completed', (job) => console.log(`[WORKER] Asset timeline job ${job.id} completed`))
  assetTimelineWorker.on('failed', (job, err) => console.error(`[WORKER ERROR] Asset timeline job ${job?.id} failed:`, err))
  console.log('[WORKER] Asset timeline worker started')

  // Create upload-timeline worker
  const { processUploadTimeline } = await import('./asset-upload-timeline-processor')
  const uploadTimelineWorker = new Worker<UploadTimelineJob>('upload-timeline', processUploadTimeline, {
    connection: getRedisForQueue(),
    concurrency: Math.max(1, concurrency),
  })
  uploadTimelineWorker.on('completed', (job) => console.log(`[WORKER] Upload timeline job ${job.id} completed`))
  uploadTimelineWorker.on('failed', (job, err) => console.error(`[WORKER ERROR] Upload timeline job ${job?.id} failed:`, err))
  console.log('[WORKER] Upload timeline worker started')

  // Create notification processing queue with repeatable job
  console.log('Setting up notification processing...')
  const notificationQueue = new Queue('notification-processing', {
    connection: getRedisForQueue(),
    defaultJobOptions: {
      removeOnComplete: {
        age: 3600, // keep completed jobs for 1 hour
      },
      removeOnFail: {
        age: 86400, // keep failed jobs for 24 hours
      },
    },
  })

  // Clean up any existing repeatable notification processor jobs (e.g. old every-minute schedule)
  try {
    const repeatables = await notificationQueue.getRepeatableJobs()
    const toRemove = repeatables.filter((job) => {
      // Keep this targeted so we don't accidentally remove unrelated every-minute schedules.
      if (job.name === 'process-notifications') return true
      if (job.name === 'project-key-date-reminders') return true
      if (job.name === 'user-key-date-reminders') return true
      if (job.name === 'auto-start-projects-on-shooting-key-date') return true
      if (job.name === 'orphan-project-files-scan') return true
      if (job.name === 'notification-log-cleanup') return true
      if (job.name === 'accounting-reminders') return true
      if (job.name === 'quickbooks-refresh-token') return true
      if (job.name === 's3-multipart-cleanup') return true
      if (job.name === 'share-upload-preview-reconcile') return true
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
      removeOnComplete: true,
      removeOnFail: true,
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

  // Auto-start projects when Start Date is due or a SHOOTING key date begins.
  await notificationQueue.add(
    'auto-start-projects-on-shooting-key-date',
    {},
    {
      repeat: {
        pattern: '*/15 * * * *',
      },
      jobId: 'auto-start-projects-on-shooting-key-date',
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
      removeOnComplete: true,
      removeOnFail: true,
    }
  )

  // Reconcile derived Project.totalBytes + Project.diskBytes (daily @ 04:30 server/container time)
  await notificationQueue.add(
    'reconcile-project-total-bytes',
    {},
    {
      repeat: {
        pattern: '30 4 * * *',
      },
      jobId: 'reconcile-project-total-bytes',
      removeOnComplete: true,
      removeOnFail: true,
    }
  )

  // S3 multipart upload cleanup — abort incomplete uploads older than 24 hours (daily @ 05:00)
  // Prevents orphaned multipart parts from accumulating storage costs on R2/S3.
  if (isS3Mode()) {
    await notificationQueue.add(
      's3-multipart-cleanup',
      {},
      {
        repeat: {
          pattern: '0 5 * * *',
        },
        jobId: 's3-multipart-cleanup',
        removeOnComplete: true,
        removeOnFail: true,
      }
    )

    // S3 local backup — daily @ 22:00 (runs only when enabled in settings)
    await notificationQueue.add(
      's3-local-backup',
      {},
      {
        repeat: {
          pattern: '0 22 * * *',
        },
        jobId: 's3-local-backup',
        removeOnComplete: true,
        removeOnFail: true,
      }
    )
  }

  // Orphan project files scan (weekly on Sunday at 03:00 server/container time)
  await notificationQueue.add(
    'orphan-project-files-scan',
    {},
    {
      repeat: {
        pattern: '0 3 * * 0',
      },
      jobId: 'orphan-project-files-scan',
      removeOnComplete: true,
      removeOnFail: true,
    }
  )

  // Notification log cleanup — purge PushNotificationLog entries older than 45 days (daily @ 02:30)
  await notificationQueue.add(
    'notification-log-cleanup',
    {},
    {
      repeat: {
        pattern: '30 2 * * *',
      },
      jobId: 'notification-log-cleanup',
      removeOnComplete: true,
      removeOnFail: true,
    }
  )

  // Share upload preview reconcile — hourly scan for files missing previews
  await notificationQueue.add(
    'share-upload-preview-reconcile',
    {},
    {
      repeat: {
        pattern: '0 * * * *',
      },
      jobId: 'share-upload-preview-reconcile',
      removeOnComplete: true,
      removeOnFail: true,
    }
  )

  // Accounting reminders — vehicle odometer (1 Jul) and BAS due dates (daily @ 08:30)
  await notificationQueue.add(
    'accounting-reminders',
    {},
    {
      repeat: {
        pattern: '30 8 * * *',
      },
      jobId: 'accounting-reminders',
      removeOnComplete: true,
      removeOnFail: true,
    }
  )

  // QuickBooks integration removed: purge any stale 'quickbooks-daily-pull'
  // repeatable left over in Redis from previous versions.
  try {
    const repeatables = await notificationQueue.getRepeatableJobs()
    const toRemove = repeatables.filter((job) => job.name === 'quickbooks-daily-pull')
    for (const job of toRemove) {
      await notificationQueue.removeRepeatableByKey(job.key)
    }
  } catch (e) {
    console.warn('[worker] Failed to purge stale quickbooks-daily-pull job (continuing):', e instanceof Error ? e.message : e)
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

      if (job.name === 'reconcile-project-total-bytes') {
        console.log('[TOTALS] Running scheduled project totalBytes + diskBytes reconciliation...')
        const [result, accountingBytes] = await Promise.all([
          reconcileAllProjectsStorageTotals(),
          reconcileAccountingFilesBytes().catch((e) => {
            console.warn('[TOTALS] Failed to reconcile accounting file bytes (continuing):', e instanceof Error ? e.message : e)
            return BigInt(0)
          }),
        ])
        console.log('[TOTALS] Reconciliation completed', { ...result, accountingFilesBytes: accountingBytes.toString() })
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

      if (job.name === 'orphan-project-files-scan') {
        try {
          // Self-heal dangling StoredFile rows (owning entity already deleted) before the
          // file scan. These are unambiguous garbage — pruning them daily keeps them from
          // accumulating and from masquerading as "missing files" in the scan below.
          const dangling = await findDanglingStoredFiles()
          if (dangling.length > 0) {
            const pruned = await deleteStoredFilesByIds(dangling.map((r) => r.id))
            console.log(`[CONSISTENCY] Pruned ${pruned} dangling StoredFile row(s) (entity no longer exists)`)
          }

          console.log('[CONSISTENCY] Running scheduled storage integrity scan (dry run)...')
          const result = await cleanupProjectStorageOrphans(true)
          const scanFailed = result.missingFiles < 0
          const hasIssues = result.orphanFiles > 0 || result.missingFiles > 0
          if (scanFailed) {
            // S3 listing failed — keep any existing notification and log the failure.
            // Don't clear the old notification; the admin needs to see this is broken.
            await upsertOrphanProjectFilesScanNotification(result, new Date().toISOString())
            console.warn(`[CONSISTENCY] Storage integrity scan failed: S3 listing error (see errors array). Keeping existing notification.`)
          } else if (hasIssues) {
            await upsertOrphanProjectFilesScanNotification(result, new Date().toISOString())
            console.log(`[CONSISTENCY] Storage integrity scan completed: ${result.orphanFiles} orphan files, ${result.missingFiles} missing files`)
          } else {
            await clearOrphanProjectFilesScanNotifications()
            console.log('[CONSISTENCY] Storage integrity scan completed: no issues found')
          }
        } catch (e) {
          console.error('[CONSISTENCY] Orphan project files scan failed:', e instanceof Error ? e.message : e)
        }
        return
      }

      if (job.name === 'notification-log-cleanup') {
        try {
          const cutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000)
          const result = await prisma.pushNotificationLog.deleteMany({
            where: {
              sentAt: { lt: cutoff },
              type: { notIn: PINNED_SYSTEM_NOTIFICATION_TYPES as unknown as string[] },
            },
          })
          if (result.count > 0) {
            console.log(`[NOTIF-CLEANUP] Deleted ${result.count} notification log entries older than 45 days`)
          }
        } catch (e) {
          console.error('[NOTIF-CLEANUP] Notification log cleanup failed:', e instanceof Error ? e.message : e)
        }
        return
      }

      if (job.name === 's3-multipart-cleanup') {
        try {
          const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000
          // Abort any upload older than 24 h across the whole bucket (empty prefix)
          const aborted = await s3AbortIncompleteMultipartUploadsOlderThan('', TWENTY_FOUR_HOURS_MS)
          if (aborted > 0) {
            console.log(`[S3-CLEANUP] Aborted ${aborted} incomplete multipart upload(s) older than 24 h`)
          }
        } catch (e) {
          console.error('[S3-CLEANUP] Multipart upload cleanup failed:', e instanceof Error ? e.message : e)
        }
        return
      }

      if (job.name === 's3-local-backup') {
        try {
          const backupSettings = await getS3LocalBackupSettings()
          if (!backupSettings?.enabled) {
            // Silently skip — backup is not enabled
            return
          }
          if (backupSettings.categories.length === 0) {
            console.log('[S3-BACKUP] No categories configured; skipping scheduled backup run')
            return
          }
          if (backupSettings.running) {
            console.log('[S3-BACKUP] Backup already in progress; skipping scheduled run')
            return
          }

          console.log(`[S3-BACKUP] Starting scheduled backup (categories: ${backupSettings.categories.join(', ')})`)
          await prisma.settings.update({ where: { id: 'default' }, data: { s3LocalBackupRunning: true } })

          try {
            const result = await runS3LocalBackup(backupSettings.categories)
            const summary = formatBackupResultSummary(result)
            await prisma.settings.update({
              where: { id: 'default' },
              data: {
                s3LocalBackupLastRunAt: new Date(),
                s3LocalBackupLastRunResult: summary,
                s3LocalBackupRunning: false,
              },
            })
            console.log(`[S3-BACKUP] ${summary}`)
            // If any files failed, create a pinned notification + push
            if (!result.ok && result.failed > 0) {
              const errorSummary = result.errors.slice(0, 3).join('; ') || 'Unknown error'
              upsertS3BackupFailureNotification(`${result.failed} file(s) failed. ${errorSummary}`).catch(() => {})
            }
          } catch (innerErr) {
            const msg = innerErr instanceof Error ? innerErr.message : String(innerErr)
            await prisma.settings.update({
              where: { id: 'default' },
              data: { s3LocalBackupLastRunResult: `Error: ${msg}`, s3LocalBackupRunning: false },
            }).catch(() => {})
            upsertS3BackupFailureNotification(msg).catch(() => {})
            throw innerErr
          }
        } catch (e) {
          console.error('[S3-BACKUP] Scheduled backup failed:', e instanceof Error ? e.message : e)
        }
        return
      }

      if (job.name === 'accounting-reminders') {
        try {
          await processAccountingReminders(new Date())
        } catch (e) {
          console.error('[ACCOUNTING] Accounting reminders failed:', e instanceof Error ? e.message : e)
        }
        return
      }

      if (job.name === 'share-upload-preview-reconcile') {
        try {
          const result = await reconcileShareUploadPreviews()
          if (result.queued > 0) {
            console.log(`[PREVIEW-RECONCILE] Queued ${result.queued} preview job(s)`)
          }
        } catch (e) {
          console.error('[PREVIEW-RECONCILE] Reconciliation failed:', e instanceof Error ? e.message : e)
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

      if (job.name === 'auto-start-projects-on-shooting-key-date') {
        try {
          const result = await processAutoStartProjectsOnShootingKeyDate()
          if (result.startedCount > 0) {
            console.log(`[AUTO-START] Completed (started=${result.startedCount})`)
          }
        } catch (e) {
          console.warn('[AUTO-START] Failed (continuing):', e instanceof Error ? e.message : e)
        }
        return
      }

      const [pendingAdminCommentSummaries, pendingClientSummaries, pendingInternalCommentSummaries, pendingTaskCommentSummaries] =
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
          prisma.notificationQueue.count({
            where: {
              type: 'TASK_COMMENT',
              sentToAdmins: false,
              adminFailed: false,
              adminAttempts: { lt: 3 },
            },
          }),
        ])

      console.log(
        `Running scheduled notification check... (adminComment=${pendingAdminCommentSummaries}, client=${pendingClientSummaries}, internalComment=${pendingInternalCommentSummaries}, taskComment=${pendingTaskCommentSummaries})`
      )

      await Promise.all([
        processAdminNotifications(),
        processClientNotifications(),
        processInternalCommentNotifications(),
        processTaskCommentNotifications(),
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

  const getNotificationWorkerJobLabel = (name?: string) => {
    if (name === 'project-key-date-reminders') return 'Project Key Date reminders check'
    if (name === 'user-key-date-reminders') return 'User Key Date reminders check'
    if (name === 'auto-start-projects-on-shooting-key-date') return 'Auto-start on SHOOTING key date check'
    if (name === 'process-notifications' || name === 'process-notifications-retry') return 'Notification check'
    return name || 'Job'
  }

  notificationWorker.on('completed', (job) => {
    const label = getNotificationWorkerJobLabel(job.name)

    console.log(`${label} ${job.id} completed`)
  })

  notificationWorker.on('failed', (job, err) => {
    const label = getNotificationWorkerJobLabel(job?.name)

    console.error(`${label} ${job?.id} failed:`, err)
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

  const downloadCleanupInterval = setInterval(async () => {
    const cleaned = await cleanupStaleTrackedDownloads().catch((error) => {
      console.error('Scheduled download tracking cleanup failed:', error)
      return 0
    })

    if (cleaned > 0) {
      console.log(`[DOWNLOAD] Marked ${cleaned} stale download(s) as failed`)
    }
  }, 60 * 1000)

  // Periodically refresh Redis-backed CPU overrides so admin changes take
  // effect without a container restart (threads per job only; concurrency
  // changes still require restart).
  const cpuConfigRefreshInterval = setInterval(async () => {
    await loadCpuConfigOverrides(getRedis()).catch(() => undefined)
  }, 60 * 1000)

  // Handle shutdown gracefully
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing workers...')
    clearInterval(tusCleanupInterval)
    clearInterval(tempCleanupInterval)
    clearInterval(downloadCleanupInterval)
    clearInterval(cpuConfigRefreshInterval)
    await Promise.all([
      worker.close(),
      assetWorker.close(),
      albumPhotoSocialWorker.close(),
      albumPhotoZipWorker.close(),
      passwordEmailWorker.close(),
      shareUploadPreviewWorker.close(),
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
    clearInterval(downloadCleanupInterval)
    clearInterval(cpuConfigRefreshInterval)
    await Promise.all([
      worker.close(),
      assetWorker.close(),
      albumPhotoSocialWorker.close(),
      albumPhotoZipWorker.close(),
      passwordEmailWorker.close(),
      shareUploadPreviewWorker.close(),
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
