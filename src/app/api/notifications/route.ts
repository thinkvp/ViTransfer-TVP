import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { requireApiAdmin } from '@/lib/auth'
import { canSeeMenu } from '@/lib/rbac'
import { rateLimit } from '@/lib/rate-limit'

// Security/auth events (UNAUTHORIZED_OTP, FAILED_LOGIN, SUCCESSFUL_ADMIN_LOGIN,
// FAILED_SHARE_PASSWORD, SHARE_ACCESS, GUEST_VIDEO_LINK_ACCESS, PASSWORD_RESET_* etc.)
// are implicitly excluded for non-system-admin users because they are not in
// PROJECT_TYPES or SALES_TYPES — the positive-inclusion allow-list below.

// Notification types for users with Sales menu access
const SALES_TYPES = [
  'SALES_QUOTE_VIEWED',
  'SALES_QUOTE_ACCEPTED',
  'SALES_INVOICE_VIEWED',
  'SALES_INVOICE_PAID',
]

// Notification types for users with Projects menu access
const PROJECT_TYPES = [
  'CLIENT_COMMENT',
  'ADMIN_SHARE_COMMENT',
  'VIDEO_APPROVAL',
  'INTERNAL_COMMENT',
  'PROJECT_USER_ASSIGNED',
]

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const noStoreHeaders = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

