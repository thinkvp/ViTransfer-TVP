import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getShareContext } from '@/lib/auth'
import { generateVideoAccessToken } from '@/lib/video-access'
import { rateLimit } from '@/lib/rate-limit'
import { getStoredFileRecords, VIDEO_DELIVERY_ROLES } from '@/lib/stored-file'
import { getDirectStreamUrl, buildHlsMasterUrl, hlsAbrReady } from '@/lib/video-stream-url'
import { canIssueShareVideoToken } from '@/lib/share-video-token'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const url = new URL(request.url)
  const videoId = url.searchParams.get('videoId')
  const quality = url.searchParams.get('quality') || '720p'

  if (!videoId) {
    return NextResponse.json({ error: 'videoId is required' }, { status: 400 })
  }

  const shareContext = await getShareContext(request)
  if (!shareContext) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // The share page's bulk tokenization (initial load / forced refresh passes) goes
  // through the batch POST sibling (./batch) — this GET now only serves one-off flows
  // (e.g. click-time original-download token minting), so the limit is pure abuse
  // headroom rather than a budget page size has to fit inside. The share page backs
  // off client-side on 429 (Retry-After) instead of retrying.
  const limited = await rateLimit(request, { maxRequests: 240, windowMs: 60_000 }, 'share-video-token')
  if (limited) return limited

  let project: { id: string; slug: string; enableVideos: boolean | null } | null
  let video: { id: string; projectId: string; approved: boolean; hlsVersion: number } | null
  let storedRoles = new Set<string>()
  const storedPaths = new Map<string, string>()
  try {
    project = await prisma.project.findUnique({
      where: { id: shareContext.projectId },
      select: { id: true, slug: true, enableVideos: true },
    })

    if (!project || project.slug !== token) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    if (project.enableVideos === false) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    video = await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        projectId: true,
        approved: true,
        hlsVersion: true,
      },
    })

    if (!video || video.projectId !== project.id) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    // Resolve available file roles + paths from StoredFile registry. Roles gate which
    // qualities may be issued; paths let us mint a direct-to-R2 stream URL (Option B).
    const storedFiles = await getStoredFileRecords('VIDEO', [videoId], {
      fileRoles: VIDEO_DELIVERY_ROLES,
      select: { fileRole: true, storagePath: true },
    })
    storedRoles = new Set(storedFiles.map(f => f.fileRole))
    for (const f of storedFiles) storedPaths.set(f.fileRole, f.storagePath)
  } catch (error) {
    console.error('[SHARE] Failed to load project/video:', error)
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 })
  }

  if (!canIssueShareVideoToken(storedRoles, video!.approved, quality)) {
    return NextResponse.json({ error: `${quality} unavailable` }, { status: quality === 'original' ? 403 : 404 })
  }

  const sessionId = shareContext.sessionId || `share:${project!.id}:${token}`

  try {
    const tokenValue = await generateVideoAccessToken(
      video!.id,
      project!.id,
      quality,
      request,
      sessionId
    )

    // Option B: in S3 mode, also hand back a presigned R2 URL the player can stream
    // directly (bypassing the /api/content 302 redirect that breaks Range-seeking behind
    // some corporate proxies). Null for local mode / non-stream qualities — the client
    // then falls back to the token-gated /api/content URL. Approval is already enforced
    // by canIssueShareVideoToken above; original is only a fallback when approved.
    const streamUrl = await getDirectStreamUrl({
      storedPaths,
      quality,
      canServeOriginal: video!.approved,
      sessionId,
      videoId: video!.id,
    }).catch(() => null)

    // HLS (proxy-robust segmented) URL — same-origin, token-scoped master playlist.
    // Per-video (not per-quality); the token is cached so repeated quality fetches
    // return the same URL. Offered only when a packaged bundle exists.
    let hlsUrl = ''
    let hlsAbr = false
    if (storedRoles.has('HLS_PLAYLIST')) {
      const hlsToken = await generateVideoAccessToken(video!.id, project!.id, 'hls', request, sessionId).catch(() => '')
      if (hlsToken) {
        hlsUrl = buildHlsMasterUrl(hlsToken)
        hlsAbr = hlsAbrReady(video!.hlsVersion)
      }
    }

    const response = NextResponse.json({ token: tokenValue, streamUrl, hlsUrl, hlsAbr })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('[SHARE] Failed to generate video token', { videoId, quality, error })
    return NextResponse.json({ error: 'Failed to generate token' }, { status: 500 })
  }
}
