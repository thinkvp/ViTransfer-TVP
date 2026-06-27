import { NextRequest, NextResponse } from 'next/server'
import { getRedis } from '@/lib/redis'
import { verifyVideoAccessToken } from '@/lib/video-access'
import { rateLimit } from '@/lib/rate-limit'
import { Readable } from 'stream'
import { downloadFile } from '@/lib/storage'
import { isS3Mode, s3GetPresignedStreamUrl } from '@/lib/s3-storage'
import { buildVideoHlsStorageRoot, buildVideoAssetHlsStorageRoot } from '@/lib/project-storage-paths'
import { hlsStreamingEnabled } from '@/lib/video-stream-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * HLS delivery (Option B for HLS).
 *
 * S3 mode: serves ONLY the tiny `.m3u8` playlists, same-origin and token-gated; the variant
 * playlist references each segment by a presigned R2 URL, so the heavy bytes flow browser ⇄ R2
 * directly (full-file 200 GETs that survive Range-hostile proxies, and keep R2's free egress
 * off our app server).
 *
 * Local mode: there is no R2 to presign against, so segment URIs are rewritten same-origin and
 * the segment bytes are streamed from local disk through this same route (still full-file 200
 * GETs, still token-gated).
 *
 * Routes:
 *   /api/hls/{token}/master.m3u8         → master, variant URIs rewritten same-origin
 *   /api/hls/{token}/{label}/index.m3u8  → variant, segment URIs → presigned R2 (S3) or same-origin (local)
 *   /api/hls/{token}/{label}/{seg}.m4s   → (local mode only) segment bytes from disk
 *
 * Only these shapes are servable — everything else is 404, which also closes off path traversal
 * (we never serve an arbitrary stored file).
 */

const RENDITION_LABELS = new Set(['480', '720', '1080'])
const PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl'
// Segment basenames are produced by ffmpeg: init.mp4 + seg-NNNNN.m4s. Reject anything else.
const SEGMENT_NAME_RE = /^[A-Za-z0-9._-]+\.(m4s|mp4)$/
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

  // --- {label}/index.m3u8: rewrite segment URIs (init.mp4 + seg-*.m4s) ---
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

    // Resolve each segment basename to a delivery URL: presigned R2 in S3 mode, or a
    // same-origin token URL in local mode (the segment branch below streams the bytes).
    const segmentUrl = new Map<string, string>()
    await Promise.all(
      names.map(async (name) => {
        // Bare basenames only — reject anything that could escape the rendition directory.
        if (name.includes('/') || name.includes('\\') || name.includes('..')) return
        if (isS3Mode()) {
          segmentUrl.set(name, await s3GetPresignedStreamUrl(`${hlsRoot}/${label}/${name}`, SEGMENT_TTL_SECONDS, 'video/mp4'))
        } else {
          segmentUrl.set(name, `/api/hls/${token}/${label}/${name}`)
        }
      }),
    )

    let rewritten = variant.replace(/URI="([^"]+)"/g, (match, name: string) => {
      const url = segmentUrl.get(name)
      return url ? `URI="${url}"` : match
    })
    rewritten = rewritten
      .split('\n')
      .map((line) => {
        const t = line.trim()
        if (t && !t.startsWith('#') && /\.(m4s|mp4)$/i.test(t)) return segmentUrl.get(t) ?? line
        return line
      })
      .join('\n')

    await redis.setex(cacheKey, PLAYLIST_CACHE_SECONDS, rewritten).catch(() => {})
    return playlistResponse(rewritten)
  }

  // --- {label}/{seg}.m4s|init.mp4: local-mode segment bytes (S3 mode delivers direct-from-R2) ---
  if (
    !isS3Mode() &&
    pathParts.length === 2 &&
    RENDITION_LABELS.has(pathParts[0]) &&
    SEGMENT_NAME_RE.test(pathParts[1])
  ) {
    const [label, name] = pathParts
    let stream: Readable
    try {
      stream = await downloadFile(`${hlsRoot}/${label}/${name}`)
    } catch {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const contentType = name.toLowerCase().endsWith('.mp4') ? 'video/mp4' : 'video/iso.segment'
    const res = new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, { status: 200 })
    res.headers.set('Content-Type', contentType)
    // Segments are immutable once written; allow private caching for the session.
    res.headers.set('Cache-Control', 'private, max-age=3600')
    return res
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}
