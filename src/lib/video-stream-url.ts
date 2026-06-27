import { isS3Mode, s3GetPresignedStreamUrl } from '@/lib/s3-storage'
import { getRedis } from '@/lib/redis'

// Presigned stream-URL lifetime. In direct-to-R2 mode (Option B) this URL is the
// credential the browser uses for the *entire* playback/seek session — it is not
// re-minted per range request the way the /api/content redirect was. So it must
// comfortably outlast a long viewing session. Mirrors the TTL the /api/content
// streaming redirect has always used (14400s = 4h).
export const STREAM_URL_TTL_SECONDS = 14400

// How long a minted stream URL is reused from cache. Kept well below the URL's own
// TTL so a cache hit always returns a URL with plenty of remaining validity, while
// still returning the *same* URL across repeated token fetches (window refocus,
// session-recovery refreshes). A stable URL keeps the <video> src stable — re-minting
// a fresh-signature URL each time would churn the src and could itself reset playback
// to the start, which is the very bug Option B exists to fix.
const STREAM_URL_CACHE_SECONDS = 7200

// Main video stream qualities that are eligible for direct-to-R2 delivery. Thumbnails,
// timeline VTT/sprites and downloads deliberately stay on /api/content so their
// per-request gating and analytics are preserved (see getDirectStreamUrl).
const STREAM_QUALITIES = new Set(['480p', '720p', '1080p', 'original'])

/**
 * Resolve the storage path the streaming player should receive for a given quality,
 * applying the same preview→preview→original fallback chain used by the /api/content
 * delivery route. Returns null when nothing suitable is available.
 *
 * `canServeOriginal` must already fold in approval/admin rules — the original is only a
 * legitimate fallback when the caller is actually allowed to serve it.
 *
 * This is the single source of truth for quality→path resolution; both the delivery
 * route and the token-issuing endpoints call it so the two can never drift.
 */
export function resolveStreamStoragePath(
  storedPaths: Map<string, string>,
  quality: string,
  canServeOriginal: boolean,
): string | null {
  const original = canServeOriginal ? (storedPaths.get('ORIGINAL') ?? null) : null
  switch (quality) {
    case '1080p':
      return storedPaths.get('PREVIEW_1080') || storedPaths.get('PREVIEW_720') || storedPaths.get('PREVIEW_480') || original
    case '720p':
      return storedPaths.get('PREVIEW_720') || storedPaths.get('PREVIEW_1080') || storedPaths.get('PREVIEW_480') || original
    case '480p':
      return storedPaths.get('PREVIEW_480') || storedPaths.get('PREVIEW_720') || storedPaths.get('PREVIEW_1080') || original
    case 'original':
    case 'download':
      return original
    default:
      return null
  }
}

/**
 * Option B: when running in S3 mode, build a presigned R2 URL the browser can stream
 * directly, bypassing the /api/content 302 redirect. The redirect-with-Range hop breaks
 * seeking behind some corporate proxies (they drop the Range header across the
 * cross-origin redirect, so a seek returns the whole file from byte 0 and playback
 * resets to the start); handing the element a direct URL removes that hop entirely.
 *
 * Returns null — so callers fall back to the token-gated /api/content URL — when:
 *  - not in S3 mode (local disk still streams same-origin 206s, which proxies handle),
 *  - the quality is not a main video stream (thumbnails/timeline/downloads stay gated),
 *  - the requested quality has no servable file, or
 *  - STREAM_DIRECT_FROM_R2 is explicitly disabled (kill-switch, no redeploy needed).
 *
 * Access is authorized once, here, at issue time — the caller has already verified the
 * share/guest session and approval state. The trade-off (no per-range revocation, coarser
 * streaming analytics) is documented where this is wired up.
 */
export async function getDirectStreamUrl(params: {
  storedPaths: Map<string, string>
  quality: string
  canServeOriginal: boolean
  // Used only to key the reuse cache so repeated fetches return a stable URL.
  sessionId: string
  videoId: string
}): Promise<string | null> {
  if (!directStreamingEnabled()) return null
  if (!STREAM_QUALITIES.has(params.quality)) return null

  const path = resolveStreamStoragePath(params.storedPaths, params.quality, params.canServeOriginal)
  if (!path) return null

  return presignCachedStreamUrl(path, `stream_url:${params.sessionId}:${params.videoId}:${params.quality}:${path}`)
}

function directStreamingEnabled(): boolean {
  return isS3Mode() && process.env.STREAM_DIRECT_FROM_R2 !== 'false'
}

/** Same-origin, token-scoped master-playlist URL the player hands to hls.js. */
export function buildHlsMasterUrl(token: string): string {
  return `/api/hls/${token}/master.m3u8`
}

// HLS packaging format version stamped on Video.hlsVersion. Bump when the on-disk format
// changes in a way the player must distinguish. v1 = keyframe-aligned renditions, so the
// player may enable hls.js adaptive-bitrate switching; v0 = none/legacy (ABR-unsafe).
export const HLS_PACKAGE_VERSION = 1

/** Whether a video's stored HLS bundle is keyframe-aligned and safe for ABR switching. */
export function hlsAbrReady(hlsVersion: number | null | undefined): boolean {
  return (hlsVersion ?? 0) >= HLS_PACKAGE_VERSION
}

/**
 * Presign a stream URL for `path`, reusing a previously-minted URL from Redis when one
 * exists for `cacheKey`. Reuse keeps the player's <video> src byte-for-byte stable
 * across refreshes — re-minting a fresh-signature URL each time would churn the src and
 * could itself reset playback to the start. The path is part of every cache key so a
 * newly-available preview naturally supersedes a stale entry. Best-effort: any Redis
 * hiccup just falls through to minting a fresh (still valid) URL.
 */
async function presignCachedStreamUrl(path: string, cacheKey: string): Promise<string> {
  const redis = getRedis()
  try {
    const cached = await redis.get(cacheKey)
    if (cached) return cached
  } catch {
    // ignore and mint fresh
  }

  const url = await s3GetPresignedStreamUrl(path, STREAM_URL_TTL_SECONDS, 'video/mp4')
  try {
    await redis.setex(cacheKey, STREAM_URL_CACHE_SECONDS, url)
  } catch {
    // ignore cache write failures
  }
  return url
}
