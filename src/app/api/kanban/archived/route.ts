import { NextRequest, NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/kanban/archived
 * Returns all archived kanban cards, newest first (admin only).
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  if (!authResult.appRoleIsSystemAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const limited = await rateLimit(request, { maxRequests: 30, windowMs: 60_000 }, 'kanban-archived')
  if (limited) return limited

  try {
  const cards = await prisma.kanbanCard.findMany({
    where: { archivedAt: { not: null } },
    orderBy: { archivedAt: 'desc' },
    include: {
      members: {
        include: {
          user: {
            select: { id: true, name: true, email: true, displayColor: true },
          },
        },
      },
      column: {
        select: { id: true, name: true, color: true, position: true },
      },
      project: {
        select: { id: true, title: true },
      },
      client: {
        select: { id: true, name: true },
      },
      createdBy: {
        select: { id: true, name: true, email: true },
      },
      _count: {
        select: { comments: true },
      },
    },
  })

  return NextResponse.json({ cards })
  } catch (error) {
    console.error('[KANBAN] Failed to fetch archived cards:', error)
    return NextResponse.json({ error: 'Failed to fetch archived cards' }, { status: 500 })
  }
}
