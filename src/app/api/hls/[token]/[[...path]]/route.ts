import { NextRequest, NextResponse } from 'next/server'
import { getRedis } from '@/lib/redis'
import { verifyVideoAccessToken } from '@/lib/video-access'
import { rateLimit } from '@/lib/rate-limit'
import { downloadFile } from '@/lib/storage'
import { s3GetPresignedStreamUrl } from '@/lib/s3-storage'
import { buildVideoHlsStorageRoot, buildVideoAssetHlsStorageRoot } from '@/lib/project-storage-paths'
import { hlsStreamingEnabled } from '@/lib/video-stream-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * HLS playlist delivery (Option B for HLS).
 *
 * Serves ONLY the tiny `.m3u8` playlists, same-origin and token-gated, so access
 * gating + analytics stay on our origin. Media segments are NEVER served here — the
 * variant playlist references each segment by a presigned R2 URL, so the heavy bytes
 * flow browser ⇄ R2 directly (full-file 200 GETs that survive Range-hostile proxies,
 * and keep R2's free egress off our app server).
 *
 * Routes:
 *   /api/hls/{token}/master.m3u8        → master, variant URIs rewritten same-origin
 *   /api/hls/{token}/{label}/index.m3u8 → variant, segment URIs rewritten to presigned R2
 *
 * Only `master.m3u8` and `{480|720|1080}/index.m3u8` are servable — everything else is
 * 404, which also closes off path traversal (we never serve an arbitrary stored file).
 */

const RENDITION_LABELS = new Set(['480', '720', '1080'])
const PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl'
// Segment presign lifetime — must comfortably outlast a viewing session. Mirrors the
// MP4 stream TTL (STREAM_URL_TTL_SECONDS = 14400 = 4h).
const SEGMENT_TTL_SECONDS = 14400
// How long a fully-rewritten variant playlist (with presigned segment URLs) is reused
// from Redis. Kept well under the segment TTL so a cache hit always returns URLs with
// plenty of validity left, while avoiding re-presigning every segment on each fetch.
const PLAYLIST_CACHE_SECONDS = 7200

async function readStorageText(storagePath: string): Promise<string> {
  const stream = await downloadFile(storagePath)
  const chunks: Buffer[] = []
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

function playlistResponse(body: string): NextResponse {
  const res = new NextResponse(body, { status: 200 })
  res.headers.set('Content-Type', PLAYLIST_CONTENT_TYPE)
  // Playlists embed short-lived presigned URLs — never let a shared/CDN cache hold them.
  res.headers.set('Cache-Control', 'private, no-store')
  return res
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; path?: string[] }> },
) {
  // Kill-switch / mode gate: if HLS isn't being served, behave as if the route doesn't exist.
  if (!hlsStreamingEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const limited = await rateLimit(request, { windowMs: 60_000, maxRequests: 600 }, 'hls-playlist')
  if (limited) return limited

  const { token, path: pathParts = [] } = await params

  // Resolve the token payload to learn its session (the URL doesn't carry one), then
  // fully verify (session binding, IP, revocation) exactly like /api/content does.
  const redis = getRedis()
  const raw = await redis.get(`video_access:${token}`).catch(() => null)
  if (!raw) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  let payload: { sessionId?: string; videoId?: string; projectId?: string; quality?: string }
  try {
    payload = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const sessionId = payload.sessionId
  if (!sessionId || payload.quality !== 'hls' || !payload.videoId || !payload.projectId) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const verified = await verifyVideoAccessToken(token, request, sessionId)
  if (!verified) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  // Asset playback previews live under the asset's own HLS root; main video versions under the
  // video's. The token carries entityType='asset'/entityId for assets (videoId is the parent).
  const hlsRoot = verified.entityType === 'asset' && verified.entityId
    ? buildVideoAssetHlsStorageRoot(verified.projectId, verified.videoId, verified.entityId)
    : buildVideoHlsStorageRoot(verified.projectId, verified.videoId)

  // --- master.m3u8: rewrite variant URIs ("480/index.m3u8") to same-origin token URLs ---
  if (pathParts.length === 1 && pathParts[0] === 'master.m3u8') {
    let master: string
    try {
      master = await readStorageText(`${hlsRoot}/master.m3u8`)
    } catch {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const rewritten = master.replace(
      /^(\d+)\/index\.m3u8\s*$/gm,
      (_match, label: string) => `/api/hls/${token}/${label}/index.m3u8`,
    )
    return playlistResponse(rewritten)
  }

  // --- {label}/index.m3u8: rewrite segment URIs (init.mp4 + seg-*.m4s) to presigned R2 ---
  if (pathParts.length === 2 && RENDITION_LABELS.has(pathParts[0]) && pathParts[1] === 'index.m3u8') {
    const label = pathParts[0]
    const cacheKey = `hls_variant:${sessionId}:${verified.videoId}:${label}`

    const cached = await redis.get(cacheKey).catch(() => null)
    if (cached) return playlistResponse(cached)

    let variant: string
    try {
      variant = await readStorageText(`${hlsRoot}/${label}/index.m3u8`)
    } catch {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Collect every referenced media file: EXT-X-MAP:URI="init.mp4" + bare segment lines.
    const mapNames = [...variant.matchAll(/URI="([^"]+)"/g)].map((m) => m[1])
    const segNames = variant
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && /\.(m4s|mp4)$/i.test(l))
    const names = Array.from(new Set([...mapNames, ...segNames]))

    const signed = new Map<string, string>()
    await Promise.all(
      names.map(async (name) => {
        // Segment names are bare basenames produced by ffmpeg — reject anything that
        // could escape the rendition directory before presigning.
        if (name.includes('/') || name.includes('\\') || name.includes('..')) return
        const url = await s3GetPresignedStreamUrl(`${hlsRoot}/${label}/${name}`, SEGMENT_TTL_SECONDS, 'video/mp4')
        signed.set(name, url)
      }),
    )

    let rewritten = variant.replace(/URI="([^"]+)"/g, (match, name: string) => {
      const url = signed.get(name)
      return url ? `URI="${url}"` : match
    })
    rewritten = rewritten
      .split('\n')
      .map((line) => {
        const t = line.trim()
        if (t && !t.startsWith('#') && /\.(m4s|mp4)$/i.test(t)) return signed.get(t) ?? line
        return line
      })
      .join('\n')

    await redis.setex(cacheKey, PLAYLIST_CACHE_SECONDS, rewritten).catch(() => {})
    return playlistResponse(rewritten)
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}
