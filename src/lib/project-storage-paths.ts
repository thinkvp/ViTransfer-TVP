/**
 * Project Storage Paths — CENTRAL SOURCE OF TRUTH
 *
 * Every storage path in the system MUST be constructed via a function in this file.
 * Never build paths inline with path.posix.join() — use these builders.
 *
 * === SANITIZATION ===
 *
 * Folder segments use sanitizeFilePathSegment()  (from @/lib/storage-sanitize)
 * File names     use sanitizeFileName()          (from @/lib/storage-sanitize)
 *
 * === PATH STRUCTURE OVERVIEW ===
 *
 *   clients/{clientName}/
 *     projects/{projectTitle}/
 *       files/projectfile-{ts}-{name}           ← ProjectFile
 *       uploads/{folderPath}/{fileName}          ← Share uploads
 *       videos/{videoFolder}/{version}/
 *         {originalFile}                         ← Video original
 *         assets/{fileName}                      ← VideoAsset
 *       albums/{albumFolder}/
 *         {photoFile}                            ← AlbumPhoto original
 *         {photoFile}-social.jpg                 ← AlbumPhoto social derivative
 *         zips/{AlbumName} Full Res.zip
 *       comments/{commentId}/{name}_{ts}.{ext}
 *       communication/
 *         raw/email-{ts}-{name}
 *         emails/{id}/att-{ts}-{idx}-{name}
 *
 *   files/clientfile-{ts}-{name}                 ← ClientFile (under clients/{name})
 *
 * === DERIVED PREVIEWS (ID-keyed, rename-immune) ===
 *
 * Preview derivatives live OUTSIDE the name-based client/project tree, keyed by
 * stable entity IDs so renaming a client/project/video/album never moves them.
 * StoredFile is the single source of truth for these paths.
 *
 *   previews/{projectId}/
 *     videos/{videoId}/
 *       preview-{res}.mp4
 *       thumbnail.jpg
 *       timeline-previews/
 *       assets/{assetId}/
 *         preview.jpg | preview.mp4
 *         timeline-previews/
 *     uploads/{uploadFileId}/
 *       preview.jpg
 *       timeline-previews/
 *     album-photos/{albumPhotoId}/
 *       thumbnail.jpg
 *
 * === ACCOUNTING (separate volume) ===
 *   See src/lib/accounting/file-storage.ts
 *   accounting/FY{year}-{year}/{AccountName}/filename.ext
 *
 * === IMPORTANT ===
 *
 * All I/O (uploadFile, deleteFile, createReadStream) goes through src/lib/storage.ts,
 * which handles path validation and any physical-layer redirects transparently.
 * DO NOT bypass storage.ts with raw fs operations on these paths.
 */

import path from 'path'
import { sanitizeFileName, sanitizeFilePathSegment } from '@/lib/storage-sanitize'

export type AlbumZipVariant = 'full' | 'social'

/**
 * @deprecated Use sanitizeFilePathSegment() from @/lib/storage-sanitize instead.
 * Kept for backward compatibility.
 */
export const sanitizeStorageName = sanitizeFilePathSegment

function sanitizeAlbumZipName(albumName: string): string {
  const sanitized = albumName
    .trim()
    .replace(/[^a-zA-Z0-9. _-]+/g, ' ')
    .replace(/ +/g, ' ')
    .replace(/^[ \.\-]+|[ \.\-]+$/g, '')

  return sanitized || 'Album'
}

function getAlbumZipFileNameLocal(params: { albumName: string; variant: AlbumZipVariant }): string {
  const { albumName, variant } = params
  const baseName = sanitizeAlbumZipName(albumName)
  const suffix = variant === 'social' ? 'Social Sized' : 'Full Res'
  return `${baseName} ${suffix}.zip`
}

export function allocateUniqueStorageName(baseName: string, existingNames: Iterable<string>): string {
  const base = sanitizeStorageName(baseName)
  const used = new Set(Array.from(existingNames, (value) => value.trim().toLowerCase()).filter(Boolean))
  if (!used.has(base.toLowerCase())) {
    return base
  }

  let suffix = 2
  while (used.has(`${base} (${suffix})`.toLowerCase())) {
    suffix += 1
  }

  return `${base} (${suffix})`
}

export function buildClientStorageRoot(clientName: string): string {
  return path.posix.join('clients', sanitizeStorageName(clientName))
}

