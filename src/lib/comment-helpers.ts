import { prisma } from '@/lib/db'
import { getPrimaryRecipient } from '@/lib/recipients'
import { isSmtpConfigured } from '@/lib/settings'
import { getRedis } from '@/lib/redis'
import { validateCommentLength, containsSuspiciousPatterns, sanitizeCommentHtml } from '@/lib/security/html-sanitization'
import { queueNotification } from '@/lib/notifications'
import { sendPushNotification } from '@/lib/push-notifications'
import { canDoAction, isProjectStatusVisible, normalizeRolePermissions } from '@/lib/rbac'
import {
  buildReactionSummaries,
  collectCommentIds,
  type CommentReactionSummary,
} from '@/lib/comment-reactions'

function buildAdminShareUrl(projectId: string, videoName?: string | null, videoVersion?: number | null): string {
  if (!videoName || !Number.isFinite(videoVersion ?? NaN)) {
    return `/admin/projects/${encodeURIComponent(projectId)}`
  }

  return `/admin/projects/${encodeURIComponent(projectId)}/share?video=${encodeURIComponent(videoName)}&version=${encodeURIComponent(String(videoVersion))}`
}

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

  const [primaryRecipient, project, recipient] = await Promise.all([
    getPrimaryRecipient(projectId),
    prisma.project.findUnique({
      where: { id: projectId },
      select: { companyName: true }
    }),
    recipientId
      ? prisma.projectRecipient.findUnique({
          where: { id: recipientId },
          select: { email: true, projectId: true }
        })
      : Promise.resolve(null),
  ])

  // Priority: companyName → primary recipient → 'Client'
  const fallbackName = project?.companyName || primaryRecipient?.name || 'Client'

  // If recipientId provided, use that recipient's email
  let finalAuthorEmail = authorEmail || null

  if (recipient && recipient.projectId === projectId) {
    finalAuthorEmail = recipient.email
  }

  return { authorEmail: finalAuthorEmail, fallbackName }
}

/**
 * Load emoji reactions for a whole comment list (parents and replies) in one query and
 * roll them up per comment, ready to hand to sanitizeComment().
 *
 * The viewer identity decides `viewerReacted`. A share session's recipient normally comes
 * from the token, but the share page lets a viewer pick their name after the token was
 * issued, so `requestedRecipientId` accepts a client-supplied id — validated against the
 * project first, since an unvalidated id would let a caller read back whether some other
 * named recipient had reacted.
 */
