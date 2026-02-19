import { prisma } from '@/lib/db'
import { getPrimaryRecipient } from '@/lib/recipients'
import { isSmtpConfigured } from '@/lib/settings'
import { getRedis } from '@/lib/redis'
import { validateCommentLength, containsSuspiciousPatterns, sanitizeCommentHtml } from '@/lib/security/html-sanitization'
import { sendImmediateNotification, queueNotification } from '@/lib/notifications'
import { sendPushNotification } from '@/lib/push-notifications'
import { canDoAction, isProjectStatusVisible, normalizeRolePermissions } from '@/lib/rbac'

export async function resolveCommentDisplayColorSnapshot(params: {
  projectId: string
  isInternal: boolean
  userId?: string | null
  recipientId?: string | null
}): Promise<string | null> {
  const { projectId, userId, recipientId } = params

  // NOTE: author identity is not the same as visibility.
  // Admin users can create client-visible comments (isInternal === false).
  // If a comment is linked to a user, always use user.displayColor.
  if (userId) {
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
 * Validate comment permissions
 * Checks if user can create comments based on project settings
 */
export async function validateCommentPermissions(params: {
  projectId: string
  isInternal: boolean
  currentUser: any
}): Promise<{ valid: boolean; error?: string; errorStatus?: number }> {
  const { projectId, isInternal, currentUser } = params

  const isAuthenticatedInternalUser = !!currentUser

  if (isAuthenticatedInternalUser && currentUser?.appRoleIsSystemAdmin !== true) {
    const permissions = normalizeRolePermissions(currentUser?.permissions)
    const requiredPermission = isInternal ? 'makeCommentsOnProjects' : 'manageSharePageComments'
    if (!canDoAction(permissions, requiredPermission)) {
      return { valid: false, error: 'Forbidden', errorStatus: 403 }
    }
  }

  // SECURITY: If isInternal flag is set, verify admin session
  if (isInternal) {
    if (!currentUser) {
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
      status: true,
      guestMode: true,
    }
  })

  if (!project) {
    return { valid: false, error: 'Access denied', errorStatus: 403 }
  }

  if (isAuthenticatedInternalUser) {
    const permissions = normalizeRolePermissions(currentUser?.permissions)
    if (!isProjectStatusVisible(permissions, project.status)) {
      return { valid: false, error: 'Access denied', errorStatus: 403 }
    }
  }

  // SECURITY: If feedback is hidden (or Share Only mode), reject comment creation
  if (project.hideFeedback || project.status === 'SHARE_ONLY') {
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

    // IMPORTANT: author identity is not the same as visibility.
    // Internal users can create share-visible comments (isInternal === false).
    const isAdminAuthored = !!comment?.userId || comment.isInternal

    // Each side has its own schedule. Evaluate both independently so all
    // non-author recipients on both sides are always notified.
    const adminSchedule = settings?.adminNotificationSchedule || 'IMMEDIATE'
    const clientSchedule = project.clientNotificationSchedule
    const adminImmediate = adminSchedule === 'IMMEDIATE'
    const clientImmediate = clientSchedule === 'IMMEDIATE'

    console.log(`[COMMENT-NOTIFICATION] Comment type: ${isAdminAuthored ? 'ADMIN' : 'CLIENT'}, Admin schedule: ${adminSchedule}, Client schedule: ${clientSchedule}`)

    const context = {
      comment,
      project: { id: project.id, title: project.title, slug: project.slug },
      video,
      isReply: !!parentId
    }

    // Send/queue for client recipients
    if (clientImmediate) {
      console.log('[COMMENT-NOTIFICATION] Client path: sending immediately...')
      await sendImmediateNotification(context, 'client')
    }
    // Send/queue for admin/internal recipients
    if (adminImmediate) {
      console.log('[COMMENT-NOTIFICATION] Admin path: sending immediately...')
      await sendImmediateNotification(context, 'admin')
    }
    // Queue once if either side needs batched delivery.
    // Pre-mark sides that were already sent immediately so workers don't re-process them.
    if (!clientImmediate || !adminImmediate) {
      console.log(`[COMMENT-NOTIFICATION] Queuing for batched delivery (admin: ${adminSchedule}, client: ${clientSchedule})...`)
      await queueNotification(context, { admins: adminImmediate, clients: clientImmediate })
    }

    // Collaboration signal: share-visible admin comment (authored by an internal user).
    // This feeds the admin header notification bell (PushNotificationLog).
    // Exclude internal-only comments (`isInternal === true`).
    if (isAdminAuthored && comment?.isInternal === false && comment?.userId) {
      try {
        await sendPushNotification({
          type: 'ADMIN_SHARE_COMMENT',
          projectId: project.id,
          projectName: project.title,
          title: 'New admin comment',
          message: 'New admin comment on project',
          details: {
            __meta: {
              authorUserId: String(comment.userId),
              commentId: String(comment.id),
            },
            __link: {
              href: `/admin/projects/${encodeURIComponent(project.id)}`,
            },
            'Project': project.title,
            'Video': video?.name || 'N/A',
            'Timecode': comment.timecode,
            'Author': comment.authorName || 'Admin',
            'Comment': comment.content.substring(0, 200) + (comment.content.length > 200 ? '...' : ''),
          },
        })
      } catch (e) {
        console.warn('[COMMENT-NOTIFICATION] Failed to emit admin share-comment push event')
      }
    }

    // Send push notification for client comments only (not admin activity)
    if (!isAdminAuthored) {
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

    console.log(`[CANCEL-NOTIFICATION] Cancelling notification for comment ${commentId}`)

    // Mark as cancelled in Redis (8-day TTL covers weekly schedules)
    await redis.set(
      `comment_cancelled:${commentId}`,
      '1',
      'EX',
      691200 // 8 days
    )

    // Delete from notification queue if it exists
    await prisma.notificationQueue.deleteMany({
      where: {
        data: {
          path: ['commentId'],
          equals: commentId
        }
      }
    })

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
