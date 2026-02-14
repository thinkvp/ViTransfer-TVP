import { prisma } from '../lib/db'
import { buildCompanyLogoUrl, getEmailSettings, sendEmail } from '../lib/email'
import { generateInternalCommentSummaryEmail } from '../lib/email-templates'
import { shouldSendNow, getPeriodString, sendNotificationsWithRetry } from './notification-helpers'
import { redactEmailForLogs } from '../lib/log-sanitization'

export async function processInternalCommentNotifications() {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: {
        adminNotificationSchedule: true,
        adminNotificationTime: true,
        adminNotificationDay: true,
        lastInternalCommentNotificationSent: true,
      },
    })

    if (!settings || settings.adminNotificationSchedule === 'IMMEDIATE') {
      return
    }

    const now = new Date()
    const shouldSend = shouldSendNow(
      settings.adminNotificationSchedule,
      settings.adminNotificationTime,
      settings.adminNotificationDay,
      settings.lastInternalCommentNotificationSent,
      now
    )

    if (!shouldSend) return

    const pendingNotifications = await prisma.notificationQueue.findMany({
      where: {
        type: 'INTERNAL_COMMENT',
        sentToAdmins: false,
        adminFailed: false,
        adminAttempts: { lt: 3 },
      },
      include: {
        project: {
          select: { id: true, title: true, slug: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    if (pendingNotifications.length === 0) return

    const projectGroups: Record<string, { projectTitle: string; adminUrl: string; comments: any[] }> = {}

    const emailSettings = await getEmailSettings()
    const companyLogoUrl = buildCompanyLogoUrl({
      appDomain: emailSettings.appDomain,
      companyLogoMode: emailSettings.companyLogoMode,
      companyLogoPath: emailSettings.companyLogoPath,
      companyLogoUrl: emailSettings.companyLogoUrl,
      updatedAt: emailSettings.updatedAt,
    })

    const appDomain = emailSettings.appDomain
      ? (() => {
          try {
            const parsed = new URL(emailSettings.appDomain)
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin
          } catch {
            // ignore
          }
          return null
        })()
      : null

    for (const notification of pendingNotifications) {
      const projectId = notification.projectId
      if (!projectGroups[projectId]) {
        const origin = appDomain || ''
        projectGroups[projectId] = {
          projectTitle: notification.project.title,
          adminUrl: origin ? `${origin}/admin/projects/${projectId}` : '#',
          comments: [],
        }
      }

      const data: any = notification.data || {}
      projectGroups[projectId].comments.push({
        authorName: String(data.authorName || 'User'),
        authorEmail: data.authorEmail ? String(data.authorEmail) : null,
        content: String(data.content || ''),
      })
    }

    const projectIds = Object.keys(projectGroups)
    const assignedUsers = await prisma.projectUser.findMany({
      where: {
        projectId: { in: projectIds },
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
    if (recipients.length === 0) return

    const period = getPeriodString(settings.adminNotificationSchedule)
    const notificationIds = pendingNotifications.map((n) => n.id)

    await prisma.notificationQueue.updateMany({
      where: { id: { in: notificationIds } },
      data: { adminAttempts: { increment: 1 } },
    })

    const currentAttempts = pendingNotifications[0]?.adminAttempts + 1 || 1

    const result = await sendNotificationsWithRetry({
      notificationIds,
      currentAttempts,
      isClientNotification: false,
      logPrefix: '[INTERNAL]',
      onSuccess: async () => {
        for (const recipient of recipients) {
          const html = generateInternalCommentSummaryEmail({
            companyName: emailSettings.companyName || 'ViTransfer',
            recipientName: recipient.name || '',
            period,
            companyLogoUrl: companyLogoUrl || undefined,
            mainCompanyDomain: emailSettings.mainCompanyDomain,
            accentTextMode: emailSettings.accentTextMode || undefined,
            emailHeaderColor: emailSettings.emailHeaderColor || undefined,
            emailHeaderTextMode: emailSettings.emailHeaderTextMode || undefined,
            projects: recipient.projects,
          })

          const sendResult = await sendEmail({
            to: recipient.email,
            subject: `Internal comments summary (${pendingNotifications.length} updates)`,
            html,
          })

          if (sendResult.success) {
            console.log(`[INTERNAL] Sent to ${redactEmailForLogs(recipient.email)}`)
          } else {
            throw new Error(`Failed to send to ${redactEmailForLogs(recipient.email)}: ${sendResult.error}`)
          }
        }
      },
    })

    if (result.success) {
      await prisma.settings.update({
        where: { id: 'default' },
        data: { lastInternalCommentNotificationSent: now },
      })
    }
  } catch (error) {
    console.error('Failed to process internal comment notifications:', error)
  }
}
