/**
 * File upload configuration and utilities for comment attachments
 */

import { buildCommentFileStoragePath } from '@/lib/project-storage-paths'

// Maximum number of files per comment
export const MAX_FILES_PER_COMMENT = 5;

// The file-type policy lives in a dependency-free module so server-side callers can pull it in
// without dragging Node built-ins along. Re-exported here so existing importers are unaffected.
export {
  ALLOWED_FILE_TYPES,
  BLOCKED_FILE_EXTENSIONS,
  UPLOAD_CATEGORIES,
  DEFAULT_CLIENT_UPLOAD_POLICY,
  getCategoryExtensions,
  isBlockedExtension,
  normalizeUploadCategories,
  parseCustomExtensions,
  parseClientUploadPolicy,
  validateCommentFile,
  getAllowedFileTypesDescription,
} from '@/lib/upload-policy'
export type { ClientUploadPolicy, UploadCategory } from '@/lib/upload-policy'

/**
 * Generate safe storage path for comment file
 * @param projectId - Project ID
 * @param commentId - Comment ID
 * @param fileName - Original file name
 * @returns Safe storage path
 */
export function generateCommentFilePath(projectStoragePath: string, commentId: string, fileName: string): string {
  // Sanitize filename and ensure it doesn't contain path traversal attempts
  const sanitized = fileName.replace(/[^a-zA-Z0-9 ._&-]/g, "_");

  // Generate unique filename to avoid collisions
  const timestamp = Date.now();
  return buildCommentFileStoragePath(projectStoragePath, commentId, sanitized, timestamp);
}
