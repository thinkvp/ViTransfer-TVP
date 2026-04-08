import { prisma } from '@/lib/db'
import { RATE_LIMIT_ALERT_NOTIFICATION_TYPE } from '@/lib/pinned-system-notifications'
import { sendBrowserPushToEligibleUsers } from '@/lib/admin-web-push'

type RateLimitAlertInput = {
  rateLimitType: string
  ipAddress?: string
  retryAfter?: number
}

/**
 * Upsert a pinned system notification for an active rate limit lockout.
 * A single notification is maintained and updated on each new lockout event.
 * It must be manually cleared from the notifications bell.
 */
export async function upsertRateLimitAlertNotification(input: RateLimitAlertInput): Promise<void> {
  const now = new Date()

  const details = {
    __payload: {
      title: 'System alert: Rate limit triggered',
      message: `A rate limit lockout was activated for "${input.rateLimitType}"`,
    },
    __link: {
      href: '/admin/security',
    },
    __controls: {
      clearable: true,
      pinned: true,
      manualClearRequired: true,
    },
    'Rate limit type': input.rateLimitType,
    ...(input.ipAddress ? { 'IP address': input.ipAddress } : {}),
    ...(input.retryAfter ? { 'Retry after': `${input.retryAfter}s` } : {}),
    'Last triggered': now.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
  }

  const existing = await prisma.pushNotificationLog.findMany({
    where: { type: RATE_LIMIT_ALERT_NOTIFICATION_TYPE },
    orderBy: { sentAt: 'desc' },
    select: { id: true },
  })

  if (existing.length > 0) {
    const [primary, ...duplicates] = existing
    await prisma.pushNotificationLog.update({
      where: { id: primary.id },
      data: {
        projectId: null,
        success: true,
        statusCode: null,
        message: 'Manual clear required',
        details,
        sentAt: now,
      },
    })

    if (duplicates.length > 0) {
      await prisma.pushNotificationLog.deleteMany({
        where: { id: { in: duplicates.map((row) => row.id) } },
      })
    }
    return
  }

  await prisma.pushNotificationLog.create({
    data: {
      type: RATE_LIMIT_ALERT_NOTIFICATION_TYPE,
      projectId: null,
      success: true,
      statusCode: null,
      message: 'Manual clear required',
      details,
      sentAt: now,
    },
  })

  sendBrowserPushToEligibleUsers({
    type: RATE_LIMIT_ALERT_NOTIFICATION_TYPE,
    title: details.__payload.title,
    message: details.__payload.message,
    details: { __link: details.__link },
  }).catch(() => {})
}

export async function clearRateLimitAlertNotifications(): Promise<void> {
  await prisma.pushNotificationLog.deleteMany({
    where: { type: RATE_LIMIT_ALERT_NOTIFICATION_TYPE },
  })
}
