import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getVideoQueue } from '@/lib/queue'

export const runtime = 'nodejs'

// POST /api/videos/[id]/repackage-hls
// Re-package the HLS bundle for a READY video from its existing previews (no re-transcode).
// Used to recover from a transient HLS packaging failure (e.g. an R2 500) that left the
// video MP4-only. The video stays READY throughout — there's no playback interruption.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu
  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 10, message: 'Too many HLS repackage requests. Please slow down.' },
    'video-repackage-hls',
  )
  if (rateLimitResult) return rateLimitResult

  const { id: videoId } = await params
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: { id: true, projectId: true, status: true, project: { select: { status: true } } },
  })
  if (!video) return NextResponse.json({ error: 'Video not found' }, { status: 404 })
  if (!isVisibleProjectStatusForUser(authResult, video.project?.status)) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 })
  }
  if (video.status !== 'READY') {
    return NextResponse.json({ error: 'HLS can only be (re)packaged for a fully processed (READY) video.' }, { status: 409 })
  }

  await getVideoQueue().add('process-video', {
    videoId: video.id,
    projectId: video.projectId,
    storagePath: '',
    hlsOnly: true,
  })

  return NextResponse.json({ success: true })
}
