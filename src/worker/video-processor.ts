import { Job } from 'bullmq'
import { VideoProcessingJob } from '../lib/queue'
import { prisma } from '../lib/db'
import {
  TempFiles,
  isVideoRecordMissingError,
  downloadAndValidateVideo,
  fetchProcessingSettings,
  filterRequestedResolutions,
  calculateOutputDimensions,
  processPreview,
  processThumbnail,
  processTimelinePreviews,
  finalizeVideo,
  finalizeVideoWithoutPreview,
  updateVideoStatus,
  updateVideoRecord,
  cleanupTempFiles,
  handleProcessingError,
  debugLog,
  PreviewResolutionCancelledError,
  type Resolution,
} from './video-processor-helpers'
import { getPreviewProcessingPhase } from '@/lib/video-processing-phase'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { incrementActiveVideoJobs, decrementActiveVideoJobs, getActiveVideoJobs, getCpuAllocation, getDynamicThreadsPerJob } from '@/lib/cpu-config'

/**
 * Main video processing orchestrator
 *
 * Stages:
 * 1. Download and validate video file
 * 2. Fetch processing settings from database
 * 3. Calculate output dimensions
 * 4. Process preview with watermark
 * 5. Generate thumbnail
 * 6. Finalize and update database
 * 7. Cleanup temporary files
 */
