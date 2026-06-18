import { prisma } from '../lib/db'
import { deleteFile } from '../lib/storage'
import { invalidateProjectSessions, invalidateShareTokensByProject } from '../lib/session-invalidation'
import { cancelProjectJobs } from '../lib/cancel-project-jobs'
import { findStoredFilesToDelete, deleteStoredFilesByCriteria } from '../lib/stored-file'
import { recalculateAndStoreProjectDiskBytes, recalculateAndStoreProjectPreviewBytes, recalculateAndStoreProjectTotalBytes } from '../lib/project-total-bytes'

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

  // Auto-delete the heavy playable renditions if the setting is enabled. We only
  // shed video 480/720/1080 previews and the video-asset playback MP4, keeping
  // everything needed to still browse the FILES area after close (video THUMBNAIL,
  // timeline sprites/VTT, and the video-asset still image PREVIEW_IMAGE).
  if (settings?.autoDeletePreviewsOnClose) {
    const VIDEO_PREVIEW_ROLES = ['PREVIEW_480', 'PREVIEW_720', 'PREVIEW_1080'] as const
    const ASSET_PREVIEW_ROLES = ['PREVIEW_MP4'] as const
    for (const projectId of ids) {
      try {
        // Get all video IDs (and their asset IDs) for this project
        const videos = await prisma.video.findMany({
          where: { projectId },
          select: { id: true },
        })
        const videoIds = videos.map(v => v.id)
        const videoAssetIds = (await prisma.videoAsset.findMany({
          where: { video: { projectId } },
          select: { id: true },
        })).map(a => a.id)

        // Resolve preview file paths via the StoredFile registry
        const [videoFiles, assetFiles] = await Promise.all([
          videoIds.length > 0
            ? findStoredFilesToDelete({ entityType: 'VIDEO', entityIds: videoIds, fileRoles: [...VIDEO_PREVIEW_ROLES] })
            : [],
          videoAssetIds.length > 0
            ? findStoredFilesToDelete({ entityType: 'VIDEO_ASSET', entityIds: videoAssetIds, fileRoles: [...ASSET_PREVIEW_ROLES] })
            : [],
        ])

        // Delete the physical files from storage (no directory roles in this set)
        const filesToDelete = [...videoFiles, ...assetFiles]
        if (filesToDelete.length > 0) {
          await Promise.allSettled(filesToDelete.map(f => deleteFile(f.storagePath)))
        }

        // Clean up StoredFile rows for the deleted files
        if (videoIds.length > 0) {
          await deleteStoredFilesByCriteria({ entityType: 'VIDEO', entityIds: videoIds, fileRoles: [...VIDEO_PREVIEW_ROLES] })
        }
        if (videoAssetIds.length > 0) {
          await deleteStoredFilesByCriteria({ entityType: 'VIDEO_ASSET', entityIds: videoAssetIds, fileRoles: [...ASSET_PREVIEW_ROLES] })
        }

        // Refresh precomputed storage totals so freed space shows up immediately
        // instead of waiting for the daily reconcile job.
        await Promise.allSettled([
          recalculateAndStoreProjectTotalBytes(projectId),
          recalculateAndStoreProjectPreviewBytes(projectId),
          recalculateAndStoreProjectDiskBytes(projectId),
        ])

        console.log(`[AUTO-CLOSE] Deleted previews for project ${projectId}`)
      } catch (err) {
        console.error(`[AUTO-CLOSE] Error deleting previews for project ${projectId}:`, err)
      }
    }
  }

  console.log(`[AUTO-CLOSE] Closed ${ids.length} approved project(s)`)
  return { closedCount: ids.length }
}
