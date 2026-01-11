import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function assertProjectAccessOr404(projectId: string, auth: any) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, status: true } })
  if (!project) return null

  if (!isVisibleProjectStatusForUser(auth, project.status)) return null

  if (auth.appRoleIsSystemAdmin !== true) {
    const assignment = await prisma.projectUser.findUnique({
      where: {
        projectId_userId: {
          projectId: project.id,
          userId: auth.id,
        },
      },
      select: { projectId: true },
    })
    if (!assignment) return null
  }

  return project
}

// DELETE /api/projects/[id]/internal-comments/[commentId]
// - system admin: can delete any comment
// - non-admin: can delete only their own comments
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; commentId: string }> }
) {
  const { id: projectId, commentId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'makeCommentsOnProjects')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'project-internal-comment-delete'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const comment = await prisma.projectInternalComment.findUnique({
    where: { id: commentId },
    select: { id: true, projectId: true, userId: true },
  })

  if (!comment || comment.projectId !== projectId) {
    return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
  }

  const canDelete = authResult.appRoleIsSystemAdmin === true || comment.userId === authResult.id
  if (!canDelete) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  await prisma.projectInternalComment.delete({ where: { id: commentId } })

  return NextResponse.json({ ok: true })
}
