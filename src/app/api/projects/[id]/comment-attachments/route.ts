import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'

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

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'accessSharePage')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'project-comment-attachments-list'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const files = await prisma.commentFile.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      fileName: true,
      fileSize: true,
      createdAt: true,
      comment: {
        select: {
          authorName: true,
          isInternal: true,
          user: {
            select: {
              name: true,
              email: true,
            },
          },
          recipient: {
            select: {
              name: true,
              email: true,
            },
          },
        },
      },
    },
  })

  return NextResponse.json({
    files: files.map((file) => ({
      id: file.id,
      fileName: file.fileName,
      fileSize: file.fileSize.toString(),
      createdAt: file.createdAt,
      uploadedByName:
        file.comment.authorName ||
        file.comment.user?.name ||
        file.comment.user?.email ||
        file.comment.recipient?.name ||
        file.comment.recipient?.email ||
        (file.comment.isInternal ? 'Admin' : 'Client'),
      downloadUrl: `/api/projects/${projectId}/comment-attachments/${file.id}`,
    })),
  })
}