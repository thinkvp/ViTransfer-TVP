import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getShareContext } from '@/lib/auth'
import { getRedis } from '@/lib/redis'
import { getClientIpAddress } from '@/lib/utils'
import { trackVideoAccess } from '@/lib/video-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VIEW_DEDUPE_TTL_SECONDS = 6 * 60 * 60 // 6 hours

  // POST /api/track/video-view
  // Logs a single "video view" (play) for the currently-authenticated share session.
export async function POST(request: NextRequest) {
  try {
    const shareContext = await getShareContext(request)

    // Only share-token sessions should count toward client analytics.
    if (!shareContext?.projectId || !shareContext.sessionId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Internal/admin-override share tokens should not count toward client analytics.
    if (shareContext.adminOverride === true) {
      return NextResponse.json({ tracked: false })
    }

    const body = await request.json().catch(() => null)
    const videoId = typeof body?.videoId === 'string' ? body.videoId : null

    if (!videoId) {
      return NextResponse.json({ error: 'videoId is required' }, { status: 400 })
    }

    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true, projectId: true, status: true },
    })

    if (!video || video.projectId !== shareContext.projectId || video.status !== 'READY') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const redis = getRedis()
    const viewerKey = shareContext.sessionId || getClientIpAddress(request) || 'unknown'
    const dedupeKey = `analytics:video_view:${video.projectId}:${video.id}:${viewerKey}`

    const already = await redis.get(dedupeKey)
    if (already) {
      return NextResponse.json({ tracked: false })
    }

    await redis.setex(dedupeKey, VIEW_DEDUPE_TTL_SECONDS, '1')

    await trackVideoAccess({
      videoId: video.id,
      projectId: video.projectId,
      sessionId: shareContext.sessionId,
      request,
      quality: 'share-play',
      eventType: 'VIDEO_VIEW',
    }).catch(() => {})

    return NextResponse.json({ tracked: true })
  } catch {
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}
