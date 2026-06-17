/**
 * File Upload Security
 * Validates file types and sizes to prevent malicious uploads
 */

// Allowed video MIME types
export const ALLOWED_VIDEO_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
  'video/x-matroska',
  'video/avi'
]

// File configuration
export const FILE_LIMITS = {
  ALLOWED_EXTENSIONS: ['.mp4', '.mov', '.avi', '.webm', '.mkv']
}

// Allowed asset types by category
export const ALLOWED_ASSET_TYPES = {
  thumbnail: {
    extensions: ['.jpg', '.jpeg', '.png'],
    mimeTypes: ['image/jpeg', 'image/png']
  },
  image: {
    extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg'],
    mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff', 'image/svg+xml']
  },
  audio: {
    extensions: ['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a', '.wma'],
    mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/flac', 'audio/ogg', 'audio/mp4', 'audio/x-ms-wma']
  },
  video: {
    extensions: ['.mp4', '.mov', '.avi', '.mkv', '.mxf', '.prores'],
    mimeTypes: ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/webm', 'application/octet-stream']
  },
  subtitle: {
    extensions: ['.srt', '.vtt', '.ass', '.ssa', '.sub'],
    mimeTypes: ['text/plain', 'text/vtt', 'application/x-subrip', 'application/octet-stream']
  },
  project: {
    extensions: ['.prproj', '.aep', '.fcp', '.drp', '.drt', '.dra', '.zip', '.rar', '.7z'],
    mimeTypes: ['application/octet-stream', 'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed']
  },
  document: {
    extensions: ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.xls', '.xlsx', '.ppt', '.pptx'],
    mimeTypes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'application/rtf',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ]
  },
  other: {
    extensions: ['.zip', '.rar', '.7z', '.tar', '.gz'],
    mimeTypes: ['application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed', 'application/x-tar', 'application/gzip']
  }
}

/**
 * Validate file extension
 */
export function validateFileExtension(filename: string): boolean {
  if (!filename || typeof filename !== 'string') {
    return false
  }

  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'))
  return FILE_LIMITS.ALLOWED_EXTENSIONS.includes(ext)
}

/**
 * Validate MIME type
 */
export function validateMimeType(mimeType: string): boolean {
  if (!mimeType || typeof mimeType !== 'string') {
    return false
  }

  return ALLOWED_VIDEO_TYPES.includes(mimeType.toLowerCase())
}


import { sanitizeFileName } from '@/lib/storage-sanitize'

/**
 * Sanitize filename to prevent path traversal and other attacks.
 *
 * @deprecated Import sanitizeFileName from @/lib/storage-sanitize instead.
 * Kept for backward compatibility.
 */
export const sanitizeFilename = sanitizeFileName

/**
 * Check if filename is suspicious
 */
export function isSuspiciousFilename(filename: string): boolean {
  const suspiciousPatterns = [
    /\.exe$/i,
    /\.sh$/i,
    /\.bat$/i,
    /\.cmd$/i,
    /\.com$/i,
    /\.scr$/i,
    /\.pif$/i,
    /\.app$/i,
    /\.deb$/i,
    /\.rpm$/i,
    /\.dmg$/i,
    /\.pkg$/i,
    /\.php$/i,
    /\.asp$/i,
    /\.jsp$/i,
    /\.js$/i,
    /\.vbs$/i,
    /\.ws$/i,
    /\.wsf$/i,
    /\.\./,  // Directory traversal
    /^\.ht/,  // .htaccess, .htpasswd
    /^\.env/, // Environment files
  ]
  
  return suspiciousPatterns.some(pattern => pattern.test(filename))
}

/**
 * Comprehensive file validation
 */