export async function hydrateCommentReactions(params: {
  comments: Array<{ id: string; replies?: Array<{ id: string }> }>
  isAdmin: boolean
  // Reactor names go to admins and authenticated share viewers — the same audience that
  // already sees comment author names in sanitizeComment. Anonymous viewers get counts only.
  isAuthenticated?: boolean
  viewerUserId?: string | null
  viewerRecipientId?: string | null
  requestedRecipientId?: string | null
  projectId?: string | null
}): Promise<Map<string, CommentReactionSummary[]>> {
  const { comments, isAdmin, viewerUserId, projectId } = params
  const includeNames = isAdmin || params.isAuthenticated === true

  const commentIds = collectCommentIds(comments)
  if (commentIds.length === 0) return new Map()

  let viewerRecipientId = params.viewerRecipientId || null
  const requested = typeof params.requestedRecipientId === 'string' ? params.requestedRecipientId.trim() : ''
  if (!viewerRecipientId && requested && projectId) {
    const recipient = await prisma.projectRecipient.findFirst({
      where: { id: requested, projectId },
      select: { id: true },
    })
    viewerRecipientId = recipient?.id || null
  }

  const rows = await prisma.commentReaction.findMany({
    where: { commentId: { in: commentIds } },
    select: {
      commentId: true,
      emoji: true,
      userId: true,
      recipientId: true,
      user: { select: { name: true, email: true } },
      recipient: { select: { name: true, email: true } },
    },
  })

  return buildReactionSummaries(rows, { userId: viewerUserId || null, recipientId: viewerRecipientId }, includeNames)
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

  // Sanitize authorName (alphanumeric, spaces, and safe punctuation only)
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
    const [project, video, settings] = await Promise.all([
      prisma.project.findUnique({
        where: { id: projectId },
        select: {
          id: true,
          title: true,
          slug: true,
          clientNotificationSchedule: true,
        }
      }),
      videoId
        ? prisma.video.findUnique({
            where: { id: videoId },
            select: { name: true, version: true, versionLabel: true }
          })
        : Promise.resolve(null),
      prisma.settings.findUnique({
        where: { id: 'default' },
        select: { adminNotificationSchedule: true }
      }),
    ])

    if (!project) {
      console.log('[COMMENT-NOTIFICATION] Project not found')
      return
    }

    console.log('[COMMENT-NOTIFICATION] Video:', video?.name || 'None')

    // IMPORTANT: author identity is not the same as visibility.
    // Internal users can create share-visible comments (isInternal === false).
    const isAdminAuthored = !!comment?.userId || comment.isInternal

    // --- Bell / browser push notifications ---
    // These run regardless of SMTP configuration; they feed the in-app
    // notification bell and (if enabled) browser push delivery.

    // Collaboration signal: share-visible admin comment (authored by an internal user).
    // Exclude internal-only comments (`isInternal === true`).
    if (isAdminAuthored && comment?.isInternal === false && comment?.userId) {
      try {
        const shareUrl = buildAdminShareUrl(project.id, video?.name, comment.videoVersion)
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
              videoId: comment.videoId,
              videoVersion: comment.videoVersion,
              videoName: video?.name,
            },
            __link: {
              href: shareUrl,
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

    // Client comment bell notification (not admin activity)
    if (!isAdminAuthored) {
      try {
        const shareUrl = buildAdminShareUrl(project.id, video?.name, comment.videoVersion)
        await sendPushNotification({
          type: 'CLIENT_COMMENT',
          projectId: project.id,
          projectName: project.title,
          title: 'New Client Comment',
          message: `New comment on project`,
          details: {
            __meta: {
              commentId: String(comment.id),
              videoId: comment.videoId,
              videoVersion: comment.videoVersion,
              videoName: video?.name,
            },
            __link: {
              href: shareUrl,
            },
            'Project': project.title,
            'Video': video?.name || 'N/A',
            'Timecode': comment.timecode,
            'Author': comment.authorName || 'Client',
            'Comment': comment.content.substring(0, 200) + (comment.content.length > 200 ? '...' : ''),
          },
        })
      } catch (e) {
        console.warn('[COMMENT-NOTIFICATION] Failed to emit client comment push event')
      }
    }

    // --- Email notifications ---
    // These require SMTP to be configured; skip silently if it is not.
    const smtpConfigured = await isSmtpConfigured()
    console.log('[COMMENT-NOTIFICATION] SMTP configured:', smtpConfigured)

    if (!smtpConfigured) {
      console.log('[COMMENT-NOTIFICATION] Skipping email - SMTP not configured')
      return
    }

    // Each side has its own schedule. Evaluate both independently so all
    // non-author recipients on both sides are always notified.
    //
    // Comment activity is always batched — the only choice is the cadence (HOURLY/DAILY)
    // or NONE. Approvals and revision requests do not come through here and still send the
    // moment they happen.
    const adminSchedule = settings?.adminNotificationSchedule || 'HOURLY'
    const clientSchedule = project.clientNotificationSchedule
    const adminNone = adminSchedule === 'NONE'
    const clientNone = clientSchedule === 'NONE'

    console.log(`[COMMENT-NOTIFICATION] Comment type: ${isAdminAuthored ? 'ADMIN' : 'CLIENT'}, Admin schedule: ${adminSchedule}, Client schedule: ${clientSchedule}`)

    const context = {
      comment,
      project: { id: project.id, title: project.title, slug: project.slug },
      video,
      isReply: !!parentId
    }

    // Queue once if either side wants notifications (NONE sides are pre-marked as sent).
    if (!adminNone || !clientNone) {
      console.log(`[COMMENT-NOTIFICATION] Queuing for batched delivery (admin: ${adminSchedule}, client: ${clientSchedule})...`)
      await queueNotification(context, { admins: adminNone, clients: clientNone })
    }
  } catch (emailError) {
    // Don't fail the request if notification processing fails
    console.error('[COMMENT-NOTIFICATION] Error processing notification:', emailError)
  }
}

/**
 * Cancel pending notifications for deleted comment(s).
 *
 * Marks each comment as cancelled in Redis (the workers and the manual send path both
 * check this before rendering a digest) and drops its still-pending queue rows.
 *
 * Pass every comment id that is disappearing, not just the one the user clicked:
 * replies cascade-delete with their parent, and every comment on a video cascades when
 * the video is deleted. A row left behind emails feedback that no longer exists.
 *
 * Already-sent rows are left in place — an email cannot be unsent, and deleting the row
 * would erase it from the backlog history.
 */
export async function cancelCommentNotification(commentIds: string | string[]): Promise<void> {
  const ids = (Array.isArray(commentIds) ? commentIds : [commentIds]).filter(Boolean)
  if (ids.length === 0) return

  try {
    console.log(`[CANCEL-NOTIFICATION] Cancelling notifications for ${ids.length} comment(s)`)

    // Mark as cancelled in Redis (8-day TTL covers weekly schedules). Pipelined so a
    // video with hundreds of comments is one round trip rather than hundreds.
    const pipeline = getRedis().pipeline()
    for (const commentId of ids) {
      pipeline.set(`comment_cancelled:${commentId}`, '1', 'EX', 691200) // 8 days
    }
    await pipeline.exec()

    // Delete still-pending rows from the queue. Rows where both sides have gone out stay:
    // the Redis marker is what stops a half-sent row from reaching the remaining side.
    // Chunked so deleting a video with a full thread can't build a query with hundreds
    // of OR'd JSON predicates.
    let count = 0
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100)
      const result = await prisma.notificationQueue.deleteMany({
        where: {
          AND: [
            { OR: [{ sentToClients: false }, { sentToAdmins: false }] },
            { OR: chunk.map((commentId) => ({ data: { path: ['commentId'], equals: commentId } })) },
          ],
        },
      })
      count += result.count
    }

    console.log(`[CANCEL-NOTIFICATION] Removed ${count} pending notification(s) for ${ids.length} comment(s)`)
  } catch (error) {
    console.error('[CANCEL-NOTIFICATION] Error cancelling notification:', error)
    // Don't throw - deletion should succeed even if notification cancellation fails
  }
}

