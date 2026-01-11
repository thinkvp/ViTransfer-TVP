import { Comment } from '@prisma/client'
import { prisma } from './db'
import { getEmailSettings, sendCommentNotificationEmail, sendAdminCommentNotificationEmail, sendProjectApprovedEmail, sendAdminProjectApprovedEmail } from './email'
import { getProjectRecipients } from './recipients'
import { buildUnsubscribeUrl } from './unsubscribe'
import { generateShareUrl } from './url'
import { getRedis } from './redis'
import { sendPushNotification } from './push-notifications'
import { createHash } from 'crypto'
import { redactEmailForLogs } from './log-sanitization'

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
}

/**
 * Send immediate notification (when schedule is IMMEDIATE)
 */
export async function sendImmediateNotification(context: NotificationContext) {
  const { comment, project, video } = context

  // Check if notification was cancelled before sending
  const redis = getRedis()
  const notificationData = await redis.get(`comment_notification:${comment.id}`)

  if (!notificationData) {
    console.log(`[IMMEDIATE] Comment ${comment.id} notification was cancelled, skipping send`)
    return
  }

  // Get recipients with notifications enabled
  const allRecipients = await getProjectRecipients(comment.projectId)
  const recipients = allRecipients.filter(r => r.receiveNotifications && r.email)

  // Internal recipients (admins + non-admins) assigned to this project with notifications enabled
  const internalUsers = await prisma.projectUser.findMany({
    where: { projectId: comment.projectId, receiveNotifications: true },
    select: { user: { select: { email: true, name: true } } },
  })
  const internalEmails = internalUsers.map((r) => r.user.email).filter(Boolean)

  const shareUrl = await generateShareUrl(project.slug)
  const videoName = video?.name || 'Unknown Video'
  const versionLabel = video?.versionLabel || 'Unknown Version'

  if (comment.isInternal) {
    // Admin commented/replied → notify clients IMMEDIATELY
    if (recipients.length === 0) {
      console.log(`[IMMEDIATE→CLIENT] Skipped - no recipients for project "${project.title}"`)
      return
    }

    const emailSettings = await getEmailSettings()
    const trackingPixelsEnabled = emailSettings.emailTrackingPixelsEnabled ?? true
    let appDomain = new URL(shareUrl).origin
    if (emailSettings.appDomain) {
      try {
        const parsed = new URL(emailSettings.appDomain)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          appDomain = parsed.origin
        }
      } catch {
        // Fallback to shareUrl origin
      }
    }

    console.log(`[IMMEDIATE→CLIENT] Sending to ${recipients.length} recipient(s) for "${project.title}"`)
    console.log(`[IMMEDIATE→CLIENT]   Video: ${videoName} (${versionLabel})`)
    console.log(`[IMMEDIATE→CLIENT]   Author: ${comment.authorName || 'Admin'}`)

    const emailPromises = recipients.map(async (recipient) => {
      const recipientEmail = recipient.email!
      const unsubscribeUrl = recipient.id
        ? buildUnsubscribeUrl(appDomain, project.id, recipient.id)
        : undefined

      const trackingToken = trackingPixelsEnabled
        ? await prisma.emailTracking.upsert({
            where: {
              token: createHash('sha256')
                .update(`NEW_COMMENT|${project.id}|${comment.id}|${recipientEmail.toLowerCase()}`)
                .digest('hex')
                .slice(0, 32),
            },
            update: {
              sentAt: new Date(),
            },
            create: {
              token: createHash('sha256')
                .update(`NEW_COMMENT|${project.id}|${comment.id}|${recipientEmail.toLowerCase()}`)
                .digest('hex')
                .slice(0, 32),
              projectId: project.id,
              type: 'NEW_COMMENT',
              videoId: comment.videoId,
              recipientEmail: recipientEmail.toLowerCase(),
            },
          })
        : null

      const result = await sendCommentNotificationEmail({
        clientEmail: recipientEmail,
        clientName: recipient.name || 'Client',
        projectTitle: project.title,
        videoName,
        versionLabel,
        authorName: comment.authorName || 'Admin',
        commentContent: comment.content,
        timecode: comment.timecode,
        shareUrl,
        displayColor: comment.user?.displayColor || null,
        trackingToken: trackingToken?.token,
        unsubscribeUrl,
      })

      if (result.success) {
        console.log(`[IMMEDIATE→CLIENT]   Sent to ${redactEmailForLogs(recipientEmail)}`)
      } else {
        console.error(
          `[IMMEDIATE→CLIENT]   Failed to ${redactEmailForLogs(recipientEmail)}: ${result.error}`
        )
      }

      return { recipientEmail: recipientEmail.toLowerCase(), success: result.success }
    })

    const results = await Promise.allSettled(emailPromises)
    const successfulRecipientEmails: string[] = []
    results.forEach((r) => {
      if (r.status === 'fulfilled' && r.value.success) {
        successfulRecipientEmails.push(r.value.recipientEmail)
      }
    })

    if (successfulRecipientEmails.length > 0) {
      try {
        await prisma.projectEmailEvent.create({
          data: {
            projectId: project.id,
            type: 'NEW_COMMENT',
            dedupeKey: `NEW_COMMENT:${comment.id}`,
            videoId: comment.videoId,
            recipientEmails: JSON.stringify(successfulRecipientEmails),
          },
        })
      } catch (e: any) {
        // Ignore unique constraint violations (already logged)
        if (e?.code !== 'P2002') {
          console.error('[IMMEDIATE→CLIENT]   Failed to log ProjectEmailEvent:', e)
        }
      }
    }
  } else {
    // Client commented → notify admins IMMEDIATELY
    if (internalEmails.length === 0) {
      console.log(`[IMMEDIATE→ADMIN] Skipped - no internal users opted in`)
      return
    }

    console.log(`[IMMEDIATE→ADMIN] Sending to ${internalEmails.length} internal user(s) for "${project.title}"`)
    console.log(`[IMMEDIATE→ADMIN]   Video: ${videoName} (${versionLabel})`)
    console.log(`[IMMEDIATE→ADMIN]   Client: ${comment.authorName || 'Client'}`)

    const result = await sendAdminCommentNotificationEmail({
      adminEmails: internalEmails,
      clientName: comment.authorName || 'Client',
      clientEmail: comment.authorEmail,
      projectTitle: project.title,
      videoName,
      versionLabel,
      commentContent: comment.content,
      timecode: comment.timecode,
      shareUrl,
      displayColor: comment.recipient?.displayColor || null,
    })

    if (result.success) {
      console.log(`[IMMEDIATE→ADMIN]   ${result.message}`)
    } else {
      console.error(`[IMMEDIATE→ADMIN]   Failed: ${result.message}`)
    }
  }
}