export function validateUploadedFile(
  filename: string,
  mimeType: string,
  size: number
): { valid: boolean; error?: string; sanitizedFilename?: string } {
  // Sanitize filename first
  const sanitizedFilename = sanitizeFilename(filename)

  // Check for suspicious filenames
  if (isSuspiciousFilename(filename)) {
    return {
      valid: false,
      error: 'Filename contains suspicious patterns'
    }
  }

  // Validate extension
  if (!validateFileExtension(sanitizedFilename)) {
    return {
      valid: false,
      error: `Invalid file type. Allowed: ${FILE_LIMITS.ALLOWED_EXTENSIONS.join(', ')}`
    }
  }

  // Validate MIME type
  if (!validateMimeType(mimeType)) {
    return {
      valid: false,
      error: `Invalid MIME type. Allowed: ${ALLOWED_VIDEO_TYPES.join(', ')}`
    }
  }

  return {
    valid: true,
    sanitizedFilename
  }
}

/**
 * Validate asset file (images, audio, documents, etc.)
 */
export function validateAssetFile(
  filename: string,
  mimeType: string,
  category?: string
): { valid: boolean; error?: string; sanitizedFilename?: string; detectedCategory?: string } {
  // Sanitize filename first
  const sanitizedFilename = sanitizeFilename(filename)

  // Check for suspicious filenames
  if (isSuspiciousFilename(filename)) {
    return {
      valid: false,
      error: 'Filename contains suspicious patterns'
    }
  }

  const ext = sanitizedFilename.toLowerCase().slice(sanitizedFilename.lastIndexOf('.'))

  // If category specified, validate against that category
  if (category && category in ALLOWED_ASSET_TYPES) {
    const categoryConfig = ALLOWED_ASSET_TYPES[category as keyof typeof ALLOWED_ASSET_TYPES]

    // Check extension
    if (!categoryConfig.extensions.includes(ext)) {
      return {
        valid: false,
        error: `Invalid file type for ${category}. Allowed: ${categoryConfig.extensions.join(', ')}`
      }
    }

    // Check MIME type - accept if it matches OR if it's a generic binary type
    // SECURITY: We allow generic MIME types here because:
    // 1. Browser MIME detection can be unreliable
    // 2. Worker performs strict magic byte validation (defense-in-depth)
    // 3. Suspicious extensions are still blocked above
    const normalizedMime = mimeType.toLowerCase()
    if (!categoryConfig.mimeTypes.includes(normalizedMime) &&
        normalizedMime !== 'application/octet-stream') {
      // Log the actual MIME type for debugging
      console.log(`[FILE-VALIDATION] Extension ${ext} matched ${category}, but MIME type ${mimeType} did not match. Worker will validate via magic bytes.`)
      console.log(`[FILE-VALIDATION] Allowed MIME types: ${categoryConfig.mimeTypes.join(', ')}`)
      return {
        valid: false,
        error: `Invalid MIME type for ${category}. Received: ${mimeType}. Allowed: ${categoryConfig.mimeTypes.join(', ')}`
      }
    }

    return {
      valid: true,
      sanitizedFilename,
      detectedCategory: category
    }
  }

  // If no category, detect from extension OR MIME type
  // First try to find by extension (most reliable)
  // SECURITY: Extension-based detection is acceptable here because:
  // 1. Worker performs strict magic byte validation (defense-in-depth)
  // 2. Suspicious extensions (.exe, .sh, etc.) are blocked above
  for (const [cat, config] of Object.entries(ALLOWED_ASSET_TYPES)) {
    if (config.extensions.includes(ext)) {
      // Extension matches, accept it
      // Worker will validate actual file content via magic bytes
      return {
        valid: true,
        sanitizedFilename,
        detectedCategory: cat
      }
    }
  }

  // If extension didn't match, try MIME type
  for (const [cat, config] of Object.entries(ALLOWED_ASSET_TYPES)) {
    if (config.mimeTypes.includes(mimeType.toLowerCase())) {
      return {
        valid: true,
        sanitizedFilename,
        detectedCategory: cat
      }
    }
  }

  // No category matched
  return {
    valid: false,
    error: `Unsupported file type: ${ext}. Please upload images, audio, documents, or project files.`
  }
}

