import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(request, { windowMs: 60 * 1000, maxRequests: 10 })
  if (rateLimitResult) return rateLimitResult

  const body = await request.json().catch(() => ({}))
  const dryRun = body.dryRun !== false

  try {
    // Find all rows where either side has never been sent
    const pending = await prisma.notificationQueue.findMany({
      where: {
        OR: [
          { sentToClients: false, clientFailed: false },
          { sentToAdmins: false, adminFailed: false },
        ],
      },
      select: {
        id: true,
        createdAt: true,
        projectId: true,
        type: true,
        sentToClients: true,
        sentToAdmins: true,
      },
      orderBy: { createdAt: 'asc' },
    })

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const stale = pending.filter(r => r.createdAt < sevenDaysAgo)
    const recent = pending.filter(r => r.createdAt >= sevenDaysAgo)

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        totalUnsent: pending.length,
        staleCount: stale.length,
        recentCount: recent.length,
        oldestCreatedAt: pending[0]?.createdAt ?? null,
      })
    }

    // Mark all unsent stale rows as dismissed on both sides
    const now = new Date()
    const result = await prisma.notificationQueue.updateMany({
      where: {
        id: { in: stale.map(r => r.id) },
      },
      data: {
        sentToClients: true,
        sentToAdmins: true,
        clientSentAt: now,
        adminSentAt: now,
      },
    })

    return NextResponse.json({
      ok: true,
      dryRun: false,
      dismissed: result.count,
      recentCount: recent.length,
    })
  } catch (err: any) {
    console.error('[purge-notification-backlog]', err)
    return NextResponse.json({ error: err?.message || 'Unknown error' }, { status: 500 })
  }
}
