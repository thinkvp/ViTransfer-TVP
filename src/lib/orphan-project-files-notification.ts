import { prisma } from '@/lib/db'
import { ORPHAN_PROJECT_FILES_SCAN_NOTIFICATION_TYPE } from '@/lib/pinned-system-notifications'
import { sendBrowserPushToEligibleUsers } from '@/lib/admin-web-push'
import { type ProjectStorageOrphanCleanupResult } from '@/lib/project-storage-orphan-cleanup'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const decimals = value >= 10 || unitIndex === 0 ? 0 : 1
  return `${value.toFixed(decimals)} ${units[unitIndex]}`
}

export async function clearOrphanProjectFilesScanNotifications(): Promise<void> {
  await prisma.pushNotificationLog.deleteMany({
    where: { type: ORPHAN_PROJECT_FILES_SCAN_NOTIFICATION_TYPE },
  })
}

export async function upsertOrphanProjectFilesScanNotification(
  result: ProjectStorageOrphanCleanupResult,
  scannedAtIso: string,
): Promise<void> {
  const sentAt = new Date(scannedAtIso)
  const orphanPaths = result.sample?.orphanPaths ?? []
  const projectIds = result.sample?.projectIds ?? []
  const missingPaths = result.missingFileSample?.paths ?? []

  // Build a human-readable summary for the notification message.
  const parts: string[] = []
  const scanFailed = result.missingFiles < 0
  if (scanFailed) {
    parts.push('S3 listing failed — scan results may be incomplete')
  } else {
    if (result.orphanFiles > 0) {
      parts.push(`${result.orphanFiles} orphaned file${result.orphanFiles === 1 ? '' : 's'} (on storage but not in DB)`)
    }
    if (result.missingFiles > 0) {
      parts.push(`${result.missingFiles} missing file${result.missingFiles === 1 ? '' : 's'} (in DB but not on storage)`)
    }
  }
  const message = (parts.length > 0 ? parts.join(' and ') + ' found' : 'No issues found') + ' during the weekly scan'

  const details = {
    __payload: {
      title: 'System alert: storage integrity issues detected',
      message,
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
    'Projects in DB': String(result.scannedProjects ?? result.scannedDirectories),
    'Scanned storage roots': String(result.scannedDirectories),
    'Scanned files': String(result.scannedFiles),
    'Orphan files (storage \u2260 DB)': String(result.orphanFiles),
    'Orphan bytes': formatBytes(result.orphanFileBytes),
    'Missing files (DB \u2260 storage)': String(result.missingFiles),
    'Related project IDs': projectIds.length > 0 ? projectIds.join(', ') : 'None',
    ...(orphanPaths.length > 0
      ? {
          'Orphan paths (first 10)': orphanPaths.slice(0, 10).join('\n'),
          ...(orphanPaths.length > 10 ? { 'Orphan paths additional': `${orphanPaths.length - 10} more` } : {}),
        }
      : {}),
    ...(missingPaths.length > 0
      ? {
          'Missing paths (first 10)': missingPaths.slice(0, 10).join('\n'),
          ...(missingPaths.length > 10 ? { 'Missing paths additional': `${missingPaths.length - 10} more` } : {}),
        }
      : {}),
  }

  const existing = await prisma.pushNotificationLog.findMany({
    where: { type: ORPHAN_PROJECT_FILES_SCAN_NOTIFICATION_TYPE },
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
      type: ORPHAN_PROJECT_FILES_SCAN_NOTIFICATION_TYPE,
      projectId: null,
      success: true,
      statusCode: null,
      message: 'Manual clear required',
      details,
      sentAt,
    },
  })

  sendBrowserPushToEligibleUsers({
    type: ORPHAN_PROJECT_FILES_SCAN_NOTIFICATION_TYPE,
    title: details.__payload.title,
    message: details.__payload.message,
    details: { __link: details.__link },
  }).catch(() => {})
}