import { NextRequest, NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * GET /api/kanban/cards/[id]/history
 * Returns history events for a kanban card.
 * Any authenticated user can view history (same access as viewing the card).
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const limited = await rateLimit(request, { maxRequests: 60, windowMs: 60_000 }, `kanban-history-${authResult.id}`)
  if (limited) return limited

  const { id } = await context.params

  const card = await prisma.kanbanCard.findUnique({
    where: { id },
    include: {
      members: { select: { userId: true } },
      project: { select: { assignedUsers: { select: { userId: true } } } },
    },
  })
  if (!card) {
    return NextResponse.json({ error: 'Card not found' }, { status: 404 })
  }

  // Non-admins must be a member or on the linked project to view
  const isAdmin = authResult.appRoleIsSystemAdmin === true
  if (!isAdmin) {
    const isMember = card.members.some((m) => m.userId === authResult.id)
    const isOnProject = card.project?.assignedUsers?.some((u) => u.userId === authResult.id) ?? false
    if (!isMember && !isOnProject) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const history = await prisma.kanbanCardHistory.findMany({
    where: { cardId: id },
    include: {
      actor: {
        select: { id: true, name: true, displayColor: true, avatarPath: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  return NextResponse.json({ history })
}
