import { prisma } from '../lib/db'
import { buildCompanyLogoUrl, getEmailSettings, sendEmail } from '../lib/email'
import { generateTaskCommentSummaryEmail } from '../lib/email-templates'
import { shouldSendNow, getPeriodString, sendNotificationsWithRetry } from './notification-helpers'
import { redactEmailForLogs } from '../lib/log-sanitization'

export async function processTaskCommentNotifications() {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: {
        adminNotificationSchedule: true,
        adminNotificationTime: true,
        adminNotificationDay: true,
        adminEmailTaskComments: true,
        lastTaskCommentNotificationSent: true,
      },
    })

    if (!settings || settings.adminNotificationSchedule === 'IMMEDIATE' || settings.adminNotificationSchedule === 'NONE') {
      return
    }

    if (settings.adminEmailTaskComments === false) {
      return
    }

    const now = new Date()
    const shouldSend = shouldSendNow(
      settings.adminNotificationSchedule,
      settings.adminNotificationTime,
      settings.adminNotificationDay,
      settings.lastTaskCommentNotificationSent,
      now
    )

    if (!shouldSend) return

    const pendingNotifications = await prisma.notificationQueue.findMany({
      where: {
        type: 'TASK_COMMENT',
        sentToAdmins: false,
        adminFailed: false,
        adminAttempts: { lt: 3 },
      },
      include: {
        kanbanCard: {
          select: { id: true, title: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    if (pendingNotifications.length === 0) return

    const cardGroups: Record<string, { cardTitle: string; dashboardUrl: string; comments: any[] }> = {}

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
      const cardId = notification.kanbanCardId
      if (!cardId) continue
      if (!cardGroups[cardId]) {
        const origin = appDomain || ''
        cardGroups[cardId] = {
          cardTitle: notification.kanbanCard?.title || 'Task',
          dashboardUrl: origin ? `${origin}/admin/projects` : '#',
          comments: [],
        }
      }

      const data: any = notification.data || {}
      cardGroups[cardId].comments.push({
        authorName: String(data.authorName || 'User'),
        authorEmail: data.authorEmail ? String(data.authorEmail) : null,
        content: String(data.content || ''),
      })
    }

    // Gather all card members with receiveNotifications=true
    const cardIds = Object.keys(cardGroups)
    const cardMembers = await prisma.kanbanCardMember.findMany({
      where: {
        cardId: { in: cardIds },
        receiveNotifications: true,
      },
      select: {
        cardId: true,
        user: { select: { id: true, email: true, name: true } },
      },
    })

    const usersById = new Map<string, { email: string; name: string | null; tasks: any[] }>()
    for (const row of cardMembers) {
      const user = row.user
      if (!user?.email) continue
      if (!usersById.has(user.id)) {
        usersById.set(user.id, { email: user.email, name: user.name || null, tasks: [] })
      }
      const group = cardGroups[row.cardId]
      if (group) {
        const recipientEmail = user.email.toLowerCase()
        const filteredComments = group.comments.filter(
          (c: any) => !c.authorEmail || c.authorEmail.toLowerCase() !== recipientEmail
        )
        if (filteredComments.length > 0) {
          usersById.get(user.id)!.tasks.push({ ...group, comments: filteredComments })
        }
      }
    }

    const recipients = Array.from(usersById.values()).filter((u) => u.tasks.length > 0)
    if (recipients.length === 0) {
      const notificationIds = pendingNotifications.map((n) => n.id)
      await prisma.notificationQueue.updateMany({
        where: { id: { in: notificationIds } },
        data: {
          adminFailed: true,
          lastError: 'Skipped: no eligible task comment recipients',
        },
      })
      console.log(
        `[TASK_COMMENT] No eligible recipients for ${notificationIds.length} notification(s); marking skipped`
      )
      return
    }

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
      logPrefix: '[TASK_COMMENT]',
      onSuccess: async () => {
        for (const recipient of recipients) {
          const html = generateTaskCommentSummaryEmail({
            companyName: emailSettings.companyName || 'ViTransfer',
            recipientName: recipient.name || '',
            period,
            companyLogoUrl: companyLogoUrl || undefined,
            mainCompanyDomain: emailSettings.mainCompanyDomain,
            accentColor: emailSettings.accentColor || undefined,
            accentTextMode: emailSettings.accentTextMode || undefined,
            emailHeaderColor: emailSettings.emailHeaderColor || undefined,
            emailHeaderTextMode: emailSettings.emailHeaderTextMode || undefined,
            tasks: recipient.tasks,
          })

          try {
            await sendEmail({
              to: recipient.email,
              subject: `Task Comments Summary — ${emailSettings.companyName || 'ViTransfer'}`,
              html,
            })
            console.log(`[TASK_COMMENT] Sent summary to ${redactEmailForLogs(recipient.email)}`)
          } catch (e) {
            console.error(`[TASK_COMMENT] Failed to send to ${redactEmailForLogs(recipient.email)}:`, e)
            throw e
          }
        }
      },
    })

    if (result?.success) {
      await prisma.settings.update({
        where: { id: 'default' },
        data: { lastTaskCommentNotificationSent: now },
      })
      console.log(`[TASK_COMMENT] Successfully processed ${notificationIds.length} notifications for ${recipients.length} recipients`)
    }
  } catch (e) {
    console.error('[TASK_COMMENT] Error processing task comment notifications:', e)
  }
}
