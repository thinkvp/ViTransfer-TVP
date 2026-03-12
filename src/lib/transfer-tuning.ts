export const BYTES_PER_MB = 1024 * 1024

export const DEFAULT_UPLOAD_CHUNK_SIZE_MB = 200
export const MIN_UPLOAD_CHUNK_SIZE_MB = 8
export const MAX_UPLOAD_CHUNK_SIZE_MB = 512

export const DEFAULT_DOWNLOAD_CHUNK_SIZE_MB = 16
export const MIN_DOWNLOAD_CHUNK_SIZE_MB = 1
export const MAX_DOWNLOAD_CHUNK_SIZE_MB = 64

function normalizeChunkSize(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback

  const integer = Math.trunc(numeric)
  if (integer < min) return min
  if (integer > max) return max
  return integer
}

export function normalizeUploadChunkSizeMB(value: unknown): number {
  return normalizeChunkSize(
    value,
    DEFAULT_UPLOAD_CHUNK_SIZE_MB,
    MIN_UPLOAD_CHUNK_SIZE_MB,
    MAX_UPLOAD_CHUNK_SIZE_MB,
  )
}

export function normalizeDownloadChunkSizeMB(value: unknown): number {
  return normalizeChunkSize(
    value,
    DEFAULT_DOWNLOAD_CHUNK_SIZE_MB,
    MIN_DOWNLOAD_CHUNK_SIZE_MB,
    MAX_DOWNLOAD_CHUNK_SIZE_MB,
  )
}