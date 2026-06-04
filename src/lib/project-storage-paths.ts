import path from 'path'
import { sanitizeFilename } from '@/lib/file-validation'

export type AlbumZipVariant = 'full' | 'social'

function trimStorageSegment(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export function sanitizeStorageName(name: string): string {
  const sanitized = trimStorageSegment(name)
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/[\x00-\x1F]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/[.\s]+$/g, '')
    .replace(/^[.\s]+/g, '')

  return sanitized || 'Untitled'
}

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
  const safeFileName = sanitizeFilename(fileName)
  return path.posix.join(normalizedFolderPath, safeFileName)
}

export function buildProjectUploadVideoThumbnailStoragePath(projectStoragePath: string, uploadFileStoragePath: string): string {
  const normalized = String(uploadFileStoragePath || '').replace(/\\/g, '/')
  const relativePath = path.posix.relative(projectStoragePath, normalized).replace(/\\/g, '/')
  const parsed = path.posix.parse(relativePath)
  const baseName = sanitizeFilename(parsed.base || `${parsed.name || 'video'}.bin`)
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
  const fileName = `${sanitizeFilename(parsed.name || 'asset')}${safeExtension}`
  return path.posix.join(buildProjectPreviewsRoot(projectStoragePath), 'videos', sanitizeStorageName(videoFolderName), sanitizeStorageName(versionLabel), 'assets', parsed.dir, fileName)
}

export function allocateUniqueUploadFileName(fileName: string, existingNames: Iterable<string>): string {
  const safeFileName = sanitizeFilename(fileName)
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
  const safeOriginalFileName = sanitizeFilename(originalFileName)
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