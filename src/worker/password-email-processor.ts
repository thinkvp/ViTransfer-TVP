import type { Job } from 'bullmq'
import { prisma } from '../lib/db'
import { decrypt } from '../lib/encryption'
import { getEmailSettings, sendPasswordEmail } from '../lib/email'
import { getProjectRecipients } from '../lib/recipients'
import { redactEmailForLogs } from '../lib/log-sanitization'
import { sendSummaryToRecipients, notificationBatchHash } from './notification-helpers'
import type { PasswordEmailJob } from '../lib/queue'

/**
 * Send the share-link password as a separate email, staggered after the notification email.
 *
 * Enqueued (with a delay) by the notify route instead of blocking the admin's request with an
 * in-process sleep. Records a `PASSWORD` ProjectEmailEvent (analytics "sent") and a per-recipient
 * EmailTracking row with an open-tracking pixel (when tracking pixels are enabled), so password
 * sends and opens show up in project analytics like every other notification email.
 *
 * Per-recipient idempotency (shared helper) means a BullMQ retry after a partial failure only
 * re-sends to the recipients who didn't already receive it.
 */
export async function processPasswordEmail(job: Job<PasswordEmailJob>) {
  const { projectId, recipientIds } = job.data

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, title: true, sharePassword: true, authMode: true },
  })

  if (!project) {
    console.warn(`[PASSWORD] Project ${projectId} no longer exists; skipping password email`)
    return
  }

  const isPasswordProtected =
    (project.authMode === 'PASSWORD' || project.authMode === 'BOTH') && !!project.sharePassword
  if (!isPasswordProtected || !project.sharePassword) {
    console.warn(`[PASSWORD] Project ${projectId} is no longer password protected; skipping`)
    return
  }

  const requestedIds = Array.isArray(recipientIds) ? recipientIds.map((x) => String(x)) : []
  if (requestedIds.length === 0) return

  const idSet = new Set(requestedIds)
  const allRecipients = await getProjectRecipients(projectId)
  const recipients = allRecipients.filter((r) => r.id && idSet.has(String(r.id)) && r.email)

  if (recipients.length === 0) {
    console.warn(`[PASSWORD] No matching recipients with an email for project ${projectId}`)
    return
  }

  const password = decrypt(project.sharePassword)
  const emailSettings = await getEmailSettings()
  const trackingPixelsEnabled = emailSettings.emailTrackingPixelsEnabled ?? true

  // Stable hash for this recipient set so a BullMQ retry reuses the same per-recipient tracking
  // tokens and idempotency markers (no duplicate sends / tracking rows).
  const batchHash = notificationBatchHash(requestedIds, `password|${project.id}`)

  const { sentEmails } = await sendSummaryToRecipients({
    channel: 'password',
    batchHash,
    recipients,
    getEmail: (r) => r.email,
    logPrefix: '[PASSWORD]',
    sendOne: async (recipient) => {
      const normalizedEmail = recipient.email!.toLowerCase()
      const stableToken = `${project.id}-pw-${batchHash}-${normalizedEmail}`

      // Create the open-tracking row before sending so the embedded pixel resolves to it.
      if (trackingPixelsEnabled) {
        await prisma.emailTracking.upsert({
          where: { token: stableToken },
          update: { sentAt: new Date() },
          create: {
            token: stableToken,
            projectId: project.id,
            type: 'PASSWORD',
            videoId: null,
            recipientEmail: normalizedEmail,
          },
        })
      }

      const result = await sendPasswordEmail({
        clientEmail: recipient.email!,
        clientName: recipient.name || 'Client',
        projectTitle: project.title,
        password,
        trackingToken: trackingPixelsEnabled ? stableToken : undefined,
      })

      if (result.success) {
        console.log(`[PASSWORD]   Sent to ${redactEmailForLogs(recipient.email)}`)
      }
      return result
    },
  })

  // Log the analytics "sent" event (non-blocking). DB-level dedupe so a retry can't double-log.
  if (sentEmails.length > 0) {
    try {
      await prisma.projectEmailEvent.create({
        data: {
          projectId: project.id,
          type: 'PASSWORD',
          dedupeKey: `PASSWORD:${project.id}:${batchHash}`,
          videoId: null,
          recipientEmails: JSON.stringify(sentEmails),
        },
      })
    } catch (e: any) {
      if (e?.code !== 'P2002') console.error('[PASSWORD] Failed to log ProjectEmailEvent:', e)
    }
  }
}
