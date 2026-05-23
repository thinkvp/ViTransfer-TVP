import { Job } from 'bullmq'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { prisma } from '@/lib/db'
import { generateThumbnail } from '@/lib/ffmpeg'
import { buildProjectUploadVideoThumbnailStoragePath } from '@/lib/project-storage-paths'
import { isS3Mode, s3FileExists, s3GetFileSize, s3GetPresignedStreamUrl } from '@/lib/s3-storage'
import { getFilePath, uploadFile } from '@/lib/storage'
import { stripDropboxStoragePrefix } from '@/lib/project-storage-paths'
import type { ShareUploadPreviewJob } from '@/lib/queue'

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

function getPreviewStoragePath(storagePath: string): string {
  return buildProjectUploadVideoThumbnailStoragePath(storagePath)
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
    return fs.existsSync(getFilePath(stripDropboxStoragePrefix(previewStoragePath)))
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
    const stat = fs.statSync(getFilePath(stripDropboxStoragePrefix(previewStoragePath)))
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
    sourceInput = getFilePath(stripDropboxStoragePrefix(sourcePath))
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
    inputArg = getFilePath(stripDropboxStoragePrefix(sourcePath))
  }

  await generateThumbnail(inputArg, tempOutputPath, timestamp)
}

async function updateRecordSuccess(
  type: 'shareUploadFile' | 'videoAsset',
  recordId: string,
  previewPath: string,
  previewFileSize: bigint,
): Promise<void> {
  const data = {
    previewStatus: 'READY',
    previewPath,
    previewFileSize,
    previewGeneratedAt: new Date(),
    previewError: null as string | null,
  }
  if (type === 'shareUploadFile') {
    await prisma.shareUploadFile.update({ where: { id: recordId }, data })
  } else {
    await prisma.videoAsset.update({ where: { id: recordId }, data })
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
    console.warn(`[PREVIEW] ${type}:${recordId} exceeded max attempts (${currentAttempts}); skipping`)
    return
  }

  const previewStoragePath = getPreviewStoragePath(storagePath)

  // Idempotency: if preview already exists and is stored, mark READY and exit
  if (await previewExists(previewStoragePath)) {
    const size = await getPreviewFileSize(previewStoragePath)
    await updateRecordSuccess(type, recordId, previewStoragePath, size)
    console.log(`[PREVIEW] Already exists for ${type}:${recordId}, marked READY`)
    return
  }

  await updateRecordProcessing(type, recordId)

  const isImage = String(fileType || '').toLowerCase().startsWith('image/')
  const isVideo = String(fileType || '').toLowerCase().startsWith('video/')

  if (!isImage && !isVideo) {
    // Non-previewable type somehow queued — mark failed and exit
    await updateRecordFailed(type, recordId, `Non-previewable file type: ${fileType}`)
    return
  }

  const tempDir = path.join(os.tmpdir(), 'vitransfer-preview')
  await fs.promises.mkdir(tempDir, { recursive: true })
  const safeName = path.basename(fileName || storagePath).replace(/[^\w.-]/g, '_')
  const tempOutputPath = path.join(tempDir, `${recordId}-${Date.now()}-${safeName}.jpg`)

  try {
    if (isImage) {
      await generateImagePreview(storagePath, tempOutputPath)
    } else {
      await generateVideoPreview(storagePath, tempOutputPath, durationSeconds)
    }

    const stat = fs.statSync(tempOutputPath)
    if (!stat.isFile() || stat.size === 0) {
      throw new Error('Preview output file is empty')
    }

    await uploadFile(previewStoragePath, fs.createReadStream(tempOutputPath) as any, stat.size, 'image/jpeg')

    const previewFileSize = BigInt(stat.size)
    await updateRecordSuccess(type, recordId, previewStoragePath, previewFileSize)

    console.log(`[PREVIEW] Generated preview for ${type}:${recordId} → ${previewStoragePath} (${stat.size} bytes)`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[PREVIEW] Failed for ${type}:${recordId}:`, msg)
    await updateRecordFailed(type, recordId, msg)
    throw err // Re-throw so BullMQ registers the failure and applies retry/backoff
  } finally {
    try { fs.unlinkSync(tempOutputPath) } catch { /* ignore */ }
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
    select: { id: true, storagePath: true, fileType: true, fileName: true, mediaDurationSeconds: true },
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
    select: { id: true, storagePath: true, fileType: true, fileName: true, mediaDurationSeconds: true },
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
    select: { id: true, storagePath: true, fileType: true, fileName: true },
    take: Math.floor(BATCH_CAP / 4),
  })

  const videoAssetsVideo = await prisma.videoAsset.findMany({
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
    select: { id: true, storagePath: true, fileType: true, fileName: true },
    take: Math.floor(BATCH_CAP / 4),
  })

  let queued = 0

  for (const f of uploadFiles) {
    await enqueueShareUploadPreview({
      type: 'shareUploadFile',
      recordId: f.id,
      storagePath: f.storagePath,
      fileType: f.fileType,
      fileName: f.fileName,
      durationSeconds: f.mediaDurationSeconds,
    }).catch((e) => console.warn(`[PREVIEW-RECONCILE] Enqueue failed for ShareUploadFile ${f.id}:`, e))
    queued++
  }

  for (const f of uploadFilesVideo) {
    await enqueueShareUploadPreview({
      type: 'shareUploadFile',
      recordId: f.id,
      storagePath: f.storagePath,
      fileType: f.fileType,
      fileName: f.fileName,
      durationSeconds: f.mediaDurationSeconds,
    }).catch((e) => console.warn(`[PREVIEW-RECONCILE] Enqueue failed for ShareUploadFile ${f.id}:`, e))
    queued++
  }

  for (const a of videoAssetsImage) {
    await enqueueShareUploadPreview({
      type: 'videoAsset',
      recordId: a.id,
      storagePath: a.storagePath,
      fileType: a.fileType,
      fileName: a.fileName,
    }).catch((e) => console.warn(`[PREVIEW-RECONCILE] Enqueue failed for VideoAsset ${a.id}:`, e))
    queued++
  }

  for (const a of videoAssetsVideo) {
    await enqueueShareUploadPreview({
      type: 'videoAsset',
      recordId: a.id,
      storagePath: a.storagePath,
      fileType: a.fileType,
      fileName: a.fileName,
    }).catch((e) => console.warn(`[PREVIEW-RECONCILE] Enqueue failed for VideoAsset ${a.id}:`, e))
    queued++
  }

  return { queued }
}
