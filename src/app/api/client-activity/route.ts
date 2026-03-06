import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getUserPermissions } from '@/lib/rbac-api'
import { listActiveClientActivities } from '@/lib/client-activity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(request, { windowMs: 10 * 1000, maxRequests: 20 })
  if (rateLimitResult) return rateLimitResult

  try {
    const isSystemAdmin = authResult.appRoleIsSystemAdmin === true
    const permissions = getUserPermissions(authResult)
    const allowedStatuses = permissions.projectVisibility?.statuses ?? []

    const rawActivities = await listActiveClientActivities(30)
    if (rawActivities.length === 0) {
      return NextResponse.json({ activities: [] })
    }

    const candidateProjectIds = Array.from(new Set(rawActivities.map((activity) => activity.projectId).filter(Boolean)))
    if (candidateProjectIds.length === 0) {
      return NextResponse.json({ activities: [] })
    }

    const visibleProjects = await prisma.project.findMany({
      where: {
        id: { in: candidateProjectIds },
        status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
        ...(isSystemAdmin
          ? {}
          : { assignedUsers: { some: { userId: authResult.id } } }),
      },
      select: {
        id: true,
        title: true,
      },
    })

    const visibleProjectMap = new Map(visibleProjects.map((project) => [project.id, project.title]))
    const activities = rawActivities
      .filter((activity) => visibleProjectMap.has(activity.projectId))
      .map((activity) => ({
        ...activity,
        projectTitle: visibleProjectMap.get(activity.projectId) || activity.projectTitle,
      }))

    return NextResponse.json({ activities })
  } catch (error: any) {
    console.error('[client-activity]', error)
    return NextResponse.json({ error: error?.message || 'Unknown error' }, { status: 500 })
  }
}