export function buildProjectStorageRoot(clientName: string, projectFolderName: string): string {
  return path.posix.join(buildClientStorageRoot(clientName), 'projects', sanitizeStorageName(projectFolderName))
}

export function buildClientFilesStoragePath(clientName: string, fileName: string, timestamp: number): string {
  return path.posix.join(buildClientStorageRoot(clientName), 'files', `clientfile-${timestamp}-${fileName}`)
}

export function buildProjectFilesStoragePath(projectStoragePath: string, fileName: string, timestamp: number): string {
  return path.posix.join(projectStoragePath, 'files', `projectfile-${timestamp}-${fileName}`)
}

export function buildProjectUploadsRoot(projectStoragePath: string): string {
  return path.posix.join(projectStoragePath, 'uploads')
}

/**
 * Root directory for all videos under a project (not for a specific video).
 * Used as a prune-stop boundary when deleting individual videos.
 */
export function buildProjectAllVideosRoot(projectStoragePath: string): string {
  return path.posix.join(projectStoragePath, 'videos')
}

// ---------------------------------------------------------------------------
// PREVIEW PATHS — ID-keyed, rename-immune (see header). All derived previews
// live under previews/{projectId}/… keyed by stable entity IDs, NOT by the
// mutable client/project/video/album names. StoredFile is the source of truth.
// ---------------------------------------------------------------------------

/** Root for all of a project's derived previews: previews/{projectId} */
export function buildPreviewsRoot(projectId: string): string {
  return path.posix.join('previews', projectId)
}

/** Root for a single video's previews: previews/{projectId}/videos/{videoId} */
export function buildVideoPreviewsRoot(projectId: string, videoId: string): string {
  return path.posix.join(buildPreviewsRoot(projectId), 'videos', videoId)
}

/** Root for a video asset's previews: previews/{projectId}/videos/{videoId}/assets/{assetId} */
export function buildVideoAssetPreviewsRoot(projectId: string, videoId: string, assetId: string): string {
  return path.posix.join(buildVideoPreviewsRoot(projectId, videoId), 'assets', assetId)
}

/** Root for a share-upload file's previews: previews/{projectId}/uploads/{uploadFileId} */
export function buildUploadPreviewsRoot(projectId: string, uploadFileId: string): string {
  return path.posix.join(buildPreviewsRoot(projectId), 'uploads', uploadFileId)
}

/** Root for an album photo's previews: previews/{projectId}/album-photos/{albumPhotoId} */
export function buildAlbumPhotoPreviewsRoot(projectId: string, albumPhotoId: string): string {
  return path.posix.join(buildPreviewsRoot(projectId), 'album-photos', albumPhotoId)
}

export function normalizeProjectUploadRelativePath(relativePath: string): string {
  const trimmed = String(relativePath || '').trim()
  if (!trimmed) return ''

  const cleaned = trimmed
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')

  const segments = cleaned
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)

  const normalizedSegments: string[] = []
  for (const segment of segments) {
    if (segment === '.' || segment === '..') continue
    const safeSegment = sanitizeStorageName(segment)
    if (!safeSegment || safeSegment === 'Untitled') continue
    normalizedSegments.push(safeSegment)
  }

  return normalizedSegments.join('/')
}

export function buildProjectUploadFolderStoragePath(projectStoragePath: string, folderRelativePath: string): string {
  const normalizedRelativePath = normalizeProjectUploadRelativePath(folderRelativePath)
  if (!normalizedRelativePath) return buildProjectUploadsRoot(projectStoragePath)
  return path.posix.join(buildProjectUploadsRoot(projectStoragePath), normalizedRelativePath)
}

export function buildProjectUploadFileStoragePath(
  projectStoragePath: string,
  folderRelativePath: string,
  fileName: string,
): string {
  const normalizedFolderPath = buildProjectUploadFolderStoragePath(projectStoragePath, folderRelativePath)
  const safeFileName = sanitizeFileName(fileName)
  return path.posix.join(normalizedFolderPath, safeFileName)
}

/** Preview image (jpg) for a share-upload file: previews/{projectId}/uploads/{uploadFileId}/preview.jpg */
export function buildUploadPreviewStoragePath(projectId: string, uploadFileId: string, previewExtension = '.jpg'): string {
  const ext = previewExtension.startsWith('.') ? previewExtension : `.${previewExtension}`
  return path.posix.join(buildUploadPreviewsRoot(projectId, uploadFileId), `preview${ext}`)
}

