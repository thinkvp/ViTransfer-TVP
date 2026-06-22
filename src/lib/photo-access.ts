import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { getRedis } from '@/lib/redis'
import { getClientIpAddress } from '@/lib/utils'
import { getClientSessionTimeoutSeconds } from '@/lib/settings'
import { isS3Mode, s3GetPresignedStreamUrl } from '@/lib/s3-storage'
import { getStoredFileRecords } from '@/lib/stored-file'

/** Presigned R2 URL validity for album-photo thumbnails (matches the content route's stream TTL). */
const THUMBNAIL_PRESIGN_TTL_SECONDS = 14400

/**
 * S3 mode only: presign direct R2 thumbnail URLs for album photos, keyed by photoId.
 *
 * Lets album/photo grids point each `<img>` straight at R2 instead of proxying every
 * thumbnail through `/api/content/photo` (token verify + DB lookups + existence HEAD +
 * 302 redirect). One StoredFile query plus local URL signing — no per-photo S3 round-trip.
 *
 * Returns an empty map in local-storage mode, and omits any photo that has no THUMBNAIL
 * StoredFile row. Callers fall back to the token-based `/api/content/photo` URL (which
 * also runs the thumbnail→social→original fallback chain). A THUMBNAIL row only exists
 * once the worker has generated it, so presence here implies the thumbnail is ready.
 */
export async function presignAlbumPhotoThumbnailUrls(
  photoIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!isS3Mode() || photoIds.length === 0) return out

  const files = await getStoredFileRecords('ALBUM_PHOTO', photoIds, {
    fileRoles: ['THUMBNAIL'],
    select: { entityId: true, storagePath: true },
  })
  await Promise.all(
    files.map(async (f) => {
      if (!f.storagePath) return
      try {
        out.set(f.entityId, await s3GetPresignedStreamUrl(f.storagePath, THUMBNAIL_PRESIGN_TTL_SECONDS, 'image/jpeg'))
      } catch {
        // Leave unset; the caller falls back to the token URL.
      }
    }),
  )
  return out
}

interface PhotoAccessToken {
  photoId: string
  albumId: string
  projectId: string
  sessionId: string
  ipAddress: string
  createdAt: number
}

export async function generateAlbumPhotoAccessToken(params: {
  photoId: string
  albumId: string
  projectId: string
  request: NextRequest
  sessionId: string
}): Promise<string> {
  const { photoId, albumId, projectId, request, sessionId } = params
  const redis = getRedis()

  const cacheKey = `photo_token_cache:${sessionId}:${photoId}`
  const cached = await redis.get(cacheKey)
  if (cached) {
    const tokenData = await redis.get(`photo_access:${cached}`)
    if (tokenData) return cached
  }

  const token = crypto.randomBytes(16).toString('base64url')
  const ttlSeconds = await getClientSessionTimeoutSeconds()

  const tokenData: PhotoAccessToken = {
    photoId,
    albumId,
    projectId,
    sessionId,
    ipAddress: getClientIpAddress(request),
    createdAt: Date.now(),
  }

  await redis.setex(`photo_access:${token}`, ttlSeconds, JSON.stringify(tokenData))
  await redis.setex(cacheKey, ttlSeconds, token)

  return token
}

export async function verifyAlbumPhotoAccessToken(params: {
  token: string
  request: NextRequest
  sessionId: string
}): Promise<PhotoAccessToken | null> {
  const { token, request, sessionId } = params
  const redis = getRedis()
  const raw = await redis.get(`photo_access:${token}`)
  if (!raw) return null

  let tokenData: PhotoAccessToken
  try {
    tokenData = JSON.parse(raw)
  } catch {
    return null
  }

  if (!tokenData?.photoId || !tokenData?.projectId || !tokenData?.sessionId) return null

  const isAdminSession = sessionId?.startsWith('admin:') || false
  if (!isAdminSession && tokenData.sessionId !== sessionId) return null

  // Soft IP binding (defense-in-depth): only enforce exact match if token has an IP.
  // We do not hard-block on mismatch to avoid breaking mobile networks.
  const requestIp = getClientIpAddress(request)
  if (!isAdminSession && tokenData.ipAddress && requestIp && tokenData.ipAddress !== requestIp) {
    // Intentionally allow (LOG_ONLY behavior for now)
  }

  return tokenData
}
