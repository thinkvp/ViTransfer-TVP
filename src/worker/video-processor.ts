import { Job } from 'bullmq'
import { VideoProcessingJob } from '../lib/queue'
import {
  TempFiles,
  isVideoRecordMissingError,
  downloadAndValidateVideo,
  fetchProcessingSettings,
  filterRequestedResolutions,
  isPreviewResolutionStillRequested,
  processThumbnail,
  processTimelinePreviews,
  packageVideoHlsFromOriginal,
  finalizeVideoWithoutPreview,
  updateVideoStatus,
  updateVideoRecord,
  cleanupTempFiles,
  handleProcessingError,
  debugLog,
} from './video-processor-helpers'
import { PROCESSING_PHASES } from '@/lib/video-processing-phase'
import { recalculateAndStoreProjectTotalBytes, recalculateAndStoreProjectPreviewBytes, recalculateAndStoreProjectDiskBytes } from '@/lib/project-total-bytes'
import { incrementActiveVideoJobs, decrementActiveVideoJobs, getActiveVideoJobs, getCpuAllocation, getDynamicThreadsPerJob } from '@/lib/cpu-config'
import { isS3Mode } from '@/lib/s3-storage'
import { HLS_PACKAGE_VERSION } from '@/lib/video-stream-url'

/**
 * Returns a throttled progress callback (max 1 DB write per 500 ms) for tracking
 * S3→local download progress in the Running Jobs UI.
 */
function makeDownloadProgressCallback(videoId: string) {
  let lastUpdate = 0
  return (transferred: number, total: number) => {
    if (total <= 0) return

    const now = Date.now()
    const isFinal = transferred >= total
    if (!isFinal && now - lastUpdate < 500) return
    lastUpdate = now

    const progress = Math.min(transferred / total, 1)
    // Fire-and-forget — progress is best-effort; don't block the download stream
    updateVideoRecord(
      videoId,
      { processingProgress: progress },
      { context: 'download-progress', ignoreMissing: true }
    ).catch(() => {})
  }
}

/**
 * Main video processing orchestrator
 *
 * Stages:
 * 1. Download and validate video file
 * 2. Fetch processing settings from database
 * 3. Calculate output dimensions
 * 4. Process preview
 * 5. Generate thumbnail
 * 6. Finalize and update database
 * 7. Cleanup temporary files
 */
