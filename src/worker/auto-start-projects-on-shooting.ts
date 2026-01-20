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

export async function processAutoStartProjectsOnShootingKeyDate(): Promise<{ startedCount: number }> {
  const today = isoDateTodayLocal()
  const nowTime = hhmmNowLocal()

  // Promote projects when the SHOOTING key date has started.
  // - allDay: any time on that date
  // - timed: next check after startTime
  // Uses server/container local time (see TZ env var) to match other key-date logic.
  const due = await prisma.project.findMany({
    where: {
      status: 'NOT_STARTED',
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
  })

  if (due.length === 0) return { startedCount: 0 }

  const ids = due.map((p) => p.id)

  await prisma.$transaction([
    prisma.project.updateMany({
      where: { id: { in: ids }, status: 'NOT_STARTED' },
      data: { status: 'IN_PROGRESS' },
    }),
    prisma.projectStatusChange.createMany({
      data: due.map((p) => ({
        projectId: p.id,
        previousStatus: 'NOT_STARTED' as any,
        currentStatus: 'IN_PROGRESS' as any,
        source: 'SYSTEM' as any,
        changedById: null,
      })),
    }),
  ])

  console.log(`[AUTO-START] Promoted ${ids.length} project(s) to IN_PROGRESS based on SHOOTING key dates`, {
    today,
    nowTime,
  })

  return { startedCount: ids.length }
}
