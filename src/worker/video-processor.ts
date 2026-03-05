import { Job } from 'bullmq'
import { VideoProcessingJob } from '../lib/queue'
import { prisma } from '../lib/db'
import {
  TempFiles,
  downloadAndValidateVideo,
  fetchProcessingSettings,
  calculateOutputDimensions,
  processPreview,
  processThumbnail,
  processTimelinePreviews,
  finalizeVideo,
  updateVideoStatus,
  cleanupTempFiles,
  handleProcessingError,
  debugLog
} from './video-processor-helpers'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { incrementActiveVideoJobs, decrementActiveVideoJobs, getActiveVideoJobs, getCpuAllocation } from '@/lib/cpu-config'

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
  const { videoId, originalStoragePath, projectId, timelineOnly } = job.data

  // Timeline-only mode: skip transcode/thumbnail, just generate sprites.
  // The video stays in READY status — no interruption to viewing.
  if (timelineOnly) {
    return processTimelineOnly(videoId, originalStoragePath, projectId)
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
  const dynamicThreads = Math.min(
    Math.floor(alloc.budgetThreads / Math.max(1, activeNow)),
    12
  )
  console.log(
    `[WORKER] Video ${videoId}: active jobs ${activeNow}/${alloc.videoWorkerConcurrency}, ` +
    `dynamic FFmpeg threads: ${dynamicThreads} (budget ${alloc.budgetThreads})`
  )

  try {
    // Stage 1: Advance status from QUEUED → PROCESSING now that the worker has claimed the job
    console.log(`[WORKER] Setting video ${videoId} to PROCESSING status`)
    await updateVideoStatus(videoId, 'PROCESSING', 0, 'transcode')

    // Stage 2: Download and validate video
    const videoInfo = await downloadAndValidateVideo(videoId, originalStoragePath, tempFiles)

    // Stage 3: Fetch processing settings
    const settings = await fetchProcessingSettings(projectId, videoId)

    // Stage 4: Calculate output dimensions
    const dimensions = calculateOutputDimensions(videoInfo.metadata, settings.resolution)

    // Stage 5: Process preview with watermark
    const previewPath = await processPreview(
      videoId,
      projectId,
      videoInfo.path,
      dimensions,
      settings,
      tempFiles,
      videoInfo.metadata.duration
    )

    // Stage 6: Generate and upload thumbnail
    const thumbnailPath = await processThumbnail(
      videoId,
      projectId,
      videoInfo.path,
      videoInfo.metadata.duration,
      tempFiles
    )

    // Stage 6.5: Generate timeline previews (optional)
    // Uses the original video file (not the transcoded preview) for best quality.
    let timelineResult: { vttPath: string; spritesPath: string; ready: boolean } | null = null
    if (settings.timelinePreviewsEnabled) {
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

    // Stage 7: Finalize - update database with results
    await finalizeVideo(
      videoId,
      previewPath,
      thumbnailPath,
      videoInfo.metadata,
      settings.resolution
    )

    // Persist timeline preview paths/ready flag (do not block READY if generation skipped)
    if (settings.timelinePreviewsEnabled && timelineResult?.ready) {
      await prisma.video.update({
        where: { id: videoId },
        data: {
          timelinePreviewsReady: true,
          timelinePreviewVttPath: timelineResult.vttPath,
          timelinePreviewSpritesPath: timelineResult.spritesPath,
        },
      })
    } else {
      await prisma.video.update({
        where: { id: videoId },
        data: {
          timelinePreviewsReady: false,
          timelinePreviewVttPath: null,
          timelinePreviewSpritesPath: null,
        },
      })
    }

    await recalculateAndStoreProjectTotalBytes(projectId)

    // Success!
    const totalTime = Date.now() - processingStart
    console.log(`[WORKER] Successfully processed video ${videoId} in ${(totalTime / 1000).toFixed(2)}s`)

  } catch (error) {
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
      await prisma.video.update({
        where: { id: videoId },
        data: {
          timelinePreviewsReady: true,
          timelinePreviewVttPath: timelineResult.vttPath,
          timelinePreviewSpritesPath: timelineResult.spritesPath,
        },
      })
      console.log(`[WORKER] Timeline previews generated for video ${videoId}`)
    } else {
      console.warn(`[WORKER] Timeline preview generation returned no result for ${videoId}`)
    }

    await recalculateAndStoreProjectTotalBytes(projectId)

    const totalTime = Date.now() - processingStart
    console.log(`[WORKER] Timeline-only completed for ${videoId} in ${(totalTime / 1000).toFixed(2)}s`)
  } catch (error) {
    // Don't mark the video as ERROR — it's still READY. Just log the failure.
    console.error(`[WORKER] Timeline-only generation failed for ${videoId}:`, error)
    throw error
  } finally {
    decrementActiveVideoJobs()
    await cleanupTempFiles(tempFiles)
  }
}
