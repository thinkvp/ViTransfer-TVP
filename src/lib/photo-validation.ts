import { sanitizeFilename, isSuspiciousFilename } from '@/lib/file-validation'

const ALLOWED_PHOTO_EXTENSIONS = ['.jpg', '.jpeg']

export function validateAlbumPhotoFile(
  filename: string,
  mimeType: string
): { valid: boolean; error?: string; sanitizedFilename?: string } {
  const sanitizedFilename = sanitizeFilename(filename || 'photo.jpg')

  if (isSuspiciousFilename(filename)) {
    return { valid: false, error: 'Filename contains suspicious patterns' }
  }

  const ext = sanitizedFilename.toLowerCase().slice(sanitizedFilename.lastIndexOf('.'))
  if (!ALLOWED_PHOTO_EXTENSIONS.includes(ext)) {
    return {
      valid: false,
      error: `Invalid file type. Allowed: ${ALLOWED_PHOTO_EXTENSIONS.join(', ')}`,
    }
  }

  const normalizedMime = (mimeType || '').toLowerCase()
  if (normalizedMime && normalizedMime !== 'image/jpeg' && normalizedMime !== 'application/octet-stream') {
    return { valid: false, error: `Invalid MIME type. Received: ${mimeType}. Allowed: image/jpeg` }
  }

  return { valid: true, sanitizedFilename }
}
