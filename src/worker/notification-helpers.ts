import { prisma } from '../lib/db'
import { secondsToTimecode, parseTimecodeInput, isValidTimecode } from '../lib/timecode'
import { getRedis } from '../lib/redis'
import { redactEmailForLogs } from '../lib/log-sanitization'
import { createHash } from 'crypto'
import { REACTION_EMOJIS } from '../lib/comment-reactions'

const MAX_ATTEMPTS = 3

// How long a per-recipient "already sent" marker lives. The retry window for a batch is
// minutes-to-hours (2-minute fast retries + hourly cron, max 3 attempts), so two days
// comfortably covers it while letting the keys expire on their own afterwards.
const SENT_MARKER_TTL_SECONDS = 2 * 24 * 60 * 60

/**
 * Get period description string for email template
 */
export function getPeriodString(schedule: string): string {
  switch (schedule) {
    case 'HOURLY':
      return 'in the last hour'
    case 'DAILY':
      return 'today'
    default:
      return 'recently'
  }
}

/**
 * Check if notifications should be sent now (CRON-like scheduling)
 *
 * CRON Principle: Compares last sent time against the most recent target time.
 * If schedule changes (e.g., WEEKLY→DAILY), immediately re-evaluates and sends if past due.
 *
 * TZ Note: All Date operations use container's TZ (set via TZ env var in docker-compose)
 */
export function shouldSendNow(
  schedule: string,
  time: string | null,
  day: number | null,
  lastSent: Date | null,
  now: Date
): boolean {
  const getTargetTime = (): Date | null => {
    switch (schedule) {
      case 'HOURLY':
        // Target is the most recent top-of-hour boundary.
        // This allows the scheduler to run hourly (or any interval) without missing sends.
        const hourTarget = new Date(now)
        hourTarget.setMinutes(0, 0, 0)
        return hourTarget

      case 'DAILY':
        if (!time) return null
        const [dailyHour, dailyMin] = time.split(':').map(Number)
        // Target is the most recent scheduled time (today, or yesterday if not reached yet).
        const dailyTarget = new Date(now)
        dailyTarget.setHours(dailyHour, dailyMin, 0, 0)
        if (now < dailyTarget) {
          dailyTarget.setDate(dailyTarget.getDate() - 1)
        }
        return dailyTarget

      default:
        return null
    }
  }

  const target = getTargetTime()
  if (!target) return false

  // Not past target time yet - wait
  if (now < target) return false

  // Never sent before - send now
  if (!lastSent) return true

  // Already sent after this target - don't send again
  if (lastSent >= target) return false

  // Last sent was before this target - send now
  return true
}

/**
 * Attach each comment's current reaction tally to its queued payload, so a digest shows
 * acknowledgement state inline under the comment body.
 *
 * Deliberately reads live counts rather than a snapshot taken at queue time: by the moment
 * the digest goes out, the tally the reader cares about is the one on screen now. Reaction
 * entries themselves are skipped — they already name their own emoji.
 */
export async function attachReactionTallies(notifications: any[]): Promise<any[]> {
  const commentIds = [...new Set(
    notifications
      .filter((n) => n?.type !== 'COMMENT_REACTION' && typeof n?.commentId === 'string')
      .map((n) => n.commentId as string),
  )]
  if (commentIds.length === 0) return notifications

  const grouped = await prisma.commentReaction.groupBy({
    by: ['commentId', 'emoji'],
    where: { commentId: { in: commentIds } },
    _count: { _all: true },
  })
  if (grouped.length === 0) return notifications

  const byComment = new Map<string, Array<{ emoji: string; count: number }>>()
  for (const row of grouped) {
    const list = byComment.get(row.commentId) || []
    list.push({ emoji: row.emoji, count: row._count._all })
    byComment.set(row.commentId, list)
  }

  // Stable display order, matching the share page's allowlist ordering.
  for (const list of byComment.values()) {
    list.sort((a, b) => REACTION_EMOJIS.indexOf(a.emoji as any) - REACTION_EMOJIS.indexOf(b.emoji as any))
  }

  return notifications.map((n) =>
    n?.commentId && byComment.has(n.commentId) ? { ...n, reactions: byComment.get(n.commentId) } : n,
  )
}

