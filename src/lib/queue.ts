import { Queue, Worker, Job } from 'bullmq'
import { getRedisForQueue } from './redis'

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

// Export for backward compatibility, but use getter in new code
export const videoQueue = new Proxy({} as Queue<VideoProcessingJob>, {
  get(target, prop) {
    return getVideoQueue()[prop as keyof Queue<VideoProcessingJob>]
  }
})

export const assetQueue = new Proxy({} as Queue<AssetProcessingJob>, {
  get(target, prop) {
    return getAssetQueue()[prop as keyof Queue<AssetProcessingJob>]
  }
})
