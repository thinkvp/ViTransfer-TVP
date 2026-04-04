import { NextRequest, NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/kanban/project-tasks?projectId=...
 * Returns kanban cards linked to a specific project.
 * Admins see all cards; non-admins see cards they are a member of
 * or cards linked to projects they are assigned to.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const projectId = request.nextUrl.searchParams.get('projectId')?.trim()
  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  }

  const isAdmin = authResult.appRoleIsSystemAdmin === true

  const cards = await prisma.kanbanCard.findMany({
    where: {
      projectId,
      ...(isAdmin
        ? {}
        : {
            OR: [
              { members: { some: { userId: authResult.id } } },
              { project: { assignedUsers: { some: { userId: authResult.id } } } },
            ],
          }),
    },
    select: {
      id: true,
      title: true,
      description: true,
      dueDate: true,
      position: true,
      columnId: true,
      projectId: true,
      archivedAt: true,
      createdAt: true,
      updatedAt: true,
      members: {
        include: {
          user: {
            select: { id: true, name: true, email: true, displayColor: true, avatarPath: true },
          },
        },
      },
      column: {
        select: { id: true, name: true, color: true, position: true },
      },
      project: {
        select: { id: true, title: true },
      },
      createdBy: {
        select: { id: true, name: true, email: true },
      },
      _count: {
        select: { comments: true },
      },
    },
    orderBy: [{ column: { position: 'asc' } }, { position: 'asc' }],
  })

  return NextResponse.json({ tasks: cards })
}
