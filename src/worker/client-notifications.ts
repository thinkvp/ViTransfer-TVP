import { prisma } from '../lib/db'
import { getEmailSettings, sendEmail } from '../lib/email'
import { buildCompanyLogoUrl } from '../lib/email'
import { generateNotificationSummaryEmail } from '../lib/email-templates'
import { getProjectRecipients } from '../lib/recipients'
import { buildUnsubscribeUrl } from '../lib/unsubscribe'
import { generateShareUrl } from '../lib/url'
import { getRedis } from '../lib/redis'
import { getPeriodString, shouldSendNow, sendNotificationsWithRetry, sendSummaryToRecipients, notificationBatchHash, tryAcquireSendLock, releaseSendLock, clientSendLockKey, normalizeNotificationDataTimecode } from './notification-helpers'
import { redactEmailForLogs } from '../lib/log-sanitization'

/**
 * Process client notification summaries
 * Sends notifications to clients for admin replies based on schedule
 */
export async function processClientNotifications() {
  try {
    const now = new Date()
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`
    console.log(`[CLIENT] Checking for summaries to send (time: ${timeStr})`)

    // Get all projects with pending client notifications
    const projects = await prisma.project.findMany({
      where: {
        notificationQueue: {
          some: {
            type: 'ADMIN_REPLY',
            sentToClients: false,
            clientFailed: false,
            clientAttempts: { lt: 3 }
          }
        }
      },
      select: {
        id: true,
        title: true,
        slug: true,
        useFullTimecode: true,
        clientNotificationSchedule: true,
        clientNotificationTime: true,
        clientNotificationDay: true,
        lastClientNotificationSent: true,
        notificationQueue: {
          where: {
            type: 'ADMIN_REPLY',
            sentToClients: false,
            clientFailed: false,
            clientAttempts: { lt: 3 },
            createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
          },
          orderBy: { createdAt: 'asc' }
        }
      }
    })

    if (projects.length === 0) {
      console.log('[CLIENT] No projects with pending notifications')
      return
    }

    console.log(`[CLIENT] Found ${projects.length} project(s) with unsent notifications`)

    for (const project of projects) {
      const pending = project.notificationQueue.length
      console.log(`[CLIENT] "${project.title}": ${project.clientNotificationSchedule} at ${project.clientNotificationTime || 'N/A'} (${pending} pending)`)

      if (project.clientNotificationSchedule === 'IMMEDIATE' || project.clientNotificationSchedule === 'NONE') {
        console.log('[CLIENT]   Skip - IMMEDIATE or NONE, not a batch schedule')
        continue
      }

      // Check if it's time to send based on project schedule
      const shouldSend = shouldSendNow(
        project.clientNotificationSchedule,
        project.clientNotificationTime,
        project.clientNotificationDay,
        project.lastClientNotificationSent,
        now
      )

      if (!shouldSend) {
        const lastSentStr = project.lastClientNotificationSent
          ? new Date(project.lastClientNotificationSent).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
          : 'never'
        console.log(`[CLIENT]   Wait - last sent ${lastSentStr}`)
        continue
      }

      console.log(`[CLIENT]   Sending summary now...`)

      if (project.notificationQueue.length === 0) {
        continue
      }

      // Get recipients with notifications enabled
      const allRecipients = await getProjectRecipients(project.id)
      const recipients = allRecipients.filter(r => r.receiveNotifications && r.email)

      if (recipients.length === 0) {
        console.log(`[CLIENT]   No recipients with notifications enabled, marking as sent`)
        const noRecipientIds = project.notificationQueue.map(n => n.id)
        await prisma.notificationQueue.updateMany({
          where: { id: { in: noRecipientIds } },
          data: { sentToClients: true, clientSentAt: new Date() },
        })
        continue
      }

      const period = getPeriodString(project.clientNotificationSchedule)
      const shareUrl = await generateShareUrl(project.slug)

      // Filter out cancelled notifications
      const redis = getRedis()
      const validNotifications: typeof project.notificationQueue = []
      const cancelledNotificationIds: string[] = []

      for (const notification of project.notificationQueue) {
        const commentId = (notification.data as any).commentId
        if (commentId) {
          const isCancelled = await redis.get(`comment_cancelled:${commentId}`)
          if (isCancelled) {
            console.log(`[CLIENT]   Skipping cancelled notification for comment ${commentId}`)
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
        console.log(`[CLIENT]   Removed ${cancelledNotificationIds.length} cancelled notification(s)`)
      }

      if (validNotifications.length === 0) {
        console.log(`[CLIENT]   No valid notifications to send (all cancelled)`)
        continue
      }

      const notificationIds = validNotifications.map(n => n.id)

      // Serialize against a concurrent manual send for this project so the two paths can't both
      // fire the same summary at once. If a manual send holds the lock, skip this project and
      // pick it up next run. Released right after sending; the lock's TTL is the crash backstop.
      const lockKey = clientSendLockKey(project.id)
      if (!(await tryAcquireSendLock(lockKey))) {
        console.log(`[CLIENT]   Another send is in progress for this project; will retry next run`)
        continue
      }

      // Increment attempt counter before sending
      await prisma.notificationQueue.updateMany({
        where: { id: { in: notificationIds } },
        data: { clientAttempts: { increment: 1 } }
      })

      const currentAttempts = (project.notificationQueue[0]?.clientAttempts ?? 0) + 1
      console.log(`[CLIENT]   Attempt #${currentAttempts} for ${project.notificationQueue.length} notification(s)`)

      // Send summary to each recipient
      const result = await sendNotificationsWithRetry({
        notificationIds,
        currentAttempts,
        isClientNotification: true,
        logPrefix: '[CLIENT]  ',
        onSuccess: async () => {
          const notifications = validNotifications.map(n =>
            normalizeNotificationDataTimecode(n.data as any)
          )

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
          const companyLogoUrl = buildCompanyLogoUrl({
            appDomain,
            companyLogoMode: emailSettings.companyLogoMode,
            companyLogoPath: null,
            companyLogoUrl: emailSettings.companyLogoUrl,
            updatedAt: emailSettings.updatedAt,
          })

          // Stable batch key to prevent duplicate tracking/event logs on retries, and to share
          // per-recipient idempotency markers with the manual "Comment Summary" send (which
          // computes the identical hash), so the two paths never re-mail the same recipient.
          const batchHash = notificationBatchHash(notificationIds, `${project.id}|${period}`)

          // Per-recipient idempotent send: retries skip recipients already emailed for
          // this batch, so a single failing address never re-mails everyone else.
          const { sentEmails: successfulRecipientEmails } = await sendSummaryToRecipients({
            channel: 'client',
            batchHash,
            recipients,
            getEmail: (r) => r.email,
            logPrefix: '[CLIENT]  ',
            sendOne: async (recipient) => {
              // Create tracking token per-recipient so opens can be recorded.
              // Use upsert with a stable token so retries don't create duplicate rows.
              const normalizedEmail = recipient.email!.toLowerCase()
              const stableToken = `${project.id}-${batchHash}-${normalizedEmail}`
              const trackingToken = trackingPixelsEnabled
                ? await prisma.emailTracking.upsert({
                    where: { token: stableToken },
                    update: {
                      sentAt: new Date(),
                    },
                    create: {
                      token: stableToken,
                      projectId: project.id,
                      type: 'COMMENT_SUMMARY',
                      videoId: null,
                      recipientEmail: normalizedEmail,
                    },
                  })
                : null

              const html = generateNotificationSummaryEmail({
                companyName: emailSettings.companyName || 'ViTransfer',
                projectTitle: project.title,
                useFullTimecode: project.useFullTimecode,
                shareUrl,
                unsubscribeUrl: recipient.id ? buildUnsubscribeUrl(appDomain, project.id, recipient.id) : undefined,
                recipientName: recipient.name || recipient.email!,
                recipientEmail: recipient.email!,
                period,
                notifications,
                trackingToken: trackingToken?.token,
                trackingPixelsEnabled,
                appDomain,
                companyLogoUrl: companyLogoUrl || undefined,
                mainCompanyDomain: emailSettings.mainCompanyDomain,
                emailCustomFooterText: emailSettings.emailCustomFooterText,
                accentColor: emailSettings.accentColor || undefined,
                accentTextMode: emailSettings.accentTextMode || undefined,
                emailHeaderColor: emailSettings.emailHeaderColor || undefined,
                emailHeaderTextMode: emailSettings.emailHeaderTextMode || undefined,
              })

              const result = await sendEmail({
                to: recipient.email!,
                subject: `Updates on ${project.title}`,
                html,
              })

              if (result.success) {
                console.log(
                  `[CLIENT]     Sent to ${recipient.name || redactEmailForLogs(recipient.email)}`
                )
              }
              return result
            },
          })

          // Log analytics event for this batch (non-blocking)
          if (successfulRecipientEmails.length > 0) {
            try {
              const recipientEmailsJson = JSON.stringify(successfulRecipientEmails)

              // DB-level dedupe: retries will collide on the same dedupeKey and be ignored.
              const dedupeKey = `COMMENT_SUMMARY:${project.id}:${batchHash}`

              try {
                await prisma.projectEmailEvent.create({
                  data: {
                    projectId: project.id,
                    type: 'COMMENT_SUMMARY',
                    dedupeKey,
                    videoId: null,
                    recipientEmails: recipientEmailsJson,
                  },
                })
              } catch (e: any) {
                // Ignore unique constraint violations (already logged)
                if (e?.code !== 'P2002') {
                  throw e
                }
              }
            } catch (e) {
              console.error('[CLIENT]     Failed to log ProjectEmailEvent:', e)
            }
          }
        }
      })

      // Sending is done — release the lock so a manual send isn't blocked longer than needed.
      await releaseSendLock(lockKey)

      // Update project last sent timestamp on success
      if (result.success) {
        await prisma.project.update({
          where: { id: project.id },
          data: { lastClientNotificationSent: now }
        })
        console.log(`[CLIENT]   Summary sent (${project.notificationQueue.length} items to ${recipients.length} recipient(s))`)
      }
    }

    console.log('[CLIENT] Check completed')
  } catch (error) {
    console.error('[CLIENT] Error processing notifications:', error)
  }
}
