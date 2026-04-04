import { NextRequest, NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/kanban
 *
 * Returns all kanban columns with their cards.
 * - Admin (isSystemAdmin): sees all cards
 * - Other users: only cards where they are a member OR linked to a project they are assigned to
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const isAdmin = authResult.appRoleIsSystemAdmin === true

  const columns = await prisma.kanbanColumn.findMany({
    orderBy: { position: 'asc' },
    include: {
      cards: {
        orderBy: { position: 'asc' },
        where: {
          archivedAt: null,
          ...(!isAdmin
            ? {
                OR: [
                  { members: { some: { userId: authResult.id } } },
                  {
                    project: {
                      assignedUsers: {
                        some: { userId: authResult.id },
                      },
                    },
                  },
                ],
              }
            : {}),
        },
        include: {
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
          _count: {
            select: { comments: true },
          },
        },
      },
    },
  })

  return NextResponse.json({ columns })
}
