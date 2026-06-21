import path from 'path'
import os from 'os'
import fs from 'fs/promises'
import { prisma } from '@/lib/db'
import { generateTimelineSprite, getVideoMetadata } from '@/lib/ffmpeg'
import { moveUploadedFile } from '@/lib/storage'
import { materializeStoragePathToLocalFile } from '@/lib/storage-provider'
import { buildAssetTimelineStorageRoot, buildUploadTimelineStorageRoot } from '@/lib/project-storage-paths'
import { getStoredFilePath, registerStoredFile } from '@/lib/stored-file'
import { TEMP_DIR as WORKER_TEMP_DIR } from './cleanup'
import type { AssetTimelineJob, UploadTimelineJob } from '@/lib/queue'

const DEBUG = process.env.DEBUG_FFMPEG === 'true'
// Scratch space for sprite generation. Use the shared worker temp dir (under
// STORAGE_ROOT, created at startup and swept by cleanupOldTempFiles) rather than
// a path under process.cwd() — in the container cwd is /app, which the non-root
// worker user cannot write to (EACCES on mkdir '/app/temp').
const TEMP_DIR = process.env.TEMP_DIR || WORKER_TEMP_DIR

function calculateScaledHeight(inputWidth: number, inputHeight: number, targetWidth: number): number {
  if (inputWidth <= 0 || inputHeight <= 0) return 90
  const aspect = inputWidth / inputHeight
  const raw = targetWidth / aspect
  return Math.max(2, Math.round(raw / 2) * 2)
}

function formatVttTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds)
  const hours = Math.floor(clamped / 3600)
  const minutes = Math.floor((clamped % 3600) / 60)
  const secs = Math.floor(clamped % 60)
  const ms = Math.floor((clamped - Math.floor(clamped)) * 1000)
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const pad3 = (n: number) => String(n).padStart(3, '0')
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)}.${pad3(ms)}`
}

async function generateTimelinePreviews(params: {
  inputPath: string
  outputSpritesPath: string
  durationSeconds: number
  videoWidth: number
  videoHeight: number
  tempDirPrefix: string
}): Promise<{ vttPath: string; spritesPath: string; ready: boolean } | null> {
  const { inputPath, outputSpritesPath, durationSeconds, videoWidth, videoHeight, tempDirPrefix } = params

  const intervalSeconds = 5
  const tileColumns = 10
  const tileRows = 10
  const framesPerSprite = tileColumns * tileRows
  const frameWidth = 320
  const frameHeight = calculateScaledHeight(videoWidth, videoHeight, frameWidth)
  const segmentDurationSeconds = framesPerSprite * intervalSeconds

  if (durationSeconds <= 0) return null

  const tempDir = path.join(TEMP_DIR, `${tempDirPrefix}-timeline`)
  await fs.mkdir(tempDir, { recursive: true })

  const spriteCount = Math.ceil(durationSeconds / segmentDurationSeconds)
  const vttLines: string[] = ['WEBVTT', '']

  for (let spriteIndex = 0; spriteIndex < spriteCount; spriteIndex++) {
    const segmentStart = spriteIndex * segmentDurationSeconds
    const remaining = Math.max(0, durationSeconds - segmentStart)
    if (remaining <= 0) break

    const segmentDuration = Math.min(segmentDurationSeconds, remaining)
    const spriteFileName = `sprite-${String(spriteIndex).padStart(3, '0')}.jpg`
    const tempSpritePath = path.join(tempDir, spriteFileName)

    await generateTimelineSprite({
      inputPath,
      outputPath: tempSpritePath,
      startTimeSeconds: segmentStart,
      durationSeconds: segmentDuration,
      intervalSeconds,
      tileColumns,
      tileRows,
      frameWidth,
    })

    if (DEBUG) console.log(`[WORKER] Timeline sprite ${spriteIndex + 1}/${spriteCount} generated`)

    for (let frameIndex = 0; frameIndex < framesPerSprite; frameIndex++) {
      const cueStart = segmentStart + frameIndex * intervalSeconds
      if (cueStart >= durationSeconds) break
      const cueEnd = Math.min(durationSeconds, cueStart + intervalSeconds)
      const col = frameIndex % tileColumns
      const row = Math.floor(frameIndex / tileColumns)
      vttLines.push(`${formatVttTimestamp(cueStart)} --> ${formatVttTimestamp(cueEnd)}`)
      vttLines.push(`${spriteFileName}#xywh=${col * frameWidth},${row * frameHeight},${frameWidth},${frameHeight}`)
      vttLines.push('')
    }
  }

  const tempVttPath = path.join(tempDir, 'index.vtt')
  await fs.writeFile(tempVttPath, vttLines.join('\n'), 'utf-8')
  const vttPath = `${outputSpritesPath}/index.vtt`
  const vttStats = await fs.stat(tempVttPath)
  await moveUploadedFile(tempVttPath, vttPath, vttStats.size)

  const localFiles = await fs.readdir(tempDir)
  const spriteFiles = localFiles.filter((f) => f.startsWith('sprite-') && f.endsWith('.jpg'))
  for (const spriteFile of spriteFiles) {
    const spriteFullPath = path.join(tempDir, spriteFile)
    const spriteStats = await fs.stat(spriteFullPath)
    await moveUploadedFile(spriteFullPath, `${outputSpritesPath}/${spriteFile}`, spriteStats.size)
  }

  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  return { vttPath, spritesPath: outputSpritesPath, ready: true }
}

