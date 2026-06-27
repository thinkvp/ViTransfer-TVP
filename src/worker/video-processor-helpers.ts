import { prisma } from '../lib/db'
import { getFilePath, moveUploadedFile, deleteDirectory, getStoredFileSize, downloadFile, listStoredFileSizes } from '../lib/storage'
import { materializeStoragePathToLocalFile } from '../lib/storage-provider'
import { isS3Mode, s3FileExists } from '../lib/s3-storage'
import { transcodeVideo, generateThumbnail, getVideoMetadata, VideoMetadata, generateTimelineSprite, FFmpegCancellationError } from '../lib/ffmpeg'
import { Prisma, type VideoStatus, type EntityType } from '@prisma/client'
import {
  buildProjectStorageRoot,
  buildVideoOriginalStoragePath,
  buildVideoThumbnailStoragePath,
  buildVideoTimelineStorageRoot,
  buildVideoHlsStorageRoot,
  buildVideoAssetHlsStorageRoot,
} from '@/lib/project-storage-paths'
import { registerStoredFile, registerStoredFiles } from '@/lib/stored-file'
import fs from 'fs'
import path from 'path'
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
  hlsDir?: string
}

export interface ProcessingSettings {
  resolutions: Resolution[]
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

async function resolveExistingVideoOriginalPath(videoId: string, storagePath: string): Promise<string> {
  const trimmedStoragePath = storagePath.trim()
  const candidates: string[] = []
  const seenCandidates = new Set<string>()

  const pushCandidate = (candidate: string | null | undefined) => {
    const trimmedCandidate = candidate?.trim()
    if (!trimmedCandidate || seenCandidates.has(trimmedCandidate)) {
      return
    }

    seenCandidates.add(trimmedCandidate)
    candidates.push(trimmedCandidate)
  }

  pushCandidate(trimmedStoragePath)

  // Get video metadata for canonical path construction (no dropped columns)
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: {
      id: true,
      name: true,
      versionLabel: true,
      storageFolderName: true,
      project: {
        select: {
          title: true,
          companyName: true, client: { select: { name: true } },
        },
      },
    },
  })

  // Get the original file name and path from StoredFile (single query)
  const storedFile = await prisma.storedFile.findUnique({
    where: { entityType_entityId_fileRole: { entityType: 'VIDEO', entityId: videoId, fileRole: 'ORIGINAL' } },
    select: { storagePath: true, fileName: true },
  })
  const originalPath = storedFile?.storagePath ?? null
  const originalFileName = storedFile?.fileName || `${video?.name || 'video'}.mp4`

  if (!video) {
    if (isS3Mode()) {
      for (const candidate of candidates) {
        if (await s3FileExists(candidate)) {
          return candidate
        }
      }
    }
    return candidates[0] || trimmedStoragePath
  }

  const projectStoragePath = (video.project as any).storagePath
    || buildProjectStorageRoot(
      video.project.client?.name || video.project.companyName || 'Client',
      video.project.title,
    )

  pushCandidate(
    buildVideoOriginalStoragePath(
      projectStoragePath,
      video.storageFolderName || video.name,
      video.versionLabel,
      originalFileName,
    )
  )

  if (isS3Mode()) {
    for (const candidate of candidates) {
      if (await s3FileExists(candidate)) {
        return candidate
      }
    }
    return candidates[0] || trimmedStoragePath
  }

  // For local mode, try the stored path as primary fallback
  if (originalPath && originalPath !== trimmedStoragePath) {
    if (fs.existsSync(getFilePath(originalPath))) {
      return originalPath
    }
  }

  return trimmedStoragePath
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
  tempFiles: TempFiles,
  onDownloadProgress?: (transferred: number, total: number) => void
): Promise<VideoInfo> {
  debugLog('Starting validation...')

  const resolvedStoragePath = await resolveExistingVideoOriginalPath(videoId, storagePath)

  const resolvedInput = await materializeStoragePathToLocalFile({
    rawPath: resolvedStoragePath,
    tempDir: TEMP_DIR,
    suggestedName: `${videoId}-source.bin`,
    onProgress: onDownloadProgress,
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
  _videoId: string
): Promise<ProcessingSettings> {
  debugLog('Fetching processing settings...')

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true,
      previewResolutions: true,
    },
  })

  const resolutions = parseResolutions(project?.previewResolutions)

  debugLog('Project settings:', {
    title: project?.title,
    resolutions,
  })

  return {
    resolutions,
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
  // Capture one timeline thumbnail every second (60 per minute) for dense
  // hover/scrub previews. With a 10×10 sprite sheet that's 100s of video per sheet.
  const intervalSeconds = 1
  const tileColumns = 10
  const tileRows = 10
  const framesPerSprite = tileColumns * tileRows
  const frameWidth = 320
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

  // Move VTT + sprites to storage (atomic rename on same filesystem).
  // Previews are ID-keyed (rename-immune) — see project-storage-paths.ts.
  const spritesPath = buildVideoTimelineStorageRoot(projectId, videoId)
  const vttPath = `${spritesPath}/index.vtt`

  await moveTempFileToLogicalStorage(tempVttPath, vttPath)

  const localFiles = await fs.promises.readdir(tempDir)
  const spriteFiles = localFiles.filter((f) => f.startsWith('sprite-') && f.endsWith('.jpg'))
  for (const spriteFile of spriteFiles) {
    const localSpritePath = path.join(tempDir, spriteFile)
    await moveTempFileToLogicalStorage(localSpritePath, `${spritesPath}/${spriteFile}`)
  }

  // Register timeline files in StoredFile registry
  await registerTimelineStoredFiles(videoId, vttPath, spritesPath)

  return { vttPath, spritesPath, ready: true }
}