/** Preview (jpg thumbnail / mp4 playback) for a video asset, keyed by assetId. */
export function buildVideoAssetPreviewStoragePath(
  projectId: string,
  videoId: string,
  assetId: string,
  previewExtension = '.jpg',
): string {
  const ext = previewExtension.startsWith('.') ? previewExtension : `.${previewExtension}`
  return path.posix.join(buildVideoAssetPreviewsRoot(projectId, videoId, assetId), `preview${ext}`)
}

export function allocateUniqueUploadFileName(fileName: string, existingNames: Iterable<string>): string {
  const safeFileName = sanitizeFileName(fileName)
  const parsed = path.posix.parse(safeFileName)
  const baseName = parsed.name || 'file'
  const extension = parsed.ext || ''

  const used = new Set(Array.from(existingNames, (value) => String(value || '').trim().toLowerCase()).filter(Boolean))
  if (!used.has(safeFileName.toLowerCase())) {
    return safeFileName
  }

  let suffix = 2
  while (used.has(`${baseName} (${suffix})${extension}`.toLowerCase())) {
    suffix += 1
  }

  return `${baseName} (${suffix})${extension}`
}

export function buildProjectEmailRawStoragePath(projectStoragePath: string, fileName: string, timestamp: number): string {
  return path.posix.join(projectStoragePath, 'communication', 'raw', `email-${timestamp}-${fileName}`)
}

export function buildProjectEmailAttachmentStoragePath(
  projectStoragePath: string,
  projectEmailId: string,
  fileName: string,
  timestamp: number,
  index: number,
): string {
  return path.posix.join(projectStoragePath, 'communication', 'emails', projectEmailId, `att-${timestamp}-${index}-${fileName}`)
}

export function buildCommentFileStoragePath(projectStoragePath: string, commentId: string, fileName: string, timestamp: number): string {
  const extension = fileName.includes('.') ? fileName.split('.').pop() : ''
  const nameWithoutExt = extension ? fileName.slice(0, -(extension.length + 1)) : fileName
  const finalName = `${nameWithoutExt}_${timestamp}.${extension || 'bin'}`
  return path.posix.join(projectStoragePath, 'comments', commentId, finalName)
}

export function buildVideoStorageRoot(projectStoragePath: string, videoFolderName: string): string {
  return path.posix.join(projectStoragePath, 'videos', sanitizeStorageName(videoFolderName))
}

export function buildVideoVersionRoot(projectStoragePath: string, videoFolderName: string, versionLabel: string): string {
  return path.posix.join(buildVideoStorageRoot(projectStoragePath, videoFolderName), sanitizeStorageName(versionLabel))
}

export function buildVideoOriginalStoragePath(
  projectStoragePath: string,
  videoFolderName: string,
  versionLabel: string,
  originalFileName: string,
): string {
  const safeOriginalFileName = sanitizeFileName(originalFileName)
  return path.posix.join(
    buildVideoVersionRoot(projectStoragePath, videoFolderName, versionLabel),
    safeOriginalFileName,
  )
}

export function buildVideoAssetsStorageRoot(projectStoragePath: string, videoFolderName: string, versionLabel: string): string {
  return path.posix.join(buildVideoVersionRoot(projectStoragePath, videoFolderName, versionLabel), 'assets')
}

export function buildVideoAssetStoragePath(
  projectStoragePath: string,
  videoFolderName: string,
  versionLabel: string,
  fileName: string,
): string {
  return path.posix.join(buildVideoAssetsStorageRoot(projectStoragePath, videoFolderName, versionLabel), fileName)
}

export function buildVideoPreviewStoragePath(projectId: string, videoId: string, resolution: string): string {
  return path.posix.join(buildVideoPreviewsRoot(projectId, videoId), `preview-${resolution}.mp4`)
}

export function buildVideoThumbnailStoragePath(projectId: string, videoId: string): string {
  return path.posix.join(buildVideoPreviewsRoot(projectId, videoId), 'thumbnail.jpg')
}

export function buildVideoTimelineStorageRoot(projectId: string, videoId: string): string {
  return path.posix.join(buildVideoPreviewsRoot(projectId, videoId), 'timeline-previews')
}

/** Root for a video's auto-generated subtitles (SRT + playback VTT). ID-keyed (rename-immune). */
export function buildVideoSubtitlesStorageRoot(projectId: string, videoId: string): string {
  return path.posix.join(buildVideoPreviewsRoot(projectId, videoId), 'subtitles')
}

