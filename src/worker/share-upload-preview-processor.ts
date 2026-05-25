import { Job } from 'bullmq'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { prisma } from '@/lib/db'
import { generateThumbnail, getVideoMetadata, transcodeVideo } from '@/lib/ffmpeg'
import { buildProjectStorageRoot, buildProjectUploadVideoThumbnailStoragePath, buildVideoAssetPreviewStoragePath } from '@/lib/project-storage-paths'
import { recalculateAndStoreProjectPreviewBytes } from '@/lib/project-total-bytes'
import { isS3Mode, s3FileExists, s3GetFileSize, s3GetPresignedStreamUrl } from '@/lib/s3-storage'
import { getFilePath, uploadFile } from '@/lib/storage'
import { stripDropboxStoragePrefix } from '@/lib/project-storage-paths'
import { materializeStoragePathToLocalFile } from '@/lib/storage-provider'
import type { ShareUploadPreviewJob } from '@/lib/queue'
import { calculateOutputDimensions, parseResolutions } from './video-processor-helpers'

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

function getPreviewStoragePath(projectStoragePath: string, storagePath: string): string {
  return buildProjectUploadVideoThumbnailStoragePath(projectStoragePath, storagePath)
}

function getVideoAssetPreviewStoragePath(projectStoragePath: string, storagePath: string, videoFolderName: string, versionLabel: string): string {
  return buildVideoAssetPreviewStoragePath(projectStoragePath, videoFolderName, versionLabel, storagePath)
}