export async function processAssetTimeline(job: { data: AssetTimelineJob }): Promise<void> {
  const { assetId, videoId, storagePath, durationSeconds, width, height } = job.data
  console.log(`[WORKER] Starting asset timeline generation for asset ${assetId}`)

  // Resolve original storage path from StoredFile if not provided
  const resolvedStoragePath = storagePath || await getStoredFilePath('VIDEO_ASSET', assetId, 'ORIGINAL') || ''

  await prisma.videoAsset.update({ where: { id: assetId }, data: { processingPhase: 'timeline', processingProgress: 0 } }).catch(() => {})

  let materializedInput: { localPath: string; isTemporary: boolean } | null = null
  try {
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      include: { project: { select: { storagePath: true } } },
    })
    if (!video?.project) { console.error(`[WORKER] Video ${videoId} not found`); return }

    // Materialize the asset file from S3 (or use local path in local mode)
    materializedInput = await materializeStoragePathToLocalFile({
      rawPath: resolvedStoragePath,
      tempDir: path.join(os.tmpdir(), 'vitransfer-asset-timeline'),
      suggestedName: `${assetId}-source.bin`,
    })
    const inputPath = materializedInput.localPath

    // Probe file for metadata if not provided (covers existing assets without populated metadata)
    let effectiveDuration = durationSeconds
    let effectiveWidth = width
    let effectiveHeight = height
    if (!effectiveDuration || !effectiveWidth || !effectiveHeight) {
      try {
        const metadata = await getVideoMetadata(inputPath)
        effectiveDuration = effectiveDuration || metadata.duration || 0
        effectiveWidth = effectiveWidth || metadata.width || 0
        effectiveHeight = effectiveHeight || metadata.height || 0
        // Persist the metadata for future use
        await prisma.videoAsset.update({ where: { id: assetId }, data: {
          mediaDurationSeconds: effectiveDuration || undefined,
          mediaWidth: effectiveWidth || undefined,
          mediaHeight: effectiveHeight || undefined,
        }}).catch(() => {})
        console.log(`[WORKER] Probed metadata for asset ${assetId}: ${effectiveWidth}x${effectiveHeight}, ${effectiveDuration}s`)
      } catch (err) {
        console.error(`[WORKER] Failed to probe metadata for asset ${assetId}:`, err)
        await prisma.videoAsset.update({ where: { id: assetId }, data: { processingPhase: null, processingProgress: 0 } }).catch(() => {})
        return
      }
    }

    const spritesPath = buildAssetTimelineStorageRoot(
      video.project.storagePath || '', video.storageFolderName || video.name, video.versionLabel, assetId,
    )
    const result = await generateTimelinePreviews({
      inputPath, outputSpritesPath: spritesPath,
      durationSeconds: effectiveDuration, videoWidth: effectiveWidth, videoHeight: effectiveHeight, tempDirPrefix: `asset-${assetId}`,
    })

    if (result?.ready) {
      // Register timeline paths via the registry helper so projectId is populated.
      await Promise.all([
        registerStoredFile({ entityType: 'VIDEO_ASSET', entityId: assetId, fileRole: 'TIMELINE_VTT', storagePath: result.vttPath, status: 'READY' }),
        registerStoredFile({ entityType: 'VIDEO_ASSET', entityId: assetId, fileRole: 'TIMELINE_SPRITES', storagePath: result.spritesPath, status: 'READY' }),
        prisma.videoAsset.update({ where: { id: assetId }, data: {
          timelinePreviewsReady: true,
          processingPhase: null, processingProgress: 100,
        }}),
      ])
      console.log(`[WORKER] Asset timeline done: ${assetId}`)
    } else {
      console.error(`[WORKER] Asset timeline generation returned null/not-ready for ${assetId} (duration=${effectiveDuration})`)
      await prisma.videoAsset.update({ where: { id: assetId }, data: { processingPhase: null, processingProgress: 0 } }).catch(() => {})
    }
  } catch (err) {
    console.error(`[WORKER ERROR] Asset timeline failed for ${assetId}:`, err)
    await prisma.videoAsset.update({ where: { id: assetId }, data: { processingPhase: null, processingProgress: 0 } }).catch(() => {})
    throw err
  } finally {
    if (materializedInput?.isTemporary) {
      fs.unlink(materializedInput.localPath).catch(() => {})
    }
  }
}

