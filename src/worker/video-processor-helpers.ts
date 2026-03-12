import { prisma } from '../lib/db'
import { getFilePath, moveUploadedFile } from '../lib/storage'
import { materializeStoragePathToLocalFile } from '../lib/storage-provider'
import { transcodeVideo, generateThumbnail, getVideoMetadata, VideoMetadata, generateTimelineSprite, FFmpegCancellationError } from '../lib/ffmpeg'
import { Prisma, type VideoStatus } from '@prisma/client'
import {
  buildProjectStorageRoot,
  buildVideoPreviewStoragePath,
  buildVideoThumbnailStoragePath,
  buildVideoTimelineStorageRoot,
} from '@/lib/project-storage-paths'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { TEMP_DIR } from './cleanup'
import {
  getPreviewProcessingPhase,
  PROCESSING_PHASES,
  VALID_PREVIEW_RESOLUTIONS,
  type PreviewResolution,
} from '@/lib/video-processing-phase'

const DEBUG = process.env.DEBUG_WORKER === 'true'

// Constants (no more magic numbers!)
export const RESOLUTION_PRESETS = {
  '480p': { horizontal: { width: 854, height: 480 }, verticalWidth: 480 },
  '720p': { horizontal: { width: 1280, height: 720 }, verticalWidth: 720 },
  '1080p': { horizontal: { width: 1920, height: 1080 }, verticalWidth: 1080 }
} as const

export const VALID_RESOLUTIONS = VALID_PREVIEW_RESOLUTIONS
export type Resolution = PreviewResolution

async function getCanonicalVideoStorageContext(videoId: string): Promise<{ projectStoragePath: string; videoFolderName: string; versionLabel: string }> {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: {
      name: true,
      version: true,
      versionLabel: true,
      storageFolderName: true,
      project: {
        select: {
          storagePath: true,
          title: true,
          companyName: true,
          client: { select: { name: true } },
        },
      },
    },
  })

  const project = video?.project
  return {
    projectStoragePath: project?.storagePath
      || buildProjectStorageRoot(project?.client?.name || project?.companyName || 'Client', project?.title || 'Untitled'),
    videoFolderName: video?.storageFolderName || video?.name || videoId,
    versionLabel: video?.versionLabel || `v${video?.version ?? 1}`,
  }
}

/**
 */
export function parseResolutions(raw: string | null | undefined): Resolution[] {
  if (!raw) return ['720p']
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) return ['720p']
    const valid = parsed.filter((r: unknown): r is Resolution =>
      typeof r === 'string' && VALID_RESOLUTIONS.includes(r as Resolution)
    )
    return valid.length > 0 ? valid : ['720p']
  } catch {
    // Legacy single-value format
    if (typeof raw === 'string' && VALID_RESOLUTIONS.includes(raw as Resolution)) {
      return [raw as Resolution]
    }
    return ['720p']
  }
}

export const THUMBNAIL_CONFIG = {
  percentage: 0.1,  // 10% into video
  min: 0.5,         // Minimum 0.5 seconds
  max: 10           // Maximum 10 seconds
} as const

export const VALID_VIDEO_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
  'video/x-matroska',
  'video/avi',
  'video/x-ms-wmv',
  'video/mpeg'
] as const

// Types
export interface TempFiles {
  input?: string
  preview?: string
  thumbnail?: string
  timelineDir?: string
}

export interface ProcessingSettings {
  resolutions: Resolution[]
  watermarkText?: string
  timelinePreviewsEnabled: boolean
}

export class PreviewResolutionCancelledError extends Error {
  constructor(public readonly resolution: Resolution) {
    super(`Preview generation cancelled for ${resolution}`)
    this.name = 'PreviewResolutionCancelledError'
  }
}

export function filterRequestedResolutions(
  requested: Array<'480p' | '720p' | '1080p'> | undefined,
  available: Resolution[]
): Resolution[] {
  if (!requested || requested.length === 0) return available

  const requestedSet = new Set(requested)
  const filtered = available.filter((resolution) => requestedSet.has(resolution))
  return filtered.length > 0 ? filtered : available
}

export interface VideoInfo {
  path: string
  metadata: VideoMetadata
  fileSize: number
}

