import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getUserPermissions, requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function isoDateTodayUtc(): string {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// GET /api/projects/key-dates - list key dates across all visible projects (internal)
export async function GET(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'projects')
  if (forbidden) return forbidden

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-projects-key-dates-list'
  )
  if (rateLimitResult) return rateLimitResult

  // Apply same visibility logic as /api/projects
  const permissions = getUserPermissions(authResult)
  const statuses = permissions.projectVisibility.statuses
  const isSystemAdmin = authResult.appRoleIsSystemAdmin === true

  if (!Array.isArray(statuses) || statuses.length === 0) {
    const response = NextResponse.json({ keyDates: [], today: isoDateTodayUtc() })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  }

  const rows = await prisma.projectKeyDate.findMany({
    where: {
      project: {
        status: { in: statuses as any },
        ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId: authResult.id } } }),
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
      project: {
        select: {
          title: true,
          companyName: true,
        },
      },
    },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }, { createdAt: 'asc' }],
  })

  const personalRows = await prisma.userKeyDate.findMany({
    where: { userId: authResult.id },
    select: {
      id: true,
      date: true,
      allDay: true,
      startTime: true,
      finishTime: true,
      title: true,
      notes: true,
    },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }, { createdAt: 'asc' }],
  })

  const response = NextResponse.json({ keyDates: rows, personalKeyDates: personalRows, today: isoDateTodayUtc() })
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Pragma', 'no-cache')
  return response
}
