import { prisma } from '@/lib/db'
import { getPrimaryRecipient } from '@/lib/recipients'
import { isSmtpConfigured } from '@/lib/settings'
import { getRedis } from '@/lib/redis'
import { validateCommentLength, containsSuspiciousPatterns, sanitizeCommentHtml } from '@/lib/security/html-sanitization'
import { sendImmediateNotification, queueNotification } from '@/lib/notifications'
import { sendPushNotification } from '@/lib/push-notifications'

const normalizeRecipientName = (value: string): string => {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/**
 * Best-effort backfill for legacy client comments.
 *
 * If a client comment is missing recipientId, try to match its authorName to a
 * ProjectRecipient.name (case-insensitive) and persist recipientId.
 *
 * This allows displayColor to update retroactively for older comments.
 */
export async function backfillCommentRecipientIdsByAuthorName(projectId: string): Promise<void> {
  try {
    const recipients = await prisma.projectRecipient.findMany({
      where: { projectId, name: { not: null } },
      select: { id: true, name: true },
    })

    const nameToRecipientId = new Map<string, string>()
    for (const recipient of recipients) {
      const name = typeof recipient.name === 'string' ? normalizeRecipientName(recipient.name) : ''
      if (!name) continue
      // Only map unique names; if duplicates exist, skip to avoid incorrect linking.
      if (nameToRecipientId.has(name)) {
        nameToRecipientId.delete(name)
        continue
      }
      nameToRecipientId.set(name, recipient.id)
    }

    if (nameToRecipientId.size === 0) return

    // Find legacy client comments missing recipientId.
    // Includes replies as well (not just top-level).
    const commentsNeedingBackfill = await prisma.comment.findMany({
      where: {
        projectId,
        isInternal: false,
        recipientId: null,
        authorName: { not: null },
      },
      select: { id: true, authorName: true },
      take: 500,
    })

    if (commentsNeedingBackfill.length === 0) return

    const updates: Array<ReturnType<typeof prisma.comment.update>> = []

    for (const comment of commentsNeedingBackfill) {
      const author = typeof comment.authorName === 'string' ? normalizeRecipientName(comment.authorName) : ''
      if (!author) continue
      const matchedRecipientId = nameToRecipientId.get(author)
      if (!matchedRecipientId) continue

      updates.push(
        prisma.comment.update({
          where: { id: comment.id },
          data: { recipientId: matchedRecipientId },
        })
      )
    }

    if (updates.length === 0) return

    await prisma.$transaction(updates)
  } catch {
    // Best-effort only; ignore failures.
  }
}

export async function resolveCommentDisplayColorSnapshot(params: {
  projectId: string
  isInternal: boolean
  userId?: string | null
  recipientId?: string | null
}): Promise<string | null> {
  const { projectId, isInternal, userId, recipientId } = params

  if (isInternal) {
    if (!userId) return null
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { displayColor: true },
    })
    return user?.displayColor || null
  }

  if (!recipientId) return null

  const recipient = await prisma.projectRecipient.findUnique({
    where: { id: recipientId },
    select: { displayColor: true, projectId: true },
  })

  if (!recipient || recipient.projectId !== projectId) return null
  return recipient.displayColor || null
}

/**
 * Best-effort backfill for legacy comments.
 *
 * If a comment is already linked to a user/recipient but missing a snapshot,
 * copy the current linked displayColor into displayColorSnapshot.
 */
export async function backfillCommentDisplayColorSnapshots(projectId: string): Promise<void> {
  try {
    const candidates = await prisma.comment.findMany({
      where: {
        projectId,
        displayColorSnapshot: null,
        OR: [{ userId: { not: null } }, { recipientId: { not: null } }],
      },
      select: {
        id: true,
        isInternal: true,
        user: { select: { displayColor: true } },
        recipient: { select: { displayColor: true } },
      },
      take: 500,
    })

    if (candidates.length === 0) return

    const updates: Array<ReturnType<typeof prisma.comment.update>> = []

    for (const comment of candidates) {
      const snapshot = comment.isInternal
        ? (comment.user?.displayColor || null)
        : (comment.recipient?.displayColor || null)

      if (!snapshot) continue

      updates.push(
        prisma.comment.update({
          where: { id: comment.id },
          data: { displayColorSnapshot: snapshot },
        })
      )
    }

    if (updates.length === 0) return
    await prisma.$transaction(updates)
  } catch {
    // Best-effort only; ignore failures.
  }
}

