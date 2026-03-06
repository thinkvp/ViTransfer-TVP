import { getRedis } from '@/lib/redis'

export const CLIENT_ACTIVITY_TTL_SECONDS = 120

const CLIENT_ACTIVITY_INDEX_KEY = 'client-activity:index'
const CLIENT_ACTIVITY_SESSION_PREFIX = 'client-activity:session:'
const CLIENT_ACTIVITY_THROTTLE_PREFIX = 'client-activity:throttle:'

export type ClientActivityType =
  | 'VIEWING_SHARE_PAGE'
  | 'STREAMING_VIDEO'
  | 'DOWNLOADING_VIDEO'
  | 'DOWNLOADING_ASSET'

export type ClientActivityRecord = {
  sessionId: string
  projectId: string
  projectTitle: string | null
  videoId: string | null
  videoName: string | null
  assetId: string | null
  assetName: string | null
  activityType: ClientActivityType
  accessMethod: 'OTP' | 'PASSWORD' | 'GUEST' | 'NONE' | null
  email: string | null
  ipAddress: string | null
  firstSeenAt: string
  updatedAt: string
}

type RecordClientActivityInput = {
  sessionId: string
  projectId: string
  projectTitle?: string | null
  videoId?: string | null
  videoName?: string | null
  assetId?: string | null
  assetName?: string | null
  activityType: ClientActivityType
  accessMethod?: 'OTP' | 'PASSWORD' | 'GUEST' | 'NONE' | null
  email?: string | null
  ipAddress?: string | null
  throttleKey?: string | null
  throttleSeconds?: number
}

function getSessionKey(sessionId: string) {
  return `${CLIENT_ACTIVITY_SESSION_PREFIX}${sessionId}`
}

function getThrottleKey(rawKey: string) {
  return `${CLIENT_ACTIVITY_THROTTLE_PREFIX}${rawKey}`
}

function parseClientActivity(raw: string | null): ClientActivityRecord | null {
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as ClientActivityRecord
    if (!parsed?.sessionId || !parsed?.projectId || !parsed?.activityType || !parsed?.updatedAt || !parsed?.firstSeenAt) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export async function recordClientActivity(input: RecordClientActivityInput): Promise<void> {
  if (!input.sessionId || input.sessionId.startsWith('admin:')) {
    return
  }

  try {
    const redis = getRedis()

    if (input.throttleKey) {
      const throttleApplied = await redis.set(
        getThrottleKey(input.throttleKey),
        '1',
        'EX',
        input.throttleSeconds ?? 15,
        'NX',
      )

      if (!throttleApplied) {
        return
      }
    }

    const sessionKey = getSessionKey(input.sessionId)
    const now = Date.now()
    const nowIso = new Date(now).toISOString()
    const existing = parseClientActivity(await redis.get(sessionKey))

    const nextRecord: ClientActivityRecord = {
      sessionId: input.sessionId,
      projectId: input.projectId,
      projectTitle: input.projectTitle ?? existing?.projectTitle ?? null,
      videoId: input.videoId ?? existing?.videoId ?? null,
      videoName: input.videoName ?? existing?.videoName ?? null,
      assetId: input.assetId ?? existing?.assetId ?? null,
      assetName: input.assetName ?? existing?.assetName ?? null,
      activityType: input.activityType,
      accessMethod: input.accessMethod ?? existing?.accessMethod ?? null,
      email: input.email ?? existing?.email ?? null,
      ipAddress: input.ipAddress ?? existing?.ipAddress ?? null,
      firstSeenAt: existing?.firstSeenAt ?? nowIso,
      updatedAt: nowIso,
    }

    const cutoff = now - (CLIENT_ACTIVITY_TTL_SECONDS * 1000) - 1000
    const pipeline = redis.pipeline()
    pipeline.setex(sessionKey, CLIENT_ACTIVITY_TTL_SECONDS, JSON.stringify(nextRecord))
    pipeline.zadd(CLIENT_ACTIVITY_INDEX_KEY, now, input.sessionId)
    pipeline.zremrangebyscore(CLIENT_ACTIVITY_INDEX_KEY, 0, cutoff)
    await pipeline.exec()
  } catch (error) {
    console.error('[CLIENT_ACTIVITY] Failed to record activity:', error)
  }
}

export async function listActiveClientActivities(limit: number = 25): Promise<ClientActivityRecord[]> {
  try {
    const redis = getRedis()
    const cutoff = Date.now() - (CLIENT_ACTIVITY_TTL_SECONDS * 1000)
    const sessionIds = await redis.zrevrangebyscore(
      CLIENT_ACTIVITY_INDEX_KEY,
      '+inf',
      cutoff,
      'LIMIT',
      0,
      Math.max(limit * 3, limit),
    )

    if (sessionIds.length === 0) {
      return []
    }

    const rawRecords = await redis.mget(sessionIds.map((sessionId) => getSessionKey(sessionId)))
    const records = rawRecords
      .map((raw) => parseClientActivity(raw))
      .filter((record): record is ClientActivityRecord => !!record)
      .filter((record) => new Date(record.updatedAt).getTime() >= cutoff)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

    return records.slice(0, limit)
  } catch (error) {
    console.error('[CLIENT_ACTIVITY] Failed to list activity:', error)
    return []
  }
}