import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { generateVideoAccessToken, logSecurityEvent, trackVideoAccess } from '@/lib/video-access'
import { sendPushNotification } from '@/lib/push-notifications'
import { getClientIpAddress } from '@/lib/utils'
import { getRedis } from '@/lib/redis'
import { isLikelyAdminIp } from '@/lib/admin-ip-match'
import { touchProjectLastAccessForRequest } from '@/lib/project-last-access'
import { getStoredFilePathForProject, getStoredFileRecords } from '@/lib/stored-file'
import { getDirectStreamUrl, hlsStreamingEnabled, buildHlsMasterUrl, hlsAbrReady } from '@/lib/video-stream-url'

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
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please try again later.' },
    'guest-video-link-view'
  )
  if (rateLimitResult) return rateLimitResult

  const { token } = await params

  const link = await prisma.guestVideoShareLink.findUnique({
    where: { token },
    select: {
      token: true,
      expiresAt: true,
      project: {
        select: {
          id: true,
          title: true,
          status: true,
          enableVideos: true,
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
          timelinePreviewsReady: true,
          hlsVersion: true,
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

  if (link.project.status === 'CLOSED') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (link.project.enableVideos === false) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (!link.video || link.video.projectId !== link.project.id || link.video.status !== 'READY') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const sessionId = `guest-video-link:${link.token}`

  // Resolve preview existence from StoredFile (legacy path columns have been dropped)
  const thumbnailPath = await getStoredFilePathForProject('VIDEO', link.video.id, 'THUMBNAIL', link.project.id).catch(() => null)
  const hasThumbnail = !!thumbnailPath

  // Best-effort internal user detection: skip analytics/notifications when an
  // internal user is testing the link from the same IP they last logged in from.
  const ipAddress = getClientIpAddress(request)
  const likelyAdmin = await isLikelyAdminIp(ipAddress).catch(() => false)

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
  // Skip tracking entirely when the visitor is likely an admin.
  if (!likelyAdmin) {
    await touchProjectLastAccessForRequest({
      projectId: link.project.id,
      request,
      sessionId,
    }).catch(() => {})

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
  }

  // Build tokenized URLs (mirrors /share/* behavior but for a single video and public access).
  // Preview existence is resolved at content-delivery time via StoredFile.
  const wantTimeline = Boolean(link.video.timelinePreviewsReady)

  // Resolve StoredFile paths so we can mint direct-to-R2 stream URLs (Option B) in
  // addition to the token-gated /api/content URLs used as a fallback.
  const storedPaths = new Map<string, string>()
  try {
    const storedFiles = await getStoredFileRecords('VIDEO', [link.video.id], {
      select: { fileRole: true, storagePath: true },
    })
    for (const f of storedFiles) storedPaths.set(f.fileRole, f.storagePath)
  } catch {
    // Best-effort; without paths we simply fall back to /api/content URLs below.
  }
  const canServeOriginal = link.video.approved

  const [token480, token720, token1080, thumbToken, vttToken, spriteToken, direct480, direct720, direct1080] = await Promise.all([
    generateVideoAccessToken(link.video.id, link.project.id, '480p', request, sessionId).catch(() => ''),
    generateVideoAccessToken(link.video.id, link.project.id, '720p', request, sessionId).catch(() => ''),
    generateVideoAccessToken(link.video.id, link.project.id, '1080p', request, sessionId).catch(() => ''),
    generateVideoAccessToken(link.video.id, link.project.id, 'thumbnail', request, sessionId).catch(() => ''),
    wantTimeline
      ? generateVideoAccessToken(link.video.id, link.project.id, 'timeline-vtt', request, sessionId).catch(() => '')
      : Promise.resolve(''),
    wantTimeline
      ? generateVideoAccessToken(link.video.id, link.project.id, 'timeline-sprite', request, sessionId).catch(() => '')
      : Promise.resolve(''),
    getDirectStreamUrl({ storedPaths, quality: '480p', canServeOriginal, sessionId, videoId: link.video.id }).catch(() => null),
    getDirectStreamUrl({ storedPaths, quality: '720p', canServeOriginal, sessionId, videoId: link.video.id }).catch(() => null),
    getDirectStreamUrl({ storedPaths, quality: '1080p', canServeOriginal, sessionId, videoId: link.video.id }).catch(() => null),
  ])

  // HLS (proxy-robust segmented) URL — same-origin, token-scoped master playlist.
  let hlsUrl = ''
  let hlsAbr = false
  if (hlsStreamingEnabled() && storedPaths.has('HLS_PLAYLIST')) {
    const hlsToken = await generateVideoAccessToken(link.video.id, link.project.id, 'hls', request, sessionId).catch(() => '')
    if (hlsToken) {
      hlsUrl = buildHlsMasterUrl(hlsToken)
      hlsAbr = hlsAbrReady(link.video.hlsVersion)
    }
  }

  const payload = {
    expiresAt: link.expiresAt,
    project: {
      id: link.project.id,
      title: link.project.title,
      status: link.project.status,
    },
    video: {
      id: link.video.id,
      name: link.video.name,
      version: link.video.version,
      versionLabel: link.video.versionLabel,
      approved: link.video.approved,
      hasThumbnail,
      timelinePreviewsReady: link.video.timelinePreviewsReady,
      // Prefer the direct-to-R2 URL (Option B); fall back to the token-gated redirect.
      streamUrl480p: direct480 || (token480 ? `/api/content/${token480}` : ''),
      streamUrl720p: direct720 || (token720 ? `/api/content/${token720}` : ''),
      streamUrl1080p: direct1080 || (token1080 ? `/api/content/${token1080}` : ''),
      // HLS master playlist (proxy-robust); empty when unavailable, player falls back to MP4.
      hlsUrl,
      // Whether the HLS bundle is keyframe-aligned and safe for hls.js adaptive bitrate.
      hlsAbr,
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