export async function processUploadTimeline(job: { data: UploadTimelineJob }): Promise<void> {
  const { uploadFileId, projectId, storagePath, durationSeconds, width, height } = job.data
  console.log(`[WORKER] Starting upload timeline generation for upload ${uploadFileId}`)

  // Resolve original storage path from StoredFile if not provided
  const resolvedStoragePath = storagePath || await getStoredFilePath('SHARE_UPLOAD_FILE', uploadFileId, 'ORIGINAL') || ''

  await prisma.shareUploadFile.update({ where: { id: uploadFileId }, data: { processingPhase: 'timeline', processingProgress: 0 } }).catch(() => {})

  let materializedInput: { localPath: string; isTemporary: boolean } | null = null
  try {
    const [project, uploadFile] = await Promise.all([
      prisma.project.findUnique({ where: { id: projectId }, select: { storagePath: true } }),
      prisma.shareUploadFile.findUnique({ where: { id: uploadFileId }, select: { folderRelativePath: true } }),
    ])
    if (!project || !uploadFile) { console.error(`[WORKER] Project/upload not found`); return }

    // Materialize the upload file from S3 (or use local path in local mode)
    materializedInput = await materializeStoragePathToLocalFile({
      rawPath: resolvedStoragePath,
      tempDir: path.join(os.tmpdir(), 'vitransfer-upload-timeline'),
      suggestedName: `${uploadFileId}-source.bin`,
    })
    const inputPath = materializedInput.localPath

    // Probe file for metadata if not provided
    let effectiveDuration = durationSeconds
    let effectiveWidth = width
    let effectiveHeight = height
    if (!effectiveDuration || !effectiveWidth || !effectiveHeight) {
      try {
        const metadata = await getVideoMetadata(inputPath)
        effectiveDuration = effectiveDuration || metadata.duration || 0
        effectiveWidth = effectiveWidth || metadata.width || 0
        effectiveHeight = effectiveHeight || metadata.height || 0
        await prisma.shareUploadFile.update({ where: { id: uploadFileId }, data: {
          mediaDurationSeconds: effectiveDuration || undefined,
          mediaWidth: effectiveWidth || undefined,
          mediaHeight: effectiveHeight || undefined,
        }}).catch(() => {})
      } catch (err) {
        console.error(`[WORKER] Failed to probe metadata for upload ${uploadFileId}:`, err)
        await prisma.shareUploadFile.update({ where: { id: uploadFileId }, data: { processingPhase: null, processingProgress: 0 } }).catch(() => {})
        return
      }
    }

    const spritesPath = buildUploadTimelineStorageRoot(project.storagePath || '', uploadFile.folderRelativePath, uploadFileId)
    const result = await generateTimelinePreviews({
      inputPath, outputSpritesPath: spritesPath,
      durationSeconds: effectiveDuration, videoWidth: effectiveWidth, videoHeight: effectiveHeight, tempDirPrefix: `upload-${uploadFileId}`,
    })

    if (result?.ready) {
      // Register timeline paths via the registry helper so projectId is populated.
      await Promise.all([
        registerStoredFile({ entityType: 'SHARE_UPLOAD_FILE', entityId: uploadFileId, fileRole: 'TIMELINE_VTT', storagePath: result.vttPath, status: 'READY' }),
        registerStoredFile({ entityType: 'SHARE_UPLOAD_FILE', entityId: uploadFileId, fileRole: 'TIMELINE_SPRITES', storagePath: result.spritesPath, status: 'READY' }),
        prisma.shareUploadFile.update({ where: { id: uploadFileId }, data: {
          timelinePreviewsReady: true,
          processingPhase: null, processingProgress: 100,
        }}),
      ])
      console.log(`[WORKER] Upload timeline done: ${uploadFileId}`)
    } else {
      console.error(`[WORKER] Upload timeline generation returned null/not-ready for ${uploadFileId} (duration=${effectiveDuration})`)
      await prisma.shareUploadFile.update({ where: { id: uploadFileId }, data: { processingPhase: null, processingProgress: 0 } }).catch(() => {})
    }
  } catch (err) {
    await prisma.shareUploadFile.update({ where: { id: uploadFileId }, data: { processingPhase: null, processingProgress: 0 } }).catch(() => {})
    throw err
  } finally {
    if (materializedInput?.isTemporary) {
      fs.unlink(materializedInput.localPath).catch(() => {})
    }
  }
}
