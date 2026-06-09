import { prisma } from '../lib/db'
import { deleteFile, deleteDirectory } from '../lib/storage'
import { invalidateProjectSessions, invalidateShareTokensByProject } from '../lib/session-invalidation'
import { cancelProjectJobs } from '../lib/cancel-project-jobs'
import { findStoredFilesToDelete, deleteStoredFilesByCriteria } from '../lib/stored-file'

export async function processAutoCloseApprovedProjects(): Promise<{ closedCount: number }> {
  const settings = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: {
      autoCloseApprovedProjectsEnabled: true,
      autoCloseApprovedProjectsAfterDays: true,
      autoDeletePreviewsOnClose: true,
    },
  })

  if (!settings?.autoCloseApprovedProjectsEnabled) {
    return { closedCount: 0 }
  }

  const days = settings.autoCloseApprovedProjectsAfterDays
  if (!Number.isInteger(days) || days < 1) {
    return { closedCount: 0 }
  }

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)

  console.log(`[AUTO-CLOSE] Enabled (days=${days}) cutoff=${cutoff.toISOString()}`)

  const dueProjects = await prisma.project.findMany({
    where: {
      status: 'APPROVED',
      approvedAt: {
        not: null,
        lte: cutoff,
      },
    },
    select: { id: true, title: true },
  })

  if (dueProjects.length === 0) {
    return { closedCount: 0 }
  }

  // Close projects
  const ids = dueProjects.map((p: { id: string }) => p.id)
  await prisma.$transaction([
    prisma.project.updateMany({
      where: { id: { in: ids } },
      data: { status: 'CLOSED' },
    }),
    prisma.projectStatusChange.createMany({
      data: ids.map((projectId) => ({
        projectId,
        previousStatus: 'APPROVED',
        currentStatus: 'CLOSED',
        source: 'SYSTEM',
        changedById: null,
      })),
    }),
  ])

  // Invalidate client sessions/share sessions so closed projects are immediately inaccessible
  await Promise.allSettled(
    ids.flatMap((projectId: string) => [
      invalidateShareTokensByProject(projectId),
      invalidateProjectSessions(projectId),
    ])
  )

  // Cancel any pending/waiting jobs for the closed projects
  await Promise.allSettled(
    ids.map((projectId: string) => cancelProjectJobs(projectId))
  )

  // Auto-delete previews and timeline sprites if the setting is enabled
  if (settings?.autoDeletePreviewsOnClose) {
    for (const projectId of ids) {
      try {
        // Get all video IDs for this project
        const videos = await prisma.video.findMany({
          where: { projectId },
          select: { id: true },
        })
        const videoIds = videos.map(v => v.id)

        // Find all preview, thumbnail, and timeline files via StoredFile registry
        const previewFilesToDelete = await findStoredFilesToDelete({
          entityType: 'VIDEO',
          entityIds: videoIds,
          fileRoles: ['PREVIEW_480', 'PREVIEW_720', 'PREVIEW_1080', 'THUMBNAIL', 'TIMELINE_VTT', 'TIMELINE_SPRITES'],
        })

        // Delete the physical files from storage
        if (previewFilesToDelete.length > 0) {
          await Promise.allSettled(previewFilesToDelete.map(f => {
            // TIMELINE_SPRITES is a directory — delete the whole prefix
            if (f.fileRole === 'TIMELINE_SPRITES') {
              return deleteDirectory(f.storagePath)
            }
            return deleteFile(f.storagePath)
          }))
        }

        // Clean up StoredFile rows for the deleted files
        if (videoIds.length > 0) {
          await deleteStoredFilesByCriteria({
            entityType: 'VIDEO',
            entityIds: videoIds,
            fileRoles: ['PREVIEW_480', 'PREVIEW_720', 'PREVIEW_1080', 'THUMBNAIL', 'TIMELINE_VTT', 'TIMELINE_SPRITES'],
          })
        }

        // StoredFile handles preview cleanup — legacy columns dropped

        console.log(`[AUTO-CLOSE] Deleted previews for project ${projectId}`)
      } catch (err) {
        console.error(`[AUTO-CLOSE] Error deleting previews for project ${projectId}:`, err)
      }
    }
  }

  console.log(`[AUTO-CLOSE] Closed ${ids.length} approved project(s)`)
  return { closedCount: ids.length }
}
