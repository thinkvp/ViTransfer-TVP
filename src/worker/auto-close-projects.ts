import { prisma } from '../lib/db'
import { deleteFile, deleteDirectory } from '../lib/storage'
import { invalidateProjectSessions, invalidateShareTokensByProject } from '../lib/session-invalidation'
import { getAlbumZipStoragePath, AlbumZipVariant } from '../lib/album-photo-zip'
import { cancelProjectJobs } from '../lib/cancel-project-jobs'

export async function processAutoCloseApprovedProjects(): Promise<{ closedCount: number }> {
  const settings = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: {
      autoCloseApprovedProjectsEnabled: true,
      autoCloseApprovedProjectsAfterDays: true,
      autoDeletePreviewsOnClose: true,
      autoDeleteAlbumZipsOnClose: true,
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
        const videos = await prisma.video.findMany({
          where: { projectId },
          select: {
            id: true,
            preview480Path: true,
            preview720Path: true,
            preview1080Path: true,
            timelinePreviewSpritesPath: true,
            timelinePreviewsReady: true,
          },
        })

        for (const video of videos) {
          const previewPaths = [video.preview480Path, video.preview720Path, video.preview1080Path].filter(Boolean) as string[]
          const updateData: Record<string, null | boolean> = {}

          if (previewPaths.length > 0) {
            await Promise.allSettled(previewPaths.map(p => deleteFile(p)))
            updateData.preview480Path = null
            updateData.preview720Path = null
            updateData.preview1080Path = null
          }

          if (video.timelinePreviewSpritesPath) {
            await deleteDirectory(video.timelinePreviewSpritesPath).catch(() => {})
            updateData.timelinePreviewsReady = false
            updateData.timelinePreviewVttPath = null
            updateData.timelinePreviewSpritesPath = null
          }

          if (Object.keys(updateData).length > 0) {
            await prisma.video.update({
              where: { id: video.id },
              data: updateData,
            })
          }
        }
        console.log(`[AUTO-CLOSE] Deleted previews and timeline sprites for project ${projectId}`)
      } catch (err) {
        console.error(`[AUTO-CLOSE] Error deleting previews for project ${projectId}:`, err)
      }
    }
  }

  // Auto-delete album ZIPs if the setting is enabled
  if (settings?.autoDeleteAlbumZipsOnClose) {
    for (const projectId of ids) {
      try {
        const albums = await prisma.album.findMany({
          where: { projectId },
          select: { id: true, fullZipFileSize: true, socialZipFileSize: true },
        })

        for (const album of albums) {
          const variants: AlbumZipVariant[] = ['full', 'social']
          for (const variant of variants) {
            const zipPath = getAlbumZipStoragePath({ projectId, albumId: album.id, variant })
            await deleteFile(zipPath).catch(() => {})
          }

          if (album.fullZipFileSize > 0 || album.socialZipFileSize > 0) {
            await prisma.album.update({
              where: { id: album.id },
              data: { fullZipFileSize: BigInt(0), socialZipFileSize: BigInt(0) },
            })
          }
        }
        console.log(`[AUTO-CLOSE] Deleted album ZIPs for project ${projectId}`)
      } catch (err) {
        console.error(`[AUTO-CLOSE] Error deleting album ZIPs for project ${projectId}:`, err)
      }
    }
  }

  console.log(`[AUTO-CLOSE] Closed ${ids.length} approved project(s)`)
  return { closedCount: ids.length }
}
