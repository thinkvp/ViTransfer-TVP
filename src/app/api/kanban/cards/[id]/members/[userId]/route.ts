import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { z } from 'zod'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  receiveNotifications: z.boolean(),
})

type RouteContext = { params: Promise<{ id: string; userId: string }> }

// PATCH /api/kanban/cards/[id]/members/[userId]
export async function PATCH(request: NextRequest, context: RouteContext) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const { id: cardId, userId } = await context.params

  const body = await request.json().catch(() => null)
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  const limited = await rateLimit(request, { maxRequests: 30, windowMs: 60_000 }, 'kanban-members')
  if (limited) return limited

  try {
  const member = await prisma.kanbanCardMember.findUnique({
    where: { cardId_userId: { cardId, userId } },
  })
  if (!member) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 })
  }

  await prisma.kanbanCardMember.update({
    where: { cardId_userId: { cardId, userId } },
    data: { receiveNotifications: parsed.data.receiveNotifications },
  })

  return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[KANBAN] Failed to update card member:', error)
    return NextResponse.json({ error: 'Failed to update member' }, { status: 500 })
  }
}
