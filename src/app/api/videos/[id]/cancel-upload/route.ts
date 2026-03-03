import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireAnyActionAccess, requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'

// POST /api/videos/[id]/cancel-upload
// Marks an in-progress upload as failed/cancelled so ghost UPLOADING records
// do not linger on the Projects page when a client-side cancel cannot delete.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  // Allow both uploaders and settings users to cancel incomplete uploads.
  const forbiddenAction = requireAnyActionAccess(authResult, ['uploadVideosOnProjects', 'accessProjectSettings'])
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: 'Too many upload cancel requests. Please slow down.',
  }, 'video-cancel-upload')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id } = await params

    const video = await prisma.video.findUnique({
      where: { id },
      include: {
        project: {
          select: {
            status: true,
            assignedUsers: {
              select: { userId: true },
            },
          },
        },
      },
    })

    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    if (authResult.appRoleIsSystemAdmin !== true) {
      const assigned = video.project.assignedUsers?.some((u: any) => u.userId === authResult.id)
      if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

      if (!isVisibleProjectStatusForUser(authResult, video.project.status)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    if (video.status === 'READY') {
      return NextResponse.json({ error: 'Video is already complete' }, { status: 409 })
    }

    if (video.status === 'PROCESSING' || video.status === 'QUEUED') {
      return NextResponse.json({ error: 'Video is already being processed and cannot be upload-cancelled' }, { status: 409 })
    }

    // UPLOADING (or already ERROR): mark as ERROR with explicit cancellation reason.
    await prisma.video.update({
      where: { id },
      data: {
        status: 'ERROR',
        processingError: 'Upload cancelled before completion',
        uploadProgress: 0,
      },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ error: 'Failed to cancel upload' }, { status: 500 })
  }
}