/**
 * Re-point pending notifications at a comment's edited text.
 *
 * Queue rows carry a snapshot of the comment body (the digest is assembled from
 * `data`, not from a live join), so a comment edited before the next summary goes
 * out would otherwise be emailed in its original wording — the exact thing the
 * client edited away. Rewrite every still-pending row that quotes this comment:
 * its own entry, a reply's "in reply to" quote, and a reaction's quoted comment.
 *
 * Rows with at least one side still pending are updated, which includes a row
 * already sent to admins but not yet to clients. That is deliberate: the pending
 * side is what a reader will act on, and the alternative — splitting the row —
 * would double-send the comment.
 */
export async function syncCommentNotificationContent(commentId: string, content: string): Promise<void> {
  try {
    const pending = await prisma.notificationQueue.findMany({
      where: {
        AND: [
          { OR: [{ sentToClients: false }, { sentToAdmins: false }] },
          {
            OR: [
              { data: { path: ['commentId'], equals: commentId } },
              { data: { path: ['parentCommentId'], equals: commentId } },
            ],
          },
        ],
      },
      select: { id: true, data: true },
    })

    if (pending.length === 0) return

    let updated = 0
    for (const row of pending) {
      const data = row.data as any
      if (!data || typeof data !== 'object') continue

      const next = { ...data }
      let changed = false

      if (data.commentId === commentId) {
        // The comment itself — COMMENT_REACTION rows quote it under `reactedTo`
        // instead of carrying it as the entry body.
        if (data.type === 'COMMENT_REACTION') {
          if (data.reactedTo && data.reactedTo.content !== content) {
            next.reactedTo = { ...data.reactedTo, content }
            changed = true
          }
        } else if (data.content !== content) {
          next.content = content
          next.edited = true
          changed = true
        }
      }

      if (data.parentCommentId === commentId && data.parentComment && data.parentComment.content !== content) {
        next.parentComment = { ...data.parentComment, content }
        changed = true
      }

      if (!changed) continue

      await prisma.notificationQueue.update({
        where: { id: row.id },
        data: { data: next },
      })
      updated++
    }

    if (updated > 0) {
      console.log(`[SYNC-NOTIFICATION] Updated ${updated} pending notification(s) after edit of comment ${commentId}`)
    }
  } catch (error) {
    console.error('[SYNC-NOTIFICATION] Error syncing edited comment into pending notifications:', error)
    // Don't throw - the edit itself must succeed even if the queue can't be updated.
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
          fileName: true },
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
              fileName: true },
          },
        },
        orderBy: { createdAt: 'asc' }
      }
    },
    orderBy: { createdAt: 'asc' }
  })
}
