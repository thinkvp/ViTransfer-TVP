import { NextRequest, NextResponse } from 'next/server'
import { requireApiSystemAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createColumnSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
})

/**
 * POST /api/kanban/columns
 * Create a new kanban column. Admin only.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiSystemAdmin(request)
  if (authResult instanceof Response) return authResult

  const body = await request.json().catch(() => null)
  const parsed = createColumnSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  // Get next position
  const maxPos = await prisma.kanbanColumn.aggregate({ _max: { position: true } })
  const nextPosition = (maxPos._max.position ?? -1) + 1

  const column = await prisma.kanbanColumn.create({
    data: {
      name: parsed.data.name,
      color: parsed.data.color ?? null,
      position: nextPosition,
    },
  })

  return NextResponse.json({ column }, { status: 201 })
}