export interface OutputDimensions {
  width: number
  height: number
}

// Debug logging helper
export function debugLog(message: string, data?: any) {
  if (!DEBUG) return

  if (data !== undefined) {
    console.log(`[WORKER DEBUG] ${message}`, data)
  } else {
    console.log(`[WORKER DEBUG] ${message}`)
  }
}
export class VideoRecordMissingError extends Error {
  constructor(videoId: string, context?: string) {
    super(`Video ${videoId} was removed during processing${context ? ` (${context})` : ''}`)
    this.name = 'VideoRecordMissingError'
  }
}

function isVideoRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025'
}

export function isVideoRecordMissingError(error: unknown): error is VideoRecordMissingError {
  return error instanceof VideoRecordMissingError
}

export async function updateVideoRecord(
  videoId: string,
  data: Prisma.VideoUpdateInput,
  options?: {
    context?: string
    ignoreMissing?: boolean
  }
): Promise<boolean> {
  try {
    await prisma.video.update({
      where: { id: videoId },
      data,
    })
    return true
  } catch (error) {
    if (!isVideoRecordNotFound(error)) {
      throw error
    }

    const contextSuffix = options?.context ? ` during ${options.context}` : ''
    if (options?.ignoreMissing) {
      console.warn(`[WORKER] Video ${videoId} no longer exists${contextSuffix}; skipping update`)
      return false
    }

    throw new VideoRecordMissingError(videoId, options?.context)
  }
}

/**
 * Move a file from the worker temp directory to its final storage location.
 * Uses atomic fs.rename when both paths are on the same filesystem (zero-cost),
 * with a stream-copy + unlink fallback for cross-device (EXDEV) edge cases.
 */
async function moveToStorage(srcPath: string, destPath: string): Promise<void> {
  const destDir = path.dirname(destPath)
  await fs.promises.mkdir(destDir, { recursive: true })

  try {
    await fs.promises.rename(srcPath, destPath)
  } catch (err: any) {
    if (err?.code === 'EXDEV') {
      // Cross-device fallback: stream-copy then remove original
      const readStream = fs.createReadStream(srcPath)
      const writeStream = fs.createWriteStream(destPath)
      await pipeline(readStream, writeStream)
      await fs.promises.unlink(srcPath).catch(() => {})
    } else {
      throw err
    }
  }
}

async function moveTempFileToLogicalStorage(srcPath: string, destLogicalPath: string): Promise<void> {
  const stats = await fs.promises.stat(srcPath)
  await moveUploadedFile(srcPath, destLogicalPath, stats.size)
}

/**
 * Resolve original video path in storage and validate content.
 * Reads directly from STORAGE_ROOT — no temp copy needed.
 */
export async function downloadAndValidateVideo(
  videoId: string,
  storagePath: string,
  tempFiles: TempFiles
): Promise<VideoInfo> {
  debugLog('Starting validation...')

  const resolvedInput = await materializeStoragePathToLocalFile({
    rawPath: storagePath,
    tempDir: TEMP_DIR,
    suggestedName: `${videoId}-source.bin`,
  })
  const inputPath = resolvedInput.localPath

  if (resolvedInput.isTemporary) {
    tempFiles.input = inputPath
  }

  debugLog('Reading original directly from:', inputPath)

  // Verify file exists and has content
  const stats = fs.statSync(inputPath)
  if (stats.size === 0) {
    throw new Error('Original file is empty')
  }

  const fileSize = stats.size
  console.log(`[WORKER] Original file size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`)

  debugLog('File verification passed')

  // Validate file content (magic bytes)
  debugLog('Validating magic bytes...')

  // Note: `file-type` exports a Node-only `fileTypeFromFile` under the `node` condition.
  // During Next.js build/typecheck this can resolve to the default (core) export instead.
  // Using the core API keeps it compatible across bundler conditions.
  const { fileTypeFromBuffer } = await import('file-type/core')

  const sampleSize = 4100
  const sampleBuffer = Buffer.alloc(Math.min(sampleSize, stats.size))
  const fileHandle = await fs.promises.open(inputPath, 'r')
  try {
    await fileHandle.read(sampleBuffer, 0, sampleBuffer.length, 0)
  } finally {
    await fileHandle.close()
  }

  const fileType = await fileTypeFromBuffer(sampleBuffer)
  if (!fileType) {
    throw new Error('Could not determine file type from content')
  }

  if (!VALID_VIDEO_TYPES.includes(fileType.mime as any)) {
    throw new Error(`File content does not match a valid video format. Detected: ${fileType.mime}`)
  }

  console.log(`[WORKER] Magic byte validation passed - detected type: ${fileType.mime}`)
  debugLog('File is a valid video format')

  // Get video metadata
  debugLog('Extracting video metadata...')

  const metadataStart = Date.now()
  const metadata = await getVideoMetadata(inputPath)
  const metadataTime = Date.now() - metadataStart

  console.log(`[WORKER] Video metadata:`, metadata)
  debugLog('Metadata extraction took:', (metadataTime / 1000).toFixed(2) + ' s')

  return {
    path: inputPath,
    metadata,
    fileSize
  }
}

