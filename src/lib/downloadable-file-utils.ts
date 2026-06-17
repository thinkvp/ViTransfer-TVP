import type { DownloadableFile } from '@/lib/downloadable-files'

export type DownloadableFileKind =
  | 'video'
  | 'image'
  | 'audio'
  | 'archive'
  | 'document'
  | 'other'

// ── Single source of truth for extension → kind mapping ──
const EXT_IMAGE   = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif']
const EXT_VIDEO   = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'mxf']
const EXT_AUDIO   = ['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a']
const EXT_ARCHIVE = ['zip', 'rar', '7z', 'tar', 'gz']
const EXT_DOC     = ['pdf', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx']

function extKind(ext: string): DownloadableFileKind | null {
  if (EXT_IMAGE.includes(ext))   return 'image'
  if (EXT_VIDEO.includes(ext))   return 'video'
  if (EXT_AUDIO.includes(ext))   return 'audio'
  if (EXT_ARCHIVE.includes(ext)) return 'archive'
  if (EXT_DOC.includes(ext))     return 'document'
  return null
}

export function getDownloadableFileKey(file: DownloadableFile): string {
  if (file.uploadFileId) return file.uploadFileId
  if (file.photoId) return file.photoId
  return file.assetId ?? (file.albumId ? `${file.albumId}-${file.variant || 'full'}` : file.videoId ?? file.fileName)
}

export function getFileExtension(fileName: string): string {
  const safeName = typeof fileName === 'string' ? fileName : ''
  const dotIndex = safeName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === safeName.length - 1) return ''
  return safeName.slice(dotIndex + 1).toLowerCase()
}

export function isImageFileName(fileName: string): boolean {
  const ext = getFileExtension(fileName)
  return EXT_IMAGE.includes(ext)
}

export function getDownloadableFileKind(file: DownloadableFile): DownloadableFileKind {
  if (file.type === 'video') return 'video'
  if (file.type === 'album-photo') return 'image'
  if (file.type === 'album-zip') return 'archive'

  const ext = getFileExtension(file.fileName)
  return extKind(ext) ?? 'other'
}
