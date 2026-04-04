import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser, getCurrentUserFromRequest } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { contentSchema } from '@/lib/validation'
import { sendPushNotification } from '@/lib/push-notifications'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createCommentSchema = z.object({
  content: contentSchema,
  parentId: z.string().regex(/^c[a-z0-9]{24}$/).optional().nullable(),
})

function serializeComment(comment: any) {
  return {
    id: comment.id,
    cardId: comment.cardId,
    userId: comment.userId,
    parentId: comment.parentId,
    content: comment.content,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    authorName:
      comment?.user?.name ||
      comment?.user?.email ||
      comment?.authorNameSnapshot ||
      'Unknown',
    displayColor:
      comment?.user?.displayColor ||
      comment?.displayColorSnapshot ||
      null,
    avatarUrl: comment?.user?.avatarPath ? `/api/users/${comment.userId}/avatar` : null,
    replies: Array.isArray(comment.replies) ? comment.replies.map(serializeComment) : [],
  }
}

type RouteContext = { params: Promise<{ id: string }> }

// GET /api/kanban/cards/[id]/comments
export async function GET(request: NextRequest, context: RouteContext) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const { id: cardId } = await context.params

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests.' },
    'task-comments-list'
  )
  if (rateLimitResult) return rateLimitResult

  const card = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: { id: true },
  })
  if (!card) return NextResponse.json({ error: 'Card not found' }, { status: 404 })

  const comments = await prisma.kanbanCardComment.findMany({
    where: { cardId, parentId: null },
    include: {
      user: { select: { id: true, name: true, email: true, displayColor: true, avatarPath: true } },
      replies: {
        include: {
          user: { select: { id: true, name: true, email: true, displayColor: true, avatarPath: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  return NextResponse.json(comments.map(serializeComment))
}

// POST /api/kanban/cards/[id]/comments
export async function POST(request: NextRequest, context: RouteContext) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const { id: cardId } = await context.params

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests.' },
    'task-comment-create'
  )
  if (rateLimitResult) return rateLimitResult

  const currentUser = await getCurrentUserFromRequest(request)
  if (!currentUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const card = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: { id: true, title: true, projectId: true },
  })
  if (!card) return NextResponse.json({ error: 'Card not found' }, { status: 404 })

  const body = await request.json().catch(() => ({}))
  const parsed = createCommentSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.issues }, { status: 400 })
  }

  const parentId = parsed.data.parentId || null
  if (parentId) {
    const parent = await prisma.kanbanCardComment.findUnique({
      where: { id: parentId },
      select: { id: true, cardId: true, parentId: true },
    })
    if (!parent || parent.cardId !== cardId) {
      return NextResponse.json({ error: 'Invalid parent comment' }, { status: 400 })
    }
    if (parent.parentId) {
      return NextResponse.json({ error: 'Replies can only be made to the original comment' }, { status: 400 })
    }
  }

  const existingCount = await prisma.kanbanCardComment.count({ where: { cardId } })
  if (existingCount >= 500) {
    return NextResponse.json({ error: 'Maximum comments (500) reached for this card' }, { status: 400 })
  }

  const created = await prisma.kanbanCardComment.create({
    data: {
      cardId,
      userId: currentUser.id,
      authorNameSnapshot: currentUser.name || currentUser.email,
      displayColorSnapshot: (currentUser as any).displayColor || null,
      content: parsed.data.content,
      parentId,
    },
    include: {
      user: { select: { id: true, name: true, email: true, displayColor: true, avatarPath: true } },
      replies: {
        include: {
          user: { select: { id: true, name: true, email: true, displayColor: true, avatarPath: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  })

  // Queue for task-comment summary emails (sent by worker on admin schedule)
  try {
    await prisma.notificationQueue.create({
      data: {
        projectId: card.projectId || undefined,
        kanbanCardId: cardId,
        type: 'TASK_COMMENT',
        sentToClients: true, // Task comments are never client-facing
        data: {
          type: 'TASK_COMMENT',
          taskCommentId: created.id,
          cardId,
          cardTitle: card.title,
          authorName: currentUser.name || currentUser.email,
          authorEmail: currentUser.email,
          content: created.content,
          parentId,
        },
      },
    })
  } catch (e) {
    console.error('[TASK COMMENTS] Failed to queue notification:', e)
  }

  // Instant push notification to card members
  try {
    await sendPushNotification({
      type: 'TASK_COMMENT',
      projectId: card.projectId || undefined,
      kanbanCardId: cardId,
      title: 'New task comment',
      message: `New comment on task "${card.title}"`,
      details: {
        __meta: { authorUserId: currentUser.id, cardId },
        __link: { href: '/admin/projects' },
        'Task': card.title,
        'Author': currentUser.name || currentUser.email,
        'Comment': created.content.substring(0, 200) + (created.content.length > 200 ? '...' : ''),
      },
    })
  } catch (e) {
    console.warn('[TASK COMMENTS] Failed to send push notification:', e)
  }

  return NextResponse.json(serializeComment({ ...created, replies: created.replies || [] }))
}
