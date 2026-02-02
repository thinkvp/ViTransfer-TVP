import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiSystemAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const noStoreHeaders = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

/**
 * GET /api/notifications
 *
 * Returns recent push notification logs (the same events that would be sent to Gotify).
 * ADMIN ONLY.
 *
 * Query params:
 * - limit: number (default 20, max 100)
 * - before: ISO datetime string (pagination cursor; returns items with sentAt < before)
 * - successOnly: 1|0 (default 1)
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiSystemAdmin(request)
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

    const where: any = {}
    if (successOnly) where.success = true
    if (beforeValid) {
      where.sentAt = { lt: before }
    }

    const readState = await prisma.notificationReadState.findUnique({
      where: { userId: authResult.id },
      select: { lastSeenAt: true },
    })

    const rows = await prisma.pushNotificationLog.findMany({
      where,
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
          ...(successOnly ? { success: true } : {}),
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
 * ADMIN ONLY.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiSystemAdmin(request)
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
