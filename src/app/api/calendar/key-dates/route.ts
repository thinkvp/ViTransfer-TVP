import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getUserPermissions } from '@/lib/rbac-api'
import { icsJoinLines, icsProperty, icsTextProperty } from '@/lib/ics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function isoDateTodayUtc(): string {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function addMonthsUtc(ymd: string, months: number): string {
  const [y, m, d] = ymd.split('-').map((n) => Number(n))
  const dt = new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1))
  dt.setUTCMonth(dt.getUTCMonth() + months)
  const yy = dt.getUTCFullYear()
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

function ymdToCompact(ymd: string): string {
  return ymd.replaceAll('-', '')
}

function nextDayYmdUtc(ymd: string): string {
  const [y, m, d] = ymd.split('-').map((n) => Number(n))
  const dt = new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1))
  dt.setUTCDate(dt.getUTCDate() + 1)
  const yy = dt.getUTCFullYear()
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

function hhmmToCompact(time: string): string {
  return time.replace(':', '')
}

function formatDtstampUtc(dt: Date): string {
  const y = dt.getUTCFullYear()
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const d = String(dt.getUTCDate()).padStart(2, '0')
  const hh = String(dt.getUTCHours()).padStart(2, '0')
  const mm = String(dt.getUTCMinutes()).padStart(2, '0')
  const ss = String(dt.getUTCSeconds()).padStart(2, '0')
  return `${y}${m}${d}T${hh}${mm}${ss}Z`
}

function typeLabel(type: string): string {
  return String(type)
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// GET /api/calendar/key-dates?token=... (ICS)
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')?.trim()
  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 })
  }

  const user = await prisma.user.findFirst({
    where: { calendarFeedToken: token },
    select: {
      id: true,
      appRole: { select: { isSystemAdmin: true, permissions: true } },
    },
  })

  if (!user) {
    // Avoid leaking whether a token exists.
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const permissions = getUserPermissions({ permissions: user.appRole?.permissions } as any)
  const statuses = permissions.projectVisibility.statuses
  const isSystemAdmin = user.appRole?.isSystemAdmin === true

  const today = isoDateTodayUtc()
  const end = addMonthsUtc(today, 12)

  const rows = Array.isArray(statuses) && statuses.length
    ? await prisma.projectKeyDate.findMany({
        where: {
          date: { gte: today, lte: end },
          project: {
            status: { in: statuses as any },
            ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId: user.id } } }),
          },
        },
        select: {
          id: true,
          projectId: true,
          date: true,
          allDay: true,
          startTime: true,
          finishTime: true,
          type: true,
          notes: true,
          updatedAt: true,
          project: { select: { title: true, companyName: true } },
        },
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }, { createdAt: 'asc' }],
      })
    : []

  const now = new Date()
  const dtstamp = formatDtstampUtc(now)
  const calLines: string[] = []

  calLines.push('BEGIN:VCALENDAR')
  calLines.push(icsProperty('VERSION', '2.0'))
  calLines.push(icsProperty('PRODID', '-//ViTransfer//Key Dates//EN'))
  calLines.push(icsProperty('CALSCALE', 'GREGORIAN'))
  calLines.push(icsProperty('METHOD', 'PUBLISH'))
  calLines.push(icsProperty('X-WR-CALNAME', 'ViTransfer Key Dates'))

  for (const k of rows) {
    const projectLabel = k.project.companyName || k.project.title
    const summary = `${projectLabel}: ${typeLabel(k.type)}`

    calLines.push('BEGIN:VEVENT')
    calLines.push(icsProperty('UID', `${k.id}@vitransfer`))
    calLines.push(icsProperty('DTSTAMP', dtstamp))
    calLines.push(icsProperty('LAST-MODIFIED', formatDtstampUtc(k.updatedAt)))
    calLines.push(icsProperty('SUMMARY', summary))
    const desc = icsTextProperty('DESCRIPTION', k.notes)
    if (desc) calLines.push(desc)

    const isTimed = k.allDay !== true && !!k.startTime
    if (!isTimed) {
      const start = ymdToCompact(k.date)
      const endExclusive = ymdToCompact(nextDayYmdUtc(k.date))
      calLines.push(icsProperty('DTSTART;VALUE=DATE', start))
      calLines.push(icsProperty('DTEND;VALUE=DATE', endExclusive))
    } else {
      const start = `${ymdToCompact(k.date)}T${hhmmToCompact(k.startTime!)}00`
      calLines.push(icsProperty('DTSTART', start))

      if (k.finishTime) {
        const endDt = `${ymdToCompact(k.date)}T${hhmmToCompact(k.finishTime)}00`
        calLines.push(icsProperty('DTEND', endDt))
      } else {
        calLines.push(icsProperty('DURATION', 'PT1H'))
      }
    }

    calLines.push('END:VEVENT')
  }

  calLines.push('END:VCALENDAR')

  const icsBody = icsJoinLines(calLines)

  const response = new NextResponse(icsBody, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="vitransfer-key-dates.ics"',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  })

  return response
}
