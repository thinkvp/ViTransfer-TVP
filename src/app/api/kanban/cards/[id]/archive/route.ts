import { NextRequest, NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * POST /api/kanban/cards/[id]/archive
 * Archives a kanban card (admin only).
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  if (!authResult.appRoleIsSystemAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id } = await context.params

  const card = await prisma.kanbanCard.findUnique({ where: { id } })
  if (!card) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  await prisma.kanbanCard.update({
    where: { id },
    data: { archivedAt: new Date() },
  })

  // Clear any pinned TASK_USER_ASSIGNED notifications for this card — it's no longer actionable.
  await prisma.pushNotificationLog.deleteMany({
    where: {
      type: 'TASK_USER_ASSIGNED',
      details: { path: ['__meta', 'cardId'], equals: id },
    },
  }).catch(() => {})

  return NextResponse.json({ ok: true })
}

/**
 * DELETE /api/kanban/cards/[id]/archive
 * Unarchives a kanban card, restoring it to its column (admin only).
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  if (!authResult.appRoleIsSystemAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id } = await context.params

  const card = await prisma.kanbanCard.findUnique({ where: { id } })
  if (!card) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Verify the column still exists; if not, move to the leftmost column
  let targetColumnId = card.columnId
  const column = await prisma.kanbanColumn.findUnique({ where: { id: card.columnId } })
  if (!column) {
    const firstColumn = await prisma.kanbanColumn.findFirst({ orderBy: { position: 'asc' } })
    if (!firstColumn) {
      return NextResponse.json({ error: 'No columns available to restore to' }, { status: 409 })
    }
    targetColumnId = firstColumn.id
  }

  // Place at the end of the target column
  const maxPos = await prisma.kanbanCard.aggregate({
    where: { columnId: targetColumnId, archivedAt: null },
    _max: { position: true },
  })
  const newPosition = (maxPos._max.position ?? -1) + 1

  await prisma.kanbanCard.update({
    where: { id },
    data: { archivedAt: null, columnId: targetColumnId, position: newPosition },
  })

  return NextResponse.json({ ok: true })
}
