import type { DownloadableFile } from '@/lib/downloadable-files'

export type DownloadableFileKind =
  | 'video'
  | 'image'
  | 'audio'
  | 'archive'
  | 'document'
  | 'other'

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
  return ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif'].includes(ext)
}

export function getDownloadableFileKind(file: DownloadableFile): DownloadableFileKind {
  if (file.type === 'video') return 'video'
  if (file.type === 'album-photo') return 'image'
  if (file.type === 'album-zip') return 'archive'

  const ext = getFileExtension(file.fileName)

  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif'].includes(ext)) return 'image'
  if (['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a'].includes(ext)) return 'audio'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive'
  if (['pdf', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx'].includes(ext)) return 'document'

  return 'other'
}