function getVideoAssetPlaybackPreviewStoragePath(projectStoragePath: string, storagePath: string, videoFolderName: string, versionLabel: string): string {
  return buildVideoAssetPreviewStoragePath(projectStoragePath, videoFolderName, versionLabel, storagePath, '.mp4')
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

async function generatePlayableVideoPreview(
  sourcePath: string,
  tempOutputPath: string,
  project: {
    previewResolutions: string
    watermarkEnabled: boolean
    watermarkText: string | null
    title: string
  },
): Promise<void> {
  // In S3 mode sourcePath is a raw object key — FFmpeg can't reach it directly.
  // Materialize to a local temp file first, then clean up afterwards.
  const tempDir = path.join(os.tmpdir(), 'vitransfer-asset-preview-src')
  const materialized = await materializeStoragePathToLocalFile({
    rawPath: sourcePath,
    tempDir,
    suggestedName: path.basename(sourcePath),
  })
  const localInputPath = materialized.localPath
  try {
    const metadata = await getVideoMetadata(localInputPath)
    const resolution = getHighestSelectedResolution(project.previewResolutions)
    const dimensions = calculateOutputDimensions(metadata, resolution)
    const watermarkText = project.watermarkEnabled
      ? (project.watermarkText || `PREVIEW-${project.title || 'PROJECT'}`)
      : undefined

    await transcodeVideo({
      inputPath: localInputPath,
      outputPath: tempOutputPath,
      width: dimensions.width,
      height: dimensions.height,
      watermarkText,
    })
  } finally {
    if (materialized.isTemporary) {
      await fs.promises.rm(materialized.localPath, { force: true }).catch(() => undefined)
    }
  }
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

  const record = type === 'shareUploadFile'
    ? await prisma.shareUploadFile.findUnique({
        where: { id: recordId },
        select: {
          storagePath: true,
          fileType: true,
          fileName: true,
          project: {
            select: {
              storagePath: true,
              title: true,
              companyName: true,
              previewResolutions: true,
              watermarkEnabled: true,
              watermarkText: true,
              client: { select: { name: true } },
            },
          },
        },
      })
    : await prisma.videoAsset.findUnique({
        where: { id: recordId },
        select: {
          storagePath: true,
          fileType: true,
          fileName: true,
          video: {
            select: {
              projectId: true,
              storageFolderName: true,
              name: true,
              versionLabel: true,
              project: {
                select: {
                  storagePath: true,
                  title: true,
                  companyName: true,
                  previewResolutions: true,
                  watermarkEnabled: true,
                  watermarkText: true,
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

  let projectStoragePath: string
  if ('project' in record) {
    projectStoragePath = record.project.storagePath || buildProjectStorageRoot(
      record.project.client?.name || record.project.companyName || 'Client',
      record.project.title,
    )
  } else {
    projectStoragePath = record.video.project.storagePath || buildProjectStorageRoot(
      record.video.project.client?.name || record.video.project.companyName || 'Client',
      record.video.project.title,
    )
  }

  const resolvedStoragePath = record.storagePath
  const resolvedFileType = record.fileType || fileType
  const resolvedFileName = record.fileName || fileName

  let previewStoragePath: string
  let playbackPreviewStoragePath: string | null = null
  let projectIdForPreviewBytes: string | null = null
  let videoAssetPreviewProject: {
    previewResolutions: string
    watermarkEnabled: boolean
    watermarkText: string | null
    title: string
  } | null = null
  if ('project' in record) {
    previewStoragePath = getPreviewStoragePath(projectStoragePath, resolvedStoragePath)
  } else {
    const videoRecord = record.video
    projectIdForPreviewBytes = videoRecord.projectId
    videoAssetPreviewProject = {
      previewResolutions: videoRecord.project.previewResolutions,
      watermarkEnabled: videoRecord.project.watermarkEnabled,
      watermarkText: videoRecord.project.watermarkText,
      title: videoRecord.project.title,
    }
    previewStoragePath = getVideoAssetPreviewStoragePath(
      projectStoragePath,
      resolvedStoragePath,
      videoRecord.storageFolderName || videoRecord.name,
      videoRecord.versionLabel,
    )
    playbackPreviewStoragePath = getVideoAssetPlaybackPreviewStoragePath(
      projectStoragePath,
      resolvedStoragePath,
      videoRecord.storageFolderName || videoRecord.name,
      videoRecord.versionLabel,
    )
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
  // - video assets with video input must have both playback mp4 and thumbnail jpg
  // - all other previewable files require a single preview output
  if (shouldGenerateVideoAssetPlaybackPreview) {
    const playbackExists = Boolean(playbackPreviewStoragePath) && await previewExists(playbackPreviewStoragePath!)
    const thumbnailExists = await previewExists(previewStoragePath)
    if (playbackExists && thumbnailExists) {
      // Both exist — already fully complete.
      const size = await getPreviewFileSize(playbackPreviewStoragePath!)
      await updateRecordSuccess(type, recordId, playbackPreviewStoragePath!, size)
      if (projectIdForPreviewBytes) {
        await recalculateAndStoreProjectPreviewBytes(projectIdForPreviewBytes).catch(() => {})
      }
      console.log(`[PREVIEW] Already exists for ${type}:${recordId}, marked READY`)
      return
    }
    if (playbackExists && !thumbnailExists) {
      // MP4 playback already exists; generate only the missing companion JPG thumbnail
      // without re-encoding the full video (which would be expensive).
      await updateRecordProcessing(type, recordId)
      const fastTempDir = path.join(os.tmpdir(), 'vitransfer-preview')
      await fs.promises.mkdir(fastTempDir, { recursive: true })
      const fastSafeName = path.basename(resolvedFileName || resolvedStoragePath).replace(/[^\w.-]/g, '_')
      const fastTempThumbnailPath = path.join(fastTempDir, `${recordId}-${Date.now()}-${fastSafeName}.jpg`)
      try {
        await generateVideoPreview(resolvedStoragePath, fastTempThumbnailPath, durationSeconds)
        const thumbnailStat = fs.statSync(fastTempThumbnailPath)
        if (!thumbnailStat.isFile() || thumbnailStat.size === 0) {
          throw new Error('Companion thumbnail output file is empty')
        }
        await uploadFile(previewStoragePath, fs.createReadStream(fastTempThumbnailPath) as any, thumbnailStat.size, 'image/jpeg')
        const size = await getPreviewFileSize(playbackPreviewStoragePath!)
        await updateRecordSuccess(type, recordId, playbackPreviewStoragePath!, size)
        if (projectIdForPreviewBytes) {
          await recalculateAndStoreProjectPreviewBytes(projectIdForPreviewBytes).catch(() => {})
        }
        console.log(`[PREVIEW] Generated missing companion JPG for ${type}:${recordId} → ${previewStoragePath} (${thumbnailStat.size} bytes)`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[PREVIEW] Failed to generate companion JPG for ${type}:${recordId}:`, msg)
        await updateRecordFailed(type, recordId, msg)
        throw err
      } finally {
        try { fs.unlinkSync(fastTempThumbnailPath) } catch { /* ignore */ }
      }
      return
    }
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
  const tempPlaybackPath = path.join(tempDir, `${tempBaseName}.mp4`)
  const tempFilesToCleanup = [tempThumbnailPath, tempPlaybackPath]

  try {
    if (isImage) {
      await generateImagePreview(resolvedStoragePath, tempThumbnailPath)
      const stat = fs.statSync(tempThumbnailPath)
      if (!stat.isFile() || stat.size === 0) {
        throw new Error('Preview output file is empty')
      }

      await uploadFile(previewStoragePath, fs.createReadStream(tempThumbnailPath) as any, stat.size, 'image/jpeg')
      const previewFileSize = BigInt(stat.size)
      await updateRecordSuccess(type, recordId, previewStoragePath, previewFileSize)
    } else {
      if (videoAssetPreviewProject) {
        await generatePlayableVideoPreview(resolvedStoragePath, tempPlaybackPath, {
          previewResolutions: videoAssetPreviewProject.previewResolutions,
          watermarkEnabled: videoAssetPreviewProject.watermarkEnabled,
          watermarkText: videoAssetPreviewProject.watermarkText,
          title: videoAssetPreviewProject.title,
        })

        // Persist a dedicated image thumbnail for grid cards while keeping the mp4 playback preview.
        await generateVideoPreview(resolvedStoragePath, tempThumbnailPath, durationSeconds)

        const playbackStat = fs.statSync(tempPlaybackPath)
        if (!playbackStat.isFile() || playbackStat.size === 0) {
          throw new Error('Playback preview output file is empty')
        }
        const thumbnailStat = fs.statSync(tempThumbnailPath)
        if (!thumbnailStat.isFile() || thumbnailStat.size === 0) {
          throw new Error('Thumbnail preview output file is empty')
        }

        await uploadFile(previewStoragePath, fs.createReadStream(tempThumbnailPath) as any, thumbnailStat.size, 'image/jpeg')
        await uploadFile(playbackPreviewStoragePath!, fs.createReadStream(tempPlaybackPath) as any, playbackStat.size, 'video/mp4')

        const previewFileSize = BigInt(playbackStat.size)
        await updateRecordSuccess(type, recordId, playbackPreviewStoragePath!, previewFileSize)
      } else {
        await generateVideoPreview(resolvedStoragePath, tempThumbnailPath, durationSeconds)

        const stat = fs.statSync(tempThumbnailPath)
        if (!stat.isFile() || stat.size === 0) {
          throw new Error('Preview output file is empty')
        }

        await uploadFile(previewStoragePath, fs.createReadStream(tempThumbnailPath) as any, stat.size, 'image/jpeg')
        const previewFileSize = BigInt(stat.size)
        await updateRecordSuccess(type, recordId, previewStoragePath, previewFileSize)
      }
    }

    if (projectIdForPreviewBytes) {
      await recalculateAndStoreProjectPreviewBytes(projectIdForPreviewBytes).catch(() => {})
    }

    if (shouldGenerateVideoAssetPlaybackPreview) {
      const playbackStat = fs.statSync(tempPlaybackPath)
      const thumbnailStat = fs.statSync(tempThumbnailPath)
      console.log(`[PREVIEW] Generated preview for ${type}:${recordId} → ${playbackPreviewStoragePath} (${playbackStat.size} bytes), thumbnail → ${previewStoragePath} (${thumbnailStat.size} bytes)`)
    } else {
      const stat = fs.statSync(tempThumbnailPath)
      console.log(`[PREVIEW] Generated preview for ${type}:${recordId} → ${previewStoragePath} (${stat.size} bytes)`)
    }
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
      fileType: { startsWith: 'video/' },
    },
    select: {
      id: true,
      storagePath: true,
      fileType: true,
      fileName: true,
      previewStatus: true,
      previewPath: true,
      previewAttempts: true,
      previewGeneratedAt: true,
    },
    take: Math.floor(BATCH_CAP / 4),
  })

  const videoAssetsVideoToQueue: typeof videoAssetsVideo = []
  for (const asset of videoAssetsVideo) {
    const previewPath = String(asset.previewPath || '').toLowerCase()
    const isStaleReadyPreview = asset.previewStatus === 'READY' && previewPath.length > 0 && !previewPath.endsWith('.mp4')
    const needsRetry =
      asset.previewStatus === null ||
      asset.previewStatus === 'PENDING' ||
      (
        asset.previewStatus === 'FAILED' &&
        (asset.previewAttempts ?? 0) < MAX_PREVIEW_ATTEMPTS &&
        (!asset.previewGeneratedAt || asset.previewGeneratedAt < twoHoursAgo)
      )
    if (isStaleReadyPreview || needsRetry) {
      videoAssetsVideoToQueue.push(asset)
    } else if (asset.previewStatus === 'READY' && previewPath.endsWith('.mp4') && asset.previewPath) {
      // The MP4 playback preview exists in the DB; check whether the companion JPG thumbnail
      // was also generated. Assets processed before companion-JPG generation was introduced
      // will have only the MP4 — detect and re-enqueue so the worker can backfill the JPG
      // without re-encoding the video.
      const companionJpgPath = asset.previewPath.replace(/\.mp4$/i, '.jpg')
      const companionExists = await previewExists(companionJpgPath)
      if (!companionExists) {
        videoAssetsVideoToQueue.push(asset)
      }
    }
  }

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

  for (const a of videoAssetsVideoToQueue) {
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
