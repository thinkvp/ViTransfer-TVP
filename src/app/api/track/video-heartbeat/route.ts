import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getShareContext } from '@/lib/auth'
import { getClientIpAddress } from '@/lib/utils'
import { isLikelyAdminIp } from '@/lib/admin-ip-match'
import { recordClientActivity } from '@/lib/client-activity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/track/video-heartbeat
// Keeps the Client Activity "Streaming video" presence alive while a share-token
// session is actively watching. The player POSTs this on play and then on a timer
// (see VideoPlayer). Unlike /api/content streaming (bypassed by direct-to-HLS/R2
// playback since 2.1.0), this is the only continuous signal that a client is
// currently watching — the HLS route only marks the *start* of playback.
export async function POST(request: NextRequest) {
  try {
    const shareContext = await getShareContext(request)

    // Only genuine share-token sessions count toward client activity.
    if (!shareContext?.projectId || !shareContext.sessionId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Internal/admin-override share tokens must not inflate client activity.
    if (shareContext.adminOverride === true || shareContext.sessionId.startsWith('admin:')) {
      return NextResponse.json({ tracked: false })
    }

    const body = await request.json().catch(() => null)
    const videoId = typeof body?.videoId === 'string' ? body.videoId : null

    if (!videoId) {
      return NextResponse.json({ error: 'videoId is required' }, { status: 400 })
    }

    // Best-effort: skip when the viewer's IP matches a known internal user (admin
    // reviewing the share page without an admin JWT). Mirrors the other activity
    // recorders (share-access-tracking, /api/share/[token]/activity).
    const ipAddress = getClientIpAddress(request)
    const likelyAdmin = await isLikelyAdminIp(ipAddress).catch(() => false)
    if (likelyAdmin) {
      return NextResponse.json({ tracked: false })
    }

    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        projectId: true,
        status: true,
        name: true,
        versionLabel: true,
        project: { select: { title: true } },
      },
    })

    if (!video || video.projectId !== shareContext.projectId || video.status !== 'READY') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    await recordClientActivity({
      sessionId: shareContext.sessionId,
      projectId: video.projectId,
      projectTitle: video.project?.title ?? null,
      videoId: video.id,
      videoName: video.name,
      versionLabel: video.versionLabel || null,
      activityType: 'STREAMING_VIDEO',
      accessMethod: shareContext.accessMethod ?? null,
      email: shareContext.accessMethod === 'OTP' ? shareContext.email ?? null : null,
      ipAddress: ipAddress || null,
    }).catch(() => {})

    return NextResponse.json({ tracked: true })
  } catch {
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}