/**
 * Validate comment permissions
 * Checks if user can create comments based on project settings
 */
export async function validateCommentPermissions(params: {
  projectId: string
  isInternal: boolean
  currentUser: any
}): Promise<{ valid: boolean; error?: string; errorStatus?: number }> {
  const { projectId, isInternal, currentUser } = params

  // SECURITY: If isInternal flag is set, verify admin session
  if (isInternal) {
    if (!currentUser || currentUser.role !== 'ADMIN') {
      return { valid: false, error: 'Unauthorized', errorStatus: 401 }
    }
  }

  // Fetch the project to check permissions
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      sharePassword: true,
      authMode: true,
      hideFeedback: true,
      guestMode: true,
    }
  })

  if (!project) {
    return { valid: false, error: 'Access denied', errorStatus: 403 }
  }

  // SECURITY: If feedback is hidden, reject comment creation
  if (project.hideFeedback) {
    return { valid: false, error: 'Comments are disabled for this project', errorStatus: 403 }
  }

  return { valid: true }
}

/**
 * Resolve comment author information
 * Determines author email and fallback name based on user type
 */
export async function resolveCommentAuthor(params: {
  projectId: string
  authorEmail?: string | null | undefined
  recipientId?: string | null | undefined
}): Promise<{ authorEmail: string | null; fallbackName: string }> {
  const { projectId, authorEmail, recipientId } = params

  // Get primary recipient for author name fallback
  const primaryRecipient = await getPrimaryRecipient(projectId)

  // Get project company name
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { companyName: true }
  })

  // Priority: companyName → primary recipient → 'Client'
  const fallbackName = project?.companyName || primaryRecipient?.name || 'Client'

  // If recipientId provided, use that recipient's email
  let finalAuthorEmail = authorEmail || null

  if (recipientId) {
    const recipient = await prisma.projectRecipient.findUnique({
      where: { id: recipientId },
      select: { email: true, projectId: true }
    })

    if (recipient && recipient.projectId === projectId) {
      finalAuthorEmail = recipient.email
    }
  }

  return { authorEmail: finalAuthorEmail, fallbackName }
}

/**
 * Sanitize and validate comment content and author name
 */
export async function sanitizeAndValidateContent(params: {
  content: string
  authorName?: string | null | undefined
}): Promise<{
  valid: boolean
  sanitizedContent?: string
  sanitizedAuthorName?: string | null
  error?: string
  errorStatus?: number
}> {
  const { content, authorName } = params

  // Validate content length
  if (!validateCommentLength(content)) {
    return {
      valid: false,
      error: 'Comment is too long (max 10,000 characters)',
      errorStatus: 400
    }
  }

  // Check for suspicious patterns
  if (containsSuspiciousPatterns(content)) {
    return {
      valid: false,
      error: 'Comment contains potentially malicious content',
      errorStatus: 400
    }
  }

  // Sanitize HTML content
  const sanitizedContent = sanitizeCommentHtml(content)

  // Sanitize authorName (same rules as watermark text)
  let sanitizedAuthorName = authorName || null
  if (sanitizedAuthorName) {
    // Remove invalid characters
    const invalidChars = sanitizedAuthorName.match(/[^a-zA-Z0-9\s\-_.()]/g)
    if (invalidChars) {
      return {
        valid: false,
        error: 'Invalid characters in name',
        errorStatus: 400
      }
    }

    // Length check
    if (sanitizedAuthorName.length > 50) {
      return {
        valid: false,
        error: 'Name is too long (max 50 characters)',
        errorStatus: 400
      }
    }

    // Trim whitespace
    sanitizedAuthorName = sanitizedAuthorName.trim()
  }

  return {
    valid: true,
    sanitizedContent,
    sanitizedAuthorName
  }
}

/**
 * Handle comment notifications
 * Sends notifications immediately or queues them based on schedule
 * Also tracks pending notifications in Redis for cancellation support
 */