/**
 * GET /api/notifications
 *
 * Returns push notification log entries for the current user.
 * System admins see all types. Other internal users see only notifications
 * relevant to their role permissions (project/sales events for assigned projects).
 *
 * Query params:
 * - limit: number (default 20, max 100)
 * - before: ISO datetime string (pagination cursor; returns items with sentAt < before)
 * - successOnly: 1|0 (default 1)
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Too many requests. Please slow down.',
    },
    'notifications-read'
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const { searchParams } = new URL(request.url)

    const limitRaw = searchParams.get('limit')
    const limit = Math.max(1, Math.min(100, Number(limitRaw || 20)))

    const beforeRaw = searchParams.get('before')
    const before = beforeRaw ? new Date(beforeRaw) : null
    const beforeValid = before && !Number.isNaN(before.getTime())

    const successOnly = (searchParams.get('successOnly') ?? '1') !== '0'

    // Base author filter: never show self-authored notifications
    const authorFilter = {
      OR: [
        { details: { path: ['__meta', 'authorUserId'], equals: Prisma.JsonNull } },
        { details: { path: ['__meta', 'authorUserId'], equals: Prisma.DbNull } },
        { details: { path: ['__meta', 'authorUserId'], not: authResult.id } },
      ],
    }

    const andConditions: any[] = [
      authorFilter,
      // PROJECT_USER_ASSIGNED is always scoped to the target user only
      {
        OR: [
          { type: { not: 'PROJECT_USER_ASSIGNED' } },
          { details: { path: ['__meta', 'targetUserId'], equals: authResult.id } },
        ],
      },
    ]

    let typeFilter: any = undefined // undefined = no type restriction (system admin sees all)

    if (!authResult.appRoleIsSystemAdmin) {
      const permissions = authResult.permissions
      // Sales access is gated on menu visibility (no per-doc assignment model).
      const hasSalesAccess = permissions ? canSeeMenu(permissions, 'sales') : false

      // Project notifications are gated on project *assignment*, not menu visibility.
      // A user may be assigned to projects without having the Projects menu in their role,
      // and they should still receive notifications for those projects.
      const assignedRows = await prisma.projectUser.findMany({
        where: { userId: authResult.id },
        select: { projectId: true },
      })
      const assignedProjectIds = assignedRows.map((r) => r.projectId)
      const hasAssignedProjects = assignedProjectIds.length > 0

      const allowedTypes: string[] = []
      if (hasAssignedProjects) allowedTypes.push(...PROJECT_TYPES)
      if (hasSalesAccess) allowedTypes.push(...SALES_TYPES)

      if (allowedTypes.length === 0) {
        // User has no assigned projects and no sales access
        const res = NextResponse.json({
          items: [],
          nextBefore: null,
          unreadCount: 0,
          lastSeenAt: null,
        })
        Object.entries(noStoreHeaders).forEach(([k, v]) => res.headers.set(k, v))
        return res
      }

      typeFilter = { in: allowedTypes }

      if (hasAssignedProjects) {
        // Project-related notifications: only show if in an assigned project.
        // Sales-related notifications: no per-project restriction.
        // Note: we intentionally exclude projectId: null here — project-type
        // events should always have a projectId; leaking null-projectId rows
        // to unassigned users would be incorrect.
        const projectScopeOrClauses: any[] = [
          {
            AND: [
              { type: { in: PROJECT_TYPES } },
              { projectId: { in: assignedProjectIds } },
            ],
          },
        ]
        if (hasSalesAccess) {
          projectScopeOrClauses.push({ type: { in: SALES_TYPES } })
        }
        andConditions.push({ OR: projectScopeOrClauses })
      }
    }

    // Base where clause — reused for both the main query and the unread count
    const baseWhere: any = {
      ...(successOnly ? { success: true } : {}),
      ...(typeFilter !== undefined ? { type: typeFilter } : {}),
      AND: andConditions,
    }

    const readState = await prisma.notificationReadState.findUnique({
      where: { userId: authResult.id },
      select: { lastSeenAt: true },
    })

    const rows = await prisma.pushNotificationLog.findMany({
      where: {
        ...baseWhere,
        ...(beforeValid ? { sentAt: { lt: before } } : {}),
      },
      orderBy: { sentAt: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        type: true,
        projectId: true,
        success: true,
        statusCode: true,
        message: true,
        details: true,
        sentAt: true,
      },
    })

    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    const nextBefore = hasMore ? items[items.length - 1]?.sentAt?.toISOString() : null

    // Unread badge count:
    // - If lastSeenAt exists, count newer notifications.
    // - If never opened (null/no row), fall back to current page size.
    const lastSeenAt = readState?.lastSeenAt || null
    let unreadCount = items.length
    if (lastSeenAt) {
      unreadCount = await prisma.pushNotificationLog.count({
        where: {
          ...baseWhere,
          sentAt: { gt: lastSeenAt },
        },
      })
    }

    const response = NextResponse.json({
      items,
      nextBefore,
      unreadCount,
      lastSeenAt: lastSeenAt ? lastSeenAt.toISOString() : null,
    })
    Object.entries(noStoreHeaders).forEach(([k, v]) => response.headers.set(k, v))
    return response
  } catch (error) {
    console.error('Error fetching notifications:', error)
    return NextResponse.json({ error: 'Failed to fetch notifications' }, { status: 500, headers: noStoreHeaders })
  }
}

/**
 * POST /api/notifications
 *
 * Mark notifications as seen by setting the per-user lastSeenAt.
 * Available to all authenticated internal users.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }

  try {
    const body = await request.json().catch(() => ({}))
    const lastSeenAtRaw = typeof body?.lastSeenAt === 'string' ? body.lastSeenAt : null
    const lastSeenAt = lastSeenAtRaw ? new Date(lastSeenAtRaw) : null

    if (!lastSeenAt || Number.isNaN(lastSeenAt.getTime())) {
      return NextResponse.json(
        { error: 'lastSeenAt must be a valid ISO date string' },
        { status: 400, headers: noStoreHeaders }
      )
    }

    await prisma.notificationReadState.upsert({
      where: { userId: authResult.id },
      create: { userId: authResult.id, lastSeenAt },
      update: { lastSeenAt },
    })

    const response = NextResponse.json({ success: true })
    Object.entries(noStoreHeaders).forEach(([k, v]) => response.headers.set(k, v))
    return response
  } catch (error) {
    console.error('Error updating notification read state:', error)
    return NextResponse.json({ error: 'Failed to update notification state' }, { status: 500, headers: noStoreHeaders })
  }
}
