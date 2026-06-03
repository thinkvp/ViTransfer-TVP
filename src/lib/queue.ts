import { Queue, Worker, Job } from 'bullmq'
import { getRedisForQueue } from './redis'
import { prisma } from './db'

// Lazy initialization to prevent connections during build time
let videoQueueInstance: Queue<VideoProcessingJob> | null = null
let assetQueueInstance: Queue<AssetProcessingJob> | null = null
let clientFileQueueInstance: Queue<ClientFileProcessingJob> | null = null
let userFileQueueInstance: Queue<UserFileProcessingJob> | null = null
let projectFileQueueInstance: Queue<ProjectFileProcessingJob> | null = null
let projectEmailQueueInstance: Queue<ProjectEmailProcessingJob> | null = null
let albumPhotoSocialQueueInstance: Queue<AlbumPhotoSocialJob> | null = null
let albumPhotoThumbnailQueueInstance: Queue<AlbumPhotoThumbnailJob> | null = null
let albumPhotoZipQueueInstance: Queue<AlbumPhotoZipJob> | null = null
let folderRenameQueueInstance: Queue<FolderRenameJobPayload> | null = null
let shareUploadPreviewQueueInstance: Queue<ShareUploadPreviewJob> | null = null

export interface VideoProcessingJob {
  videoId: string
  originalStoragePath: string
  projectId: string
  /** When true, skip transcode/thumbnail and only generate timeline preview sprites. */
  timelineOnly?: boolean
  /** When true, regenerate only the thumbnail and leave previews/timeline assets untouched. */
  thumbnailOnly?: boolean
  /** Optional subset of preview resolutions to generate instead of the full configured set. */
  requestedPreviewResolutions?: Array<'480p' | '720p' | '1080p'>
  /** When false, keep the existing thumbnail instead of regenerating it. */
  regenerateThumbnail?: boolean
  /** When false, keep existing timeline preview assets untouched. */
  regenerateTimelinePreviews?: boolean
}

export interface AssetProcessingJob {
  assetId: string
  storagePath: string
  expectedCategory?: string
}

export interface ClientFileProcessingJob {
  clientFileId: string
  storagePath: string
  expectedCategory?: string
}

export interface UserFileProcessingJob {
  userFileId: string
  storagePath: string
  expectedCategory?: string
}

export interface ProjectFileProcessingJob {
  projectFileId: string
  storagePath: string
  expectedCategory?: string
}

export interface ProjectEmailProcessingJob {
  projectEmailId: string
  projectId: string
  rawStoragePath: string
}

export interface AlbumPhotoSocialJob {
  photoId: string
}

export interface AlbumPhotoThumbnailJob {
  albumThumbnailJobId: string
}

export interface AlbumPhotoZipJob {
  albumId: string
  variant: 'full' | 'social'
}

/** Payload for a background S3 folder rename job (copy + delete). */
export interface FolderRenameJobPayload {
  /** The FolderRenameJob DB record id. All state lives in DB, not BullMQ. */
  folderRenameJobId: string
}

/** Payload for a share-files preview generation job (image resize or video frame extract). */
export interface ShareUploadPreviewJob {
  /** 'shareUploadFile' for UPLOADS root files, 'videoAsset' for PROJECT root video assets */
  type: 'shareUploadFile' | 'videoAsset'
  recordId: string
  storagePath: string
  fileType: string
  fileName: string
  durationSeconds?: number | null
}

export function getVideoQueue(): Queue<VideoProcessingJob> {
  // Don't create queue during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }
  
  if (!videoQueueInstance) {
    videoQueueInstance = new Queue<VideoProcessingJob>('video-processing', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600, // keep completed jobs for 1 hour
        },
        removeOnFail: {
          age: 86400, // keep failed jobs for 24 hours
        },
      },
    })
  }
  return videoQueueInstance
}

export function getAssetQueue(): Queue<AssetProcessingJob> {
  // Don't create queue during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!assetQueueInstance) {
    assetQueueInstance = new Queue<AssetProcessingJob>('asset-processing', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600, // keep completed jobs for 1 hour
        },
        removeOnFail: {
          age: 86400, // keep failed jobs for 24 hours
        },
      },
    })
  }
  return assetQueueInstance
}

export function getClientFileQueue(): Queue<ClientFileProcessingJob> {
  // Don't create queue during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!clientFileQueueInstance) {
    clientFileQueueInstance = new Queue<ClientFileProcessingJob>('client-file-processing', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600,
        },
        removeOnFail: {
          age: 86400,
        },
      },
    })
  }
  return clientFileQueueInstance
}

export function getUserFileQueue(): Queue<UserFileProcessingJob> {
  // Don't create queue during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!userFileQueueInstance) {
    userFileQueueInstance = new Queue<UserFileProcessingJob>('user-file-processing', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600,
        },
        removeOnFail: {
          age: 86400,
        },
      },
    })
  }
  return userFileQueueInstance
}

export function getProjectFileQueue(): Queue<ProjectFileProcessingJob> {
  // Don't create queue during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!projectFileQueueInstance) {
    projectFileQueueInstance = new Queue<ProjectFileProcessingJob>('project-file-processing', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600,
        },
        removeOnFail: {
          age: 86400,
        },
      },
    })
  }
  return projectFileQueueInstance
}

