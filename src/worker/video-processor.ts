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
  const { videoId, originalStoragePath, projectId } = job.data

  console.log(`[WORKER] Processing video ${videoId}`)

  debugLog('Job data:', job.data)
  debugLog('Job ID:', job.id)
  debugLog('Job timestamp:', new Date(job.timestamp).toISOString())

  const tempFiles: TempFiles = {}
  const processingStart = Date.now()

  try {
    // Stage 1: Update status to processing (may already be PROCESSING from TUS handler)
    console.log(`[WORKER] Setting video ${videoId} to PROCESSING status (if not already)`)
    await updateVideoStatus(videoId, 'PROCESSING', 0)

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
    let timelineResult: { vttPath: string; spritesPath: string; ready: boolean } | null = null
    if (settings.timelinePreviewsEnabled && tempFiles.preview) {
      timelineResult = await processTimelinePreviews(
        videoId,
        projectId,
        tempFiles.preview,
        videoInfo.metadata,
        tempFiles
      )
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
    // Always cleanup temp files (success or failure)
    await cleanupTempFiles(tempFiles)
  }
}
