import { ProjectStatus, ProjectStatusChangeSource } from '@prisma/client'

import { prisma } from '../lib/db'

function isoDateTodayLocal(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function hhmmNowLocal(): string {
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function endOfTodayLocal(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
}

export async function processAutoStartProjectsOnShootingKeyDate(): Promise<{ startedCount: number }> {
  const today = isoDateTodayLocal()
  const nowTime = hhmmNowLocal()
  const todayEnd = endOfTodayLocal()

  // Two independent promotion triggers:
  // 1. startDate is due (today or earlier)
  // 2. SHOOTING key date has started
  const [dueByStartDate, dueByShootingDate] = await Promise.all([
    prisma.project.findMany({
      where: {
        status: ProjectStatus.NOT_STARTED,
        startDate: { lte: todayEnd },
      },
      select: { id: true, status: true, title: true },
    }),
    prisma.project.findMany({
      where: {
        status: ProjectStatus.NOT_STARTED,
        keyDates: {
          some: {
            type: 'SHOOTING',
            OR: [
              { date: { lt: today } },
              { date: today, allDay: true },
              { date: today, allDay: false, startTime: { not: null, lte: nowTime } },
            ],
          },
        },
      },
      select: { id: true, status: true, title: true },
    }),
  ])

  // Merge and deduplicate
  const byId = new Map<string, { id: string; status: ProjectStatus; title: string }>()
  for (const p of [...dueByStartDate, ...dueByShootingDate]) byId.set(p.id, p)
  const due = Array.from(byId.values())

  if (due.length === 0) return { startedCount: 0 }

  const ids = due.map((p) => p.id)

  await prisma.$transaction([
    prisma.project.updateMany({
      where: { id: { in: ids }, status: ProjectStatus.NOT_STARTED },
      data: { status: ProjectStatus.IN_PROGRESS },
    }),
    prisma.projectStatusChange.createMany({
      data: due.map((p) => ({
        projectId: p.id,
        previousStatus: p.status,
        currentStatus: ProjectStatus.IN_PROGRESS,
        source: ProjectStatusChangeSource.SYSTEM,
        changedById: null,
      })),
    }),
  ])

  console.log(`[AUTO-START] Promoted ${ids.length} project(s) to IN_PROGRESS based on Start Date / SHOOTING key dates`, {
    today,
    nowTime,
  })

  return { startedCount: ids.length }
}
