import { NextRequest, NextResponse } from 'next/server'
import { requireApiSystemAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateColumnSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
  position: z.number().int().min(0).optional(),
})

type RouteContext = { params: Promise<{ id: string }> }

/**
 * PATCH /api/kanban/columns/[id]
 * Update a kanban column (name, color, position). Admin only.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const authResult = await requireApiSystemAdmin(request)
  if (authResult instanceof Response) return authResult

  const { id } = await context.params

  const body = await request.json().catch(() => null)
  const parsed = updateColumnSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const existing = await prisma.kanbanColumn.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Column not found' }, { status: 404 })
  }

  // Handle position reorder
  if (parsed.data.position !== undefined && parsed.data.position !== existing.position) {
    const newPos = parsed.data.position
    const oldPos = existing.position

    if (newPos < oldPos) {
      // Moving up: shift columns in [newPos, oldPos) down by 1
      await prisma.kanbanColumn.updateMany({
        where: { position: { gte: newPos, lt: oldPos } },
        data: { position: { increment: 1 } },
      })
    } else {
      // Moving down: shift columns in (oldPos, newPos] up by 1
      await prisma.kanbanColumn.updateMany({
        where: { position: { gt: oldPos, lte: newPos } },
        data: { position: { decrement: 1 } },
      })
    }
  }

  const column = await prisma.kanbanColumn.update({
    where: { id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.color !== undefined ? { color: parsed.data.color } : {}),
      ...(parsed.data.position !== undefined ? { position: parsed.data.position } : {}),
    },
  })

  return NextResponse.json({ column })
}

/**
 * DELETE /api/kanban/columns/[id]
 * Delete a kanban column and all its cards. Admin only.
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const authResult = await requireApiSystemAdmin(request)
  if (authResult instanceof Response) return authResult

  const { id } = await context.params

  const existing = await prisma.kanbanColumn.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Column not found' }, { status: 404 })
  }

  await prisma.kanbanColumn.delete({ where: { id } })

  // Reorder remaining columns to fill the gap
  await prisma.kanbanColumn.updateMany({
    where: { position: { gt: existing.position } },
    data: { position: { decrement: 1 } },
  })

  return NextResponse.json({ success: true })
}
