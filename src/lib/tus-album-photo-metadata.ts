import { generateFileFingerprint } from '@/lib/tus-context'

const ALBUM_PHOTO_UPLOAD_META_PREFIX = 'vitransfer-album-photo-upload:'

export interface StoredAlbumPhotoUploadMetadata {
  albumId: string
  photoId: string
  createdAt: number
}

function getAlbumPhotoUploadMetadataKey(file: File, endpoint?: string): string {
  const fingerprint = generateFileFingerprint(file, endpoint)
  return `${ALBUM_PHOTO_UPLOAD_META_PREFIX}${fingerprint}`
}

export function storeAlbumPhotoUploadMetadata(
  file: File,
  metadata: Omit<StoredAlbumPhotoUploadMetadata, 'createdAt'>,
  endpoint?: string
): void {
  try {
    const key = getAlbumPhotoUploadMetadataKey(file, endpoint)
    const payload: StoredAlbumPhotoUploadMetadata = { ...metadata, createdAt: Date.now() }
    localStorage.setItem(key, JSON.stringify(payload))
  } catch {
    // Silent failure
  }
}

export function getAlbumPhotoUploadMetadata(file: File, endpoint?: string): StoredAlbumPhotoUploadMetadata | null {
  try {
    const key = getAlbumPhotoUploadMetadataKey(file, endpoint)
    const raw = localStorage.getItem(key)
    if (!raw) return null

    const metadata = JSON.parse(raw) as StoredAlbumPhotoUploadMetadata
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000

    if (!metadata?.albumId || !metadata?.photoId) {
      localStorage.removeItem(key)
      return null
    }

    if (metadata.createdAt && Date.now() - metadata.createdAt > oneWeekMs) {
      localStorage.removeItem(key)
      return null
    }

    return metadata
  } catch {
    return null
  }
}

export function clearAlbumPhotoUploadMetadata(file: File, endpoint?: string): void {
  try {
    const key = getAlbumPhotoUploadMetadataKey(file, endpoint)
    localStorage.removeItem(key)
  } catch {
    // Silent failure
  }
}
