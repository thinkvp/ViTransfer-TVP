import { prisma } from '@/lib/db'
import { DROPBOX_STORAGE_INCONSISTENCY_NOTIFICATION_TYPE } from '@/lib/dropbox-storage-inconsistency-notification'

type IssueEntity = {
  entityType: string
  entityId: string
  projectId: string
}

type UpsertInput = {
  scannedAtIso: string
  checkedCount: number
  inconsistencyCount: number
  report: string
  entities: IssueEntity[]
}

export async function clearDropboxStorageInconsistencyNotifications(): Promise<void> {
  await prisma.pushNotificationLog.deleteMany({
    where: { type: DROPBOX_STORAGE_INCONSISTENCY_NOTIFICATION_TYPE },
  })
}

export async function upsertDropboxStorageInconsistencyNotification(
  input: UpsertInput,
): Promise<void> {
  const sentAt = new Date(input.scannedAtIso)

  const details = {
    __payload: {
      title: 'System alert: Dropbox storage inconsistencies detected',
      message: `${input.inconsistencyCount} inconsistenc${input.inconsistencyCount === 1 ? 'y' : 'ies'} found during the hourly consistency scan`,
      projectName: undefined,
    },
    __link: {
      href: '/admin/settings',
    },
    __controls: {
      clearable: true,
      pinned: true,
      manualClearRequired: true,
    },
    'Last scan': sentAt.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
    'Checked items': String(input.checkedCount),
    'Inconsistencies': String(input.inconsistencyCount),
    Details: input.report,
    __entities: input.entities,
  }

  const existing = await prisma.pushNotificationLog.findMany({
    where: { type: DROPBOX_STORAGE_INCONSISTENCY_NOTIFICATION_TYPE },
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
      type: DROPBOX_STORAGE_INCONSISTENCY_NOTIFICATION_TYPE,
      projectId: null,
      success: true,
      statusCode: null,
      message: 'Manual clear required',
      details,
      sentAt,
    },
  })
}

export async function getActiveDropboxStorageIssueEntities(
  projectId: string,
): Promise<IssueEntity[]> {
  const notification = await prisma.pushNotificationLog.findFirst({
    where: { type: DROPBOX_STORAGE_INCONSISTENCY_NOTIFICATION_TYPE },
    orderBy: { sentAt: 'desc' },
    select: { details: true },
  })

  if (!notification?.details || typeof notification.details !== 'object') {
    return []
  }

  const details = notification.details as Record<string, unknown>
  const entities = details.__entities
  if (!Array.isArray(entities)) return []

  return entities.filter(
    (entry): entry is IssueEntity =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as IssueEntity).entityType === 'string' &&
      typeof (entry as IssueEntity).entityId === 'string' &&
      (entry as IssueEntity).projectId === projectId,
  )
}

export async function clearResolvedDropboxStorageIssueEntities(
  resolved: IssueEntity[],
): Promise<void> {
  if (resolved.length === 0) return

  const notification = await prisma.pushNotificationLog.findFirst({
    where: { type: DROPBOX_STORAGE_INCONSISTENCY_NOTIFICATION_TYPE },
    orderBy: { sentAt: 'desc' },
    select: { id: true, details: true },
  })

  if (!notification?.details || typeof notification.details !== 'object') return

  const details = notification.details as Record<string, unknown>
  const entities = details.__entities
  if (!Array.isArray(entities)) return

  const resolvedKeys = new Set(resolved.map((r) => `${r.entityType}:${r.entityId}`))
  const remaining = entities.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const e = entry as IssueEntity
    return !resolvedKeys.has(`${e.entityType}:${e.entityId}`)
  })

  if (remaining.length === 0) {
    await prisma.pushNotificationLog.delete({ where: { id: notification.id } })
    return
  }

  const updatedDetails: Record<string, unknown> = { ...details, __entities: remaining }
  const inconsistencyCount = remaining.length
  if (updatedDetails.__payload && typeof updatedDetails.__payload === 'object') {
    const payload = updatedDetails.__payload as Record<string, unknown>
    payload.message = `${inconsistencyCount} inconsistenc${inconsistencyCount === 1 ? 'y' : 'ies'} found during the hourly consistency scan`
  }
  if ('Inconsistencies' in updatedDetails) {
    updatedDetails['Inconsistencies'] = String(inconsistencyCount)
  }

  await prisma.pushNotificationLog.update({
    where: { id: notification.id },
    data: { details: updatedDetails as object },
  })
}