export function getProjectEmailQueue(): Queue<ProjectEmailProcessingJob> {
  // Don't create queue during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!projectEmailQueueInstance) {
    projectEmailQueueInstance = new Queue<ProjectEmailProcessingJob>('project-email-processing', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600,
        },
        removeOnFail: {
          age: 86400,
        },
      },
    })
  }
  return projectEmailQueueInstance
}

export function getAlbumPhotoSocialQueue(): Queue<AlbumPhotoSocialJob> {
  // Don't create queue during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!albumPhotoSocialQueueInstance) {
    albumPhotoSocialQueueInstance = new Queue<AlbumPhotoSocialJob>('album-photo-social', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600,
        },
        removeOnFail: {
          age: 86400,
        },
      },
    })
  }

  return albumPhotoSocialQueueInstance
}

export function getAlbumPhotoThumbnailQueue(): Queue<AlbumPhotoThumbnailJob> {
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!albumPhotoThumbnailQueueInstance) {
    albumPhotoThumbnailQueueInstance = new Queue<AlbumPhotoThumbnailJob>('album-photo-thumbnail', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: {
          age: 3600,
        },
        removeOnFail: {
          age: 86400,
        },
      },
    })
  }

  return albumPhotoThumbnailQueueInstance
}

export function getAlbumPhotoZipQueue(): Queue<AlbumPhotoZipJob> {
  // Don't create queue during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!albumPhotoZipQueueInstance) {
    albumPhotoZipQueueInstance = new Queue<AlbumPhotoZipJob>('album-photo-zip', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600,
        },
        removeOnFail: {
          age: 86400,
        },
      },
    })
  }

  return albumPhotoZipQueueInstance
}

export function getFolderRenameQueue(): Queue<FolderRenameJobPayload> {
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!folderRenameQueueInstance) {
    folderRenameQueueInstance = new Queue<FolderRenameJobPayload>('folder-rename', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        // Do not auto-retry — on failure the DB record is marked FAILED and the
        // source files are still intact. An admin can trigger a re-attempt.
        attempts: 1,
        removeOnComplete: {
          age: 3600,
        },
        removeOnFail: {
          age: 86400,
        },
      },
    })
  }

  return folderRenameQueueInstance
}

export function getShareUploadPreviewQueue(): Queue<ShareUploadPreviewJob> {
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!shareUploadPreviewQueueInstance) {
    shareUploadPreviewQueueInstance = new Queue<ShareUploadPreviewJob>('share-upload-preview', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          age: 3600,
        },
        removeOnFail: {
          age: 86400,
        },
      },
    })
  }

  return shareUploadPreviewQueueInstance
}

/**
 * Enqueue a preview generation job for a ShareUploadFile or VideoAsset.
 * Uses a deterministic jobId so duplicate enqueues are deduplicated by BullMQ
 * (a second call for the same record is a no-op if the job is already waiting/active).
 * Also stamps previewStatus=PENDING + previewQueuedAt on the DB record.
 */
export async function enqueueShareUploadPreview(
  payload: ShareUploadPreviewJob,
  options?: { forceRequeue?: boolean },
): Promise<void> {
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  const jobId = `share-preview:${payload.type}:${payload.recordId}`

  // Stamp DB record before enqueuing so the UI can immediately show PENDING state.
  if (payload.type === 'shareUploadFile') {
    await prisma.shareUploadFile.update({
      where: { id: payload.recordId },
      data: {
        previewStatus: 'PENDING',
        previewQueuedAt: new Date(),
        previewAttempts: { increment: 1 },
      },
    }).catch(() => {
      // Record may have been deleted between upload and enqueue — safe to ignore
    })
  } else {
    await prisma.videoAsset.update({
      where: { id: payload.recordId },
      data: {
        previewStatus: 'PENDING',
        previewQueuedAt: new Date(),
        previewAttempts: { increment: 1 },
      },
    }).catch(() => {})
  }

  const queue = getShareUploadPreviewQueue()

  // BullMQ deduplicates by jobId: if a job with the same ID already exists in ANY
  // state (waiting, active, delayed, completed, or failed), add() is a no-op and
  // the new payload is never processed.  When forceRequeue is true (re-open,
  // reconciliation) we evict any stale completed/failed entry first so the fresh
  // job is actually enqueued.  We leave active jobs untouched to avoid
  // interrupting a worker that is already processing the record.
  if (options?.forceRequeue) {
    try {
      const existing = await queue.getJob(jobId)
      if (existing) {
        const state = await existing.getState()
        if (state === 'failed' || state === 'completed' || state === 'unknown') {
          await existing.remove().catch(() => {})
        }
      }
    } catch {
      // Non-fatal — if removal fails the add() below will just be a no-op,
      // which is no worse than the previous behaviour.
    }
  }

  await queue.add('generate-preview', payload, {
    jobId,
    // BullMQ ignores this add() if a job with the same jobId already exists in
    // waiting/active/delayed state, giving us safe idempotent enqueue.
  })
}
