import { NextRequest, NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { sendPushNotification } from '@/lib/push-notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateCardSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).optional().nullable(),
  columnId: z.string().optional(),
  position: z.number().int().min(0).optional(),
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

type RouteContext = { params: Promise<{ id: string }> }

/**
 * PATCH /api/kanban/cards/[id]
 * Update a kanban card (title, description, move to new column/position, etc.)
 * Admin can update any card. Non-admins can update cards they are a member of
 * or cards linked to projects they are assigned to.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const { id } = await context.params
  const isAdmin = authResult.appRoleIsSystemAdmin === true

  const body = await request.json().catch(() => null)
  const parsed = updateCardSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const existing = await prisma.kanbanCard.findUnique({
    where: { id },
    include: {
      members: { select: { userId: true } },
      project: {
        select: { id: true, title: true, assignedUsers: { select: { userId: true } } },
      },
    },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Card not found' }, { status: 404 })
  }

  // Non-admins: check they can see this card
  if (!isAdmin) {
    const isMember = existing.members.some((m) => m.userId === authResult.id)
    const isOnProject = existing.project?.assignedUsers?.some((u) => u.userId === authResult.id) ?? false
    if (!isMember && !isOnProject) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  // Validate new column if changing, and capture name for history
  let newColumn: { id: string; name: string } | null = null
  if (parsed.data.columnId && parsed.data.columnId !== existing.columnId) {
    newColumn = await prisma.kanbanColumn.findUnique({ where: { id: parsed.data.columnId } })
    if (!newColumn) {
      return NextResponse.json({ error: 'Column not found' }, { status: 404 })
    }
  }

  // Validate project if provided, and capture name for history
  let newProject: { id: string; title: string } | null = null
  if (parsed.data.projectId !== undefined && parsed.data.projectId !== null) {
    newProject = await prisma.project.findUnique({ where: { id: parsed.data.projectId }, select: { id: true, title: true } })
    if (!newProject) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
  }

  const targetColumnId = parsed.data.columnId ?? existing.columnId
  const isMovingColumn = targetColumnId !== existing.columnId

  // Handle position reordering
  if (isMovingColumn) {
    // Remove from old column: shift cards down
    await prisma.kanbanCard.updateMany({
      where: { columnId: existing.columnId, position: { gt: existing.position } },
      data: { position: { decrement: 1 } },
    })

    // If position not specified, append to end of new column
    if (parsed.data.position === undefined) {
      const maxPos = await prisma.kanbanCard.aggregate({
        where: { columnId: targetColumnId },
        _max: { position: true },
      })
      parsed.data.position = (maxPos._max.position ?? -1) + 1
    }

    // Make room in new column
    await prisma.kanbanCard.updateMany({
      where: { columnId: targetColumnId, position: { gte: parsed.data.position } },
      data: { position: { increment: 1 } },
    })
  } else if (parsed.data.position !== undefined && parsed.data.position !== existing.position) {
    // Same column reorder
    const newPos = parsed.data.position
    const oldPos = existing.position

    if (newPos < oldPos) {
      await prisma.kanbanCard.updateMany({
        where: {
          columnId: existing.columnId,
          id: { not: id },
          position: { gte: newPos, lt: oldPos },
        },
        data: { position: { increment: 1 } },
      })
    } else {
      await prisma.kanbanCard.updateMany({
        where: {
          columnId: existing.columnId,
          id: { not: id },
          position: { gt: oldPos, lte: newPos },
        },
        data: { position: { decrement: 1 } },
      })
    }
  }

  // Sync members if provided — preserve receiveNotifications for existing members
  let memberSync = {}
  let addedMemberIds: string[] = []
  let removedMemberIds: string[] = []
  if (parsed.data.memberIds !== undefined) {
    const existingMembers = await prisma.kanbanCardMember.findMany({
      where: { cardId: id },
      select: { userId: true, receiveNotifications: true },
    })
    const existingMap = new Map(existingMembers.map((m) => [m.userId, m.receiveNotifications]))
    const oldMemberIdSet = new Set(existingMembers.map((m) => m.userId))
    const newMemberIdSet = new Set(parsed.data.memberIds)
    addedMemberIds = parsed.data.memberIds.filter((uid) => !oldMemberIdSet.has(uid) && uid !== authResult.id)
    removedMemberIds = [...oldMemberIdSet].filter((uid) => !newMemberIdSet.has(uid))
    memberSync = {
      members: {
        deleteMany: {},
        create: parsed.data.memberIds.map((userId) => ({
          userId,
          receiveNotifications: existingMap.get(userId) ?? true,
        })),
      },
    }
  }

  const card = await prisma.kanbanCard.update({
    where: { id },
    data: {
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(parsed.data.columnId !== undefined ? { columnId: parsed.data.columnId } : {}),
      ...(parsed.data.position !== undefined ? { position: parsed.data.position } : {}),
      ...(parsed.data.projectId !== undefined ? { projectId: parsed.data.projectId } : {}),
      ...(parsed.data.dueDate !== undefined
        ? { dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null }
        : {}),
      ...memberSync,
    },
    include: cardInclude,
  })

  // --- Log history events (only for non-reorder updates) ---
  // We skip history for pure position reorders (only position changed, nothing meaningful)
  const isPureReorder =
    parsed.data.title === undefined &&
    parsed.data.description === undefined &&
    parsed.data.columnId === undefined &&
    parsed.data.projectId === undefined &&
    parsed.data.dueDate === undefined &&
    parsed.data.memberIds === undefined

  if (!isPureReorder) {
    const actorName = authResult.name ?? authResult.email
    const historyEntries: Array<{
      cardId: string
      actorId: string
      actorNameSnapshot: string
      action: string
      payload: Prisma.InputJsonValue
    }> = []

    // Title changed
    if (parsed.data.title !== undefined && parsed.data.title !== existing.title) {
      historyEntries.push({
        cardId: id,
        actorId: authResult.id,
        actorNameSnapshot: actorName,
        action: 'TITLE_EDITED',
        payload: { oldTitle: existing.title, newTitle: parsed.data.title },
      })
    }

    // Description changed (treat null/undefined/"" equivalently as empty)
    if (parsed.data.description !== undefined) {
      const oldDesc = existing.description ?? ''
      const newDesc = parsed.data.description ?? ''
      if (oldDesc !== newDesc) {
        historyEntries.push({
          cardId: id,
          actorId: authResult.id,
          actorNameSnapshot: actorName,
          action: 'DESCRIPTION_EDITED',
          payload: { oldDescription: oldDesc || null, newDescription: newDesc || null },
        })
      }
    }

    // Column moved (status changed) — only when it's not a pure reorder-into-same-column
    if (parsed.data.columnId !== undefined && parsed.data.columnId !== existing.columnId) {
      const oldColName = (await prisma.kanbanColumn.findUnique({ where: { id: existing.columnId } }))?.name ?? 'Unknown'
      const newColName = newColumn?.name ?? 'Unknown'
      historyEntries.push({
        cardId: id,
        actorId: authResult.id,
        actorNameSnapshot: actorName,
        action: 'MOVED',
        payload: { fromColumnId: existing.columnId, fromColumnName: oldColName, toColumnId: parsed.data.columnId, toColumnName: newColName },
      })
    }

    // Members added / removed
    if (parsed.data.memberIds !== undefined) {
      const oldIds = new Set(existing.members.map((m) => m.userId))
      const newIds = new Set(parsed.data.memberIds)
      const addedIds = [...newIds].filter((uid) => !oldIds.has(uid))
      const removedIds = [...oldIds].filter((uid) => !newIds.has(uid))

      if (addedIds.length > 0 || removedIds.length > 0) {
        // Fetch names for both sets
        const allIds = [...addedIds, ...removedIds]
        const userMap = new Map(
          (await prisma.user.findMany({ where: { id: { in: allIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name])
        )
        for (const uid of addedIds) {
          historyEntries.push({
            cardId: id,
            actorId: authResult.id,
            actorNameSnapshot: actorName,
            action: 'MEMBER_ADDED',
            payload: { targetUserId: uid, targetUserName: userMap.get(uid) ?? uid },
          })
        }
        for (const uid of removedIds) {
          historyEntries.push({
            cardId: id,
            actorId: authResult.id,
            actorNameSnapshot: actorName,
            action: 'MEMBER_REMOVED',
            payload: { targetUserId: uid, targetUserName: userMap.get(uid) ?? uid },
          })
        }
      }
    }

    // Due date changed
    if (parsed.data.dueDate !== undefined) {
      const oldDue = existing.dueDate ? existing.dueDate.toISOString() : null
      const newDue = parsed.data.dueDate ?? null
      if (oldDue !== newDue) {
        if (newDue) {
          historyEntries.push({
            cardId: id,
            actorId: authResult.id,
            actorNameSnapshot: actorName,
            action: 'DUE_DATE_SET',
            payload: { date: newDue },
          })
        } else {
          historyEntries.push({
            cardId: id,
            actorId: authResult.id,
            actorNameSnapshot: actorName,
            action: 'DUE_DATE_REMOVED',
            payload: {},
          })
        }
      }
    }

    // Project linked / removed
    if (parsed.data.projectId !== undefined) {
      const oldProjectId = existing.projectId ?? null
      const newProjectId = parsed.data.projectId ?? null
      if (oldProjectId !== newProjectId) {
        if (newProjectId && newProject) {
          historyEntries.push({
            cardId: id,
            actorId: authResult.id,
            actorNameSnapshot: actorName,
            action: 'PROJECT_LINKED',
            payload: { projectId: newProject.id, projectTitle: newProject.title },
          })
        } else if (oldProjectId) {
          const oldProjectTitle = existing.project?.title ?? 'Unknown'
          historyEntries.push({
            cardId: id,
            actorId: authResult.id,
            actorNameSnapshot: actorName,
            action: 'PROJECT_REMOVED',
            payload: { projectId: oldProjectId, projectTitle: oldProjectTitle },
          })
        }
      }
    }

    if (historyEntries.length > 0) {
      await prisma.kanbanCardHistory.createMany({ data: historyEntries })
    }
  }

  // Fire TASK_USER_ASSIGNED notifications for newly added members (excluding the actor)
  if (addedMemberIds.length > 0) {
    const assignedUsers = await prisma.user.findMany({
      where: { id: { in: addedMemberIds } },
      select: { id: true, appRole: { select: { isSystemAdmin: true } } },
    })
    const usersToNotify = assignedUsers.filter((u) => u.appRole?.isSystemAdmin !== true)
    await Promise.allSettled(
      usersToNotify.map(async (u) => {
        await sendPushNotification({
          type: 'TASK_USER_ASSIGNED',
          title: 'Task Assignment',
          message: `You have been added to Task: "${card.title}"`,
          kanbanCardId: id,
          projectId: card.project?.id ?? undefined,
          projectName: card.project?.title ?? undefined,
          details: {
            __controls: { pinned: true, clearable: true, manualClearRequired: true },
            __meta: { targetUserId: u.id, authorUserId: authResult.id, cardId: id, taskTitle: card.title },
          },
        }).catch(() => {})
      })
    )
  }

  // Auto-clear any pending TASK_USER_ASSIGNED notifications for removed members
  if (removedMemberIds.length > 0) {
    await Promise.allSettled(
      removedMemberIds.map((uid) =>
        prisma.pushNotificationLog.deleteMany({
          where: {
            type: 'TASK_USER_ASSIGNED',
            AND: [
              { details: { path: ['__meta', 'cardId'], equals: id } },
              { details: { path: ['__meta', 'targetUserId'], equals: uid } },
            ],
          },
        })
      )
    )
  }

  return NextResponse.json({ card })
}

/**
 * DELETE /api/kanban/cards/[id]
 * Delete a kanban card. Admin only.
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const { id } = await context.params
  const isAdmin = authResult.appRoleIsSystemAdmin === true

  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const existing = await prisma.kanbanCard.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Card not found' }, { status: 404 })
  }

  await prisma.kanbanCard.delete({ where: { id } })

  // Reorder remaining cards
  await prisma.kanbanCard.updateMany({
    where: { columnId: existing.columnId, position: { gt: existing.position } },
    data: { position: { decrement: 1 } },
  })

  return NextResponse.json({ success: true })
}
