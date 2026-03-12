import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 120,
    message: 'Too many requests. Please slow down.',
  }, 'project-video-statuses')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id } = await params

    const project = await prisma.project.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        assignedUsers: authResult.appRoleIsSystemAdmin === true
          ? false
          : { select: { userId: true } },
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (!isVisibleProjectStatusForUser(authResult, project.status)) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (authResult.appRoleIsSystemAdmin !== true) {
      const assigned = Array.isArray(project.assignedUsers)
        && project.assignedUsers.some((user) => user.userId === authResult.id)
      if (!assigned) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 })
      }
    }

    const videos = await prisma.video.findMany({
      where: { projectId: id },
      select: {
        id: true,
        status: true,
        approved: true,
        approvedAt: true,
        processingProgress: true,
        processingPhase: true,
        processingError: true,
        duration: true,
        width: true,
        height: true,
        preview480Path: true,
        preview720Path: true,
        preview1080Path: true,
        thumbnailPath: true,
        timelinePreviewVttPath: true,
        timelinePreviewSpritesPath: true,
        timelinePreviewsReady: true,
        dropboxEnabled: true,
        dropboxUploadStatus: true,
        dropboxUploadProgress: true,
        dropboxUploadError: true,
        updatedAt: true,
      },
      orderBy: { version: 'desc' },
    })

    return NextResponse.json({ videos })
  } catch (error) {
    console.error('[project-video-statuses] Failed to fetch:', error)
    return NextResponse.json({ error: 'Failed to fetch video statuses' }, { status: 500 })
  }
}