import { isSuspiciousFilename, sanitizeFilename } from '@/lib/file-validation'

export function validateEmlFilename(fileName: string): {
  valid: boolean
  error?: string
  sanitizedFilename?: string
} {
  if (!fileName || typeof fileName !== 'string') {
    return { valid: false, error: 'Filename required' }
  }

  if (isSuspiciousFilename(fileName)) {
    return { valid: false, error: 'Filename contains suspicious patterns' }
  }

  const sanitized = sanitizeFilename(fileName)
  const lower = sanitized.toLowerCase()
  if (!lower.endsWith('.eml')) {
    return { valid: false, error: 'Only .eml files are supported' }
  }

  return { valid: true, sanitizedFilename: sanitized }
}
