import { Job } from 'bullmq'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { prisma } from '@/lib/db'
import { generateThumbnail } from '@/lib/ffmpeg'
import { buildUploadPreviewStoragePath, buildVideoAssetPreviewStoragePath } from '@/lib/project-storage-paths'
import { recalculateAndStoreProjectPreviewBytes } from '@/lib/project-total-bytes'
import { isS3Mode, s3FileExists, s3GetFileSize, s3GetPresignedStreamUrl } from '@/lib/s3-storage'
import { getFilePath, uploadFileFromPath } from '@/lib/storage'
import { getStoredFilePath } from '@/lib/stored-file'
import { registerStoredFile } from '@/lib/stored-file'
import type { ShareUploadPreviewJob } from '@/lib/queue'
import { parseResolutions, packageAssetHlsFromOriginal, type Resolution, type TempFiles } from './video-processor-helpers'

/**
 * Encode a video asset's HLS bundle DIRECTLY from its original (single rendition; no MP4
 * preview is produced anymore). Both S3 and local mode — HLS is the sole playback path.
 * Non-fatal — the hls-reconcile sweep retries on failure. Skips when an HLS bundle already
 * exists unless `force` (set after a fresh upload).
 */
async function maybePackageAssetHls(
  assetId: string,
  projectId: string,
  videoId: string,
  resolution: Resolution,
  opts?: { force?: boolean },
): Promise<void> {
  try {
    if (!opts?.force) {
      const existing = await prisma.storedFile.findUnique({
        where: { entityType_entityId_fileRole: { entityType: 'VIDEO_ASSET', entityId: assetId, fileRole: 'HLS_PLAYLIST' } },
        select: { id: true },
      })
      if (existing) {
        // Bundle already present — make sure the readiness flag reflects it.
        await prisma.videoAsset.update({ where: { id: assetId }, data: { hlsReady: true } }).catch(() => {})
        return
      }
    }
    const tempFiles: TempFiles = {}
    try {
      await packageAssetHlsFromOriginal(assetId, projectId, videoId, tempFiles, resolution)
      await prisma.videoAsset.update({ where: { id: assetId }, data: { hlsReady: true } }).catch(() => {})
    } finally {
      if (tempFiles.hlsDir) await fs.promises.rm(tempFiles.hlsDir, { recursive: true, force: true }).catch(() => {})
    }
  } catch (err) {
    console.error(`[PREVIEW] HLS packaging failed for asset ${assetId}:`, err)
    // Record the failure (was previously swallowed with no trace) so the hls-reconcile
    // sweep can find and retry this asset instead of leaving it permanently HLS-less.
    await prisma.videoAsset.update({ where: { id: assetId }, data: { hlsReady: false } }).catch(() => {})
  }
}

/** Whether a video asset already has a registered HLS bundle. */
async function assetHlsBundleExists(assetId: string): Promise<boolean> {
  const existing = await prisma.storedFile.findUnique({
    where: { entityType_entityId_fileRole: { entityType: 'VIDEO_ASSET', entityId: assetId, fileRole: 'HLS_PLAYLIST' } },
    select: { id: true },
  })
  return !!existing
}

let sharp: typeof import('sharp') | null = null
async function getSharp() {
  if (!sharp) {
    sharp = (await import('sharp')).default as unknown as typeof import('sharp')
  }
  return sharp
}

const PREVIEW_LONG_EDGE_PX = 1280
const PREVIEW_JPEG_QUALITY = 85
const MAX_PREVIEW_ATTEMPTS = 5
const RESOLUTION_PRIORITY: Record<string, number> = {
  '480p': 480,
  '720p': 720,
  '1080p': 1080,
}

function getHighestSelectedResolution(rawResolutions: string): '480p' | '720p' | '1080p' {
  const selected = parseResolutions(rawResolutions)
  if (!selected.length) return '720p'

  let best = selected[0]
  for (const candidate of selected) {
    if ((RESOLUTION_PRIORITY[candidate] || 0) > (RESOLUTION_PRIORITY[best] || 0)) {
      best = candidate
    }
  }

  return best
}

