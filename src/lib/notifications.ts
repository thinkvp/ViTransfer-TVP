import { Comment } from '@prisma/client'
import { prisma } from './db'
import { getEmailSettings, isSmtpConfigured, sendCommentNotificationEmail, sendAdminCommentNotificationEmail, sendProjectApprovedEmail, sendAdminProjectApprovedEmail, sendAdminRevisionRequestedEmail } from './email'
import { getProjectRecipients } from './recipients'
import { buildUnsubscribeUrl } from './unsubscribe'
import { generateShareUrl } from './url'
import { getRedis } from './redis'
import { sendPushNotification } from './push-notifications'
import { createHash } from 'crypto'
import { redactEmailForLogs } from './log-sanitization'
import { canDoAction, normalizeRolePermissions } from './rbac'

interface NotificationContext {
  comment: Comment & {
    user?: { displayColor?: string | null } | null
    recipient?: { displayColor?: string | null } | null
  }
  project: { id: string; title: string; slug: string }
  video: { name: string; versionLabel: string } | null
  isReply: boolean
}

interface ApprovalNotificationContext {
  project: { id: string; title: string; slug: string; clientNotificationSchedule: string }
  video?: { id: string; name: string; versionLabel?: string | null }
  approvedVideos?: Array<{ id: string; name: string }>
  approved: boolean // true = approved, false = unapproved
  authorName?: string | null
  authorEmail?: string | null
  isComplete?: boolean // true = all videos approved, false = partial approval
  performedByAdmin?: boolean // true = admin/internal user performed the action
}

/**
 * Queue an emoji reaction for the next batched summary.
 *
 * A reaction is the lightest possible signal that someone read a comment, so it never
 * sends on its own schedule — it rides whichever digest goes out next. That is also why
 * reactions were the deciding case for dropping the IMMEDIATE schedule: one email per
 * emoji click would have been unusable.
 *
 * Routing mirrors comments: a reaction from an internal user notifies the client side, a
 * reaction from a recipient notifies the admin side. The reactor is never notified, and
 * reacting to your own comment notifies nobody (it carries no information for anyone else).
 *
 * Call only when a reaction row was actually created — the route's POST is idempotent, so
 * a repeat click must not enqueue a second notification.
 */
export async function queueReactionNotification(params: {
  reactionId: string
  emoji: string
  comment: {
    id: string
    projectId: string
    videoId: string
    content: string
    timecode: string | null
    authorName: string | null
    userId: string | null
    recipientId: string | null
  }
  reactorName: string
  reactorEmail: string | null
  /** Exactly one of these is set — an internal user, or a project recipient. */
  reactorUserId: string | null
  reactorRecipientId: string | null
}) {
  const { reactionId, emoji, comment, reactorName, reactorEmail, reactorUserId, reactorRecipientId } = params

  const reactorIsAdmin = !!reactorUserId

  // Reacting to your own comment tells nobody anything. Compared strictly so a null
  // reactor id can't match a null author column and swallow a real notification.
  const ownComment =
    (!!reactorUserId && comment.userId === reactorUserId) ||
    (!!reactorRecipientId && comment.recipientId === reactorRecipientId)
  if (ownComment) return

  const [project, settings, video] = await Promise.all([
    prisma.project.findUnique({
      where: { id: comment.projectId },
      select: { id: true, title: true, clientNotificationSchedule: true },
    }),
    prisma.settings.findUnique({
      where: { id: 'default' },
      select: { adminNotificationSchedule: true },
    }),
    prisma.video.findUnique({
      where: { id: comment.videoId },
      select: { name: true, versionLabel: true },
    }),
  ])

  if (!project) return

  const adminNone = (settings?.adminNotificationSchedule || 'HOURLY') === 'NONE'
  const clientNone = project.clientNotificationSchedule === 'NONE'

  // Only the opposite side hears about it; the side the reactor belongs to is pre-marked
  // as sent so the row can't linger in the backlog as forever-pending.
  const notifyClients = reactorIsAdmin && !clientNone
  const notifyAdmins = !reactorIsAdmin && !adminNone
  if (!notifyClients && !notifyAdmins) return

  const now = new Date()
  await prisma.notificationQueue.create({
    data: {
      projectId: comment.projectId,
      type: 'COMMENT_REACTION',
      sentToClients: !notifyClients,
      clientSentAt: notifyClients ? undefined : now,
      sentToAdmins: !notifyAdmins,
      adminSentAt: notifyAdmins ? undefined : now,
      data: {
        type: 'COMMENT_REACTION',
        reactionId,
        emoji,
        // commentId drives the existing `comment_cancelled:` filter in both workers, so a
        // reaction whose comment is deleted before the digest goes out is dropped with it.
        commentId: comment.id,
        videoId: comment.videoId,
        videoName: video?.name || 'Unknown Video',
        videoLabel: video?.versionLabel,
        authorName: reactorName,
        authorEmail: reactorEmail,
        // Reactor identity, so un-reacting can find and retract exactly this row.
        reactorUserId,
        reactorRecipientId,
        timecode: comment.timecode,
        // The comment being reacted to, quoted in the email the same way a reply quotes
        // its parent.
        reactedTo: {
          authorName: comment.authorName || 'Client',
          content: comment.content,
          timecode: comment.timecode,
        },
        createdAt: now.toISOString(),
      },
    },
  })

  console.log(`[QUEUE] Reaction ${emoji} by ${reactorName} on comment ${comment.id} ("${project.title}")`)
}

