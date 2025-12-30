import { prisma } from '../lib/db'
import { downloadFile, uploadFile } from '../lib/storage'
import { transcodeVideo, generateThumbnail, getVideoMetadata, VideoMetadata, generateTimelineSprite } from '../lib/ffmpeg'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { TEMP_DIR } from './cleanup'

const DEBUG = process.env.DEBUG_WORKER === 'true'

// Constants (no more magic numbers!)
export const RESOLUTION_PRESETS = {
  '720p': { horizontal: { width: 1280, height: 720 }, verticalWidth: 720 },
  '1080p': { horizontal: { width: 1920, height: 1080 }, verticalWidth: 1080 },
  '2160p': { horizontal: { width: 3840, height: 2160 }, verticalWidth: 2160 }
} as const

export const THUMBNAIL_CONFIG = {
  percentage: 0.1,  // 10% into video
  min: 0.5,         // Minimum 0.5 seconds
  max: 10           // Maximum 10 seconds
} as const

export const PROGRESS_WEIGHTS = {
  transcode: 0.8,   // Transcoding is 80% of total progress
  thumbnail: 0.2    // Thumbnail is remaining 20%
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
  resolution: string
  watermarkText?: string
  timelinePreviewsEnabled: boolean
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

/**
 * Download video from storage and validate content
 */
export async function downloadAndValidateVideo(
  videoId: string,
  storagePath: string,
  tempFiles: TempFiles
): Promise<VideoInfo> {
  debugLog('Starting download and validation...')

  // Download original file to temp location
  const tempInputPath = path.join(TEMP_DIR, `${videoId}-original`)
  tempFiles.input = tempInputPath

  debugLog('Downloading from:', storagePath)
  debugLog('Temp path:', tempInputPath)

  const downloadStart = Date.now()
  const downloadStream = await downloadFile(storagePath)
  await pipeline(downloadStream, fs.createWriteStream(tempInputPath))
  const downloadTime = Date.now() - downloadStart

  console.log(`[WORKER] Downloaded original file for video ${videoId} in ${(downloadTime / 1000).toFixed(2)}s`)

  // Verify file exists and has content
  const stats = fs.statSync(tempInputPath)
  if (stats.size === 0) {
    throw new Error('Downloaded file is empty')
  }

  const fileSize = stats.size
  console.log(`[WORKER] Downloaded file size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`)

  debugLog('File verification passed')
  debugLog('Download speed:', (fileSize / 1024 / 1024 / (downloadTime / 1000)).toFixed(2) + ' MB/s')

  // Validate file content (magic bytes)
  debugLog('Validating magic bytes...')

  const { fileTypeFromFile } = await import('file-type')
  const fileType = await fileTypeFromFile(tempInputPath)
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
  const metadata = await getVideoMetadata(tempInputPath)
  const metadataTime = Date.now() - metadataStart

  console.log(`[WORKER] Video metadata:`, metadata)
  debugLog('Metadata extraction took:', (metadataTime / 1000).toFixed(2) + ' s')

  return {
    path: tempInputPath,
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
      previewResolution: true,
      watermarkEnabled: true,
      watermarkText: true,
      timelinePreviewsEnabled: true,
    },
  })

  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: { versionLabel: true },
  })

  debugLog('Project settings:', {
    title: project?.title,
    resolution: project?.previewResolution,
    watermarkEnabled: project?.watermarkEnabled
  })

  // Determine watermark text (only if watermarks are enabled)
  const watermarkText = project?.watermarkEnabled
    ? (project.watermarkText || `PREVIEW-${project.title || 'PROJECT'}-${video?.versionLabel || 'v1'}`)
    : undefined

  debugLog('Final watermark text:', watermarkText || '(no watermark)')

  return {
    resolution: project?.previewResolution || '720p',
    watermarkText,
    timelinePreviewsEnabled: project?.timelinePreviewsEnabled ?? false,
  }
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

  // Upload VTT + sprites to storage
  const spritesPath = `projects/${projectId}/videos/${videoId}/timeline-previews`
  const vttPath = `${spritesPath}/index.vtt`

  const vttStats = fs.statSync(tempVttPath)
  await uploadFile(vttPath, fs.createReadStream(tempVttPath), vttStats.size, 'text/vtt')

  const localFiles = await fs.promises.readdir(tempDir)
  const spriteFiles = localFiles.filter((f) => f.startsWith('sprite-') && f.endsWith('.jpg'))
  for (const spriteFile of spriteFiles) {
    const localSpritePath = path.join(tempDir, spriteFile)
    const spriteStats = fs.statSync(localSpritePath)
    await uploadFile(`${spritesPath}/${spriteFile}`, fs.createReadStream(localSpritePath), spriteStats.size, 'image/jpeg')
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
  const isVertical = metadata.height > metadata.width
  const aspectRatio = metadata.width / metadata.height

  console.log(`[WORKER] Video orientation: ${isVertical ? 'vertical' : 'horizontal'} (${metadata.width}x${metadata.height}, ratio: ${aspectRatio.toFixed(2)})`)

  const preset = RESOLUTION_PRESETS[resolution as keyof typeof RESOLUTION_PRESETS] || RESOLUTION_PRESETS['720p']

  let dimensions: OutputDimensions

  const inputWidth = Number(metadata.width) || 0
  const inputHeight = Number(metadata.height) || 0

  // Fall back to a safe default if metadata is missing.
  if (inputWidth <= 0 || inputHeight <= 0) {
    const fallback = RESOLUTION_PRESETS[resolution as keyof typeof RESOLUTION_PRESETS] || RESOLUTION_PRESETS['720p']
    return fallback.horizontal
  }

  const isVertical = inputHeight > inputWidth
  const aspectRatio = inputWidth / inputHeight

  console.log(`[WORKER] Video orientation: ${isVertical ? 'vertical' : 'horizontal'} (${inputWidth}x${inputHeight}, ratio: ${aspectRatio.toFixed(2)})`)

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
  return dimensions

  console.log(`[WORKER] Output resolution: ${dimensions.width}x${dimensions.height}`)

  debugLog('Resolution calculation:', {
    setting: resolution,
    isVertical,
    inputDimensions: `${metadata.width}x${metadata.height}`,
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
  settings: ProcessingSettings,
  tempFiles: TempFiles,
  duration: number
): Promise<string> {
  const tempPreviewPath = path.join(TEMP_DIR, `${videoId}-preview.mp4`)
  tempFiles.preview = tempPreviewPath

  debugLog('Starting video transcoding...')
  debugLog('Temp preview path:', tempPreviewPath)

  const transcodeStart = Date.now()

  await transcodeVideo({
    inputPath,
    outputPath: tempPreviewPath,
    width: dimensions.width,
    height: dimensions.height,
    watermarkText: settings.watermarkText,
    onProgress: async (progress) => {
      debugLog(`Transcode progress: ${(progress * 100).toFixed(1)}%`)

      await prisma.video.update({
        where: { id: videoId },
        data: { processingProgress: progress * PROGRESS_WEIGHTS.transcode },
      })
    },
  })

  const transcodeTime = Date.now() - transcodeStart
  console.log(`[WORKER] Generated ${settings.resolution} preview for video ${videoId} in ${(transcodeTime / 1000).toFixed(2)}s`)

  const transcodeStats = fs.statSync(tempPreviewPath)
  debugLog('Transcoded file size:', (transcodeStats.size / 1024 / 1024).toFixed(2) + ' MB')

  // Upload preview to storage
  const previewPath = `projects/${projectId}/videos/${videoId}/preview-${settings.resolution}.mp4`

  debugLog('Uploading preview to:', previewPath)

  const uploadStart = Date.now()
  await uploadFile(
    previewPath,
    fs.createReadStream(tempPreviewPath),
    transcodeStats.size,
    'video/mp4'
  )
  const uploadTime = Date.now() - uploadStart

  debugLog('Preview uploaded in:', (uploadTime / 1000).toFixed(2) + ' s')
  debugLog('Upload speed:', (transcodeStats.size / 1024 / 1024 / (uploadTime / 1000)).toFixed(2) + ' MB/s')

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

  // Upload thumbnail
  const thumbnailPath = `projects/${projectId}/videos/${videoId}/thumbnail.jpg`
  const statsThumbnail = fs.statSync(tempThumbnailPath)

  debugLog('Uploading thumbnail to:', thumbnailPath)
  debugLog('Thumbnail file size:', (statsThumbnail.size / 1024).toFixed(2) + ' KB')

  const uploadStart = Date.now()
  await uploadFile(
    thumbnailPath,
    fs.createReadStream(tempThumbnailPath),
    statsThumbnail.size,
    'image/jpeg'
  )
  const uploadTime = Date.now() - uploadStart

  debugLog('Thumbnail uploaded in:', (uploadTime / 1000).toFixed(2) + ' s')

  return thumbnailPath
}

/**
 * Update video record with final processing results
 */
export async function finalizeVideo(
  videoId: string,
  previewPath: string,
  thumbnailPath: string,
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
    // Keep custom thumbnails; only overwrite system-generated ones
    thumbnailPath: hasCustomThumbnail ? existingThumbnail?.thumbnailPath : thumbnailPath,
    duration: metadata.duration,
    width: metadata.width,
    height: metadata.height,
    fps: metadata.fps,
    codec: metadata.codec,
  }

  // Store preview path in correct field based on resolution
  if (resolution === '720p') {
    updateData.preview720Path = previewPath
  } else if (resolution === '1080p') {
    updateData.preview1080Path = previewPath
  } else if (resolution === '2160p') {
    updateData.preview2160Path = previewPath
  }

  debugLog('Updating database with final video data...')
  debugLog('Update data:', updateData)

  await prisma.video.update({
    where: { id: videoId },
    data: updateData,
  })

  debugLog('Database updated to READY status')
}

/**
 * Update video status in database
 */
export async function updateVideoStatus(
  videoId: string,
  status: string,
  progress: number
): Promise<void> {
  debugLog(`Updating video status to ${status}...`)

  await prisma.video.update({
    where: { id: videoId },
    data: { status, processingProgress: progress },
  })

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

  await prisma.video.update({
    where: { id: videoId },
    data: {
      status: 'ERROR',
      processingError: errorMessage,
    },
  })
}
