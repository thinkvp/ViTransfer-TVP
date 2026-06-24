import { prisma } from '../lib/db'
import { secondsToTimecode, parseTimecodeInput, isValidTimecode } from '../lib/timecode'
import { getRedis } from '../lib/redis'
import { redactEmailForLogs } from '../lib/log-sanitization'
import { createHash } from 'crypto'

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
 * Normalize queued notification payloads to ensure they include timecode.
 * Older queue entries stored a numeric timestamp; convert those on the fly
 * so emails consistently show the new HH:MM:SS:FF format.
 */
export function normalizeNotificationDataTimecode(data: any) {
  if (!data) return data

  const normalized = { ...data }

  const normalizeValue = (value: any) => {
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
