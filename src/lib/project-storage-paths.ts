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
 *       .previews/                               ← All derived preview assets
 *         uploads/{folder}/{id}/timeline-previews/
 *         videos/{videoFolder}/{version}/
 *           preview-{res}.mp4
 *           thumbnail.jpg
 *           timeline-previews/
 *           assets/{assetId}/timeline-previews/
 *       videos/{videoFolder}/{version}/
 *         {originalFile}                         ← Video original
 *         assets/{fileName}                      ← VideoAsset
 *       albums/{albumFolder}/
 *         {photoFile}                            ← AlbumPhoto original
 *         zips/{AlbumName} Full Res.zip
 *       comments/{commentId}/{name}_{ts}.{ext}
 *       communication/
 *         raw/email-{ts}-{name}
 *         emails/{id}/att-{ts}-{idx}-{name}
 *
 *   files/clientfile-{ts}-{name}                 ← ClientFile (under clients/{name})
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

export function buildProjectPreviewsRoot(projectStoragePath: string): string {
  return path.posix.join(projectStoragePath, '.previews')
}

/**
 * Root directory for all videos under a project (not for a specific video).
 * Used as a prune-stop boundary when deleting individual videos.
 */
export function buildProjectAllVideosRoot(projectStoragePath: string): string {
  return path.posix.join(projectStoragePath, 'videos')
}

/**
 * Root directory for all video previews under a project.
 * Used as a prune-stop boundary when deleting individual video previews.
 */