export async function processVideo(job: Job<VideoProcessingJob>) {
  const {
    videoId,
    originalStoragePath,
    projectId,
    timelineOnly,
    requestedPreviewResolutions,
    regenerateThumbnail,
    regenerateTimelinePreviews,
  } = job.data
  const previewOnly =
    Array.isArray(requestedPreviewResolutions) &&
    requestedPreviewResolutions.length > 0 &&
    regenerateThumbnail === false &&
    regenerateTimelinePreviews === false

  // Timeline-only mode: skip transcode/thumbnail, just generate sprites.
  // The video stays in READY status — no interruption to viewing.
  if (timelineOnly) {
    return processTimelineOnly(videoId, originalStoragePath, projectId)
  }

  if (previewOnly) {
    return processPreviewOnly(videoId, originalStoragePath, projectId, requestedPreviewResolutions)
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
    const videoInfo = await downloadAndValidateVideo(videoId, originalStoragePath, tempFiles)

    // Stage 4+5: Process previews for each selected resolution
    const previewResults: { resolution: string; path: string }[] = []
    const completedResolutions = new Set<Resolution>()

    while (true) {
      const settings = await fetchProcessingSettings(projectId, videoId)
      const pendingResolutions = filterRequestedResolutions(requestedPreviewResolutions, settings.resolutions)
        .filter((resolution) => !completedResolutions.has(resolution))

      if (pendingResolutions.length === 0) {
        break
      }

      const resolution = pendingResolutions[0]
      const phaseUpdated = await updateVideoRecord(
        videoId,
        {
          processingProgress: 0,
          processingPhase: getPreviewProcessingPhase(resolution),
        },
        { context: `starting ${resolution} preview generation`, ignoreMissing: true }
      )
      if (!phaseUpdated) return

      const dimensions = calculateOutputDimensions(videoInfo.metadata, resolution)
      console.log(`[WORKER] Processing ${resolution} preview for video ${videoId}`)

      try {
        const previewPath = await processPreview(
          videoId,
          projectId,
          videoInfo.path,
          dimensions,
          { ...settings, resolution },
          tempFiles,
          videoInfo.metadata.duration,
          requestedPreviewResolutions
        )
        if (previewPath) {
          previewResults.push({ resolution, path: previewPath })
          completedResolutions.add(resolution)
        }
      } catch (error) {
        if (error instanceof PreviewResolutionCancelledError) {
          continue
        }
        throw error
      }
    }

    const finalSettings = await fetchProcessingSettings(projectId, videoId)

    // Stage 6: Generate and upload thumbnail
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

    // Stage 6.5: Generate timeline previews (optional)
    // Uses the original video file (not the transcoded preview) for best quality.
    let timelineResult: { vttPath: string; spritesPath: string; ready: boolean } | null = null
    if (regenerateTimelinePreviews !== false && finalSettings.timelinePreviewsEnabled) {
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

    // Stage 7: Finalize - update database with results for each resolution
    for (const result of previewResults) {
      await finalizeVideo(
        videoId,
        result.path,
        thumbnailPath,
        videoInfo.metadata,
        result.resolution
      )
    }

    if (previewResults.length === 0) {
      await finalizeVideoWithoutPreview(videoId, thumbnailPath, videoInfo.metadata)
    }

    // Persist timeline preview paths/ready flag (do not block READY if generation skipped)
    if (regenerateTimelinePreviews !== false && finalSettings.timelinePreviewsEnabled && timelineResult?.ready) {
      const updated = await updateVideoRecord(
        videoId,
        {
          timelinePreviewsReady: true,
          timelinePreviewVttPath: timelineResult.vttPath,
          timelinePreviewSpritesPath: timelineResult.spritesPath,
        },
        { context: 'persisting timeline preview paths', ignoreMissing: true }
      )
      if (!updated) return
    } else if (regenerateTimelinePreviews !== false) {
      const updated = await updateVideoRecord(
        videoId,
        {
          timelinePreviewsReady: false,
          timelinePreviewVttPath: null,
          timelinePreviewSpritesPath: null,
        },
        { context: 'clearing timeline preview paths', ignoreMissing: true }
      )
      if (!updated) return
    }

    await recalculateAndStoreProjectTotalBytes(projectId)

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

async function processPreviewOnly(
  videoId: string,
  originalStoragePath: string,
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

    const videoInfo = await downloadAndValidateVideo(videoId, originalStoragePath, tempFiles)

    const previewResults: { resolution: string; path: string }[] = []
    const completedResolutions = new Set<Resolution>()

    while (true) {
      const settings = await fetchProcessingSettings(projectId, videoId)
      const pendingResolutions = filterRequestedResolutions(requestedPreviewResolutions, settings.resolutions)
        .filter((resolution) => !completedResolutions.has(resolution))

      if (pendingResolutions.length === 0) {
        break
      }

      const resolution = pendingResolutions[0]
      const phaseUpdated = await updateVideoRecord(
        videoId,
        {
          processingProgress: 0,
          processingPhase: getPreviewProcessingPhase(resolution),
        },
        { context: `starting ${resolution} preview-only generation`, ignoreMissing: true }
      )
      if (!phaseUpdated) return

      const dimensions = calculateOutputDimensions(videoInfo.metadata, resolution)
      console.log(`[WORKER] Generating ${resolution} preview for video ${videoId}`)

      try {
        const previewPath = await processPreview(
          videoId,
          projectId,
          videoInfo.path,
          dimensions,
          { ...settings, resolution },
          tempFiles,
          videoInfo.metadata.duration,
          requestedPreviewResolutions
        )
        if (previewPath) {
          previewResults.push({ resolution, path: previewPath })
          completedResolutions.add(resolution)
        }
      } catch (error) {
        if (error instanceof PreviewResolutionCancelledError) {
          continue
        }
        throw error
      }
    }

    for (const result of previewResults) {
      await finalizeVideo(
        videoId,
        result.path,
        null,
        videoInfo.metadata,
        result.resolution
      )
    }

    if (previewResults.length === 0) {
      await updateVideoRecord(
        videoId,
        { status: 'READY', processingPhase: null, processingProgress: 100 },
        { context: 'finalizing no-op preview-only generation', ignoreMissing: true }
      )
    }

    await recalculateAndStoreProjectTotalBytes(projectId)

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

/**
 * Timeline-only processing: generate sprite sheets and VTT file without
 * touching the video's transcoded preview, thumbnail, or status.
 * The video stays in READY status so clients can keep watching it.
 */
async function processTimelineOnly(
  videoId: string,
  originalStoragePath: string,
  projectId: string
) {
  console.log(`[WORKER] Timeline-only generation for video ${videoId}`)
  const tempFiles: TempFiles = {}
  const processingStart = Date.now()

  incrementActiveVideoJobs()
  try {
    const videoInfo = await downloadAndValidateVideo(videoId, originalStoragePath, tempFiles)

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
          timelinePreviewVttPath: timelineResult.vttPath,
          timelinePreviewSpritesPath: timelineResult.spritesPath,
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

    await recalculateAndStoreProjectTotalBytes(projectId)

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
