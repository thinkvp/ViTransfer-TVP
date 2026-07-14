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

// Batch sibling of the single-token GET (../route.ts), mirroring the admin batch route
// (src/app/api/admin/video-token/batch/route.ts). A fresh share-page load tokenizes every
// version of every video at 4-6 single GETs each — ~100+ requests on a large project —
// which meant the per-IP rate limit measured project size × concurrent viewers instead of
// abuse (two or three fresh logins behind one NAT inside a minute tripped it). The share
// page now sends its whole tokenization pass as one (chunked) POST here, so cost no longer
// scales with version count. Authorization semantics are identical to the single GET:
// same share-session gate, same per-quality availability check (shared helper), same
// approval gating on originals.
const MAX_ITEMS = 300

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  const shareContext = await getShareContext(request)
  if (!shareContext) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // One batch ≈ one tokenization pass (the client chunks at 100 items, so a large
  // project is 1-2 requests per pass). 60/min leaves room for many co-located viewers
  // and tab-switch refresh passes while still capping abusive callers; the client
  // honours Retry-After on 429 via the same backoff as the single GET.
  const limited = await rateLimit(request, { maxRequests: 60, windowMs: 60_000 }, 'share-video-token-batch')
  if (limited) return limited

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const rawItems = Array.isArray((body as any)?.items) ? (body as any).items : []
  const items: Array<{ videoId: string; quality: string }> = rawItems
    .map((it: any) => ({ videoId: String(it?.videoId || '').trim(), quality: String(it?.quality || '').trim() }))
    .filter((it: { videoId: string; quality: string }) => it.videoId.length > 0 && it.quality.length > 0)

  if (items.length === 0) {
    return NextResponse.json({ error: 'items is required' }, { status: 400 })
  }
  if (items.length > MAX_ITEMS) {
    return NextResponse.json({ error: `Too many items (max ${MAX_ITEMS})` }, { status: 400 })
  }

  let project: { id: string; slug: string; enableVideos: boolean | null } | null
  let videoById = new Map<string, { id: string; approved: boolean; hlsVersion: number }>()
  const rolesByVideoId = new Map<string, Set<string>>()
  const pathsByVideoId = new Map<string, Map<string, string>>()
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

    const videoIds = Array.from(new Set(items.map((it) => it.videoId)))

    // Only mint for videos that actually belong to this project.
    const videos = await prisma.video.findMany({
      where: { id: { in: videoIds }, projectId: project.id },
      select: { id: true, approved: true, hlsVersion: true },
    })
    videoById = new Map(videos.map((v) => [v.id, v]))

    // Resolve available file roles + paths for every video in one query. Roles gate which
    // qualities may be issued; paths let us mint direct-to-R2 stream URLs (Option B).
    const storedFiles = await getStoredFileRecords('VIDEO', videoIds, {
      fileRoles: VIDEO_DELIVERY_ROLES,
      select: { entityId: true, fileRole: true, storagePath: true },
    })
    for (const f of storedFiles) {
      if (!rolesByVideoId.has(f.entityId)) {
        rolesByVideoId.set(f.entityId, new Set())
        pathsByVideoId.set(f.entityId, new Map())
      }
      rolesByVideoId.get(f.entityId)!.add(f.fileRole)
      if (f.storagePath) pathsByVideoId.get(f.entityId)!.set(f.fileRole, f.storagePath)
    }
  } catch (error) {
    console.error('[SHARE] Failed to load project/videos for token batch:', error)
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 })
  }

  const sessionId = shareContext.sessionId || `share:${project!.id}:${token}`

  // The HLS master token is per-video (quality-independent), so mint it once per video
  // regardless of how many qualities the batch requests for it.
  const hlsTokenPromises = new Map<string, Promise<string>>()
  const getHlsToken = (videoId: string): Promise<string> => {
    let promise = hlsTokenPromises.get(videoId)
    if (!promise) {
      promise = generateVideoAccessToken(videoId, project!.id, 'hls', request, sessionId).catch(() => '')
      hlsTokenPromises.set(videoId, promise)
    }
    return promise
  }

  // Keyed `${videoId}:${quality}`. Items that are unavailable/unauthorized for this
  // session are simply absent — the client treats a missing key as an empty result,
  // matching the single GET's 403/404 → empty-token handling.
  const results: Record<string, { token: string; streamUrl: string | null; hlsUrl: string; hlsAbr: boolean }> = {}

  await Promise.all(
    items.map(async (it) => {
      const video = videoById.get(it.videoId)
      if (!video) return
      const roles = rolesByVideoId.get(it.videoId) ?? new Set<string>()
      if (!canIssueShareVideoToken(roles, video.approved, it.quality)) return

      try {
        const tokenValue = await generateVideoAccessToken(video.id, project!.id, it.quality, request, sessionId)

        // Option B: in S3 mode, also hand back a presigned R2 URL the player can stream
        // directly. Null for local mode / non-stream qualities — the client then falls
        // back to the token-gated /api/content URL.
        const streamUrl = await getDirectStreamUrl({
          storedPaths: pathsByVideoId.get(it.videoId) ?? new Map(),
          quality: it.quality,
          canServeOriginal: video.approved,
          sessionId,
          videoId: video.id,
        }).catch(() => null)

        let hlsUrl = ''
        let hlsAbr = false
        if (roles.has('HLS_PLAYLIST')) {
          const hlsToken = await getHlsToken(video.id)
          if (hlsToken) {
            hlsUrl = buildHlsMasterUrl(hlsToken)
            hlsAbr = hlsAbrReady(video.hlsVersion)
          }
        }

        results[`${it.videoId}:${it.quality}`] = { token: tokenValue, streamUrl, hlsUrl, hlsAbr }
      } catch (error) {
        console.error('[SHARE] Failed to mint video token (batch)', { videoId: it.videoId, quality: it.quality, error })
      }
    }),
  )

  const response = NextResponse.json({ results })
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Pragma', 'no-cache')
  return response
}
