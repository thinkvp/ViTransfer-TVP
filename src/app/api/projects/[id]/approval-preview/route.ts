import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { getUserPermissions, isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { canDoAction } from '@/lib/rbac'
import { rateLimit } from '@/lib/rate-limit'
import { planProjectApprovalVideos } from '@/lib/project-approval-videos'

export const dynamic = 'force-dynamic'

/**
 * Read-only preview of what marking this project Approved will do to its videos, so the
 * status picker can warn before the change. Same gates as changing a project's status.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu
  const forbiddenAction = requireActionAccess(authResult, 'changeProjectStatuses')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: 'Too many requests. Please slow down.',
  }, 'project-approval-preview')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id } = await params

    const project = await prisma.project.findUnique({
      where: { id },
      select: { status: true },
    })
    if (!project || !isVisibleProjectStatusForUser(authResult, project.status)) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (authResult.appRoleIsSystemAdmin !== true) {
      const assignment = await prisma.projectUser.findUnique({
        where: { projectId_userId: { projectId: id, userId: authResult.id } },
        select: { projectId: true },
      })
      if (!assignment) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 })
      }
    }

    const plan = await planProjectApprovalVideos(id)
    const canApproveVideos = canDoAction(getUserPermissions(authResult), 'projectsFullControl')

    return NextResponse.json({ ...plan, canApproveVideos })
  } catch (error) {
    console.error('[APPROVAL PREVIEW] Failed to build approval preview:', error)
    return NextResponse.json({ error: 'Failed to load approval preview' }, { status: 500 })
  }
}