export async function handleCommentNotifications(params: {
  comment: any
  projectId: string
  videoId?: string
  parentId?: string
}): Promise<void> {
  const { comment, projectId, videoId, parentId } = params

  try {
    // Check if SMTP is configured
    const smtpConfigured = await isSmtpConfigured()
    console.log('[COMMENT-NOTIFICATION] SMTP configured:', smtpConfigured)

    if (!smtpConfigured) {
      console.log('[COMMENT-NOTIFICATION] Skipping - SMTP not configured')
      return
    }

    // Track this comment's notification in Redis (for deletion cancellation)
    const redis = getRedis()
    await redis.set(
      `comment_notification:${comment.id}`,
      JSON.stringify({ commentId: comment.id, projectId, videoId, queued: true }),
      'EX',
      3600 // Expire after 1 hour (covers all notification schedules)
    )

    // Get project with notification schedule
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        title: true,
        slug: true,
        clientNotificationSchedule: true,
      }
    })

    if (!project) {
      console.log('[COMMENT-NOTIFICATION] Project not found')
      return
    }

    // Get video info
    const video = videoId ? await prisma.video.findUnique({
      where: { id: videoId },
      select: { name: true, versionLabel: true }
    }) : null

    console.log('[COMMENT-NOTIFICATION] Video:', video?.name || 'None')

    // Get settings for admin schedule
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { adminNotificationSchedule: true }
    })

    // Determine which schedule to use
    const isAdminComment = comment.isInternal
    const schedule = isAdminComment
      ? project.clientNotificationSchedule // Admin replies use client schedule
      : (settings?.adminNotificationSchedule || 'IMMEDIATE') // Client comments use admin schedule

    console.log(`[COMMENT-NOTIFICATION] Comment type: ${isAdminComment ? 'ADMIN' : 'CLIENT'}, Schedule: ${schedule}`)

    const context = {
      comment,
      project: { id: project.id, title: project.title, slug: project.slug },
      video,
      isReply: !!parentId
    }

    // Handle notification based on schedule
    if (schedule === 'IMMEDIATE') {
      console.log('[COMMENT-NOTIFICATION] Sending immediately...')
      await sendImmediateNotification(context)
    } else {
      console.log(`[COMMENT-NOTIFICATION] Queuing for later (${schedule})...`)
      await queueNotification(context)
    }

    // Send push notification for client comments only (not admin replies)
    if (!isAdminComment) {
      await sendPushNotification({
        type: 'CLIENT_COMMENT',
        projectId: project.id,
        projectName: project.title,
        title: 'New Client Comment',
        message: `New comment on project`,
        details: {
          'Project': project.title,
          'Video': video?.name || 'N/A',
          'Timecode': comment.timecode,
          'Author': comment.authorName || 'Client',
          'Comment': comment.content.substring(0, 200) + (comment.content.length > 200 ? '...' : ''),
        },
      })
    }
  } catch (emailError) {
    // Don't fail the request if notification processing fails
    console.error('[COMMENT-NOTIFICATION] Error processing notification:', emailError)
  }
}

/**
 * Cancel pending notification for a deleted comment
 * Removes from notification queue and marks as cancelled in Redis
 */
export async function cancelCommentNotification(commentId: string): Promise<void> {
  try {
    const redis = getRedis()

    // Check if notification is pending
    const notificationData = await redis.get(`comment_notification:${commentId}`)

    if (!notificationData) {
      console.log(`[CANCEL-NOTIFICATION] No pending notification for comment ${commentId}`)
      return
    }

    console.log(`[CANCEL-NOTIFICATION] Cancelling notification for comment ${commentId}`)

    // Delete from notification queue if it exists
    await prisma.notificationQueue.deleteMany({
      where: {
        data: {
          path: ['commentId'],
          equals: commentId
        }
      }
    })

    // Mark as cancelled in Redis
    await redis.del(`comment_notification:${commentId}`)

    console.log(`[CANCEL-NOTIFICATION] Successfully cancelled notification for comment ${commentId}`)
  } catch (error) {
    console.error('[CANCEL-NOTIFICATION] Error cancelling notification:', error)
    // Don't throw - deletion should succeed even if notification cancellation fails
  }
}

/**
 * Fetch all comments for a project
 * Returns top-level comments with nested replies
 */
export async function fetchProjectComments(projectId: string) {
  return prisma.comment.findMany({
    where: {
      projectId,
      parentId: null, // Only get top-level comments
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          username: true,
          email: true,
          displayColor: true,
        }
      },
      recipient: {
        select: {
          id: true,
          displayColor: true,
        }
      },
      files: {
        select: {
          id: true,
          fileName: true,
          fileSize: true,
        },
      },
      replies: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              username: true,
              email: true,
              displayColor: true,
            }
          },
          recipient: {
            select: {
              id: true,
              displayColor: true,
            }
          },
          files: {
            select: {
              id: true,
              fileName: true,
              fileSize: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' }
      }
    },
    orderBy: { createdAt: 'asc' }
  })
}