function getUploadPreviewStoragePath(projectId: string, uploadFileId: string): string {
  return buildUploadPreviewStoragePath(projectId, uploadFileId)
}

function getVideoAssetPreviewStoragePath(projectId: string, videoId: string, assetId: string): string {
  return buildVideoAssetPreviewStoragePath(projectId, videoId, assetId)
}

function getThumbnailCaptureTimestamp(durationSeconds?: number | null): number {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 1
  }
  return Math.max(0.5, Math.min(10, durationSeconds * 0.12))
}

async function previewExists(previewStoragePath: string): Promise<boolean> {
  try {
    if (isS3Mode()) return await s3FileExists(previewStoragePath)
    return fs.existsSync(getFilePath(previewStoragePath))
  } catch {
    return false
  }
}

async function getPreviewFileSize(previewStoragePath: string): Promise<bigint> {
  try {
    if (isS3Mode()) {
      const size = await s3GetFileSize(previewStoragePath)
      return typeof size === 'number' && size > 0 ? BigInt(size) : BigInt(0)
    }
    const stat = fs.statSync(getFilePath(previewStoragePath))
    return BigInt(stat.size)
  } catch {
    return BigInt(0)
  }
}

async function generateImagePreview(sourcePath: string, tempOutputPath: string): Promise<void> {
  const sharpLib = await getSharp()
  let sourceInput: string | Buffer

  if (isS3Mode()) {
    // Download image into memory for sharp processing (images are typically small)
    const { s3DownloadFileToBuffer } = await import('@/lib/s3-storage')
    sourceInput = await s3DownloadFileToBuffer(sourcePath)
  } else {
    sourceInput = getFilePath(sourcePath)
  }

  await (sharpLib as any)(sourceInput)
    .resize(PREVIEW_LONG_EDGE_PX, PREVIEW_LONG_EDGE_PX, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: PREVIEW_JPEG_QUALITY })
    .toFile(tempOutputPath)
}

async function generateVideoPreview(
  sourcePath: string,
  tempOutputPath: string,
  durationSeconds?: number | null,
): Promise<void> {
  const timestamp = getThumbnailCaptureTimestamp(durationSeconds)

  let inputArg: string
  if (isS3Mode()) {
    // Pass presigned URL directly so FFmpeg uses HTTP range requests internally —
    // avoids downloading the full video; FFmpeg only fetches the moov atom + target frame region.
    inputArg = await s3GetPresignedStreamUrl(sourcePath, 300, 'video/*')
  } else {
    inputArg = getFilePath(sourcePath)
  }

  await generateThumbnail(inputArg, tempOutputPath, timestamp)
}

async function updateRecordSuccess(
  type: 'shareUploadFile' | 'videoAsset',
  recordId: string,
  previewPath: string,
  previewFileSize: bigint,
): Promise<void> {
  // Legacy path/size columns have been dropped — status tracking only on entity tables.
  // All file path data is now stored exclusively in StoredFile.
  if (type === 'shareUploadFile') {
    await prisma.shareUploadFile.update({ where: { id: recordId }, data: {
      previewStatus: 'READY',
      previewGeneratedAt: new Date(),
      previewError: null,
    } })

    await registerStoredFile({
      entityType: 'SHARE_UPLOAD_FILE', entityId: recordId, fileRole: 'PREVIEW_IMAGE',
      storagePath: previewPath, fileSize: previewFileSize, status: 'READY', generatedAt: new Date(),
    })
  } else {
    await prisma.videoAsset.update({ where: { id: recordId }, data: {
      previewStatus: 'READY',
      previewGeneratedAt: new Date(),
      previewError: null,
    } })

    // The asset's preview is its poster JPG; playback is the separately-registered HLS bundle.
    await registerStoredFile({
      entityType: 'VIDEO_ASSET', entityId: recordId, fileRole: 'PREVIEW_IMAGE',
      storagePath: previewPath, fileSize: previewFileSize, status: 'READY', generatedAt: new Date(),
    })
  }
}

