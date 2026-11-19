import { prisma } from '../lib/db'
import { isSmtpConfigured } from '../lib/email'
import {
  addDaysYmd,
  dueReminderTrigger,
  normalizeReminderDaysBefore,
  todayYmd,
} from '../lib/feedback-deadline'
import { getActiveFeedbackDeadlines, sendFeedbackReminderEmails } from '../lib/feedback-reminders'

/**
 * Scheduled client reminders for video versions with a feedback deadline.
 * Runs every 15 minutes; sends once the configured time of day has passed.
 *
 * A version gets a reminder when its deadline is active, the client hasn't commented
 * on it yet, and one of the configured "days before" slots has arrived without a
 * reminder (scheduled or manual) since. See dueReminderTrigger for the slot rule.
 */
export async function processFeedbackDeadlineReminders(
  now: Date = new Date(),
  // Test seams (defaults are the real implementations).
  deps: {
    isSmtpConfigured?: typeof isSmtpConfigured
    sendFeedbackReminderEmails?: typeof sendFeedbackReminderEmails
    projectIds?: string[]
  } = {}
) {
  const smtpCheck = deps.isSmtpConfigured ?? isSmtpConfigured
  const sendReminders = deps.sendFeedbackReminderEmails ?? sendFeedbackReminderEmails
  const settings = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: { clientEmailFeedbackReminders: true, feedbackReminderDaysBefore: true, feedbackReminderTime: true },
  })
  if (!settings || settings.clientEmailFeedbackReminders === false) return { sent: 0 }

  const daysBefore = normalizeReminderDaysBefore(settings.feedbackReminderDaysBefore)
  if (daysBefore.length === 0) return { sent: 0 }

  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  if (hhmm < (settings.feedbackReminderTime || '09:00')) return { sent: 0 }

  const today = todayYmd(now)
  const horizon = addDaysYmd(today, Math.max(...daysBefore)) || today

  // Cheap prefilter; the full active rule (latest version, group approval) runs per project.
  const candidates = await prisma.video.findMany({
    where: {
      status: 'READY',
      approved: false,
      revisionRequestedAt: null,
      feedbackDueDate: { gte: today, lte: horizon },
      project: { status: { notIn: ['APPROVED', 'CLOSED', 'ON_HOLD'] } },
      ...(deps.projectIds ? { projectId: { in: deps.projectIds } } : {}),
    },
    select: { projectId: true },
    distinct: ['projectId'],
  })
  if (candidates.length === 0) return { sent: 0 }

  if (!(await smtpCheck())) {
    console.warn('[FEEDBACK-REMINDER] SMTP not configured; skipping reminders')
    return { sent: 0 }
  }

  let sent = 0
  for (const { projectId } of candidates) {
    try {
      const { deadlines } = await getActiveFeedbackDeadlines(projectId)

      const due = deadlines.filter((d) => {
        if (d.hasClientComment) return false
        const trigger = dueReminderTrigger({
          dueYmd: d.feedbackDueDate,
          daysBefore,
          today,
          lastReminderYmd: d.lastReminderAt ? todayYmd(d.lastReminderAt) : null,
          // Never remind on the day the version was uploaded.
          notBeforeYmd: addDaysYmd(todayYmd(d.createdAt), 1),
        })
        return trigger !== null
      })
      if (due.length === 0) continue

      // Claim each version (optimistic on its previous stamp) so an overlapping run
      // can't send the same reminder twice.
      const claimed: typeof due = []
      for (const d of due) {
        const res = await prisma.video.updateMany({
          where: { id: d.videoId, feedbackDueLastReminderAt: d.lastReminderAt },
          data: { feedbackDueLastReminderAt: now },
        })
        if (res.count === 1) claimed.push(d)
      }
      if (claimed.length === 0) continue

      const result = await sendReminders({ projectId, deadlines: claimed })
      if (result.sentTo.length === 0) {
        // Nothing went out — release the claims so the next run retries.
        for (const d of claimed) {
          await prisma.video.updateMany({
            where: { id: d.videoId, feedbackDueLastReminderAt: now },
            data: { feedbackDueLastReminderAt: d.lastReminderAt },
          })
        }
        if (result.error && result.error !== 'No eligible recipients') {
          console.warn(`[FEEDBACK-REMINDER] Project ${projectId}: ${result.error}`)
        }
        continue
      }
      sent += result.sentTo.length
      console.log(
        `[FEEDBACK-REMINDER] Project ${projectId}: reminded ${result.sentTo.length} recipient(s) about ${claimed.length} version(s)`
      )
    } catch (e) {
      console.error(`[FEEDBACK-REMINDER] Project ${projectId} failed:`, e instanceof Error ? e.message : e)
    }
  }
  return { sent }
}
