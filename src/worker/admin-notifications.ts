import { prisma } from '../lib/db'
import { buildCompanyLogoUrl, getEmailSettings, sendEmail } from '../lib/email'
import { generateAdminSummaryEmail } from '../lib/email-templates'
import { generateShareUrl } from '../lib/url'
import { getRedis } from '../lib/redis'
import { redactEmailForLogs } from '../lib/log-sanitization'
import { getPeriodString, shouldSendNow, sendNotificationsWithRetry, normalizeNotificationDataTimecode } from './notification-helpers'

/**
 * Process admin notification summaries
 * Sends notifications to admins for client comments based on schedule
 */
export async function processAdminNotifications() {
  try {
    // Get admin notification settings
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: {
        adminNotificationSchedule: true,
        adminNotificationTime: true,
        adminNotificationDay: true,
        lastAdminNotificationSent: true,
      }
    })

    if (!settings || settings.adminNotificationSchedule === 'IMMEDIATE') {
      console.log('[ADMIN] Admin schedule is IMMEDIATE - notifications sent in real-time')
      return
    }

    const now = new Date()
    const timeString = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`
    console.log(`[ADMIN] Checking for admin notifications to send (time: ${timeString})`)
    console.log(`[ADMIN]   Schedule: ${settings.adminNotificationSchedule}`)
    console.log(`[ADMIN]   Target time: ${settings.adminNotificationTime || 'N/A'}`)
    console.log(`[ADMIN]   Last sent: ${settings.lastAdminNotificationSent ? new Date(settings.lastAdminNotificationSent).toISOString() : 'Never'}`)

    // Check if it's time to send based on schedule
    const shouldSend = shouldSendNow(
      settings.adminNotificationSchedule,
      settings.adminNotificationTime,
      settings.adminNotificationDay,
      settings.lastAdminNotificationSent,
      now
    )

    if (!shouldSend) {
      console.log(`[ADMIN] Not time to send yet - waiting for schedule`)
      return
    }

    console.log(`[ADMIN] Time to send! Checking for pending notifications...`)

    // Get pending admin notifications
    const pendingNotifications = await prisma.notificationQueue.findMany({
      where: {
        type: 'CLIENT_COMMENT',
        sentToAdmins: false,
        adminFailed: false,
        adminAttempts: { lt: 3 }
      },
      include: {
        project: {
          select: { title: true, slug: true, useFullTimecode: true }
        }
      },
      orderBy: { createdAt: 'asc' }
    })

    if (pendingNotifications.length === 0) {
      console.log(`[ADMIN] No pending notifications found`)
      return
    }

    console.log(`[ADMIN] Found ${pendingNotifications.length} pending notification(s)`)

    // Filter out cancelled notifications
    const redis = getRedis()
    const validNotifications: typeof pendingNotifications = []
    const cancelledNotificationIds: string[] = []

    for (const notification of pendingNotifications) {
      const commentId = (notification.data as any).commentId
      if (commentId) {
        const notificationData = await redis.get(`comment_notification:${commentId}`)
        if (!notificationData) {
          console.log(`[ADMIN]   Skipping cancelled notification for comment ${commentId}`)
          cancelledNotificationIds.push(notification.id)
          continue
        }
      }
      validNotifications.push(notification)
    }

    // Clean up cancelled notifications from queue
    if (cancelledNotificationIds.length > 0) {
      await prisma.notificationQueue.deleteMany({
        where: { id: { in: cancelledNotificationIds } }
      })
      console.log(`[ADMIN]   Removed ${cancelledNotificationIds.length} cancelled notification(s)`)
    }

    if (validNotifications.length === 0) {
      console.log(`[ADMIN]   No valid notifications to send (all cancelled)`)
      return
    }

    // Group notifications by project
    const projectGroups: Record<string, any> = {}
    for (const notification of validNotifications) {
      const projectId = notification.projectId
      if (!projectGroups[projectId]) {
        projectGroups[projectId] = {
          projectTitle: notification.project.title,
          useFullTimecode: notification.project.useFullTimecode,
          shareUrl: await generateShareUrl(notification.project.slug),
          notifications: []
        }
      }
      projectGroups[projectId].notifications.push(
        normalizeNotificationDataTimecode(notification.data)
      )
    }

    const projectIds = Object.keys(projectGroups)
    const assignedUsers = await prisma.projectUser.findMany({
      where: {
        projectId: { in: projectIds },
        receiveNotifications: true,
      },
      select: {
        projectId: true,
        user: { select: { id: true, email: true, name: true } },
      },
    })

    const usersById = new Map<string, { email: string; name: string | null; projects: any[] }>()
    for (const row of assignedUsers) {
      const user = row.user
      if (!user?.email) continue
      if (!usersById.has(user.id)) {
        usersById.set(user.id, { email: user.email, name: user.name || null, projects: [] })
      }
      const group = projectGroups[row.projectId]
      if (group) {
        usersById.get(user.id)!.projects.push(group)
      }
    }

    const recipients = Array.from(usersById.values()).filter((u) => u.projects.length > 0)
    if (recipients.length === 0) {
      console.log('[ADMIN] No assigned users opted in; skipping notification summary')
      return
    }

    const period = getPeriodString(settings.adminNotificationSchedule)
    const notificationIds = validNotifications.map(n => n.id)

    // Increment attempt counter before sending
    await prisma.notificationQueue.updateMany({
      where: { id: { in: notificationIds } },
      data: { adminAttempts: { increment: 1 } }
    })

    const currentAttempts = validNotifications[0]?.adminAttempts + 1 || 1
    console.log(`[ADMIN] Attempt #${currentAttempts} for ${validNotifications.length} notification(s)`)

    // Send summary to each admin
    const result = await sendNotificationsWithRetry({
      notificationIds,
      currentAttempts,
      isClientNotification: false,
      logPrefix: '[ADMIN]',
      onSuccess: async () => {
        const emailSettings = await getEmailSettings()
        const companyLogoUrl = buildCompanyLogoUrl({
          appDomain: emailSettings.appDomain,
          companyLogoMode: emailSettings.companyLogoMode,
          companyLogoPath: emailSettings.companyLogoPath,
          companyLogoUrl: emailSettings.companyLogoUrl,
          updatedAt: emailSettings.updatedAt,
        })

        for (const recipient of recipients) {
          const html = generateAdminSummaryEmail({
            companyName: emailSettings.companyName || 'ViTransfer',
            adminName: recipient.name || '',
            period,
            companyLogoUrl: companyLogoUrl || undefined,
            projects: recipient.projects
          })

          const result = await sendEmail({
            to: recipient.email,
            subject: `Project activity summary (${pendingNotifications.length} updates)`,
            html,
          })

          if (result.success) {
            console.log(`[ADMIN]   Sent to ${redactEmailForLogs(recipient.email)}`)
          } else {
            throw new Error(`Failed to send to ${redactEmailForLogs(recipient.email)}: ${result.error}`)
          }
        }
      }
    })

    // Update settings last sent timestamp on success
    if (result.success) {
      await prisma.settings.update({
        where: { id: 'default' },
        data: { lastAdminNotificationSent: now }
      })
      console.log(`[ADMIN] Summary sent (${pendingNotifications.length} notifications to ${recipients.length} user(s))`)
    }
  } catch (error) {
    console.error('Failed to process admin notifications:', error)
  }
}