async function updateRecordFailed(
  type: 'shareUploadFile' | 'videoAsset',
  recordId: string,
  error: string,
): Promise<void> {
  const data = { previewStatus: 'FAILED', previewError: error }
  if (type === 'shareUploadFile') {
    await prisma.shareUploadFile.update({ where: { id: recordId }, data }).catch(() => {})
  } else {
    await prisma.videoAsset.update({ where: { id: recordId }, data }).catch(() => {})
  }
}

async function updateRecordProcessing(
  type: 'shareUploadFile' | 'videoAsset',
  recordId: string,
): Promise<void> {
  const data = { previewStatus: 'PROCESSING' }
  if (type === 'shareUploadFile') {
    await prisma.shareUploadFile.update({ where: { id: recordId }, data }).catch(() => {})
  } else {
    await prisma.videoAsset.update({ where: { id: recordId }, data }).catch(() => {})
  }
}

export async function processShareUploadPreview(job: Job<ShareUploadPreviewJob>): Promise<void> {
  const { type, recordId, storagePath, fileType, fileName, durationSeconds } = job.data

  console.log(`[PREVIEW] Starting preview for ${type}:${recordId} (${fileType})`)

  // Guard: check attempt count against cap before doing any work
  let currentAttempts = 0
  if (type === 'shareUploadFile') {
    const rec = await prisma.shareUploadFile.findUnique({ where: { id: recordId }, select: { previewAttempts: true } })
    currentAttempts = rec?.previewAttempts ?? 0
  } else {
    const rec = await prisma.videoAsset.findUnique({ where: { id: recordId }, select: { previewAttempts: true } })
    currentAttempts = rec?.previewAttempts ?? 0
  }

  if (currentAttempts > MAX_PREVIEW_ATTEMPTS) {
    console.warn(`[PREVIEW] ${type}:${recordId} exceeded max attempts (${currentAttempts}); marking failed`)
    await updateRecordFailed(type, recordId, `Exceeded max preview attempts (${currentAttempts})`)
    return
  }

  const record = type === 'shareUploadFile'
    ? await prisma.shareUploadFile.findUnique({
        where: { id: recordId },
        select: { fileType: true,
          fileName: true,
          projectId: true,
          project: {
            select: { title: true,
              companyName: true,
              storagePath: true,
              previewResolutions: true,
              client: { select: { name: true } },
            },
          },
        },
      })
    : await prisma.videoAsset.findUnique({
        where: { id: recordId },
        select: { fileType: true,
          fileName: true,
          video: {
            select: {
              id: true,
              projectId: true,
              storageFolderName: true,
              name: true,
              versionLabel: true,
              project: {
                select: { title: true,
                  companyName: true,
                  storagePath: true,
                  previewResolutions: true,
                  client: { select: { name: true } },
                },
              },
            },
          },
        },
      })

  if (!record) {
    await updateRecordFailed(type, recordId, 'Preview source record not found')
    return
  }

  // StoredFile handles original storage path — resolve if not provided
  const resolvedStoragePath = storagePath || await getStoredFilePath(
    type === 'shareUploadFile' ? 'SHARE_UPLOAD_FILE' : 'VIDEO_ASSET',
    recordId,
    'ORIGINAL',
  ) || ''
  const resolvedFileType = record.fileType || fileType
  const resolvedFileName = record.fileName || fileName

  let previewStoragePath: string
  let projectIdForPreviewBytes: string | null = null
  let videoIdForAsset: string | null = null
  let videoAssetPreviewProject: {
    previewResolutions: string
    title: string
  } | null = null
  if ('project' in record) {
    previewStoragePath = getUploadPreviewStoragePath(record.projectId, recordId)
  } else {
    const videoRecord = record.video
    projectIdForPreviewBytes = videoRecord.projectId
    videoIdForAsset = videoRecord.id
    videoAssetPreviewProject = {
      previewResolutions: videoRecord.project.previewResolutions,
      title: videoRecord.project.title,
    }
    previewStoragePath = getVideoAssetPreviewStoragePath(videoRecord.projectId, videoRecord.id, recordId)
  }

  const isImage = String(resolvedFileType || '').toLowerCase().startsWith('image/')
  const isVideo = String(resolvedFileType || '').toLowerCase().startsWith('video/')
  const shouldGenerateVideoAssetPlaybackPreview = type === 'videoAsset' && isVideo

  if (!isImage && !isVideo) {
    // Non-previewable type somehow queued — mark failed and exit
    await updateRecordFailed(type, recordId, `Non-previewable file type: ${resolvedFileType}`)
    return
  }

  // Idempotency:
  // - video assets need their poster JPG AND an HLS bundle (no MP4 preview anymore)
  // - all other previewable files require a single preview output
  if (shouldGenerateVideoAssetPlaybackPreview) {
    const hlsExists = await assetHlsBundleExists(recordId)
    const thumbnailExists = await previewExists(previewStoragePath)
    if (hlsExists && thumbnailExists) {
      // Both exist — already fully complete. Stamp the readiness flag (normalises
      // legacy video assets whose bundle predates the hlsReady column → null).
      await prisma.videoAsset.update({ where: { id: recordId }, data: { hlsReady: true } }).catch(() => {})
      const size = await getPreviewFileSize(previewStoragePath)
      await updateRecordSuccess(type, recordId, previewStoragePath, size)
      if (projectIdForPreviewBytes) {
        await recalculateAndStoreProjectPreviewBytes(projectIdForPreviewBytes).catch(() => {})
      }
      console.log(`[PREVIEW] Already exists for ${type}:${recordId}, marked READY`)
      return
    }
    if (thumbnailExists && !hlsExists && videoIdForAsset && projectIdForPreviewBytes && videoAssetPreviewProject) {
      // Poster already present; the expensive part (HLS encode) is what's missing — build it
      // from the original without regenerating the poster.
      await updateRecordProcessing(type, recordId)
      const resolution = getHighestSelectedResolution(videoAssetPreviewProject.previewResolutions)
      await maybePackageAssetHls(recordId, projectIdForPreviewBytes, videoIdForAsset, resolution, { force: true })
      const size = await getPreviewFileSize(previewStoragePath)
      await updateRecordSuccess(type, recordId, previewStoragePath, size)
      await recalculateAndStoreProjectPreviewBytes(projectIdForPreviewBytes).catch(() => {})
      console.log(`[PREVIEW] (Re)built HLS bundle for ${type}:${recordId}`)
      return
    }
    // else: poster missing → fall through to full (re)generation (poster + HLS)
  } else if (await previewExists(previewStoragePath)) {
    const size = await getPreviewFileSize(previewStoragePath)
    await updateRecordSuccess(type, recordId, previewStoragePath, size)
    if (projectIdForPreviewBytes) {
      await recalculateAndStoreProjectPreviewBytes(projectIdForPreviewBytes).catch(() => {})
    }
    console.log(`[PREVIEW] Already exists for ${type}:${recordId}, marked READY`)
    return
  }

  await updateRecordProcessing(type, recordId)

  const tempDir = path.join(os.tmpdir(), 'vitransfer-preview')
  await fs.promises.mkdir(tempDir, { recursive: true })
  const safeName = path.basename(resolvedFileName || resolvedStoragePath).replace(/[^\w.-]/g, '_')
  const tempBaseName = `${recordId}-${Date.now()}-${safeName}`
  const tempThumbnailPath = path.join(tempDir, `${tempBaseName}.jpg`)
  const tempFilesToCleanup = [tempThumbnailPath]

  try {
    if (isImage) {
      await generateImagePreview(resolvedStoragePath, tempThumbnailPath)
      const stat = fs.statSync(tempThumbnailPath)
      if (!stat.isFile() || stat.size === 0) {
        throw new Error('Preview output file is empty')
      }

      await uploadFileFromPath(previewStoragePath, tempThumbnailPath, stat.size, 'image/jpeg')
      const previewFileSize = BigInt(stat.size)
      await updateRecordSuccess(type, recordId, previewStoragePath, previewFileSize)
    } else {
      if (videoAssetPreviewProject) {
        // Poster JPG for grid cards. Playback is HLS, encoded directly from the original
        // below — no MP4 preview is produced or stored.
        await generateVideoPreview(resolvedStoragePath, tempThumbnailPath, durationSeconds)

        const thumbnailStat = fs.statSync(tempThumbnailPath)
        if (!thumbnailStat.isFile() || thumbnailStat.size === 0) {
          throw new Error('Thumbnail preview output file is empty')
        }

        await uploadFileFromPath(previewStoragePath, tempThumbnailPath, thumbnailStat.size, 'image/jpeg')
        const previewFileSize = BigInt(thumbnailStat.size)
        await updateRecordSuccess(type, recordId, previewStoragePath, previewFileSize)

        // Encode the asset's HLS bundle straight from the original (single rendition).
        if (videoIdForAsset && projectIdForPreviewBytes) {
          const resolution = getHighestSelectedResolution(videoAssetPreviewProject.previewResolutions)
          await maybePackageAssetHls(recordId, projectIdForPreviewBytes, videoIdForAsset, resolution, { force: true })
        }
      } else {
        await generateVideoPreview(resolvedStoragePath, tempThumbnailPath, durationSeconds)

        const stat = fs.statSync(tempThumbnailPath)
        if (!stat.isFile() || stat.size === 0) {
          throw new Error('Preview output file is empty')
        }

        await uploadFileFromPath(previewStoragePath, tempThumbnailPath, stat.size, 'image/jpeg')
        const previewFileSize = BigInt(stat.size)
        await updateRecordSuccess(type, recordId, previewStoragePath, previewFileSize)
      }
    }

    if (projectIdForPreviewBytes) {
      await recalculateAndStoreProjectPreviewBytes(projectIdForPreviewBytes).catch(() => {})
    }

    const stat = fs.statSync(tempThumbnailPath)
    console.log(`[PREVIEW] Generated preview for ${type}:${recordId} → ${previewStoragePath} (${stat.size} bytes)`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[PREVIEW] Failed for ${type}:${recordId}:`, msg)
    await updateRecordFailed(type, recordId, msg)
    throw err // Re-throw so BullMQ registers the failure and applies retry/backoff
  } finally {
    for (const tempPath of tempFilesToCleanup) {
      try { fs.unlinkSync(tempPath) } catch { /* ignore */ }
    }
  }
}

/**
 * Hourly reconciliation: find previewable files missing a preview and enqueue them.
 * Called by the notification worker on the 'share-upload-preview-reconcile' job.
 */
export async function reconcileShareUploadPreviews(): Promise<{ queued: number }> {
  const { enqueueShareUploadPreview } = await import('@/lib/queue')

  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  const BATCH_CAP = 100

  // Find ShareUploadFile records that need a preview
  const uploadFiles = await prisma.shareUploadFile.findMany({
    where: {
      OR: [
        { previewStatus: null },
        {
          previewStatus: 'PENDING',
          previewQueuedAt: { lt: thirtyMinutesAgo },
        },
        {
          previewStatus: 'FAILED',
          previewAttempts: { lt: MAX_PREVIEW_ATTEMPTS },
          previewGeneratedAt: { lt: twoHoursAgo },
        },
      ],
      fileType: {
        startsWith: 'image/',
        // Note: Prisma doesn't support OR on a single field with startsWith easily,
        // so we query images and videos separately below.
      },
    },
    select: { id: true, fileType: true, fileName: true, mediaDurationSeconds: true },
    take: Math.floor(BATCH_CAP / 2),
  })

  const uploadFilesVideo = await prisma.shareUploadFile.findMany({
    where: {
      OR: [
        { previewStatus: null },
        {
          previewStatus: 'PENDING',
          previewQueuedAt: { lt: thirtyMinutesAgo },
        },
        {
          previewStatus: 'FAILED',
          previewAttempts: { lt: MAX_PREVIEW_ATTEMPTS },
          previewGeneratedAt: { lt: twoHoursAgo },
        },
      ],
      fileType: { startsWith: 'video/' },
    },
    select: { id: true, fileType: true, fileName: true, mediaDurationSeconds: true },
    take: Math.floor(BATCH_CAP / 4),
  })

  // Find VideoAsset records that need a preview (non-video-version assets: image or video file type)
  const videoAssetsImage = await prisma.videoAsset.findMany({
    where: {
      OR: [
        { previewStatus: null },
        {
          previewStatus: 'PENDING',
          previewQueuedAt: { lt: thirtyMinutesAgo },
        },
        {
          previewStatus: 'FAILED',
          previewAttempts: { lt: MAX_PREVIEW_ATTEMPTS },
          previewGeneratedAt: { lt: twoHoursAgo },
        },
      ],
      fileType: { startsWith: 'image/' },
    },
    select: { id: true, fileType: true, fileName: true },
    take: Math.floor(BATCH_CAP / 4),
  })

  const videoAssetsVideo = await prisma.videoAsset.findMany({
    where: {
      fileType: { startsWith: 'video/' },
    },
    select: {
      id: true, fileType: true,
      fileName: true,
      previewStatus: true,
      previewAttempts: true,
      previewGeneratedAt: true,
    },
    take: Math.floor(BATCH_CAP / 4),
  })

  const videoAssetsVideoToQueue: typeof videoAssetsVideo = []
  for (const asset of videoAssetsVideo) {
    // Preview paths now come from StoredFile — check preview status only
    const needsRetry =
      asset.previewStatus === null ||
      asset.previewStatus === 'PENDING' ||
      (
        asset.previewStatus === 'FAILED' &&
        (asset.previewAttempts ?? 0) < MAX_PREVIEW_ATTEMPTS &&
        (!asset.previewGeneratedAt || asset.previewGeneratedAt < twoHoursAgo)
      )
    if (needsRetry) {
      videoAssetsVideoToQueue.push(asset)
    } else if (asset.previewStatus === 'READY') {
      // READY = poster done; re-queue if the HLS bundle (the playback path) is missing, so a
      // failed/legacy asset self-heals into HLS.
      const hasHls = await getStoredFilePath('VIDEO_ASSET', asset.id, 'HLS_PLAYLIST')
      if (!hasHls) {
        videoAssetsVideoToQueue.push(asset)
      }
    }
  }

  let queued = 0

  for (const f of uploadFiles) {
    await enqueueShareUploadPreview({
      type: 'shareUploadFile',
      recordId: f.id,
      storagePath: '',
      fileType: f.fileType,
      fileName: f.fileName,
      durationSeconds: f.mediaDurationSeconds,
    }, { forceRequeue: true }).catch((e) => console.warn(`[PREVIEW-RECONCILE] Enqueue failed for ShareUploadFile ${f.id}:`, e))
    queued++
  }

  for (const f of uploadFilesVideo) {
    await enqueueShareUploadPreview({
      type: 'shareUploadFile',
      recordId: f.id,
      storagePath: '',
      fileType: f.fileType,
      fileName: f.fileName,
      durationSeconds: f.mediaDurationSeconds,
    }, { forceRequeue: true }).catch((e) => console.warn(`[PREVIEW-RECONCILE] Enqueue failed for ShareUploadFile ${f.id}:`, e))
    queued++
  }

  for (const a of videoAssetsImage) {
    await enqueueShareUploadPreview({
      type: 'videoAsset',
      recordId: a.id,
      storagePath: '',
      fileType: a.fileType,
      fileName: a.fileName,
    }, { forceRequeue: true }).catch((e) => console.warn(`[PREVIEW-RECONCILE] Enqueue failed for VideoAsset ${a.id}:`, e))
    queued++
  }

  for (const a of videoAssetsVideoToQueue) {
    await enqueueShareUploadPreview({
      type: 'videoAsset',
      recordId: a.id,
      storagePath: '',
      fileType: a.fileType,
      fileName: a.fileName,
    }, { forceRequeue: true }).catch((e) => console.warn(`[PREVIEW-RECONCILE] Enqueue failed for VideoAsset ${a.id}:`, e))
    queued++
  }

  return { queued }
}