export function buildProjectAllVideoPreviewsRoot(projectStoragePath: string): string {
  return path.posix.join(projectStoragePath, '.previews', 'videos')
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

export function buildProjectUploadVideoThumbnailStoragePath(projectStoragePath: string, uploadFileStoragePath: string): string {
  const normalized = String(uploadFileStoragePath || '').replace(/\\/g, '/')
  const relativePath = path.posix.relative(projectStoragePath, normalized).replace(/\\/g, '/')
  const parsed = path.posix.parse(relativePath)
  const baseName = sanitizeFileName(parsed.base || `${parsed.name || 'video'}.bin`)
  const thumbnailFileName = `${baseName}.jpg`
  return path.posix.join(buildProjectPreviewsRoot(projectStoragePath), parsed.dir, thumbnailFileName)
}

export function buildVideoAssetPreviewStoragePath(
  projectStoragePath: string,
  videoFolderName: string,
  versionLabel: string,
  assetStoragePath: string,
  previewExtension = '.jpg',
): string {
  const normalized = String(assetStoragePath || '').replace(/\\/g, '/')
  const assetsRoot = buildVideoAssetsStorageRoot(projectStoragePath, videoFolderName, versionLabel)
  const relativePath = path.posix.relative(assetsRoot, normalized).replace(/\\/g, '/')
  const parsed = path.posix.parse(relativePath)
  const safeExtension = previewExtension.startsWith('.') ? previewExtension : `.${previewExtension}`
  const fileName = `${sanitizeFileName(parsed.name || 'asset')}${safeExtension}`
  return path.posix.join(buildProjectPreviewsRoot(projectStoragePath), 'videos', sanitizeStorageName(videoFolderName), sanitizeStorageName(versionLabel), 'assets', parsed.dir, fileName)
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

export function buildVideoPreviewStoragePath(projectStoragePath: string, videoFolderName: string, versionLabel: string, resolution: string): string {
  return path.posix.join(buildProjectPreviewsRoot(projectStoragePath), 'videos', sanitizeStorageName(videoFolderName), sanitizeStorageName(versionLabel), `preview-${resolution}.mp4`)
}

export function buildVideoThumbnailStoragePath(projectStoragePath: string, videoFolderName: string, versionLabel: string): string {
  return path.posix.join(buildProjectPreviewsRoot(projectStoragePath), 'videos', sanitizeStorageName(videoFolderName), sanitizeStorageName(versionLabel), 'thumbnail.jpg')
}

export function buildVideoTimelineStorageRoot(projectStoragePath: string, videoFolderName: string, versionLabel: string): string {
  return path.posix.join(buildProjectPreviewsRoot(projectStoragePath), 'videos', sanitizeStorageName(videoFolderName), sanitizeStorageName(versionLabel), 'timeline-previews')
}

/** Timeline sprite storage root for a video asset's hover previews. */
export function buildAssetTimelineStorageRoot(projectStoragePath: string, videoFolderName: string, versionLabel: string, assetId: string): string {
  return path.posix.join(buildProjectPreviewsRoot(projectStoragePath), 'videos', sanitizeStorageName(videoFolderName), sanitizeStorageName(versionLabel), 'assets', assetId, 'timeline-previews')
}

/** Timeline sprite storage root for an upload file's hover previews. */
export function buildUploadTimelineStorageRoot(projectStoragePath: string, folderRelativePath: string, uploadFileId: string): string {
  const segments = [buildProjectPreviewsRoot(projectStoragePath), 'uploads']
  if (folderRelativePath) {
    segments.push(sanitizeStorageName(folderRelativePath))
  }
  segments.push(uploadFileId, 'timeline-previews')
  return path.posix.join(...segments)
}

/**
 * Returns the root of the preview folder for a specific video version.
 * All preview derivatives (MP4 previews, thumbnail, timeline sprites, asset previews)
 * live under this root. Used when moving or renaming a version label.
 * e.g. {projectStoragePath}/.previews/videos/{videoFolderName}/{versionLabel}
 */
export function buildVideoVersionPreviewsRoot(projectStoragePath: string, videoFolderName: string, versionLabel: string): string {
  return path.posix.join(buildProjectPreviewsRoot(projectStoragePath), 'videos', sanitizeStorageName(videoFolderName), sanitizeStorageName(versionLabel))
}

export function buildAlbumStorageRoot(projectStoragePath: string, albumFolderName: string): string {
  return path.posix.join(projectStoragePath, 'albums', sanitizeStorageName(albumFolderName))
}

export function buildAlbumPhotoStoragePath(projectStoragePath: string, albumFolderName: string, fileName: string): string {
  return path.posix.join(buildAlbumStorageRoot(projectStoragePath, albumFolderName), fileName)
}

/**
 * Derives the preview storage path for an album photo.
 * Previews live in a `previews/` subfolder in the same album directory as the original.
 * e.g.  albums/AlbumName/photo.jpg  →  albums/AlbumName/previews/photo.jpg
 */
export function buildAlbumPhotoPreviewStoragePath(projectStoragePath: string, photoStoragePath: string): string {
  const relativePath = path.posix.relative(projectStoragePath, photoStoragePath).replace(/\\/g, '/')
  const parsed = path.posix.parse(relativePath)
  return path.posix.join(buildProjectPreviewsRoot(projectStoragePath), parsed.dir, 'previews', `${parsed.name || 'photo'}.jpg`)
}

/**
 * Derives the thumbnail storage path for an album photo.
 * Thumbnails live in a `thumbnails/` subfolder in the same album directory as the original.
 * e.g. albums/AlbumName/photo.jpg -> albums/AlbumName/thumbnails/photo.jpg
 */
export function buildAlbumPhotoThumbnailStoragePath(projectStoragePath: string, photoStoragePath: string): string {
  const relativePath = path.posix.relative(projectStoragePath, photoStoragePath).replace(/\\/g, '/')
  const parsed = path.posix.parse(relativePath)
  const fileName = `${parsed.name || 'thumbnail'}.jpg`
  return path.posix.join(buildProjectPreviewsRoot(projectStoragePath), parsed.dir, 'thumbnails', fileName)
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
 *   const previewPath = buildVideoPreviewStoragePath(projectRoot, folder, version, '720p')
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