/**
 * Root for a video's HLS packaging output: the master playlist, per-rendition
 * variant playlists, fMP4 init segments and media segments all live under here.
 * ID-keyed (rename-immune), mirroring the preview/timeline roots.
 *   previews/{projectId}/videos/{videoId}/hls/
 *     master.m3u8
 *     {480,720,1080}/index.m3u8
 *     {480,720,1080}/init.mp4
 *     {480,720,1080}/seg-00000.m4s
 */
export function buildVideoHlsStorageRoot(projectId: string, videoId: string): string {
  return path.posix.join(buildVideoPreviewsRoot(projectId, videoId), 'hls')
}

/** HLS bundle root for a video *asset's* playback preview (single rendition). */
export function buildVideoAssetHlsStorageRoot(projectId: string, videoId: string, assetId: string): string {
  return path.posix.join(buildVideoAssetPreviewsRoot(projectId, videoId, assetId), 'hls')
}

/** Timeline sprite storage root for a video asset's hover previews. */
export function buildAssetTimelineStorageRoot(projectId: string, videoId: string, assetId: string): string {
  return path.posix.join(buildVideoAssetPreviewsRoot(projectId, videoId, assetId), 'timeline-previews')
}

/** Timeline sprite storage root for an upload file's hover previews. */
export function buildUploadTimelineStorageRoot(projectId: string, uploadFileId: string): string {
  return path.posix.join(buildUploadPreviewsRoot(projectId, uploadFileId), 'timeline-previews')
}

export function buildAlbumStorageRoot(projectStoragePath: string, albumFolderName: string): string {
  return path.posix.join(projectStoragePath, 'albums', sanitizeStorageName(albumFolderName))
}

export function buildAlbumPhotoStoragePath(projectStoragePath: string, albumFolderName: string, fileName: string): string {
  return path.posix.join(buildAlbumStorageRoot(projectStoragePath, albumFolderName), fileName)
}

/**
 * Thumbnail storage path for an album photo, keyed by the photo's stable ID.
 * e.g. previews/{projectId}/album-photos/{albumPhotoId}/thumbnail.jpg
 *
 * Note: the album photo SOCIAL derivative is NOT a preview-tree file — it lives
 * next to the original at `{original}-social.jpg` and moves with the album folder.
 */
export function buildAlbumPhotoThumbnailStoragePath(projectId: string, albumPhotoId: string): string {
  return path.posix.join(buildAlbumPhotoPreviewsRoot(projectId, albumPhotoId), 'thumbnail.jpg')
}

export function buildAlbumZipStoragePath(
  projectStoragePath: string,
  albumFolderName: string,
  albumName: string,
  variant: AlbumZipVariant,
): string {
  return path.posix.join(buildAlbumStorageRoot(projectStoragePath, albumFolderName), 'zips', getAlbumZipFileNameLocal({ albumName, variant }))
}

export function replaceStoragePathPrefix(currentPath: string | null | undefined, oldPrefix: string, newPrefix: string): string | null {
  if (!currentPath) return null
  if (currentPath === oldPrefix) return newPrefix
  if (!currentPath.startsWith(`${oldPrefix}/`)) return currentPath
  return `${newPrefix}${currentPath.slice(oldPrefix.length)}`
}

export function replaceStoredStoragePathPrefix(
  currentPath: string | null | undefined,
  oldPrefix: string,
  newPrefix: string,
): string | null {
  if (!currentPath) return null

  return replaceStoragePathPrefix(currentPath, oldPrefix, newPrefix)
}

export function getStoragePathBasename(storagePath: string | null | undefined): string | null {
  if (!storagePath) return null
  const normalized = storagePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = path.posix.basename(normalized)
  return base && base !== '.' ? base : null
}

/**
 * Resolve a project's storage path from its DB record.
 *
 * Prefer this over reading project.storagePath directly — it guarantees a
 * valid path even when storagePath is null or stale, by falling back to
 * buildProjectStorageRoot() with the project's current client + title.
 *
 * @example
 *   const projectRoot = resolveProjectStoragePath(video.project)
 *   const originalPath = buildVideoOriginalStoragePath(projectRoot, folder, version, fileName)
 */
export function resolveProjectStoragePath(project: {
  storagePath?: string | null
  title: string
  client?: { name?: string | null } | null
  companyName?: string | null
}): string {
  return (
    project.storagePath ||
    buildProjectStorageRoot(
      project.client?.name || project.companyName || 'Client',
      project.title,
    )
  )
}