/**
 * Retract a queued reaction notification when the reactor removes the reaction before the
 * digest goes out.
 *
 * Matches on the reaction's own coordinates (comment + emoji + reactor) rather than the
 * reaction row id, because the row is already gone by the time this runs. Only rows still
 * pending delivery are dropped — an already-sent summary can't be unsent, and deleting its
 * row would corrupt the backlog's history.
 */
export async function cancelReactionNotification(params: {
  commentId: string
  emoji: string
  userId: string | null
  recipientId: string | null
}) {
  const { commentId, emoji, userId, recipientId } = params

  // Reaction rows are few per project, so filtering the candidates in JS is cheaper than
  // reaching for JSON path predicates — and far easier to keep correct.
  const pending = await prisma.notificationQueue.findMany({
    where: {
      type: 'COMMENT_REACTION',
      OR: [{ sentToClients: false }, { sentToAdmins: false }],
    },
    select: { id: true, data: true },
  })

  const doomed = pending
    .filter((row) => {
      const data = row.data as any
      if (data?.commentId !== commentId || data?.emoji !== emoji) return false
      return userId
        ? data?.reactorUserId === userId
        : data?.reactorRecipientId === recipientId
    })
    .map((row) => row.id)

  if (doomed.length === 0) return

  await prisma.notificationQueue.deleteMany({ where: { id: { in: doomed } } })
  console.log(`[QUEUE] Retracted ${doomed.length} pending reaction notification(s) for comment ${commentId}`)
}

/**
 * Queue a comment notification for the next batched summary.
 *
 * Comment activity is never sent per-event: the only schedules are HOURLY, DAILY and NONE.
 */
export async function queueNotification(context: NotificationContext, alreadySentTo?: { admins?: boolean; clients?: boolean }) {
  const { comment, project, video, isReply } = context

  // IMPORTANT: author identity is not the same as visibility.
  // Treat any authenticated internal-user-authored comment as admin activity,
  // even if isInternal is false (share-visible admin reply).
  const authoredByInternalUser = !!comment.userId
  const type = (authoredByInternalUser || comment.isInternal) ? 'ADMIN_REPLY' : 'CLIENT_COMMENT'

  console.log(`[QUEUE] Adding ${type} to queue for "${project.title}"`)
  console.log(`[QUEUE]   Video: ${video?.name || 'N/A'} (${video?.versionLabel || 'N/A'})`)
  console.log(`[QUEUE]   Author: ${comment.authorName || (comment.isInternal ? 'Admin' : 'Client')}`)

  // Get parent comment context if this is a reply
  let parentCommentData = null
  if (isReply && comment.parentId) {
    const parentComment = await prisma.comment.findUnique({
      where: { id: comment.parentId },
      select: { authorName: true, content: true, timecode: true }
    })

    if (parentComment) {
      parentCommentData = {
        authorName: parentComment.authorName || 'Client',
        content: parentComment.content,
        timecode: parentComment.timecode
      }
    }
  }

  const now = new Date()
  // CLIENT_COMMENT entries are only ever processed by the admin-side worker; the
  // client-side worker exclusively handles ADMIN_REPLY.  Pre-mark sentToClients=true
  // so these entries don't accumulate indefinitely as "pending=clients" in the backlog.
  const clientAlreadyHandled = type === 'CLIENT_COMMENT' || alreadySentTo?.clients || false
  await prisma.notificationQueue.create({
    data: {
      projectId: comment.projectId,
      type,
      // Pre-mark sides already handled via IMMEDIATE so workers don't re-process them.
      sentToAdmins: alreadySentTo?.admins || false,
      adminSentAt: alreadySentTo?.admins ? now : undefined,
      sentToClients: clientAlreadyHandled,
      clientSentAt: clientAlreadyHandled ? now : undefined,
      data: {
        type, // Include type in data JSON for email templates
        commentId: comment.id,
        videoId: comment.videoId,
        videoName: video?.name || 'Unknown Video',
        videoLabel: video?.versionLabel,
        authorName: comment.authorName || (comment.isInternal ? 'Admin' : 'Client'),
        authorEmail: comment.authorEmail,
        content: comment.content,
        timecode: comment.timecode,
        isReply,
        parentCommentId: comment.parentId,
        parentComment: parentCommentData,
        createdAt: comment.createdAt.toISOString()
      }
    }
  })

  console.log(`[QUEUE]   Queued successfully`)
}

