import { prisma } from '@/lib/db'
import { QUICKBOOKS_DAILY_PULL_FAILURE_NOTIFICATION_TYPE } from '@/lib/pinned-system-notifications'

type QuickBooksDailyPullFailureNotificationInput = {
  attemptedAtIso: string
  dailyPullTime: string
  lookbackDays: number
  message: string
}

export async function clearQuickBooksDailyPullFailureNotifications(): Promise<void> {
  await prisma.pushNotificationLog.deleteMany({
    where: { type: QUICKBOOKS_DAILY_PULL_FAILURE_NOTIFICATION_TYPE },
  })
}

export async function upsertQuickBooksDailyPullFailureNotification(
  input: QuickBooksDailyPullFailureNotificationInput,
): Promise<void> {
  const sentAt = new Date(input.attemptedAtIso)
  const details = {
    __payload: {
      title: 'System alert: QuickBooks daily pull failed',
      message: 'The scheduled QuickBooks daily pull did not complete successfully',
      projectName: undefined,
    },
    __link: {
      href: '/admin/sales/settings',
    },
    __controls: {
      clearable: true,
      pinned: true,
      manualClearRequired: true,
    },
    'Last attempt': new Date(input.attemptedAtIso).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
    Schedule: input.dailyPullTime,
    'Lookback days': String(input.lookbackDays),
    Details: input.message,
  }

  const existing = await prisma.pushNotificationLog.findMany({
    where: { type: QUICKBOOKS_DAILY_PULL_FAILURE_NOTIFICATION_TYPE },
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
        sentAt,
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
      type: QUICKBOOKS_DAILY_PULL_FAILURE_NOTIFICATION_TYPE,
      projectId: null,
      success: true,
      statusCode: null,
      message: 'Manual clear required',
      details,
      sentAt,
    },
  })
}