export async function processVideo(job: Job<VideoProcessingJob>) {
  const {
    videoId,
    storagePath,
    projectId,
    timelineOnly,
    thumbnailOnly,
    hlsOnly,
    requestedPreviewResolutions,
    regenerateThumbnail,
    regenerateTimelinePreviews,
    regenerateHls,
  } = job.data
  const previewOnly =
    Array.isArray(requestedPreviewResolutions) &&
    requestedPreviewResolutions.length > 0 &&
    regenerateThumbnail === false &&
    regenerateTimelinePreviews === false

  // Timeline-only mode: skip transcode/thumbnail, just generate sprites.
  // The video stays in READY status — no interruption to viewing.
  if (timelineOnly) {
    return processTimelineOnly(videoId, storagePath, projectId)
  }

  if (thumbnailOnly) {
    return processThumbnailOnly(videoId, storagePath, projectId)
  }

  // HLS-only: (re)package HLS from already-generated previews. Video stays READY — used by
  // the backfill and to recover/regenerate HLS without a full transcode.
  if (hlsOnly) {
    return processHlsOnly(videoId, projectId)
  }

  if (previewOnly) {
    return processPreviewOnly(videoId, storagePath, projectId, requestedPreviewResolutions)
  }

  console.log(`[WORKER] Processing video ${videoId}`)

  debugLog('Job data:', job.data)
  debugLog('Job ID:', job.id)
  debugLog('Job timestamp:', new Date(job.timestamp).toISOString())

  const tempFiles: TempFiles = {}
  const processingStart = Date.now()

  // Track this job so FFmpeg can dynamically scale threads based on active jobs.
  incrementActiveVideoJobs()
  const alloc = getCpuAllocation()
  const activeNow = getActiveVideoJobs()
  const { threads: dynamicThreads } = getDynamicThreadsPerJob()
  console.log(
    `[WORKER] Video ${videoId}: active jobs ${activeNow}/${alloc.videoWorkerConcurrency}, ` +
    `dynamic FFmpeg threads: ${dynamicThreads} (budget ${alloc.budgetThreads})`
  )

  try {
    // Stage 1: Advance status from QUEUED → PROCESSING now that the worker has claimed the job
    console.log(`[WORKER] Setting video ${videoId} to PROCESSING status`)
    await updateVideoStatus(videoId, 'PROCESSING', 0, null)

    // Stage 2: Download and validate video
    // In S3 mode the original file must be downloaded from R2 first — show a phase label so
    // the Running Jobs UI doesn't sit silently at 0% while the download is in progress.
    if (isS3Mode()) {
      await updateVideoRecord(
        videoId,
        { processingPhase: PROCESSING_PHASES.downloading, processingProgress: 0 },
        { context: 'download-from-s3', ignoreMissing: true }
      )
    }
    const videoInfo = await downloadAndValidateVideo(
      videoId,
      storagePath,
      tempFiles,
      isS3Mode() ? makeDownloadProgressCallback(videoId) : undefined
    )

    const finalSettings = await fetchProcessingSettings(projectId, videoId)
    const resolutions = filterRequestedResolutions(requestedPreviewResolutions, finalSettings.resolutions)

    // Stage 4+5: Encode each selected resolution DIRECTLY to an HLS rendition (no MP4 preview
    // is written to storage anymore). Skips a resolution that's deselected mid-encode.
    let hlsReady = false
    if (regenerateHls !== false && resolutions.length > 0) {
      const result = await packageVideoHlsFromOriginal({
        videoId,
        projectId,
        originalLocalPath: videoInfo.path,
        metadata: videoInfo.metadata,
        resolutions,
        tempFiles,
        shouldSkipResolution: async (resolution) =>
          !(await isPreviewResolutionStillRequested(projectId, requestedPreviewResolutions, resolution)),
      })
      hlsReady = result.ready
    }

    // Stage 6: Generate and upload thumbnail (from the original — best quality)
    let thumbnailPath: string | null = null
    if (regenerateThumbnail !== false) {
      thumbnailPath = await processThumbnail(
        videoId,
        projectId,
        videoInfo.path,
        videoInfo.metadata.duration,
        tempFiles
      )
    }

    // Stage 6.5: Generate timeline previews (always on)
    // Uses the original video file (not a transcoded preview) for best quality.
    let timelineResult: { vttPath: string; spritesPath: string; ready: boolean } | null = null
    if (regenerateTimelinePreviews !== false) {
      console.log(`[WORKER] Starting timeline preview generation for video ${videoId}`)
      timelineResult = await processTimelinePreviews(
        videoId,
        projectId,
        videoInfo.path,
        videoInfo.metadata,
        tempFiles
      )
      if (timelineResult?.ready) {
        console.log(`[WORKER] Timeline previews generated for video ${videoId}`)
      }
    }

    // Stage 7: Finalize — set READY + metadata + thumbnail. No PREVIEW_* rows exist anymore;
    // playback is HLS-only.
    await finalizeVideoWithoutPreview(videoId, thumbnailPath, videoInfo.metadata)

    // Persist HLS readiness (only when we actually (re)packaged it).
    if (regenerateHls !== false) {
      const updated = await updateVideoRecord(
        videoId,
        { hlsReady, hlsVersion: hlsReady ? HLS_PACKAGE_VERSION : 0, processingPhase: null },
        { context: 'persisting HLS ready flag', ignoreMissing: true },
      )
      if (!updated) return
    }

    // Persist timeline previews ready flag (paths are stored in StoredFile by processTimelinePreviews)
    if (regenerateTimelinePreviews !== false) {
      const updated = await updateVideoRecord(
        videoId,
        { timelinePreviewsReady: timelineResult?.ready === true },
        { context: 'persisting timeline preview ready flag', ignoreMissing: true }
      )
      if (!updated) return
    }

    await Promise.all([
      recalculateAndStoreProjectTotalBytes(projectId),
      recalculateAndStoreProjectPreviewBytes(projectId),
      recalculateAndStoreProjectDiskBytes(projectId),
    ])

    // Success!
    const totalTime = Date.now() - processingStart
    console.log(`[WORKER] Successfully processed video ${videoId} in ${(totalTime / 1000).toFixed(2)}s`)

  } catch (error) {
    if (isVideoRecordMissingError(error)) {
      console.warn(`[WORKER] Video ${videoId} was deleted during processing; aborting job cleanup updates.`)
      return
    }

    // Handle error - update database and log
    await handleProcessingError(videoId, error)
    throw error

  } finally {
    // Release active job slot so remaining jobs can scale up threads.
    decrementActiveVideoJobs()
    // Always cleanup temp files (success or failure)
    await cleanupTempFiles(tempFiles)
  }
}

/**
 * Package the just-generated MP4 previews into an HLS bundle and flag readiness.
 * HLS is now the sole playback path (in both S3 and local mode), so a failure here leaves
 * the video unplayable until repackaged — but it must still never fail the encode job (the
 * original/thumbnails are already persisted). On failure we clear hlsReady; the hls-reconcile
 * sweep then re-packages it automatically.
 */
