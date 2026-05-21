import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { getUserPermissions, requireActionAccess } from '@/lib/rbac-api'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const forbiddenAction = requireActionAccess(authResult, 'accessSharePage')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-share-projects',
    authResult.id,
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const permissions = getUserPermissions(authResult)
    const allowedStatuses = permissions.projectVisibility.statuses

    if (!Array.isArray(allowedStatuses) || allowedStatuses.length === 0) {
      const response = NextResponse.json({ projects: [] })
      response.headers.set('Cache-Control', 'no-store')
      response.headers.set('Pragma', 'no-cache')
      return response
    }

    const isSystemAdmin = authResult.appRoleIsSystemAdmin === true

    const projects = await prisma.project.findMany({
      where: {
        status: { in: allowedStatuses as any },
        ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId: authResult.id } } }),
      },
      select: {
        id: true,
        slug: true,
        title: true,
        status: true,
        updatedAt: true,
        client: {
          select: {
            name: true,
          },
        },
      },
      orderBy: [
        { updatedAt: 'desc' },
        { title: 'asc' },
      ],
    })

    const response = NextResponse.json({
      projects: projects.map((project) => ({
        id: project.id,
        slug: project.slug,
        title: project.title,
        status: project.status,
        updatedAt: project.updatedAt.toISOString(),
        clientName: project.client?.name || null,
      })),
    })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch {
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}