/**
 * Persist timeline preview paths to StoredFile registry.
 * Exported so video-processor.ts can also call it for timeline-only flows.
 */
export async function registerTimelineStoredFiles(
  videoId: string,
  vttPath: string,
  spritesPath: string,
): Promise<void> {
  try {
    const vttSize = await fs.promises.stat(getFilePath(vttPath)).then(s => s.size).catch(() => null)
    await registerStoredFiles([
      { entityType: 'VIDEO', entityId: videoId, fileRole: 'TIMELINE_VTT', storagePath: vttPath, status: 'READY', fileSize: vttSize },
      // TIMELINE_SPRITES is a directory — no single fileSize; leave null
      { entityType: 'VIDEO', entityId: videoId, fileRole: 'TIMELINE_SPRITES', storagePath: spritesPath, status: 'READY' },
    ])
  } catch (err) {
    console.error(`[WORKER] StoredFile timeline register failed for video ${videoId}:`, err)
  }
}

/** Conservative per-rendition bandwidth (bits/s) when probing can't derive one. */
function estimateBandwidthFallback(label: string): number {
  switch (label) {
    case '1080': return 5_000_000
    case '720': return 2_800_000
    case '480': return 1_400_000
    default: return 2_000_000
  }
}

/** Map a preview resolution setting to its HLS folder label. */
function resolutionToHlsLabel(resolution: string): string {
  return resolution === '1080p' ? '1080' : resolution === '480p' ? '480' : '720'
}

type HlsVariant = { label: string; bandwidth: number; width: number; height: number }

/**
 * Encode one rendition of the original **directly** to an HLS rendition (index.m3u8 +
 * init.mp4 + seg-*.m4s) in a single ffmpeg pass — no intermediate MP4 written to storage —
 * then upload every produced file under `{hlsRoot}/{label}/`. Returns the variant metadata
 * for the master playlist plus the logical paths uploaded (for the completeness gate).
 */
async function encodeHlsRenditionFromOriginal(params: {
  originalLocalPath: string
  hlsRoot: string
  label: string
  width: number
  height: number
  durationSeconds: number
  tempDir: string
  onProgress?: (progress: number) => void | Promise<void>
  shouldAbort?: () => Promise<boolean>
}): Promise<{ variant: HlsVariant; uploadedPaths: string[] }> {
  const { originalLocalPath, hlsRoot, label, width, height, durationSeconds, tempDir } = params

  const renditionDir = path.join(tempDir, label)
  await fs.promises.mkdir(renditionDir, { recursive: true })

  await transcodeVideo({
    inputPath: originalLocalPath,
    hlsOutputDir: renditionDir,
    width,
    height,
    // Keyframe-align every rendition so the HLS bundle supports seamless ABR switching.
    alignKeyframes: true,
    onProgress: params.onProgress,
    shouldAbort: params.shouldAbort,
  })

  // Upload every produced file (index.m3u8, init.mp4, seg-*.m4s) and tally bytes for bandwidth.
  const generated = await fs.promises.readdir(renditionDir)
  const uploadedPaths: string[] = []
  let totalBytes = 0
  for (const file of generated) {
    const abs = path.join(renditionDir, file)
    totalBytes += await fs.promises.stat(abs).then((s) => s.size).catch(() => 0)
    const dest = `${hlsRoot}/${label}/${file}`
    await moveTempFileToLogicalStorage(abs, dest)
    uploadedPaths.push(dest)
  }

  const bandwidth = durationSeconds > 0 ? Math.round((totalBytes * 8) / durationSeconds) : 0
  return {
    variant: { label, bandwidth: bandwidth || estimateBandwidthFallback(label), width, height },
    uploadedPaths,
  }
}

