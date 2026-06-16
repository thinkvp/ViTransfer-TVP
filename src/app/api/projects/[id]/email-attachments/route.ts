import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getStoredFileRecords } from '@/lib/stored-file'

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

  const forbiddenAction = requireActionAccess(authResult, 'projectExternalCommunication')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'project-email-attachments-list'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const files = await prisma.projectEmailAttachment.findMany({
    where: { projectEmail: { projectId }, isInline: false },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      fileName: true,
      createdAt: true,
      projectEmailId: true,
    },
  })

  // Resolve file sizes from StoredFile
  const ids = files.map(f => f.id)
  const sizeMap = new Map<string, number>()
  if (ids.length > 0) {
    const stored = await getStoredFileRecords('PROJECT_EMAIL_ATTACHMENT', ids, {
      fileRoles: ['ORIGINAL'],
      select: { entityId: true, fileSize: true },
    })
    for (const s of stored) {
      if (s.fileSize != null) sizeMap.set(s.entityId, Number(s.fileSize))
    }
  }

  return NextResponse.json({
    files: files.map((file) => ({
      id: file.id,
      fileName: file.fileName,
      fileSize: String(sizeMap.get(file.id) ?? 0),
      createdAt: file.createdAt,
      downloadUrl: `/api/projects/${projectId}/emails/${file.projectEmailId}/attachments/${file.id}`,
    })),
  })
}