/**
 * Queue notification for later batch sending (when schedule is not IMMEDIATE)
 */
export async function queueNotification(context: NotificationContext) {
  const { comment, project, video, isReply } = context

  const type = comment.isInternal ? 'ADMIN_REPLY' : 'CLIENT_COMMENT'

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

  await prisma.notificationQueue.create({
    data: {
      projectId: comment.projectId,
      type,
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

/**
 * Send approval notification immediately
 */
async function sendApprovalImmediately(context: ApprovalNotificationContext) {
  const { project, video, approvedVideos, approved, authorName, authorEmail, isComplete = false } = context

  const shareUrl = await generateShareUrl(project.slug)
  const allRecipients = await getProjectRecipients(project.id)
  const recipients = allRecipients.filter(r => r.receiveNotifications && r.email)

  // Internal recipients (admins + non-admins) assigned to this project with notifications enabled
  const internalUsers = await prisma.projectUser.findMany({
    where: { projectId: project.id, receiveNotifications: true },
    select: { user: { select: { email: true, name: true } } },
  })
  const internalEmails = internalUsers.map((r) => r.user.email).filter(Boolean)

  // Send to clients ONLY if complete project approval (all videos approved)
  // Don't send for partial approvals - client knows they just clicked approve
  if (recipients.length > 0 && isComplete && approved) {
    console.log(`[IMMEDIATE→CLIENT] Sending complete project approval to ${recipients.length} recipient(s)`)

    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: {
        autoCloseApprovedProjectsEnabled: true,
        autoCloseApprovedProjectsAfterDays: true,
      },
    })

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
  } else if (recipients.length > 0 && !isComplete) {
    console.log(`[IMMEDIATE→CLIENT] Skipped - partial approval (${approvedVideos?.length || 0} videos), not sending to client`)
  }

  // Send to admins - notify them when client approves OR unapproves ANY video
  if (internalEmails.length > 0) {
    const action = approved ? 'approval' : 'unapproval'
    console.log(`[IMMEDIATE→ADMIN] Sending ${action} notice to ${internalEmails.length} internal user(s)`)

    const result = await sendAdminProjectApprovedEmail({
      adminEmails: internalEmails,
      clientName: authorName || 'Client',
      projectTitle: project.title,
      approvedVideos: approvedVideos || (video ? [{ id: video.id, name: video.name }] : []),
      isApproval: approved, // Pass whether this is approval or unapproval
      isComplete, // Pass whether this is complete project or partial
    })

    if (result.success) {
      console.log(`[IMMEDIATE→ADMIN]   ${result.message}`)
    } else {
      console.error(`[IMMEDIATE→ADMIN]   Failed: ${result.message}`)
    }
  }

  // Send push notification for video approval
  const videoNames = approvedVideos?.map(v => v.name).join(', ') || video?.name || 'Unknown'
  const approvalStatus = approved ? 'approved' : 'unapproved'
  
  await sendPushNotification({
    type: 'VIDEO_APPROVAL',
    projectId: project.id,
    projectName: project.title,
    title: `Video ${approved ? 'Approved' : 'Unapproved'}`,
    message: `Client ${approvalStatus} video${approvedVideos && approvedVideos.length > 1 ? 's' : ''}`,
    details: {
      'Project': project.title,
      'Video(s)': videoNames,
      'Author': authorName || 'Client',
      'Status': isComplete ? 'Complete Project Approval' : 'Partial Approval',
    },
  })
}
