import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { generateVideoAccessToken, logSecurityEvent, trackVideoAccess } from '@/lib/video-access'
import { sendPushNotification } from '@/lib/push-notifications'
import { getClientIpAddress } from '@/lib/utils'
import { getRedis } from '@/lib/redis'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function isExpired(expiresAt: Date): boolean {
  return expiresAt.getTime() <= Date.now()
}

/**
 * GET /api/guest-video-links/[token]
 *
 * Public endpoint (no auth) that resolves a guest-video token into a single-video
 * player payload. Invalid if:
 * - token is unknown
 * - token expired
 * - project is CLOSED
 * - project guestMode disabled
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please try again later.' },
    'guest-video-link-view'
  )
  if (rateLimitResult) return rateLimitResult

  const { token } = await params

  const link = await (prisma as any).guestVideoShareLink.findUnique({
    where: { token },
    select: {
      token: true,
      expiresAt: true,
      project: {
        select: {
          id: true,
          title: true,
          status: true,
          guestMode: true,
          enableVideos: true,
          watermarkEnabled: true,
          timelinePreviewsEnabled: true,
        },
      },
      video: {
        select: {
          id: true,
          projectId: true,
          name: true,
          version: true,
          versionLabel: true,
          status: true,
          approved: true,
          thumbnailPath: true,
          timelinePreviewsReady: true,
        },
      },
    },
  })

  // Treat unknown/invalid as not-found (don’t leak existence).
  if (!link) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (isExpired(link.expiresAt)) {
    return NextResponse.json({ error: 'Expired' }, { status: 410 })
  }

  if (!link.project?.guestMode || link.project.status === 'CLOSED') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (link.project.enableVideos === false) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (!link.video || link.video.projectId !== link.project.id || link.video.status !== 'READY') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const sessionId = `guest-video-link:${link.token}`

  // Log a security event for visibility on the admin/security dashboard (best-effort).
  await logSecurityEvent({
    type: 'GUEST_VIDEO_LINK_VIEWED',
    severity: 'INFO',
    projectId: link.project.id,
    videoId: link.video.id,
    sessionId,
    ipAddress: getClientIpAddress(request),
    referer: request.headers.get('referer') || undefined,
    details: {
      projectTitle: link.project.title,
      videoName: link.video.name,
      version: link.video.version,
      versionLabel: link.video.versionLabel,
      token: link.token,
      userAgent: request.headers.get('user-agent') || 'Unknown',
    },
  }).catch(() => {})

  // Track a view event in analytics (best-effort) with IP-based dedupe.
  // Guest-video links share a sessionId across viewers, so dedupe must not be session-based.
  const ipAddress = getClientIpAddress(request)
  const redis = getRedis()
  const dedupeKey = `analytics:guest_video_view:${link.project.id}:${link.video.id}:${ipAddress || 'unknown'}`
  const alreadyTracked = await redis.get(dedupeKey).catch(() => null)
  if (!alreadyTracked) {
    await redis.setex(dedupeKey, 6 * 60 * 60, '1').catch(() => {})
    await trackVideoAccess({
      videoId: link.video.id,
      projectId: link.project.id,
      sessionId,
      request,
      quality: 'guest-video-link',
      eventType: 'VIDEO_VIEW',
    }).catch(() => {})
  }

  await sendPushNotification({
    type: 'GUEST_VIDEO_LINK_ACCESS',
    projectId: link.project.id,
    projectName: link.project.title,
    title: 'Guest Video Link Access',
    message: 'A guest opened a video-only guest link.',
    details: {
      Project: link.project.title,
      Video: `${link.video.name ?? 'Video'} (${link.video.versionLabel ?? '—'})`,
      IP: ipAddress,
    },
  }).catch(() => {})

  // Build tokenized URLs (mirrors /share/* behavior but for a single video and public access).
  const wantTimeline = Boolean(link.project.timelinePreviewsEnabled) && Boolean(link.video.timelinePreviewsReady)

  const [token720, token1080, thumbToken, vttToken, spriteToken] = await Promise.all([
    generateVideoAccessToken(link.video.id, link.project.id, '720p', request, sessionId).catch(() => ''),
    generateVideoAccessToken(link.video.id, link.project.id, '1080p', request, sessionId).catch(() => ''),
    link.video.thumbnailPath
      ? generateVideoAccessToken(link.video.id, link.project.id, 'thumbnail', request, sessionId).catch(() => '')
      : Promise.resolve(''),
    wantTimeline
      ? generateVideoAccessToken(link.video.id, link.project.id, 'timeline-vtt', request, sessionId).catch(() => '')
      : Promise.resolve(''),
    wantTimeline
      ? generateVideoAccessToken(link.video.id, link.project.id, 'timeline-sprite', request, sessionId).catch(() => '')
      : Promise.resolve(''),
  ])

  const payload = {
    expiresAt: link.expiresAt,
    project: {
      id: link.project.id,
      title: link.project.title,
      status: link.project.status,
      watermarkEnabled: link.project.watermarkEnabled,
      timelinePreviewsEnabled: link.project.timelinePreviewsEnabled,
    },
    video: {
      id: link.video.id,
      name: link.video.name,
      version: link.video.version,
      versionLabel: link.video.versionLabel,
      approved: link.video.approved,
      hasThumbnail: Boolean(link.video.thumbnailPath),
      timelinePreviewsReady: link.video.timelinePreviewsReady,
      streamUrl720p: token720 ? `/api/content/${token720}` : '',
      streamUrl1080p: token1080 ? `/api/content/${token1080}` : '',
      downloadUrl: null,
      thumbnailUrl: thumbToken ? `/api/content/${thumbToken}` : null,
      timelineVttUrl: vttToken ? `/api/content/${vttToken}` : null,
      timelineSpriteUrl: spriteToken ? `/api/content/${spriteToken}` : null,
    },
  }

  const response = NextResponse.json(payload)
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Pragma', 'no-cache')
  return response
}
