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
let assetTimelineQueueInstance: Queue<AssetTimelineJob> | null = null
let uploadTimelineQueueInstance: Queue<UploadTimelineJob> | null = null
let passwordEmailQueueInstance: Queue<PasswordEmailJob> | null = null
let aiAssistantQueueInstance: Queue<AiAssistantJob> | null = null
let transcriptionQueueInstance: Queue<TranscriptionJob> | null = null

export interface VideoProcessingJob {
  videoId: string
  /** Storage path of the original video file (resolved from StoredFile before enqueuing). */
  storagePath: string
  projectId: string
  /** When true, skip transcode/thumbnail and only generate timeline preview sprites. */
  timelineOnly?: boolean
  /** When true, skip transcode/thumbnail/timeline and only (re)package HLS from existing previews. */
  hlsOnly?: boolean
  /** When true, regenerate only the thumbnail and leave previews/timeline assets untouched. */
  thumbnailOnly?: boolean
  /** Optional subset of preview resolutions to generate instead of the full configured set. */
  requestedPreviewResolutions?: Array<'480p' | '720p' | '1080p'>
  /** When false, keep the existing thumbnail instead of regenerating it. */
  regenerateThumbnail?: boolean
  /** When false, keep existing timeline preview assets untouched. */
  regenerateTimelinePreviews?: boolean
  /** When false, skip HLS (re)packaging. Defaults to packaging whenever previews are (re)generated. */
  regenerateHls?: boolean
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

// Password emails for a password-protected project's share link. Enqueued (with a delay) by the
// notify route so the password is staggered after the notification email without blocking the
// admin's request, and so delivery survives a web-process restart.
export interface PasswordEmailJob {
  projectId: string
  recipientIds: string[]
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

/** Payload for an AI assistant generation job (proposal extraction or connection test). */
export interface AiAssistantJob {
  /** The AiAssistantRequest DB record id. All state lives in DB, not BullMQ. */
  requestId: string
}

/**
 * Payload for a Whisper transcription job. All three kinds run on the shared
 * 'transcription' queue (concurrency 1 — the Whisper server shares NAS CPU
 * with Ollama).
 */
export type TranscriptionJob =
  /** Generate SRT subtitles + playback VTT for a video version. */
  | { kind: 'video-subtitles'; videoId: string; force?: boolean }
  /** Transcribe a short dictation clip. State lives in the AiAssistantRequest row. */
  | { kind: 'dictation'; requestId: string }
  /** Whisper server liveness/model check. State lives in the AiAssistantRequest row. */
  | { kind: 'whisper-test'; requestId: string }

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

/** Payload for generating timeline hover sprites for a video asset. */
export interface AssetTimelineJob {
  assetId: string
  videoId: string
  projectId: string
  storagePath: string
  /** Duration in seconds (from media metadata). */
  durationSeconds: number
  /** Video width in pixels. */
  width: number
  /** Video height in pixels. */
  height: number
}

/** Payload for generating timeline hover sprites for an upload video. */
export interface UploadTimelineJob {
  uploadFileId: string
  projectId: string
  storagePath: string
  /** Duration in seconds (from media metadata). */
  durationSeconds: number
  /** Video width in pixels. */
  width: number
  /** Video height in pixels. */
  height: number
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

export function getPasswordEmailQueue(): Queue<PasswordEmailJob> {
  // Don't create queue during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!passwordEmailQueueInstance) {
    passwordEmailQueueInstance = new Queue<PasswordEmailJob>('password-email', {
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
  return passwordEmailQueueInstance
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

export function getAiAssistantQueue(): Queue<AiAssistantJob> {
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!aiAssistantQueueInstance) {
    aiAssistantQueueInstance = new Queue<AiAssistantJob>('ai-assistant', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        // Do not auto-retry — retries would double LLM token spend. On failure the
        // DB record is marked FAILED and the admin can retry from the UI.
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

  return aiAssistantQueueInstance
}

export function getTranscriptionQueue(): Queue<TranscriptionJob> {
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!transcriptionQueueInstance) {
    transcriptionQueueInstance = new Queue<TranscriptionJob>('transcription', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        // Video subtitle jobs tolerate a retry (Whisper server may be busy/rebooting).
        // Dictation/test jobs override this to attempts: 1 at enqueue time — the
        // admin is actively polling and the DB row is marked FAILED instead.
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 10000,
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

  return transcriptionQueueInstance
}

/**
 * Enqueue subtitle generation for a video version. No-ops unless transcription
 * is enabled + configured in Settings. Uses a deterministic jobId for
 * idempotent enqueue.
 *
 * Stamps Video.transcriptionStatus=PENDING (queued UI state + drives full
 * (re)generation) ONLY when a forced regeneration is requested or the video
 * has no subtitles yet. When subtitles already exist, the job is still
 * enqueued but runs only to heal a missing waveform — it must never overwrite
 * hand-edited cues, so the status is left as READY.
 */
export async function enqueueVideoSubtitles(
  videoId: string,
  options?: { force?: boolean },
): Promise<boolean> {
  if (process.env.NEXT_PHASE === 'phase-production-build') return false

  const settings = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: {
      transcriptionEnabled: true,
      transcriptionProvider: true,
      transcriptionWhisperUrl: true,
      transcriptionOpenaiApiKey: true,
    },
  })
  const configured = (settings?.transcriptionProvider ?? 'LOCAL') === 'OPENAI'
    ? !!settings?.transcriptionOpenaiApiKey
    : !!settings?.transcriptionWhisperUrl
  if (!settings?.transcriptionEnabled || !configured) {
    return false
  }

  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: { transcriptionStatus: true, autoGenerateSubtitles: true },
  })
  // Per-version opt-out: skip the Whisper run (and the PENDING stamp) unless
  // forced. The job is still enqueued so the waveform can heal; the processor
  // makes the same decision and generates peaks only.
  const willRegenerate =
    options?.force === true ||
    (video?.autoGenerateSubtitles !== false && video?.transcriptionStatus !== 'READY')
  if (willRegenerate) {
    await prisma.video.update({
      where: { id: videoId },
      data: { transcriptionStatus: 'PENDING', transcriptionError: null },
    }).catch(() => {
      // Video may have been deleted between processing and enqueue — safe to ignore
    })
  }

  const queue = getTranscriptionQueue()
  // NB: BullMQ rejects custom job IDs containing ':' (its Redis key delimiter), so use '-'.
  const jobId = `subtitles-${videoId}`

  // BullMQ dedupes by jobId across ALL states, so a stale completed/failed
  // entry would block a legitimate re-enqueue (reprocess, waveform heal).
  // Always evict those first; active jobs are left alone.
  try {
    const existing = await queue.getJob(jobId)
    if (existing) {
      const state = await existing.getState()
      if (state === 'failed' || state === 'completed' || state === 'unknown') {
        await existing.remove().catch(() => {})
      }
    }
  } catch {
    // Non-fatal — add() below is a no-op if eviction failed
  }

  await queue.add('video-subtitles', { kind: 'video-subtitles', videoId, force: options?.force }, { jobId })
  return true
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

export function getAssetTimelineQueue(): Queue<AssetTimelineJob> {
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!assetTimelineQueueInstance) {
    assetTimelineQueueInstance = new Queue<AssetTimelineJob>('asset-timeline', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86400 },
      },
    })
  }

  return assetTimelineQueueInstance
}

export function getUploadTimelineQueue(): Queue<UploadTimelineJob> {
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!uploadTimelineQueueInstance) {
    uploadTimelineQueueInstance = new Queue<UploadTimelineJob>('upload-timeline', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86400 },
      },
    })
  }

  return uploadTimelineQueueInstance
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

  // NB: BullMQ rejects custom job IDs containing ':' (its Redis key delimiter), so use '-'.
  const jobId = `share-preview-${payload.type}-${payload.recordId}`

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