/**
 * HLS-only job: re-encode a video's HLS bundle directly from its retained ORIGINAL (there are
 * no stored MP4 previews to remux anymore). The video keeps its current status (typically
 * READY) — there's no playback interruption. Used by the hls-reconcile sweep, the manual
 * repackage button, and the backfill to recover/regenerate HLS for already-processed videos.
 */
async function processHlsOnly(videoId: string, projectId: string) {
  console.log(`[WORKER] HLS (re)packaging for video ${videoId}`)
  const tempFiles: TempFiles = {}
  incrementActiveVideoJobs()
  try {
    const videoInfo = await downloadAndValidateVideo(
      videoId,
      '',
      tempFiles,
      isS3Mode() ? makeDownloadProgressCallback(videoId) : undefined,
    )
    const settings = await fetchProcessingSettings(projectId, videoId)
    const resolutions = filterRequestedResolutions(undefined, settings.resolutions)

    let hlsReady = false
    if (resolutions.length > 0) {
      const result = await packageVideoHlsFromOriginal({
        videoId,
        projectId,
        originalLocalPath: videoInfo.path,
        metadata: videoInfo.metadata,
        resolutions,
        tempFiles,
      })
      hlsReady = result.ready
    }

    await updateVideoRecord(
      videoId,
      { hlsReady, hlsVersion: hlsReady ? HLS_PACKAGE_VERSION : 0, processingPhase: null },
      { context: 'persisting HLS ready flag (hls-only)', ignoreMissing: true },
    )
  } catch (error) {
    if (isVideoRecordMissingError(error)) {
      console.warn(`[WORKER] Video ${videoId} was deleted during HLS packaging; skipping.`)
      return
    }
    // Leave hlsReady=false so the hls-reconcile sweep retries; don't fail the job.
    console.error(`[WORKER] HLS (re)packaging failed for video ${videoId}:`, error)
    await updateVideoRecord(
      videoId,
      { hlsReady: false, hlsVersion: 0, processingPhase: null },
      { context: 'clearing HLS ready flag after failure', ignoreMissing: true },
    ).catch(() => {})
  } finally {
    decrementActiveVideoJobs()
    await cleanupTempFiles(tempFiles)
  }
}

async function processPreviewOnly(
  videoId: string,
  storagePath: string,
  projectId: string,
  requestedPreviewResolutions: Array<'480p' | '720p' | '1080p'>
) {
  console.log(`[WORKER] Preview-only generation for video ${videoId}`)
  const tempFiles: TempFiles = {}
  const processingStart = Date.now()

  incrementActiveVideoJobs()
  try {
    await updateVideoRecord(
      videoId,
      { status: 'PROCESSING', processingPhase: null, processingProgress: 0 },
      { context: 'starting preview-only generation', ignoreMissing: true }
    )

    if (isS3Mode()) {
      await updateVideoRecord(
        videoId,
        { processingPhase: PROCESSING_PHASES.downloading, processingProgress: 0 },
        { context: 'download-from-s3', ignoreMissing: true }
      )
    }
    const videoInfo = await downloadAndValidateVideo(
      videoId,
      storagePath,
      tempFiles,
      isS3Mode() ? makeDownloadProgressCallback(videoId) : undefined
    )

    const settings = await fetchProcessingSettings(projectId, videoId)
    const resolutions = filterRequestedResolutions(requestedPreviewResolutions, settings.resolutions)

    // Re-encode the HLS renditions directly from the original to match the requested set.
    let hlsReady = false
    if (resolutions.length > 0) {
      const result = await packageVideoHlsFromOriginal({
        videoId,
        projectId,
        originalLocalPath: videoInfo.path,
        metadata: videoInfo.metadata,
        resolutions,
        tempFiles,
        shouldSkipResolution: async (resolution) =>
          !(await isPreviewResolutionStillRequested(projectId, requestedPreviewResolutions, resolution)),
      })
      hlsReady = result.ready
    }

    await updateVideoRecord(
      videoId,
      {
        status: 'READY',
        processingPhase: null,
        processingProgress: 100,
        hlsReady,
        hlsVersion: hlsReady ? HLS_PACKAGE_VERSION : 0,
      },
      { context: 'finalizing preview-only (HLS) generation', ignoreMissing: true }
    )

    await Promise.all([
      recalculateAndStoreProjectTotalBytes(projectId),
      recalculateAndStoreProjectPreviewBytes(projectId),
      recalculateAndStoreProjectDiskBytes(projectId),
    ])

    const totalTime = Date.now() - processingStart
    console.log(`[WORKER] Preview-only completed for ${videoId} in ${(totalTime / 1000).toFixed(2)}s`)
  } catch (error) {
    await updateVideoRecord(
      videoId,
      { status: 'READY', processingPhase: null, processingProgress: 0 },
      { context: 'clearing failed preview-only phase marker', ignoreMissing: true }
    ).catch(() => undefined)
    console.error(`[WORKER] Preview-only generation failed for ${videoId}:`, error)
    throw error
  } finally {
    decrementActiveVideoJobs()
    await cleanupTempFiles(tempFiles)
  }
}

