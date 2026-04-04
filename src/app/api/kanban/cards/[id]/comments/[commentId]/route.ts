import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string; commentId: string }> }

// DELETE /api/kanban/cards/[id]/comments/[commentId]
export async function DELETE(request: NextRequest, context: RouteContext) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const { id: cardId, commentId } = await context.params
  const isAdmin = authResult.appRoleIsSystemAdmin === true

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests.' },
    'task-comment-delete'
  )
  if (rateLimitResult) return rateLimitResult

  const comment = await prisma.kanbanCardComment.findUnique({
    where: { id: commentId },
    select: { id: true, cardId: true, userId: true },
  })
  if (!comment || comment.cardId !== cardId) {
    return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
  }

  // Allow system admins or the comment author to delete
  if (!isAdmin && comment.userId !== authResult.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  await prisma.kanbanCardComment.delete({ where: { id: commentId } })

  return NextResponse.json({ ok: true })
}
