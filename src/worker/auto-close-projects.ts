import { prisma } from '../lib/db'
import { invalidateProjectSessions, invalidateShareTokensByProject } from '../lib/session-invalidation'
import { cancelProjectJobs } from '../lib/cancel-project-jobs'
import { deleteProjectPreviews } from '../lib/delete-project-previews'

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

  // Auto-delete the heavy playable renditions if the setting is enabled (shared
  // close-path logic — see deleteProjectPreviews for what is shed vs. kept).
  if (settings?.autoDeletePreviewsOnClose) {
    for (const projectId of ids) {
      try {
        await deleteProjectPreviews(projectId, { logPrefix: 'AUTO-CLOSE' })
        console.log(`[AUTO-CLOSE] Deleted previews for project ${projectId}`)
      } catch (err) {
        console.error(`[AUTO-CLOSE] Error deleting previews for project ${projectId}:`, err)
      }
    }
  }

  console.log(`[AUTO-CLOSE] Closed ${ids.length} approved project(s)`)
  return { closedCount: ids.length }
}
