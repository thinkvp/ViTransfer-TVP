import { prisma } from '@/lib/db'
import { S3_LOCAL_BACKUP_FAILURE_NOTIFICATION_TYPE } from '@/lib/pinned-system-notifications'
import { sendBrowserPushToEligibleUsers } from '@/lib/admin-web-push'

/**
 * Upsert a pinned system notification when the S3 local backup fails.
 * Creates or updates a single persistent notification that must be manually
 * cleared from the notification bell.  Also fires a browser push notification.
 */
export async function upsertS3BackupFailureNotification(errorMessage: string): Promise<void> {
  const now = new Date()

  const failedAt = now.toLocaleString('en-AU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  const details = {
    __payload: {
      title: 'S3 backup failed',
      message: `The S3 \u2192 local backup encountered errors. ${errorMessage.slice(0, 200)}`,
    },
    __link: { href: '/admin/settings' },
    __controls: {
      clearable: true,
      pinned: true,
      manualClearRequired: true,
    },
    Error: errorMessage.slice(0, 500),
    'Failed at': failedAt,
  }

  // Upsert: update the existing notification (keep it as a single entry) or create a new one.
  const existing = await prisma.pushNotificationLog.findMany({
    where: { type: S3_LOCAL_BACKUP_FAILURE_NOTIFICATION_TYPE },
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
        where: { id: { in: duplicates.map((r) => r.id) } },
      })
    }
  } else {
    await prisma.pushNotificationLog.create({
      data: {
        type: S3_LOCAL_BACKUP_FAILURE_NOTIFICATION_TYPE,
        projectId: null,
        success: true,
        statusCode: null,
        message: 'Manual clear required',
        details,
        sentAt: now,
      },
    })
  }

  // Fire and forget — don't let push delivery failures affect the caller.
  sendBrowserPushToEligibleUsers({
    type: S3_LOCAL_BACKUP_FAILURE_NOTIFICATION_TYPE,
    title: details.__payload.title,
    message: details.__payload.message,
    details: { __link: details.__link },
  }).catch(() => {})
}
