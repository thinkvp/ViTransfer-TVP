import { prisma } from '../lib/db'
import { invalidateProjectSessions, invalidateShareTokensByProject } from '../lib/session-invalidation'

export async function processAutoCloseApprovedProjects(): Promise<{ closedCount: number }> {
  const settings = await prisma.settings.findUnique({
    where: { id: 'default' },
    select: {
      autoCloseApprovedProjectsEnabled: true,
      autoCloseApprovedProjectsAfterDays: true,
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
  await prisma.project.updateMany({
    where: { id: { in: ids } },
    data: { status: 'CLOSED' },
  })

  // Invalidate client sessions/share sessions so closed projects are immediately inaccessible
  await Promise.allSettled(
    ids.flatMap((projectId: string) => [
      invalidateShareTokensByProject(projectId),
      invalidateProjectSessions(projectId),
    ])
  )

  console.log(`[AUTO-CLOSE] Closed ${ids.length} approved project(s)`)
  return { closedCount: ids.length }
}
