/**
 * Storage Path Sanitization
 *
 * Central module for sanitizing path segments used in storage paths.
 * All path construction in project-storage-paths.ts and accounting/file-storage.ts
 * MUST use these functions — never inline sanitization.
 *
 * Two functions for two distinct purposes:
 *
 *   sanitizeFilePathSegment(name)
 *     Use for FOLDER-LEVEL names: client name, project folder name, video folder,
 *     version label, album folder name, upload folder segments.
 *     Preserves spaces, ampersands, dashes. Collapses underscores. Strips trailing dots.
 *
 *   sanitizeFileName(name)
 *     Use for individual FILE names: original video files, assets, photos, attachments.
 *     Stricter: replaces anything not alphanumeric/space/dash/underscore/dot/ampersand
 *     with underscore. Strips path separators and directory traversal.
 */

// ---------------------------------------------------------------------------
// sanitizeFilePathSegment — for folder names (client, project, video, album, etc.)
// ---------------------------------------------------------------------------

/**
 * Sanitize a single folder-level path segment.
 *
 * Used by: buildClientStorageRoot, buildProjectStorageRoot,
 * buildVideoStorageRoot, buildVideoVersionRoot, buildAlbumStorageRoot,
 * normalizeProjectUploadRelativePath, buildUploadTimelineStorageRoot, etc.
 *
 * Rules:
 *  - Trim + collapse whitespace
 *  - Replace OS-illegal chars (<>:"/\|?*) and control chars with underscore
 *  - Collapse consecutive underscores
 *  - Strip leading/trailing dots and spaces
 *  - Fallback to "Untitled" if empty
 */
export function sanitizeFilePathSegment(name: string): string {
  const sanitized = name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/[\x00-\x1F]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/[.\s]+$/g, '')
    .replace(/^[.\s]+/g, '')

  return sanitized || 'Untitled'
}

// ---------------------------------------------------------------------------
// sanitizeFileName — for individual file names
// ---------------------------------------------------------------------------

/**
 * Sanitize a single file name.
 *
 * Used by: buildProjectUploadFileStoragePath, buildVideoOriginalStoragePath,
 * buildVideoAssetStoragePath, buildAlbumPhotoStoragePath, etc.
 *
 * Rules:
 *  - Extract basename (strip any path separators / \ :)
 *  - Remove null bytes and control chars
 *  - Strip leading/trailing dots and spaces
 *  - Remove directory traversal (..)
 *  - Limit to 255 chars preserving extension
 *  - Replace anything not [a-zA-Z0-9 ._&-] with underscore
 *  - Fallback to "upload.bin" if empty
 */
export function sanitizeFileName(name: string): string {
  if (!name || typeof name !== 'string') {
    return 'upload.bin'
  }

  // Extract basename — strip any path components
  let safe = name.split(/[/\\:]+/).pop() || 'upload'

  // Remove null bytes
  safe = safe.replace(/\x00/g, '')

  // Remove control characters
  safe = safe.replace(/[\x00-\x1F\x7F]/g, '')

  // Remove leading/trailing dots and spaces (iterative to avoid ReDoS)
  while (safe.length > 0 && (safe[0] === '.' || safe[0] === ' ')) safe = safe.slice(1)
  while (safe.length > 0 && (safe[safe.length - 1] === '.' || safe[safe.length - 1] === ' ')) safe = safe.slice(0, -1)

  // Prevent directory traversal
  safe = safe.replace(/\.\./g, '')

  // Limit length while preserving extension
  if (safe.length > 255) {
    const ext = safe.slice(safe.lastIndexOf('.'))
    const baseName = safe.slice(0, 255 - ext.length)
    safe = baseName + ext
  }

  // Ensure not empty and not just dots
  if (!safe || safe === '.' || safe === '..') {
    safe = 'upload.bin'
  }

  // Only allow alphanumeric, space, dash, underscore, dot, ampersand
  safe = safe.replace(/[^a-zA-Z0-9 ._&-]/g, '_')

  return safe
}
