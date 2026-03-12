import { Job } from 'bullmq'
import { DropboxUploadJob } from '../lib/queue'
import { prisma } from '../lib/db'
import { uploadLocalFileToDropboxPathWithProgress } from '../lib/storage-provider-dropbox'
import { getFilePath } from '../lib/storage'
import fs from 'fs'

type WithOptionalDropboxPath = {
  dropboxPath?: string | null
}

/**
 * Background worker that uploads video originals to Dropbox.
 *
 * The TUS upload finishes with the file stored locally. This worker picks up
 * the queued job and streams the local copy to Dropbox in the background,
 * updating `dropboxUploadProgress` in the database so the Running Jobs UI
 * can display real-time progress.
 *
 * The local copy is intentionally kept after upload for fast preview
 * processing and local-first download serving.
 */
export async function processDropboxUpload(job: Job<DropboxUploadJob>) {
  const { videoId, localPath, dropboxPath, fileSizeBytes, assetId, dropboxRelPath } = job.data

  if (assetId) {
    return processAssetDropboxUpload(job)
  }

  console.log(`[DROPBOX-WORKER] Starting Dropbox upload for video ${videoId}`)
  console.log(`[DROPBOX-WORKER] Local: ${localPath} → Dropbox: ${dropboxPath} (${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB)`)

  try {
    // Verify video still exists
    const video = await prisma.video.findUnique({ where: { id: videoId } })
    if (!video) {
      console.warn(`[DROPBOX-WORKER] Video ${videoId} no longer exists, skipping`)
      return
    }

    // Mark as uploading
    await prisma.video.update({
      where: { id: videoId },
      data: {
        dropboxUploadStatus: 'UPLOADING',
        dropboxUploadProgress: 0,
        dropboxUploadError: null,
      },
    })

    // Resolve the local file path
    const localAbsPath = getFilePath(localPath)

    if (!fs.existsSync(localAbsPath)) {
      throw new Error(`Local file not found: ${localAbsPath}`)
    }

    const effectiveRelPath = (video as WithOptionalDropboxPath).dropboxPath || dropboxRelPath || null

    const stats = await fs.promises.stat(localAbsPath)
    const totalBytes = stats.size

    // Track progress with throttled DB updates
    let lastProgressUpdate = 0
    const PROGRESS_UPDATE_INTERVAL_MS = 2000

    await uploadLocalFileToDropboxPathWithProgress(localAbsPath, dropboxPath, (uploaded, total) => {
      const now = Date.now()
      if (now - lastProgressUpdate < PROGRESS_UPDATE_INTERVAL_MS) return
      lastProgressUpdate = now

      const progress = Math.min(99, Math.round((uploaded / total) * 100))

      // Fire-and-forget DB update (non-blocking)
      prisma.video.update({
        where: { id: videoId },
        data: { dropboxUploadProgress: progress },
      }).catch(() => {})
    }, effectiveRelPath)

    // Mark complete
    await prisma.video.update({
      where: { id: videoId },
      data: {
        dropboxUploadStatus: 'COMPLETE',
        dropboxUploadProgress: 100,
        dropboxUploadError: null,
      },
    })

    console.log(`[DROPBOX-WORKER] Upload complete for video ${videoId}`)
  } catch (error: any) {
    console.error(`[DROPBOX-WORKER] Upload failed for video ${videoId}:`, error)

    await prisma.video.update({
      where: { id: videoId },
      data: {
        dropboxUploadStatus: 'ERROR',
        dropboxUploadError: error?.message || 'Unknown error',
      },
    }).catch(() => {})

    throw error // Let BullMQ handle retry
  }
}

async function processAssetDropboxUpload(job: Job<DropboxUploadJob>) {
  const { videoId, localPath, dropboxPath, fileSizeBytes, assetId, dropboxRelPath } = job.data

  console.log(`[DROPBOX-WORKER] Starting Dropbox upload for asset ${assetId}`)

  try {
    const asset = await prisma.videoAsset.findUnique({ where: { id: assetId! } })
    if (!asset) {
      console.warn(`[DROPBOX-WORKER] Asset ${assetId} no longer exists, skipping`)
      return
    }

    await prisma.videoAsset.update({
      where: { id: assetId! },
      data: { dropboxUploadStatus: 'UPLOADING', dropboxUploadProgress: 0, dropboxUploadError: null },
    })

    const localAbsPath = getFilePath(localPath)
    if (!fs.existsSync(localAbsPath)) {
      throw new Error(`Local file not found: ${localAbsPath}`)
    }

    // Use the asset's own dropboxPath if available, otherwise fall back to dropboxRelPath from job
    const effectiveRelPath = (asset as WithOptionalDropboxPath).dropboxPath || dropboxRelPath || null

    let lastProgressUpdate = 0
    await uploadLocalFileToDropboxPathWithProgress(localAbsPath, dropboxPath, (uploaded, total) => {
      const now = Date.now()
      if (now - lastProgressUpdate < 2000) return
      lastProgressUpdate = now
      const progress = Math.min(99, Math.round((uploaded / total) * 100))
      prisma.videoAsset.update({
        where: { id: assetId! },
        data: { dropboxUploadProgress: progress },
      }).catch(() => {})
    }, effectiveRelPath)

    await prisma.videoAsset.update({
      where: { id: assetId! },
      data: { dropboxUploadStatus: 'COMPLETE', dropboxUploadProgress: 100, dropboxUploadError: null },
    })

    console.log(`[DROPBOX-WORKER] Upload complete for asset ${assetId}`)
  } catch (error: any) {
    console.error(`[DROPBOX-WORKER] Upload failed for asset ${assetId}:`, error)

    await prisma.videoAsset.update({
      where: { id: assetId! },
      data: { dropboxUploadStatus: 'ERROR', dropboxUploadError: error?.message || 'Unknown error' },
    }).catch(() => {})

    throw error
  }
}
