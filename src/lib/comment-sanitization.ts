/**
 * Comment Sanitization Utility
 *
 * SECURITY-FIRST: Zero PII exposure policy
 * - Clients NEVER see real names or emails (even on public shares)
 * - Only admins in admin panel get full data for management
 * - All email/notification handling is server-side only
 *
 * Extracted from duplicate code in:
 * - src/app/api/comments/route.ts
 * - src/app/api/comments/[id]/route.ts
 * - src/app/api/share/[token]/comments/route.ts
 */
import { secondsToTimecode, parseTimecodeInput, isValidTimecode } from './timecode'

// Fallback for legacy comments that still have a numeric timestamp column
const normalizeTimecode = (comment: any): string => {
  if (comment.timecode && typeof comment.timecode === 'string') {
    const trimmed = comment.timecode.trim()

    if (isValidTimecode(trimmed)) {
      return trimmed
    }

    // Handle legacy seconds stored as a string (e.g., "36" or "36.5")
    if (!Number.isNaN(Number(trimmed)) && !trimmed.includes(':')) {
      return secondsToTimecode(parseFloat(trimmed), 24)
    }

    // Attempt to normalize other partial formats (MM:SS, HH:MM:SS)
    try {
      return parseTimecodeInput(trimmed, 24)
    } catch {
      // Fall through to default below
    }
  }

  if (typeof comment.timestamp === 'number') {
    return secondsToTimecode(comment.timestamp, 24)
  }

  return '00:00:00:00'
}

export function sanitizeComment(
  comment: any,
  isAdmin: boolean,
  isAuthenticated: boolean,
  clientName?: string
) {
  const normalizedTimecode = normalizeTimecode(comment)

  // Non-PII author classification for UI permissions.
  // - USER: created by an authenticated admin user (may be internal or share-visible)
  // - RECIPIENT: created by a project recipient (share page)
  // - ANONYMOUS: legacy/unlinked client comment
  const authorType: 'USER' | 'RECIPIENT' | 'ANONYMOUS' = comment?.userId
    ? 'USER'
    : comment?.recipientId
      ? 'RECIPIENT'
      : 'ANONYMOUS'

  const sanitized: any = {
    id: comment.id,
    projectId: comment.projectId,
    videoId: comment.videoId,
    videoVersion: comment.videoVersion,
    timecode: normalizedTimecode,
    content: comment.content,
    isInternal: comment.isInternal,
    authorType,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    parentId: comment.parentId,
  }

  // Non-PII: expose display color for UI highlights.
  // - Internal/admin: from user.displayColor
  // - Client: from recipient.displayColor
  sanitized.displayColor = comment?.isInternal
    ? (comment?.user?.displayColor || comment?.displayColorSnapshot || null)
    : (comment?.recipient?.displayColor || comment?.displayColorSnapshot || null)

  // Attachments: safe metadata only (no storage paths)
  if (comment.files && Array.isArray(comment.files)) {
    sanitized.files = comment.files.map((file: any) => ({
      id: file.id,
      fileName: file.fileName,
      fileSize:
        typeof file.fileSize === 'bigint'
          ? Number(file.fileSize)
          : typeof file.fileSize === 'string'
            ? Number(file.fileSize)
            : file.fileSize,
    }))
  }

  // NEVER expose real names or emails to non-admins
  // Use generic labels only
  if (isAdmin) {
    // Admins get real data for management purposes only
    sanitized.authorName = comment.authorName
    sanitized.authorEmail = comment.authorEmail
    sanitized.userId = comment.userId
    if (comment.user) {
      sanitized.user = {
        id: comment.user.id,
        name: comment.user.name,
        email: comment.user.email
      }
    }
  } else if (isAuthenticated) {
    // Authenticated share users see author names but never emails
    sanitized.authorName = comment.isInternal
      ? (comment.authorName || 'Admin')
      : (comment.authorName || clientName || 'Client')
  } else {
    // Guests/public: generic labels only, no PII
    sanitized.authorName = comment.isInternal ? 'Admin' : 'Client'
  }

  // Recursively sanitize replies
  if (comment.replies && Array.isArray(comment.replies)) {
    sanitized.replies = comment.replies.map((reply: any) =>
      sanitizeComment(reply, isAdmin, isAuthenticated, clientName)
    )
  }

  return sanitized
}
