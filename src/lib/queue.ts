import { Queue, Worker, Job } from 'bullmq'
import { getRedisForQueue } from './redis'

// Lazy initialization to prevent connections during build time
let videoQueueInstance: Queue<VideoProcessingJob> | null = null
let assetQueueInstance: Queue<AssetProcessingJob> | null = null
let clientFileQueueInstance: Queue<ClientFileProcessingJob> | null = null
let projectFileQueueInstance: Queue<ProjectFileProcessingJob> | null = null
let albumPhotoSocialQueueInstance: Queue<AlbumPhotoSocialJob> | null = null
let albumPhotoZipQueueInstance: Queue<AlbumPhotoZipJob> | null = null

export interface VideoProcessingJob {
  videoId: string
  originalStoragePath: string
  projectId: string
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

export interface ProjectFileProcessingJob {
  projectFileId: string
  storagePath: string
  expectedCategory?: string
}

export interface AlbumPhotoSocialJob {
  photoId: string
}

export interface AlbumPhotoZipJob {
  albumId: string
  variant: 'full' | 'social'
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
