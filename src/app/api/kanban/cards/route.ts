import { NextRequest, NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { sendPushNotification } from '@/lib/push-notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createCardSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional().nullable(),
  columnId: z.string().min(1),
  projectId: z.string().optional().nullable(),
  memberIds: z.array(z.string()).optional(),
  dueDate: z.string().datetime().optional().nullable(),
})

const cardInclude = {
  members: {
    include: {
      user: {
        select: { id: true, name: true, email: true, displayColor: true, avatarPath: true },
      },
    },
  },
  project: {
    select: { id: true, title: true },
  },
  createdBy: {
    select: { id: true, name: true, email: true },
  },
} as const

/**
 * POST /api/kanban/cards
 * Create a new kanban card. Any authenticated user can create cards.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const body = await request.json().catch(() => null)
  const parsed = createCardSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  // Validate column exists
  const column = await prisma.kanbanColumn.findUnique({ where: { id: parsed.data.columnId } })
  if (!column) {
    return NextResponse.json({ error: 'Column not found' }, { status: 404 })
  }

  // Validate project exists if provided
  if (parsed.data.projectId) {
    const project = await prisma.project.findUnique({ where: { id: parsed.data.projectId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
  }

  // Get next position in the column
  const maxPos = await prisma.kanbanCard.aggregate({
    where: { columnId: parsed.data.columnId },
    _max: { position: true },
  })
  const nextPosition = (maxPos._max.position ?? -1) + 1

  const memberIds = parsed.data.memberIds || []

  const card = await prisma.kanbanCard.create({
    data: {
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      columnId: parsed.data.columnId,
      projectId: parsed.data.projectId ?? null,
      createdById: authResult.id,
      dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
      position: nextPosition,
      ...(memberIds.length > 0
        ? { members: { create: memberIds.map((userId) => ({ userId })) } }
        : {}),
    },
    include: cardInclude,
  })

  // Log creation history event
  const memberUsers = memberIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true } })
    : []
  await prisma.kanbanCardHistory.create({
    data: {
      cardId: card.id,
      actorId: authResult.id,
      actorNameSnapshot: authResult.name ?? authResult.email,
      action: 'CREATED',
      payload: {
        title: card.title,
        columnName: column?.name ?? 'Unknown',
        memberNames: memberUsers.map((u) => u.name ?? u.id),
      },
    },
  })

  // Fire TASK_USER_ASSIGNED notifications for initial members (excluding the creator)
  const membersToNotify = memberIds.filter((uid) => uid !== authResult.id)
  if (membersToNotify.length > 0) {
    const assignedUsers = await prisma.user.findMany({
      where: { id: { in: membersToNotify } },
      select: { id: true, appRole: { select: { isSystemAdmin: true } } },
    })
    const usersToNotify = assignedUsers.filter((u) => u.appRole?.isSystemAdmin !== true)
    await Promise.allSettled(
      usersToNotify.map(async (u) => {
        await sendPushNotification({
          type: 'TASK_USER_ASSIGNED',
          title: 'Task Assignment',
          message: `You have been added to Task: "${card.title}"`,
          kanbanCardId: card.id,
          projectId: card.project?.id ?? undefined,
          projectName: card.project?.title ?? undefined,
          details: {
            __controls: { pinned: true, clearable: true, manualClearRequired: true },
            __meta: { targetUserId: u.id, authorUserId: authResult.id, cardId: card.id, taskTitle: card.title },
          },
        }).catch(() => {})
      })
    )
  }

  return NextResponse.json({ card }, { status: 201 })
}
