import crypto from 'crypto'
import { type NextRequest } from 'next/server'
import { getRedis } from '@/lib/redis'
import { getClientSessionTimeoutSeconds } from '@/lib/settings'
import { getClientIpAddress } from '@/lib/utils'

interface ShareUploadAccessTokenData {
  projectId: string
  fileId: string
  storagePath: string
  fileName: string
  fileType: string
  fileSize: number
  sessionId: string | null
  ipAddress: string
  createdAt: number
}

const SHARE_UPLOAD_ACCESS_PREFIX = 'share_upload_access:'

export async function generateShareUploadAccessToken(params: {
  projectId: string
  fileId: string
  storagePath: string
  fileName: string
  fileType: string
  fileSize: number
  request: NextRequest
  sessionId: string | null
  ttlSeconds?: number
}): Promise<string> {
  const redis = getRedis()
  const token = crypto.randomBytes(16).toString('base64url')
  const sessionTtlSeconds = await getClientSessionTimeoutSeconds()
  const ttlSeconds = Math.max(60, params.ttlSeconds ?? sessionTtlSeconds)

  const payload: ShareUploadAccessTokenData = {
    projectId: params.projectId,
    fileId: params.fileId,
    storagePath: params.storagePath,
    fileName: params.fileName,
    fileType: params.fileType,
    fileSize: params.fileSize,
    sessionId: params.sessionId,
    ipAddress: getClientIpAddress(params.request),
    createdAt: Date.now(),
  }

  await redis.setex(`${SHARE_UPLOAD_ACCESS_PREFIX}${token}`, ttlSeconds, JSON.stringify(payload))
  return token
}

export async function consumeShareUploadAccessToken(
  token: string,
  request: NextRequest,
): Promise<ShareUploadAccessTokenData | null> {
  const redis = getRedis()
  const key = `${SHARE_UPLOAD_ACCESS_PREFIX}${token}`
  const payload = await redis.get(key)
  if (!payload) return null

  let data: ShareUploadAccessTokenData
  try {
    data = JSON.parse(payload)
  } catch {
    return null
  }

  if (!data?.projectId || !data?.storagePath || !data?.fileName || !data?.fileId) {
    return null
  }

  const requestIp = getClientIpAddress(request)
  if (data.ipAddress && requestIp && data.ipAddress !== requestIp) {
    return null
  }

  return data
}