/**
 * Write the master playlist for `variants`, upload it, verify the whole bundle is present,
 * then register HLS_PLAYLIST/HLS_SEGMENTS. Shared by the video and asset packagers.
 */
async function finalizeHlsMaster(params: {
  entityType: EntityType
  entityId: string
  hlsRoot: string
  variants: HlsVariant[]
  uploadedPaths: string[]
  tempDir: string
}): Promise<void> {
  const { entityType, entityId, hlsRoot, variants, uploadedPaths, tempDir } = params

  const masterLines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS']
  for (const v of variants) {
    const res = v.width > 0 && v.height > 0 ? `,RESOLUTION=${v.width}x${v.height}` : ''
    masterLines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth}${res}`)
    masterLines.push(`${v.label}/index.m3u8`)
  }
  const tempMasterPath = path.join(tempDir, 'master.m3u8')
  await fs.promises.writeFile(tempMasterPath, masterLines.join('\n') + '\n', 'utf-8')

  const masterPath = `${hlsRoot}/master.m3u8`
  await moveTempFileToLogicalStorage(tempMasterPath, masterPath)

  // Completeness gate: confirm every file we wrote is present and non-empty before flagging
  // ready. A half-uploaded bundle (e.g. a transient R2 500 the retries couldn't beat) must
  // never be marked playable — throw so the caller leaves hlsReady=false and the reconcile
  // sweep re-packages it.
  await verifyHlsBundleComplete([...uploadedPaths, masterPath])

  await registerHlsStoredFiles(entityType, entityId, masterPath, hlsRoot)
}

/**
 * Package a video's HLS bundle by encoding the original **directly** to one keyframe-aligned
 * fMP4 rendition per requested resolution (no intermediate MP4 persisted anywhere) plus a
 * master playlist. Replaces the old "transcode to MP4 → upload → download → remux" flow.
 * The original is materialized once by the caller and passed in. Returns { ready: false }
 * when no renditions were produced (e.g. every resolution was cancelled mid-flight).
 */
export async function packageVideoHlsFromOriginal(params: {
  videoId: string
  projectId: string
  originalLocalPath: string
  metadata: VideoMetadata
  resolutions: Resolution[]
  tempFiles: TempFiles
  /** Skip a resolution that's been deselected from project settings mid-processing. */
  shouldSkipResolution?: (resolution: Resolution) => Promise<boolean>
}): Promise<{ ready: boolean }> {
  const { videoId, projectId, originalLocalPath, metadata, resolutions, tempFiles } = params

  const hlsRoot = buildVideoHlsStorageRoot(projectId, videoId)
  const tempDir = path.join(TEMP_DIR, `${videoId}-hls`)
  tempFiles.hlsDir = tempDir
  await fs.promises.mkdir(tempDir, { recursive: true })

  // Clean slate: drop any previous bundle so a shrunk rendition set can't leave stale segments.
  await deleteDirectory(hlsRoot).catch(() => {})

  const duration = metadata.duration && metadata.duration > 0 ? metadata.duration : 0
  const variants: HlsVariant[] = []
  const uploadedPaths: string[] = []

  for (const resolution of resolutions) {
    if (params.shouldSkipResolution && (await params.shouldSkipResolution(resolution))) continue

    const dims = calculateOutputDimensions(metadata, resolution)
    const label = resolutionToHlsLabel(resolution)

    await updateVideoRecord(
      videoId,
      { processingProgress: 0, processingPhase: getPreviewProcessingPhase(resolution) },
      { context: `starting ${resolution} HLS encode`, ignoreMissing: true },
    )

    let lastProgressUpdate = 0
    let progressWriteInFlight = false
    try {
      const { variant, uploadedPaths: paths } = await encodeHlsRenditionFromOriginal({
        originalLocalPath,
        hlsRoot,
        label,
        width: dims.width,
        height: dims.height,
        durationSeconds: duration,
        tempDir,
        shouldAbort: params.shouldSkipResolution
          ? () => params.shouldSkipResolution!(resolution)
          : undefined,
        onProgress: async (progress) => {
          const now = Date.now()
          if (progressWriteInFlight || (now - lastProgressUpdate < 3000 && progress < 1)) return
          progressWriteInFlight = true
          lastProgressUpdate = now
          try {
            await updateVideoRecord(
              videoId,
              { processingProgress: progress, processingPhase: getPreviewProcessingPhase(resolution) },
              { context: 'updating HLS encode progress', ignoreMissing: true },
            )
          } catch {
            /* best-effort */
          } finally {
            progressWriteInFlight = false
          }
        },
      })
      variants.push(variant)
      uploadedPaths.push(...paths)
    } catch (error) {
      if (error instanceof FFmpegCancellationError) {
        console.log(`[WORKER] Cancelled ${resolution} HLS encode for video ${videoId} (settings changed)`)
        continue
      }
      throw error
    }
  }

  if (variants.length === 0) return { ready: false }

  await finalizeHlsMaster({ entityType: 'VIDEO', entityId: videoId, hlsRoot, variants, uploadedPaths, tempDir })
  return { ready: true }
}

/**
 * Encode a video asset's original **directly** to a single-rendition HLS bundle (assets have no
 * ABR — one resolution — but HLS still fixes proxy seeking). The asset original is materialized
 * from its ORIGINAL StoredFile and capped at `resolution` (fit-to-box, mirroring the old MP4
 * preview). Returns { ready: false } when the asset has no usable video original.
 */
export async function packageAssetHlsFromOriginal(
  assetId: string,
  projectId: string,
  videoId: string,
  tempFiles: TempFiles,
  resolution: Resolution = '1080p',
): Promise<{ ready: boolean }> {
  const original = await prisma.storedFile.findUnique({
    where: { entityType_entityId_fileRole: { entityType: 'VIDEO_ASSET', entityId: assetId, fileRole: 'ORIGINAL' } },
    select: { storagePath: true },
  })
  if (!original?.storagePath) return { ready: false }

  const hlsRoot = buildVideoAssetHlsStorageRoot(projectId, videoId, assetId)
  const tempDir = path.join(TEMP_DIR, `asset-${assetId}-hls`)
  tempFiles.hlsDir = tempDir
  await fs.promises.mkdir(tempDir, { recursive: true })

  await deleteDirectory(hlsRoot).catch(() => {})

  const { localPath, isTemporary } = await materializeStoragePathToLocalFile({
    rawPath: original.storagePath,
    tempDir,
    suggestedName: `asset-${assetId}-src.bin`,
  })

  try {
    const meta = await getVideoMetadata(localPath).catch(() => null)
    if (!meta || !meta.width || !meta.height) return { ready: false }

    const dims = calculateOutputDimensions(meta, resolution)
    const label = resolutionToHlsLabel(resolution)
    const duration = meta.duration && meta.duration > 0 ? meta.duration : 0

    const { variant, uploadedPaths } = await encodeHlsRenditionFromOriginal({
      originalLocalPath: localPath,
      hlsRoot,
      label,
      width: dims.width,
      height: dims.height,
      durationSeconds: duration,
      tempDir,
    })

    await finalizeHlsMaster({
      entityType: 'VIDEO_ASSET',
      entityId: assetId,
      hlsRoot,
      variants: [variant],
      uploadedPaths,
      tempDir,
    })
    return { ready: true }
  } finally {
    if (isTemporary) await fs.promises.unlink(localPath).catch(() => {})
  }
}

/**
 * Throw unless every path in `paths` exists in storage with a non-zero size. Used as the
 * final gate of HLS packaging (and reused by the reconcile sweep's deletion safety check).
 */
export async function verifyHlsBundleComplete(paths: string[]): Promise<void> {
  const sizes = await Promise.all(paths.map((p) => getStoredFileSize(p).catch(() => null)))
  const missing = paths.filter((_, i) => !sizes[i] || (sizes[i] as number) <= 0)
  if (missing.length > 0) {
    throw new Error(`HLS bundle incomplete — ${missing.length} file(s) missing/empty: ${missing.slice(0, 5).join(', ')}`)
  }
}

async function readStoredText(storagePath: string): Promise<string> {
  const stream = await downloadFile(storagePath)
  const chunks: Buffer[] = []
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

/**
 * Verify a *previously stored* HLS bundle is complete by walking its own playlists: read
 * master.m3u8 → each variant index.m3u8 → every init/segment URI, and confirm all exist
 * with non-zero size. Returns true when the bundle is fully playable. Used by the reconcile
 * sweep as the safety gate before deleting a video's MP4 previews. Best-effort: any read
 * failure means "not verified" (returns false) so we never delete previews on a bad read.
 */
export async function verifyStoredHlsBundle(hlsRoot: string): Promise<boolean> {
  try {
    // One listing of the whole bundle, then membership checks — avoids a HEAD per segment.
    const present = await listStoredFileSizes(hlsRoot)
    const isPresent = (p: string) => (present.get(p) ?? 0) > 0

    const masterPath = `${hlsRoot}/master.m3u8`
    if (!isPresent(masterPath)) return false
    const master = await readStoredText(masterPath)
    const labels = [...master.matchAll(/^(\d+)\/index\.m3u8\s*$/gm)].map((m) => m[1])
    if (labels.length === 0) return false

    for (const label of labels) {
      const indexPath = `${hlsRoot}/${label}/index.m3u8`
      if (!isPresent(indexPath)) return false
      const variant = await readStoredText(indexPath)
      const mapNames = [...variant.matchAll(/URI="([^"]+)"/g)].map((m) => m[1])
      const segNames = variant
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && /\.(m4s|mp4)$/i.test(l))
      const names = Array.from(new Set([...mapNames, ...segNames]))
      if (names.length === 0) return false
      for (const n of names) {
        if (!isPresent(`${hlsRoot}/${label}/${n}`)) return false
      }
    }

    return true
  } catch {
    return false
  }
}

/** Persist HLS master playlist + segment directory to the StoredFile registry. */
export async function registerHlsStoredFiles(
  entityType: EntityType,
  entityId: string,
  masterPath: string,
  hlsRoot: string,
): Promise<void> {
  try {
    const masterSize = await fs.promises.stat(getFilePath(masterPath)).then((s) => s.size).catch(() => null)
    await registerStoredFiles([
      { entityType, entityId, fileRole: 'HLS_PLAYLIST', storagePath: masterPath, status: 'READY', fileSize: masterSize },
      // HLS_SEGMENTS is a directory — no single fileSize; leave null.
      { entityType, entityId, fileRole: 'HLS_SEGMENTS', storagePath: hlsRoot, status: 'READY' },
    ])
  } catch (err) {
    console.error(`[WORKER] StoredFile HLS register failed for ${entityType} ${entityId}:`, err)
  }
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
 * Generate thumbnail and upload
 */
export async function processThumbnail(
  videoId: string,
  projectId: string,
  inputPath: string,
  duration: number,
  tempFiles: TempFiles
): Promise<string | null> {
  // If the video has a user-set custom (asset-based) thumbnail, do NOT generate
  // a thumbnail.jpg. The finalize* paths skip registering a THUMBNAIL StoredFile
  // row for custom thumbnails, so any generated file would be written to storage
  // but never tracked — leaving an orphan behind on every reprocess.
  if (await videoHasCustomThumbnail(videoId)) {
    debugLog('Skipping thumbnail generation — video has a custom (asset-based) thumbnail')
    return null
  }

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
  const thumbnailPath = buildVideoThumbnailStoragePath(projectId, videoId)

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
 * Check whether a video's current THUMBNAIL StoredFile entry points to a
 * VideoAsset (user-set custom thumbnail) rather than a generated thumbnail.
 * Returns true if the existing thumbnail should be preserved.
 */
async function videoHasCustomThumbnail(videoId: string): Promise<boolean> {
  try {
    const existingThumbRecord = await prisma.storedFile.findUnique({
      where: { entityType_entityId_fileRole: { entityType: 'VIDEO', entityId: videoId, fileRole: 'THUMBNAIL' } },
      select: { storagePath: true },
    })
    if (!existingThumbRecord?.storagePath) return false

    const assetIds = (await prisma.videoAsset.findMany({ where: { videoId }, select: { id: true } })).map(a => a.id)
    if (assetIds.length === 0) return false

    const assetOwnsThumbnail = await prisma.storedFile.findFirst({
      where: {
        entityType: 'VIDEO_ASSET',
        entityId: { in: assetIds },
        storagePath: existingThumbRecord.storagePath,
      },
      select: { id: true },
    })
    return !!assetOwnsThumbnail
  } catch {
    return false
  }
}

export async function finalizeVideoWithoutPreview(
  videoId: string,
  thumbnailPath: string | null,
  metadata: VideoMetadata
): Promise<void> {
  const hasCustomThumbnail = await videoHasCustomThumbnail(videoId)

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

  if (thumbnailPath !== null && !hasCustomThumbnail) {
    const thumbSize = await fs.promises.stat(getFilePath(thumbnailPath)).then(s => s.size).catch(() => null)
    await registerStoredFile({
      entityType: 'VIDEO', entityId: videoId, fileRole: 'THUMBNAIL',
      storagePath: thumbnailPath, status: 'READY', fileSize: thumbSize,
    })
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
