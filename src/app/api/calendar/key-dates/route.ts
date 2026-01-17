import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getUserPermissions } from '@/lib/rbac-api'
import { icsJoinLines, icsProperty, icsTextProperty } from '@/lib/ics'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function getCalendarTimeZone(): string {
  // Google Calendar subscriptions can default to GMT if the feed doesn't specify a timezone.
  // Prefer an explicit tz; allow deployments to override.
  return (
    process.env.VITRANSFER_ICS_TIMEZONE ||
    process.env.TZ ||
    'Australia/Brisbane'
  ).trim() || 'Australia/Brisbane'
}

function maybeBrisbaneVTimeZoneBlock(tz: string): string[] {
  if (tz !== 'Australia/Brisbane') return []
  // Brisbane has no DST; a minimal VTIMEZONE block is sufficient.
  return [
    'BEGIN:VTIMEZONE',
    'TZID:Australia/Brisbane',
    'X-LIC-LOCATION:Australia/Brisbane',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+1000',
    'TZOFFSETTO:+1000',
    'TZNAME:AEST',
    'DTSTART:19700101T000000',
    'END:STANDARD',
    'END:VTIMEZONE',
  ]
}

function isoDateTodayLocal(): string {
  // Use the server/container local timezone (controlled via TZ env var).
  // Using UTC here can show "yesterday" for deployments ahead of UTC.
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
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
  if (!token) return new NextResponse('Not found', { status: 404 })

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'calendar-key-dates-ics'
  )
  if (rateLimitResult) return rateLimitResult

  const user = await prisma.user.findFirst({
    where: { calendarFeedToken: token },
    select: {
      id: true,
      appRole: { select: { isSystemAdmin: true, permissions: true } },
    },
  })

  if (!user) {
    // Avoid leaking whether a token exists.
    return new NextResponse('Not found', { status: 404 })
  }

  const permissions = getUserPermissions({ permissions: user.appRole?.permissions } as any)
  const statuses = permissions.projectVisibility.statuses
  const isSystemAdmin = user.appRole?.isSystemAdmin === true

  const today = isoDateTodayLocal()
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

  const personalRows = await (prisma as any).userKeyDate.findMany({
    where: {
      userId: user.id,
      date: { gte: today, lte: end },
    },
    select: {
      id: true,
      date: true,
      allDay: true,
      startTime: true,
      finishTime: true,
      title: true,
      notes: true,
      updatedAt: true,
    },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }, { createdAt: 'asc' }],
  })

  const now = new Date()
  const dtstamp = formatDtstampUtc(now)
  const tz = getCalendarTimeZone()
  const calLines: string[] = []

  calLines.push('BEGIN:VCALENDAR')
  calLines.push(icsProperty('VERSION', '2.0'))
  calLines.push(icsProperty('PRODID', '-//ViTransfer//Key Dates//EN'))
  calLines.push(icsProperty('CALSCALE', 'GREGORIAN'))
  calLines.push(icsProperty('METHOD', 'PUBLISH'))
  calLines.push(icsProperty('X-WR-CALNAME', 'ViTransfer Key Dates'))
  calLines.push(icsProperty('X-WR-TIMEZONE', tz))
  calLines.push(...maybeBrisbaneVTimeZoneBlock(tz))

  for (const k of rows) {
    const projectLabel = k.project.companyName || k.project.title
    const summary = `${projectLabel}: ${typeLabel(k.type)}`

    calLines.push('BEGIN:VEVENT')
    calLines.push(icsProperty('UID', `${k.id}@vitransfer`))
    calLines.push(icsProperty('DTSTAMP', dtstamp))
    calLines.push(icsProperty('LAST-MODIFIED', formatDtstampUtc(k.updatedAt)))
    const summaryProp = icsTextProperty('SUMMARY', summary)
    if (summaryProp) calLines.push(summaryProp)
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
      calLines.push(icsProperty(`DTSTART;TZID=${tz}`, start))

      if (k.finishTime) {
        const endDt = `${ymdToCompact(k.date)}T${hhmmToCompact(k.finishTime)}00`
        calLines.push(icsProperty(`DTEND;TZID=${tz}`, endDt))
      } else {
        calLines.push(icsProperty('DURATION', 'PT1H'))
      }
    }

    calLines.push('END:VEVENT')
  }

  for (const k of personalRows) {
    const summary = `Personal: ${k.title}`

    calLines.push('BEGIN:VEVENT')
    calLines.push(icsProperty('UID', `${k.id}@vitransfer-personal`))
    calLines.push(icsProperty('DTSTAMP', dtstamp))
    calLines.push(icsProperty('LAST-MODIFIED', formatDtstampUtc(k.updatedAt)))
    const summaryProp = icsTextProperty('SUMMARY', summary)
    if (summaryProp) calLines.push(summaryProp)
    const desc = icsTextProperty('DESCRIPTION', k.notes)
    if (desc) calLines.push(desc)

    const isTimed = k.allDay !== true && !!k.startTime
    if (!isTimed) {
      const start = ymdToCompact(k.date)
      const endExclusive = ymdToCompact(nextDayYmdUtc(k.date))
      calLines.push(icsProperty('DTSTART;VALUE=DATE', start))
      calLines.push(icsProperty('DTEND;VALUE=DATE', endExclusive))
    } else {
      const start = `${ymdToCompact(k.date)}T${hhmmToCompact(k.startTime)}00`
      calLines.push(icsProperty(`DTSTART;TZID=${tz}`, start))

      if (k.finishTime) {
        const endDt = `${ymdToCompact(k.date)}T${hhmmToCompact(k.finishTime)}00`
        calLines.push(icsProperty(`DTEND;TZID=${tz}`, endDt))
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
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    },
  })

  return response
}
