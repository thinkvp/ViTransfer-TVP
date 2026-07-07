import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireAnyActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { buildProjectActivity } from '@/lib/project-activity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const noStoreHeaders = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

// GET /api/projects/[id]/activity - Project Activity feed (admin share page)
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiUser(request)
  if (auth instanceof Response) return auth

  const forbiddenMenu = requireMenuAccess(auth, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  // Same action set that grants access to the admin share/review surface.
  const forbiddenAction = requireAnyActionAccess(auth, [
    'accessSharePage',
    'accessProjectSettings',
    'uploadVideosOnProjects',
    'changeProjectSettings',
    'changeProjectStatuses',
    'manageProjectAlbums',
  ])
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'project-activity',
  )
  if (rateLimitResult) return rateLimitResult

  const { id: projectId } = await params

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      status: true,
      assignedUsers: { select: { userId: true } },
    },
  })
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  if (auth.appRoleIsSystemAdmin !== true) {
    const assigned = project.assignedUsers?.some((u) => u.userId === auth.id)
    if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    if (!isVisibleProjectStatusForUser(auth, project.status)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const { searchParams } = new URL(request.url)
  const offset = Number(searchParams.get('offset')) || 0
  const limit = Number(searchParams.get('limit')) || undefined

  const page = await buildProjectActivity(projectId, {
    audience: 'admin',
    includeComments: true,
    offset,
    limit,
  })

  return NextResponse.json(page, { headers: noStoreHeaders })
}