/**
 * Handle approval notification (video or project)
 * IMPORTANT: Approvals are ALWAYS sent immediately, regardless of schedule settings
 */
export async function handleApprovalNotification(context: ApprovalNotificationContext) {
  const { project, video, approved, isComplete = false } = context

  // Determine notification type based on whether ALL videos are approved
  const type = isComplete ? 'PROJECT_APPROVED' : (approved ? 'VIDEO_APPROVED' : 'VIDEO_UNAPPROVED')

  console.log(`[APPROVAL] Handling ${type} for "${project.title}"`)
  if (video) {
    console.log(`[APPROVAL]   Video: ${video.name}`)
  }

  // ALWAYS send approval notifications immediately, regardless of schedule
  console.log(`[APPROVAL]   Sending immediately (approvals always bypass schedule)...`)
  await sendApprovalImmediately(context)
}

interface RevisionRequestNotificationContext {
  project: { id: string; title: string }
  video: { id: string; name: string; version?: number | null; versionLabel?: string | null }
  authorName?: string | null
  performedByAdmin?: boolean
}

/**
 * Handle "Request Next Version" notification (client finished reviewing a video version).
 * Reuses the VIDEO_APPROVAL push type and the adminEmailProjectApproved email toggle so the
 * existing approval notification settings/permissions govern who hears about it.
 * Push/bell fires even when SMTP is unconfigured; only the email leg is SMTP-gated.
 */
export async function handleRevisionRequestNotification(context: RevisionRequestNotificationContext) {
  const { project, video, authorName, performedByAdmin = false } = context
  const displayAuthor = (authorName && authorName.trim()) || 'Client'
  const versionSuffix = (video.versionLabel && video.versionLabel.trim()) ? ` (${video.versionLabel.trim()})` : ''

  console.log(`[REVISION-REQUEST] Handling next-version request for "${project.title}" / ${video.name}`)

  // Deep link: clicking the bell entry opens the requested video version on the admin
  // share page (same URL shape the comment notifications use).
  const adminShareHref = Number.isFinite(video.version ?? NaN)
    ? `/admin/projects/${encodeURIComponent(project.id)}/share?video=${encodeURIComponent(video.name)}&version=${encodeURIComponent(String(video.version))}`
    : `/admin/projects/${encodeURIComponent(project.id)}`

  // In-app bell + web push (assigned admins with Share Page access, notifyVideoApproval toggle)
  await sendPushNotification({
    type: 'VIDEO_APPROVAL',
    projectId: project.id,
    projectName: project.title,
    title: 'Next Version Requested',
    message: `${displayAuthor} requested the next version of ${video.name}${versionSuffix}`,
    details: {
      __meta: {
        videoId: video.id,
        videoVersion: video.version ?? null,
        videoName: video.name,
      },
      __link: {
        href: adminShareHref,
      },
      'Project': project.title,
      'Video': `${video.name}${versionSuffix}`,
      'Author': displayAuthor,
      'Status': 'Next version requested',
    },
  })

  if (performedByAdmin) {
    console.log('[REVISION-REQUEST] Skipping admin email - action performed by internal admin')
    return
  }

  if (!(await isSmtpConfigured())) {
    console.log('[REVISION-REQUEST] SMTP not configured, skipping admin email')
    return
  }

  const globalSettings = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: { adminEmailProjectApproved: true },
  })
  if (globalSettings?.adminEmailProjectApproved === false) {
    console.log('[REVISION-REQUEST] Skipping admin email - adminEmailProjectApproved is disabled')
    return
  }

  // Internal recipients: assigned to the project, notifications on, admin role or Share Page access.
  const internalUsers = await prisma.projectUser.findMany({
    where: { projectId: project.id, receiveNotifications: true },
    select: {
      user: {
        select: {
          email: true,
          appRole: { select: { permissions: true, name: true, isSystemAdmin: true } },
        },
      },
    },
  })
  const internalEmails = internalUsers
    .filter((r) => {
      const role = r.user.appRole
      const isAdminRole = role?.isSystemAdmin === true || (typeof role?.name === 'string' && role.name.trim().toLowerCase() === 'admin')
      if (isAdminRole) return true
      const permissions = normalizeRolePermissions(role?.permissions)
      return canDoAction(permissions, 'accessSharePage')
    })
    .map((r) => r.user.email)
    .filter(Boolean)

  if (internalEmails.length === 0) {
    console.log('[REVISION-REQUEST] No eligible internal recipients for admin email')
    return
  }

  const projectMeta = await prisma.project.findUnique({
    where: { id: project.id },
    select: { companyName: true },
  })
  const allRecipients = await getProjectRecipients(project.id)
  const primaryRecipientName =
    allRecipients.find((r) => r.isPrimary)?.name ||
    allRecipients[0]?.name ||
    null
  const clientDisplayName =
    (typeof projectMeta?.companyName === 'string' && projectMeta.companyName.trim())
      ? projectMeta.companyName.trim()
      : (typeof primaryRecipientName === 'string' && primaryRecipientName.trim())
        ? primaryRecipientName.trim()
        : displayAuthor

  const result = await sendAdminRevisionRequestedEmail({
    adminEmails: internalEmails,
    clientName: clientDisplayName,
    projectTitle: project.title,
    videoName: video.name,
    versionLabel: video.versionLabel ?? null,
  })

  if (result.success) {
    console.log(`[REVISION-REQUEST]   ${result.message}`)
  } else {
    console.error(`[REVISION-REQUEST]   Failed: ${result.message}`)
  }
}

