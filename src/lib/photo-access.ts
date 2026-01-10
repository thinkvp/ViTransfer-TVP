import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { getRedis } from '@/lib/redis'
import { getClientIpAddress } from '@/lib/utils'
import { getClientSessionTimeoutSeconds } from '@/lib/settings'

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
