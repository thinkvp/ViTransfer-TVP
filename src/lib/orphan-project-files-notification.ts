import { prisma } from '@/lib/db'
import { ORPHAN_PROJECT_FILES_SCAN_NOTIFICATION_TYPE } from '@/lib/pinned-system-notifications'
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

  const details = {
    __payload: {
      title: 'System alert: orphaned files detected',
      message: `${result.orphanFiles} orphaned file${result.orphanFiles === 1 ? '' : 's'} found during the weekly dry run`,
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
    'Orphan files': String(result.orphanFiles),
    'Approx bytes': formatBytes(result.orphanFileBytes),
    'Related project IDs': projectIds.length > 0 ? projectIds.join(', ') : 'None',
    Details: orphanPaths.slice(0, 10).join('\n') || 'No sample paths recorded',
    ...(orphanPaths.length > 10 ? { 'Additional lines': `${orphanPaths.length - 10} more line${orphanPaths.length - 10 === 1 ? '' : 's'}` } : {}),
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
}