/**
 * Send approval notification immediately
 */
async function sendApprovalImmediately(context: ApprovalNotificationContext) {
  const { project, video, approvedVideos, approved, authorName, authorEmail, isComplete = false } = context

  const triggerVideo = video ? { id: video.id, name: video.name } : null
  const videosForPush = isComplete
    ? (approvedVideos || (triggerVideo ? [triggerVideo] : []))
    : (triggerVideo ? [triggerVideo] : (approvedVideos || []))

  const shareUrl = await generateShareUrl(project.slug)
  const allRecipients = await getProjectRecipients(project.id)
  const recipients = allRecipients.filter(r => r.receiveNotifications && r.email)

  const projectMeta = await prisma.project.findUnique({
    where: { id: project.id },
    select: { companyName: true },
  })

  const primaryRecipientName =
    allRecipients.find((r) => r.isPrimary)?.name ||
    allRecipients[0]?.name ||
    null

  const clientDisplayName =
    (typeof projectMeta?.companyName === 'string' && projectMeta.companyName.trim())
      ? projectMeta.companyName.trim()
      : (typeof primaryRecipientName === 'string' && primaryRecipientName.trim())
        ? primaryRecipientName.trim()
        : 'Client'

  // Internal recipients (admins + non-admins) assigned to this project with notifications enabled.
  // IMPORTANT: users without Share Page access should not receive Share-related emails.
  const internalUsers = await prisma.projectUser.findMany({
    where: { projectId: project.id, receiveNotifications: true },
    select: {
      user: {
        select: {
          email: true,
          name: true,
          appRole: { select: { permissions: true, name: true, isSystemAdmin: true } },
        },
      },
    },
  })
  const internalEmails = internalUsers
    .filter((r) => {
      const role = r.user.appRole
      const isAdminRole = role?.isSystemAdmin === true || (typeof role?.name === 'string' && role.name.trim().toLowerCase() === 'admin')
      if (isAdminRole) return true
      const permissions = normalizeRolePermissions(role?.permissions)
      return canDoAction(permissions, 'accessSharePage')
    })
    .map((r) => r.user.email)
    .filter(Boolean)

  // Send to clients ONLY if complete project approval (all videos approved)
  // Don't send for partial approvals - client knows they just clicked approve
  if (recipients.length > 0 && isComplete && approved) {
    console.log(`[IMMEDIATE→CLIENT] Sending complete project approval to ${recipients.length} recipient(s)`)

    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: {
        autoCloseApprovedProjectsEnabled: true,
        autoCloseApprovedProjectsAfterDays: true,
        clientEmailProjectApproved: true,
        adminEmailProjectApproved: true,
      },
    })

    if (settings?.clientEmailProjectApproved === false) {
      console.log('[IMMEDIATE→CLIENT] Skipped - clientEmailProjectApproved is disabled')
    } else {

    let autoCloseInfo: { closeDate: Date; days: number } | null = null
    if (settings?.autoCloseApprovedProjectsEnabled) {
      const days = settings.autoCloseApprovedProjectsAfterDays
      if (Number.isInteger(days) && days > 0) {
        const approvedAt = await prisma.project.findUnique({
          where: { id: project.id },
          select: { approvedAt: true },
        })

        const base = approvedAt?.approvedAt || new Date()
        const closeDate = new Date(base)
        closeDate.setDate(closeDate.getDate() + days)
        autoCloseInfo = { closeDate, days }
      }
    }

    const emailPromises = recipients.map(recipient =>
      sendProjectApprovedEmail({
        clientEmail: recipient.email!,
        clientName: recipient.name || 'Client',
        projectTitle: project.title,
        approvedVideos: approvedVideos || (video ? [{ id: video.id, name: video.name }] : []),
        shareUrl,
        isComplete: true, // Only send when complete
        autoCloseInfo,
      }).then(result => {
        if (result.success) {
          console.log(`[IMMEDIATE→CLIENT]   Sent to ${redactEmailForLogs(recipient.email)}`)
        } else {
          console.error(
            `[IMMEDIATE→CLIENT]   Failed to ${redactEmailForLogs(recipient.email)}: ${result.error}`
          )
        }
        return result
      })
    )

    await Promise.allSettled(emailPromises)
    } // end clientEmailProjectApproved check
  } else if (recipients.length > 0 && !isComplete) {
    console.log(`[IMMEDIATE→CLIENT] Skipped - partial approval (${approvedVideos?.length || 0} videos), not sending to client`)
  }

  // Send to admins - notify them when a *client* approves OR unapproves ANY video.
  // Skip this email when the action was performed by an internal admin (no need to
  // notify other admins that an admin clicked approve).
  const globalSettings = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: { adminEmailProjectApproved: true },
  })

  if (context.performedByAdmin) {
    console.log(`[IMMEDIATE→ADMIN] Skipped - action performed by internal admin, not notifying other admins`)
  } else if (internalEmails.length > 0 && globalSettings?.adminEmailProjectApproved !== false) {
    const action = approved ? 'approval' : 'unapproval'
    console.log(`[IMMEDIATE→ADMIN] Sending ${action} notice to ${internalEmails.length} internal user(s)`)

    // Build full per-project lists for the email UI.
    // Important: approvals are versioned per video name; treat "video" as the unique name.
    const projectVideos = await prisma.video.findMany({
      where: { projectId: project.id },
      select: { id: true, name: true, approved: true },
    })

    const byName = new Map<string, Array<{ id: string; name: string; approved: boolean }>>()
    for (const v of projectVideos) {
      const key = String(v.name || '').trim() || 'Untitled Video'
      const list = byName.get(key) || []
      list.push(v)
      byName.set(key, list)
    }

    const approvedList: Array<{ id: string; name: string }> = []
    const awaitingList: Array<{ id: string; name: string }> = []
    for (const [name, versions] of byName.entries()) {
      const approvedVersion = versions.find((vv) => vv.approved)
      if (approvedVersion) {
        approvedList.push({ id: approvedVersion.id, name })
      } else {
        awaitingList.push({ id: versions[0]!.id, name })
      }
    }

    approvedList.sort((a, b) => a.name.localeCompare(b.name))
    awaitingList.sort((a, b) => a.name.localeCompare(b.name))

    const result = await sendAdminProjectApprovedEmail({
      adminEmails: internalEmails,
      clientName: clientDisplayName,
      projectTitle: project.title,
      approvedVideos: approvedList,
      awaitingVideos: awaitingList,
      isApproval: approved, // Pass whether this is approval or unapproval
      isComplete, // Pass whether this is complete project or partial
      actionVideoName: video?.name || null,
    })

    if (result.success) {
      console.log(`[IMMEDIATE→ADMIN]   ${result.message}`)
    } else {
      console.error(`[IMMEDIATE→ADMIN]   Failed: ${result.message}`)
    }
  }

  // Send push notification for video approval
  const videoNames = videosForPush.map(v => v.name).join(', ') || video?.name || 'Unknown'
  const approvalStatus = approved ? 'approved' : 'unapproved'
  
  await sendPushNotification({
    type: 'VIDEO_APPROVAL',
    projectId: project.id,
    projectName: project.title,
    title: `Video ${approved ? 'Approved' : 'Unapproved'}`,
    message: `${authorName || 'Client'} ${approvalStatus} video${videosForPush.length > 1 ? 's' : ''}`,
    details: {
      'Project': project.title,
      'Video(s)': videoNames,
      'Author': authorName || 'Client',
      'Status': isComplete ? 'Complete Project Approval' : 'Partial Approval',
    },
  })
}