// How many replies preceding the new one are quoted as context. Threads run long; the
// replies immediately before the new one are what make it readable, and everything earlier
// is summarised as a count rather than pasted into the email.
const THREAD_CONTEXT_MAX = 3

/**
 * Quote the run-up to a reply: the replies that landed between the thread's root comment
 * and the reply being notified about.
 *
 * Queue rows snapshot only the immediate parent, and comment threads are two levels deep —
 * the reply button lives on top-level comments only — so a reply's `parentComment` is always
 * the thread root. Anything said in between was dropped, which is exactly the context that
 * makes a short reply ("Copy that!") legible.
 *
 * Read live rather than snapshotted at queue time: a digest is assembled hours after the
 * fact, so a live read shows the current wording of each quoted comment and silently omits
 * ones since deleted — neither of which a snapshot could do without teaching
 * `syncCommentNotificationContent` to rewrite a whole array on every edit.
 *
 * `includeInternal` MUST stay false for the client channel: internal comments share the
 * Comment table with client-visible ones, and quoting the thread is a path for them to
 * reach a client digest.
 */
export async function attachThreadContext(
  notifications: any[],
  options: { includeInternal: boolean },
): Promise<any[]> {
  const replyNotifications = notifications.filter(
    (n) => n?.type !== 'COMMENT_REACTION' && n?.isReply && typeof n?.parentCommentId === 'string',
  )
  if (replyNotifications.length === 0) return notifications

  const parentIds = [...new Set(replyNotifications.map((n) => n.parentCommentId as string))]

  const siblings = await prisma.comment.findMany({
    where: {
      parentId: { in: parentIds },
      ...(options.includeInternal ? {} : { isInternal: false }),
    },
    select: {
      id: true,
      parentId: true,
      authorName: true,
      content: true,
      timecode: true,
      isInternal: true,
      userId: true,
      createdAt: true,
      user: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  if (siblings.length === 0) return notifications

  const byThread = new Map<string, typeof siblings>()
  for (const reply of siblings) {
    const list = byThread.get(reply.parentId!) || []
    list.push(reply)
    byThread.set(reply.parentId!, list)
  }

  return notifications.map((n) => {
    if (!replyNotifications.includes(n)) return n
    const thread = byThread.get(n.parentCommentId as string)
    if (!thread) return n

    // Position by id where possible. A reply filtered out of `siblings` (internal, on the
    // client channel) has no index here, so fall back to its queued timestamp.
    const selfIndex = thread.findIndex((reply) => reply.id === n.commentId)
    const preceding = selfIndex >= 0
      ? thread.slice(0, selfIndex)
      : thread.filter((reply) => reply.createdAt.getTime() < new Date(n.createdAt).getTime())

    if (preceding.length === 0) return n

    const shown = preceding.slice(-THREAD_CONTEXT_MAX)
    return {
      ...n,
      threadContext: shown.map((reply) => ({
        authorName:
          reply.authorName
          || reply.user?.name
          || reply.user?.email
          || (reply.userId || reply.isInternal ? 'Admin' : 'Client'),
        content: reply.content,
        timecode: reply.timecode ? normalizeTimecodeValue(reply.timecode) : null,
        isInternal: reply.isInternal,
      })),
      threadContextOmitted: preceding.length - shown.length,
    }
  })
}

/**
 * Coerce a stored timecode into the display format, tolerating the older numeric-seconds
 * form that early queue entries (and older Comment rows) carry.
 */
function normalizeTimecodeValue(value: any) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (isValidTimecode(trimmed)) return trimmed
    if (!Number.isNaN(Number(trimmed)) && !trimmed.includes(':')) {
      return secondsToTimecode(parseFloat(trimmed), 24)
    }
    try {
      return parseTimecodeInput(trimmed, 24)
    } catch {
      return trimmed
    }
  }
  if (typeof value === 'number') {
    return secondsToTimecode(value, 24)
  }
  return value
}

/**
 * Normalize queued notification payloads to ensure they include timecode.
 * Older queue entries stored a numeric timestamp; convert those on the fly
 * so emails consistently show the new HH:MM:SS:FF format.
 */
export function normalizeNotificationDataTimecode(data: any) {
  if (!data) return data

  const normalized = { ...data }

  const normalizeValue = normalizeTimecodeValue

  if (!normalized.timecode && normalized.timestamp !== undefined) {
    normalized.timecode = normalizeValue(normalized.timestamp)
  } else if (normalized.timecode) {
    normalized.timecode = normalizeValue(normalized.timecode)
  }

  if (normalized.parentComment) {
    const parent = normalized.parentComment as any
    if (!parent.timecode && parent.timestamp !== undefined) {
      normalized.parentComment = {
        ...parent,
        timecode: normalizeValue(parent.timestamp),
      }
    } else if (parent.timecode) {
      normalized.parentComment = {
        ...parent,
        timecode: normalizeValue(parent.timecode),
      }
    }
  }

  return normalized
}

/**
 * Stable hash of a notification batch, used to scope per-recipient idempotency markers.
 * Order-independent so the same set of notifications always maps to the same key.
 */
export function notificationBatchHash(notificationIds: string[], salt = ''): string {
  const sorted = [...notificationIds].sort().join('|')
  return createHash('sha256').update(salt ? `${salt}|${sorted}` : sorted).digest('hex').slice(0, 16)
}

// How long a send lock lives if its holder never releases it (e.g. process crash mid-send).
// The lock is normally released in a finally block; this is just the crash safety net.
const SEND_LOCK_TTL_SECONDS = 2 * 60

/**
 * Try to acquire a short-lived advisory lock so the scheduled worker and a manual send can't
 * process the same scope (a project's client summary, or the global admin summary) at the same
 * instant and each fire a duplicate email. Returns true if acquired; false if another sender
 * holds it. Always release in a finally block via releaseSendLock().
 */
export async function tryAcquireSendLock(lockKey: string): Promise<boolean> {
  try {
    const res = await getRedis().set(lockKey, '1', 'EX', SEND_LOCK_TTL_SECONDS, 'NX')
    return res === 'OK'
  } catch {
    // If Redis is unavailable, don't block sending entirely — fall back to "acquired".
    // The per-recipient idempotency markers and per-batch sent flags remain as backstops.
    return true
  }
}

export async function releaseSendLock(lockKey: string): Promise<void> {
  try {
    await getRedis().del(lockKey)
  } catch {
    // best-effort; the TTL will expire it anyway
  }
}

/** Lock key for a single project's client summary send (worker is per-project; manual is per-project). */
export function clientSendLockKey(projectId: string): string {
  return `notif:lock:client:${projectId}`
}

/** Lock key for the admin summary send (worker run is global; manual is per-project but shares this key). */
export const ADMIN_SEND_LOCK_KEY = 'notif:lock:admin'

/**
 * Send one summary email per recipient with per-recipient idempotency.
 *
 * Why this exists: send state on NotificationQueue is per-batch, not per-recipient, so a
 * naive loop that throws on the first failed recipient causes the whole batch to be retried
 * — re-mailing everyone who already received it. This helper records each successful send in
 * Redis (scoped by batch hash) and skips those recipients on subsequent attempts, so retries
 * only target the recipients who still need the email. Every remaining recipient is attempted
 * before we surface failure, so one bad address never blocks delivery to the rest.
 *
 * It still throws if any recipient failed, so the caller (sendNotificationsWithRetry) leaves
 * the batch pending for another attempt — but the next attempt won't duplicate.
 *
 * Returns the list of emails that were actually sent on THIS attempt (skipped recipients are
 * not included), suitable for analytics logging of the current run.
 */
export async function sendSummaryToRecipients<T>(config: {
  /** Channel label namespacing the Redis marker, e.g. 'client' | 'admin' | 'internal' | 'task'. */
  channel: string
  /** Stable hash identifying this batch of notifications. */
  batchHash: string
  recipients: T[]
  getEmail: (recipient: T) => string | null | undefined
  logPrefix: string
  /** Performs the actual send for one recipient. Must not throw — return the send result. */
  sendOne: (recipient: T) => Promise<{ success: boolean; error?: string }>
}): Promise<{ sentEmails: string[] }> {
  const { channel, batchHash, recipients, getEmail, logPrefix, sendOne } = config
  const redis = getRedis()
  const sentEmails: string[] = []
  const failures: string[] = []

  for (const recipient of recipients) {
    const email = getEmail(recipient)
    if (!email) continue
    const normalizedEmail = email.toLowerCase()
    const sentKey = `notif_sent:${channel}:${batchHash}:${normalizedEmail}`

    // Skip recipients who already received this batch on a previous attempt.
    let alreadySent = false
    try {
      alreadySent = (await redis.get(sentKey)) !== null
    } catch {
      // Redis unavailable: fall through and attempt the send (at-least-once is preferable
      // to silently dropping the email).
    }
    if (alreadySent) {
      console.log(`${logPrefix} Skipping ${redactEmailForLogs(email)} (already sent this batch)`)
      continue
    }

    const result = await sendOne(recipient)
    if (result.success) {
      sentEmails.push(email)
      try {
        await redis.setex(sentKey, SENT_MARKER_TTL_SECONDS, '1')
      } catch {
        // Non-fatal: worst case a transient Redis failure allows a duplicate on retry.
      }
    } else {
      failures.push(`${redactEmailForLogs(email)}: ${result.error || 'unknown error'}`)
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to send to ${failures.length} recipient(s): ${failures.join('; ')}`)
  }

  return { sentEmails }
}

/**
 * Handle notification send with automatic retry logic
 * DRY helper - used by both admin and client notification processing
 */
export async function sendNotificationsWithRetry(config: {
  notificationIds: string[]
  currentAttempts: number
  isClientNotification: boolean
  onSuccess: () => Promise<void>
  logPrefix: string
}): Promise<{ success: boolean; lastError?: string }> {
  const { notificationIds, currentAttempts, isClientNotification, onSuccess, logPrefix } = config

  let sendSuccess = false
  let lastError: string | undefined

  try {
    await onSuccess()
    sendSuccess = true
  } catch (error) {
    lastError = error instanceof Error ? error.message : 'Unknown error'
    console.error(`${logPrefix} Send failed:`, error)
  }

  const now = new Date()

  if (sendSuccess) {
    // Mark as sent
    await prisma.notificationQueue.updateMany({
      where: { id: { in: notificationIds } },
      data: {
        [isClientNotification ? 'sentToClients' : 'sentToAdmins']: true,
        [isClientNotification ? 'clientSentAt' : 'adminSentAt']: now,
        lastError: null
      }
    })
    console.log(`${logPrefix} Successfully sent`)
  } else if (currentAttempts >= MAX_ATTEMPTS) {
    // Permanently failed after 3 attempts
    await prisma.notificationQueue.updateMany({
      where: { id: { in: notificationIds } },
      data: {
        [isClientNotification ? 'clientFailed' : 'adminFailed']: true,
        lastError: lastError || `Failed after ${MAX_ATTEMPTS} attempts`
      }
    })
    console.error(`${logPrefix} Permanently failed after ${MAX_ATTEMPTS} attempts`)
  } else {
    // Will retry
    await prisma.notificationQueue.updateMany({
      where: { id: { in: notificationIds } },
      data: { lastError: lastError || 'Send failed' }
    })
    console.log(`${logPrefix} Will retry (attempt ${currentAttempts}/${MAX_ATTEMPTS})`)
  }

  return { success: sendSuccess, lastError }
}