/**
 * Fetch project and video settings for processing
 */
export async function fetchProcessingSettings(
  projectId: string,
  videoId: string
): Promise<ProcessingSettings> {
  debugLog('Fetching processing settings...')

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true,
      previewResolutions: true,
      watermarkEnabled: true,
      watermarkText: true,
      timelinePreviewsEnabled: true,
    },
  })

  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: { versionLabel: true },
  })

  const resolutions = parseResolutions(project?.previewResolutions)

  debugLog('Project settings:', {
    title: project?.title,
    resolutions,
    watermarkEnabled: project?.watermarkEnabled
  })

  // Determine watermark text (only if watermarks are enabled)
  const watermarkText = project?.watermarkEnabled
    ? (project.watermarkText || `PREVIEW-${project.title || 'PROJECT'}-${video?.versionLabel || 'v1'}`)
    : undefined

  debugLog('Final watermark text:', watermarkText || '(no watermark)')

  return {
    resolutions,
    watermarkText,
    timelinePreviewsEnabled: project?.timelinePreviewsEnabled ?? false,
  }
}

export async function fetchProjectPreviewResolutions(projectId: string): Promise<Resolution[]> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { previewResolutions: true },
  })

  return parseResolutions(project?.previewResolutions)
}

export async function isPreviewResolutionStillRequested(
  projectId: string,
  requestedPreviewResolutions: Array<'480p' | '720p' | '1080p'> | undefined,
  resolution: Resolution
): Promise<boolean> {
  const availableResolutions = await fetchProjectPreviewResolutions(projectId)
  const filteredResolutions = filterRequestedResolutions(requestedPreviewResolutions, availableResolutions)
  return filteredResolutions.includes(resolution)
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

function calculateScaledHeight(inputWidth: number, inputHeight: number, targetWidth: number): number {
  if (inputWidth <= 0 || inputHeight <= 0) return 90
  const aspect = inputWidth / inputHeight
  const raw = targetWidth / aspect
  // Ensure even height like ffmpeg scale=-2
  return Math.max(2, Math.round(raw / 2) * 2)
}

export async function processTimelinePreviews(
  videoId: string,
  projectId: string,
  inputPath: string,
  metadata: VideoMetadata,
  tempFiles: TempFiles
): Promise<{ vttPath: string; spritesPath: string; ready: boolean } | null> {
  const intervalSeconds = 10
  const tileColumns = 10
  const tileRows = 10
  const framesPerSprite = tileColumns * tileRows
  const frameWidth = 160
  const frameHeight = calculateScaledHeight(metadata.width, metadata.height, frameWidth)
  const segmentDurationSeconds = framesPerSprite * intervalSeconds

  const totalDuration = metadata.duration || 0
  if (totalDuration <= 0) {
    return null
  }

  const tempDir = path.join(TEMP_DIR, `${videoId}-timeline`)
  tempFiles.timelineDir = tempDir
  await fs.promises.mkdir(tempDir, { recursive: true })

  const spriteCount = Math.ceil(totalDuration / segmentDurationSeconds)
  const vttLines: string[] = ['WEBVTT', '']

  await updateVideoRecord(
    videoId,
    {
      processingProgress: 0,
      processingPhase: PROCESSING_PHASES.timeline,
    },
    { context: 'starting timeline preview generation', ignoreMissing: false }
  )

  // Each phase tracks its own 0→1 progress independently.
  let lastTimelineProgressUpdate = 0
  let timelineProgressInFlight = false

  for (let spriteIndex = 0; spriteIndex < spriteCount; spriteIndex++) {
    const segmentStart = spriteIndex * segmentDurationSeconds
    const remaining = Math.max(0, totalDuration - segmentStart)
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

    // Update progress: each sprite is a fraction of the timeline phase (0→1)
    const spriteProgress = (spriteIndex + 1) / spriteCount

    const now = Date.now()
    if (!timelineProgressInFlight && (now - lastTimelineProgressUpdate >= 2000 || spriteIndex === spriteCount - 1)) {
      timelineProgressInFlight = true
      lastTimelineProgressUpdate = now
      try {
        await updateVideoRecord(
          videoId,
          {
            processingProgress: spriteProgress,
            processingPhase: PROCESSING_PHASES.timeline,
          },
          { context: 'updating timeline preview progress', ignoreMissing: true }
        )
      } catch (err) {
        console.error(`[WORKER] Failed to update timeline progress for ${videoId}:`, err)
      } finally {
        timelineProgressInFlight = false
      }
    }

    debugLog(`Timeline sprite ${spriteIndex + 1}/${spriteCount} generated (${Math.round(spriteProgress * 100)}%)`)

    // Generate VTT cues for each tile in the sprite
    for (let frameIndex = 0; frameIndex < framesPerSprite; frameIndex++) {
      const cueStart = segmentStart + frameIndex * intervalSeconds
      if (cueStart >= totalDuration) break
      const cueEnd = Math.min(totalDuration, cueStart + intervalSeconds)

      const col = frameIndex % tileColumns
      const row = Math.floor(frameIndex / tileColumns)
      const x = col * frameWidth
      const y = row * frameHeight

      vttLines.push(`${formatVttTimestamp(cueStart)} --> ${formatVttTimestamp(cueEnd)}`)
      vttLines.push(`${spriteFileName}#xywh=${x},${y},${frameWidth},${frameHeight}`)
      vttLines.push('')
    }
  }

  const tempVttPath = path.join(tempDir, 'index.vtt')
  await fs.promises.writeFile(tempVttPath, vttLines.join('\n'), 'utf-8')

  // Move VTT + sprites to storage (atomic rename on same filesystem)
  const storageContext = await getCanonicalVideoStorageContext(videoId)
  const spritesPath = buildVideoTimelineStorageRoot(storageContext.projectStoragePath, storageContext.videoFolderName, storageContext.versionLabel)
  const vttPath = `${spritesPath}/index.vtt`

  await moveTempFileToLogicalStorage(tempVttPath, vttPath)

  const localFiles = await fs.promises.readdir(tempDir)
  const spriteFiles = localFiles.filter((f) => f.startsWith('sprite-') && f.endsWith('.jpg'))
  for (const spriteFile of spriteFiles) {
    const localSpritePath = path.join(tempDir, spriteFile)
    await moveTempFileToLogicalStorage(localSpritePath, `${spritesPath}/${spriteFile}`)
  }

  return { vttPath, spritesPath, ready: true }
}

/**
 * Calculate output dimensions based on input metadata and target resolution
 * Pure function - easy to test!
 */
export function calculateOutputDimensions(
  metadata: VideoMetadata,
  resolution: string
): OutputDimensions {
  const inputWidth = Number(metadata.width) || 0
  const inputHeight = Number(metadata.height) || 0

  // Fall back to a safe default if metadata is missing.
  if (inputWidth <= 0 || inputHeight <= 0) {
    const fallback = RESOLUTION_PRESETS[resolution as keyof typeof RESOLUTION_PRESETS] || RESOLUTION_PRESETS['720p']
    return fallback.horizontal
  }

  const isVertical = inputHeight > inputWidth
  const aspectRatio = inputWidth / inputHeight

  console.log(
    `[WORKER] Video orientation: ${isVertical ? 'vertical' : 'horizontal'} (${inputWidth}x${inputHeight}, ratio: ${aspectRatio.toFixed(2)})`
  )

  const preset = RESOLUTION_PRESETS[resolution as keyof typeof RESOLUTION_PRESETS] || RESOLUTION_PRESETS['720p']

  // Fit-to-box (no stretching): preserve source aspect ratio while staying within a target bounding box.
  // For vertical, we use a portrait-ish bounding box by swapping the horizontal dimensions.
  const maxWidth = isVertical ? preset.verticalWidth : preset.horizontal.width
  const maxHeight = isVertical ? preset.horizontal.width : preset.horizontal.height

  const scale = Math.min(maxWidth / inputWidth, maxHeight / inputHeight)

  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  const width = even(inputWidth * scale)
  const height = even(inputHeight * scale)

  const dimensions: OutputDimensions = { width, height }
  console.log(`[WORKER] Output resolution: ${dimensions.width}x${dimensions.height}`)

  debugLog('Resolution calculation:', {
    setting: resolution,
    isVertical,
    inputDimensions: `${inputWidth}x${inputHeight}`,
    outputDimensions: `${dimensions.width}x${dimensions.height}`,
    aspectRatio: aspectRatio.toFixed(2)
  })

  return dimensions
}

/**
 * Transcode video and upload preview
 */
export async function processPreview(
  videoId: string,
  projectId: string,
  inputPath: string,
  dimensions: OutputDimensions,
  settings: ProcessingSettings & { resolution: Resolution },
  tempFiles: TempFiles,
  duration: number,
  requestedPreviewResolutions?: Array<'480p' | '720p' | '1080p'>
): Promise<string | null> {
  const resolution = settings.resolution
  const tempPreviewPath = path.join(TEMP_DIR, `${videoId}-preview-${resolution}.mp4`)
  tempFiles.preview = tempPreviewPath

  debugLog('Starting video transcoding...')
  debugLog('Temp preview path:', tempPreviewPath)

  const transcodeStart = Date.now()

  // Throttle progress DB writes to avoid exhausting the Prisma connection pool.
  // FFmpeg emits progress many times per second; we only persist every 3 seconds.
  let lastProgressUpdate = 0
  let progressWriteInFlight = false

  try {
    await transcodeVideo({
      inputPath,
      outputPath: tempPreviewPath,
      width: dimensions.width,
      height: dimensions.height,
      watermarkText: settings.watermarkText,
      shouldAbort: async () => {
        const stillRequested = await isPreviewResolutionStillRequested(
          projectId,
          requestedPreviewResolutions,
          resolution
        )
        return !stillRequested
      },
      onProgress: async (progress) => {
        debugLog(`Transcode progress: ${(progress * 100).toFixed(1)}%`)

        const now = Date.now()
        // Skip if another write is still in flight or if less than 3 s since last write
        // Always allow the final progress update (progress >= 1)
        if (progressWriteInFlight || (now - lastProgressUpdate < 3000 && progress < 1)) {
          return
        }

        progressWriteInFlight = true
        lastProgressUpdate = now
        try {
          await updateVideoRecord(
            videoId,
            {
              processingProgress: progress,
              processingPhase: getPreviewProcessingPhase(resolution),
            },
            { context: 'updating transcode progress', ignoreMissing: true }
          )
        } catch (err) {
          console.error(`[WORKER] Failed to update progress for ${videoId}:`, err)
        } finally {
          progressWriteInFlight = false
        }
      },
    })
  } catch (error) {
    if (error instanceof FFmpegCancellationError) {
      console.log(`[WORKER] Cancelled ${resolution} preview generation for video ${videoId} because project settings changed`)
      throw new PreviewResolutionCancelledError(resolution)
    }
    throw error
  }

  const transcodeTime = Date.now() - transcodeStart
  console.log(`[WORKER] Generated ${resolution} preview for video ${videoId} in ${(transcodeTime / 1000).toFixed(2)}s`)

  const transcodeStats = fs.statSync(tempPreviewPath)
  debugLog('Transcoded file size:', (transcodeStats.size / 1024 / 1024).toFixed(2) + ' MB')

  // Move preview to storage (atomic rename on same filesystem, stream-copy fallback)
  const storageContext = await getCanonicalVideoStorageContext(videoId)
  const previewPath = buildVideoPreviewStoragePath(
    storageContext.projectStoragePath,
    storageContext.videoFolderName,
    storageContext.versionLabel,
    resolution,
  )

  debugLog('Moving preview to logical path:', previewPath)

  const moveStart = Date.now()
  await moveTempFileToLogicalStorage(tempPreviewPath, previewPath)
  // File has been moved — remove from tempFiles so cleanup doesn't try to delete a missing file
  delete tempFiles.preview
  const moveTime = Date.now() - moveStart

  debugLog('Preview moved in:', (moveTime / 1000).toFixed(2) + ' s')

  return previewPath
}

/**
 * Generate thumbnail and upload
 */
export async function processThumbnail(
  videoId: string,
  projectId: string,
  inputPath: string,
  duration: number,
  tempFiles: TempFiles
): Promise<string> {
  // Calculate thumbnail timestamp using constants
  const timestamp = Math.min(
    Math.max(duration * THUMBNAIL_CONFIG.percentage, THUMBNAIL_CONFIG.min),
    THUMBNAIL_CONFIG.max
  )

  const tempThumbnailPath = path.join(TEMP_DIR, `${videoId}-thumb.jpg`)
  tempFiles.thumbnail = tempThumbnailPath

  debugLog('Generating thumbnail...')
  debugLog('Thumbnail timestamp:', timestamp + ' s')

  const thumbStart = Date.now()
  await generateThumbnail(inputPath, tempThumbnailPath, timestamp)
  const thumbTime = Date.now() - thumbStart

  console.log(`[WORKER] Generated thumbnail for video ${videoId} in ${(thumbTime / 1000).toFixed(2)}s`)

  // Update progress to reflect thumbnail completion (instant phase, just mark done)
  try {
    await updateVideoRecord(
      videoId,
      {
        processingProgress: 1,
        processingPhase: PROCESSING_PHASES.thumbnail,
      },
      { context: 'marking thumbnail phase', ignoreMissing: true }
    )
  } catch (err) {
    console.error(`[WORKER] Failed to update thumbnail progress for ${videoId}:`, err)
  }

  // Move thumbnail to storage (atomic rename on same filesystem, stream-copy fallback)
  const storageContext = await getCanonicalVideoStorageContext(videoId)
  const thumbnailPath = buildVideoThumbnailStoragePath(
    storageContext.projectStoragePath,
    storageContext.videoFolderName,
    storageContext.versionLabel,
  )

  debugLog('Moving thumbnail to logical path:', thumbnailPath)

  const moveStart = Date.now()
  await moveTempFileToLogicalStorage(tempThumbnailPath, thumbnailPath)
  // File has been moved — remove from tempFiles so cleanup doesn't try to delete a missing file
  delete tempFiles.thumbnail
  const moveTime = Date.now() - moveStart

  debugLog('Thumbnail moved in:', (moveTime / 1000).toFixed(2) + ' s')

  return thumbnailPath
}

/**
 * Update video record with final processing results
 */
export async function finalizeVideo(
  videoId: string,
  previewPath: string,
  thumbnailPath: string | null,
  metadata: VideoMetadata,
  resolution: string
): Promise<void> {
  // Preserve user-supplied thumbnails (assets) when reprocessing so we don't overwrite them
  const existingThumbnail = await prisma.video.findUnique({
    where: { id: videoId },
    select: { thumbnailPath: true },
  })

  const hasCustomThumbnail = existingThumbnail?.thumbnailPath
    ? !!(await prisma.videoAsset.findFirst({
        where: {
          videoId,
          storagePath: existingThumbnail.thumbnailPath,
        },
        select: { id: true },
      })) || existingThumbnail.thumbnailPath.includes('/videos/assets/')
    : false

  const updateData: any = {
    status: 'READY',
    processingProgress: 100,
    processingPhase: null,
    duration: metadata.duration,
    width: metadata.width,
    height: metadata.height,
    fps: metadata.fps,
    codec: metadata.codec,
  }

  if (thumbnailPath !== null) {
    // Keep custom thumbnails; only overwrite system-generated ones
    updateData.thumbnailPath = hasCustomThumbnail ? existingThumbnail?.thumbnailPath : thumbnailPath
  }

  // Store preview path in correct field based on resolution
  if (resolution === '480p') {
    updateData.preview480Path = previewPath
  } else if (resolution === '720p') {
    updateData.preview720Path = previewPath
  } else if (resolution === '1080p') {
    updateData.preview1080Path = previewPath
  }

  debugLog('Updating database with final video data...')
  debugLog('Update data:', updateData)

  await updateVideoRecord(videoId, updateData, { context: 'finalizing processed video' })

  debugLog('Database updated to READY status')
}

export async function finalizeVideoWithoutPreview(
  videoId: string,
  thumbnailPath: string | null,
  metadata: VideoMetadata
): Promise<void> {
  const existingThumbnail = await prisma.video.findUnique({
    where: { id: videoId },
    select: { thumbnailPath: true },
  })

  const hasCustomThumbnail = existingThumbnail?.thumbnailPath
    ? !!(await prisma.videoAsset.findFirst({
        where: {
          videoId,
          storagePath: existingThumbnail.thumbnailPath,
        },
        select: { id: true },
      })) || existingThumbnail.thumbnailPath.includes('/videos/assets/')
    : false

  const updateData: any = {
    status: 'READY',
    processingProgress: 100,
    processingPhase: null,
    duration: metadata.duration,
    width: metadata.width,
    height: metadata.height,
    fps: metadata.fps,
    codec: metadata.codec,
  }

  if (thumbnailPath !== null) {
    updateData.thumbnailPath = hasCustomThumbnail ? existingThumbnail?.thumbnailPath : thumbnailPath
  }

  await updateVideoRecord(videoId, updateData, { context: 'finalizing video without preview changes' })
}

/**
 * Update video status in database
 */
export async function updateVideoStatus(
  videoId: string,
  status: VideoStatus,
  progress: number,
  phase?: string | null
): Promise<void> {
  debugLog(`Updating video status to ${status}...`)

  await updateVideoRecord(
    videoId,
    {
      status,
      processingProgress: progress,
      ...(phase !== undefined ? { processingPhase: phase } : {}),
    },
    { context: `setting status to ${status}` }
  )

  debugLog(`Database updated to ${status} status`)
}

/**
 * Cleanup temporary files
 * Used in both success and error paths (DRY principle)
 */
export async function cleanupTempFiles(tempFiles: TempFiles): Promise<void> {
  debugLog('Starting temp file cleanup...')

  const files = Object.values(tempFiles).filter((f): f is string => !!f)

  for (const file of files) {
    try {
      if (fs.existsSync(file)) {
        const fileStats = fs.statSync(file)
        if (fileStats.isDirectory()) {
          await fs.promises.rm(file, { recursive: true, force: true })
          console.log(`[WORKER] Cleaned up temp directory: ${path.basename(file)}`)
        } else {
          await fs.promises.unlink(file)
          console.log(`[WORKER] Cleaned up temp file: ${path.basename(file)}`)
          debugLog('Freed disk space:', (fileStats.size / 1024 / 1024).toFixed(2) + ' MB')
        }
      }
    } catch (cleanupError) {
      console.error(`[WORKER ERROR] Failed to cleanup temp file ${path.basename(file)}:`, cleanupError)
    }
  }
}

/**
 * Handle processing errors - update database and log
 */
export async function handleProcessingError(
  videoId: string,
  error: unknown
): Promise<void> {
  console.error(`[WORKER ERROR] Error processing video ${videoId}:`, error)

  if (error instanceof Error) {
    debugLog('Full error stack:', error.stack)
  }

  const errorMessage = error instanceof Error ? error.message : 'Unknown error'

  debugLog('Updating database with error status...')
  debugLog('Error message:', errorMessage)

  await updateVideoRecord(
    videoId,
    {
      status: 'ERROR',
      processingError: errorMessage,
    },
    { context: 'marking processing error', ignoreMissing: true }
  )
}