async function processThumbnailOnly(
  videoId: string,
  storagePath: string,
  projectId: string,
) {
  console.log(`[WORKER] Thumbnail-only generation for video ${videoId}`)
  const tempFiles: TempFiles = {}
  const processingStart = Date.now()

  incrementActiveVideoJobs()
  try {
    await updateVideoRecord(
      videoId,
      { status: 'PROCESSING', processingPhase: null, processingProgress: 0 },
      { context: 'starting thumbnail-only generation', ignoreMissing: true }
    )

    if (isS3Mode()) {
      await updateVideoRecord(
        videoId,
        { processingPhase: PROCESSING_PHASES.downloading, processingProgress: 0 },
        { context: 'download-from-s3', ignoreMissing: true }
      )
    }
    const videoInfo = await downloadAndValidateVideo(
      videoId,
      storagePath,
      tempFiles,
      isS3Mode() ? makeDownloadProgressCallback(videoId) : undefined
    )
    const thumbnailPath = await processThumbnail(
      videoId,
      projectId,
      videoInfo.path,
      videoInfo.metadata.duration,
      tempFiles,
    )

    await finalizeVideoWithoutPreview(videoId, thumbnailPath, videoInfo.metadata)
    await Promise.all([
      recalculateAndStoreProjectTotalBytes(projectId),
      recalculateAndStoreProjectPreviewBytes(projectId),
      recalculateAndStoreProjectDiskBytes(projectId),
    ])

    const totalTime = Date.now() - processingStart
    console.log(`[WORKER] Thumbnail-only completed for ${videoId} in ${(totalTime / 1000).toFixed(2)}s`)
  } catch (error) {
    if (isVideoRecordMissingError(error)) {
      console.warn(`[WORKER] Video ${videoId} was deleted during thumbnail-only processing; aborting job cleanup updates.`)
      return
    }

    await handleProcessingError(videoId, error)
    throw error
  } finally {
    decrementActiveVideoJobs()
    await cleanupTempFiles(tempFiles)
  }
}

/**
 * Timeline-only processing: generate sprite sheets and VTT file without
 * touching the video's transcoded preview, thumbnail, or status.
 * The video stays in READY status so clients can keep watching it.
 */
async function processTimelineOnly(
  videoId: string,
  storagePath: string,
  projectId: string
) {
  console.log(`[WORKER] Timeline-only generation for video ${videoId}`)
  const tempFiles: TempFiles = {}
  const processingStart = Date.now()

  incrementActiveVideoJobs()
  try {
    const videoInfo = await downloadAndValidateVideo(videoId, storagePath, tempFiles)

    const timelineResult = await processTimelinePreviews(
      videoId,
      projectId,
      videoInfo.path,
      videoInfo.metadata,
      tempFiles
    )

    if (timelineResult?.ready) {
      const updated = await updateVideoRecord(
        videoId,
        {
          timelinePreviewsReady: true,
          processingPhase: null,
          processingProgress: 0,
        },
        { context: 'finalizing timeline-only preview generation', ignoreMissing: true }
      )
      if (!updated) return
      console.log(`[WORKER] Timeline previews generated for video ${videoId}`)
    } else {
      // Clear the phase marker even if generation returned no result
      const updated = await updateVideoRecord(
        videoId,
        { processingPhase: null, processingProgress: 0 },
        { context: 'clearing timeline-only phase marker', ignoreMissing: true }
      )
      if (!updated) return
      console.warn(`[WORKER] Timeline preview generation returned no result for ${videoId}`)
    }

    await Promise.all([
      recalculateAndStoreProjectTotalBytes(projectId),
      recalculateAndStoreProjectPreviewBytes(projectId),
      recalculateAndStoreProjectDiskBytes(projectId),
    ])

    const totalTime = Date.now() - processingStart
    console.log(`[WORKER] Timeline-only completed for ${videoId} in ${(totalTime / 1000).toFixed(2)}s`)
  } catch (error) {
    // Don't mark the video as ERROR — it's still READY. Just log the failure.
    // Clear the phase marker so it drops out of Running Jobs.
    await updateVideoRecord(
      videoId,
      { processingPhase: null, processingProgress: 0 },
      { context: 'clearing failed timeline-only phase marker', ignoreMissing: true }
    ).catch(() => undefined)
    console.error(`[WORKER] Timeline-only generation failed for ${videoId}:`, error)
    throw error
  } finally {
    decrementActiveVideoJobs()
    await cleanupTempFiles(tempFiles)
  }
}
