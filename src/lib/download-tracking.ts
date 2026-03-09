import { prisma } from '@/lib/db'
import { getRedis } from '@/lib/redis'
import { getSecuritySettings } from '@/lib/video-access'

const DOWNLOAD_TRACKING_PREFIX = 'download-tracking:active:'
const DOWNLOAD_TRACKING_FINALIZED_PREFIX = 'download-tracking:finalized:'

export const DOWNLOAD_TRACKING_STALE_MS = 300_000
const DOWNLOAD_TRACKING_TTL_SECONDS = 900
const DOWNLOAD_TRACKING_FINALIZED_TTL_SECONDS = 24 * 60 * 60

type ByteRange = {
  start: number
  end: number
}

type DownloadTrackingRecord = {
  downloadId: string
  projectId: string
  videoId: string
  videoName: string
  versionLabel: string | null
  assetId: string | null
  assetIds: string[] | null
  fileSizeBytes: number | null
  sessionId: string
  ipAddress: string | null
  accessMethod: 'OTP' | 'PASSWORD' | 'GUEST' | 'NONE' | null
  email: string | null
  startedAt: string
  lastProgressAt: string
  ranges: ByteRange[]
}

type RegisterTrackedDownloadInput = {
  downloadId: string
  projectId: string
  videoId: string
  videoName: string
  versionLabel?: string | null
  assetId?: string | null
  assetIds?: string[] | null
  fileSizeBytes?: number | null
  sessionId: string
  ipAddress?: string | null
  accessMethod?: 'OTP' | 'PASSWORD' | 'GUEST' | 'NONE' | null
  email?: string | null
}

type RecordTrackedDownloadProgressInput = {
  downloadId: string
  rangeStart: number
  bytesSent: number
  completeOnRequestEnd?: boolean
}

function getTrackingKey(downloadId: string) {
  return `${DOWNLOAD_TRACKING_PREFIX}${downloadId}`
}

function getFinalizedKey(downloadId: string) {
  return `${DOWNLOAD_TRACKING_FINALIZED_PREFIX}${downloadId}`
}

function parseTrackingRecord(raw: string | null): DownloadTrackingRecord | null {
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as DownloadTrackingRecord
    if (!parsed?.downloadId || !parsed?.projectId || !parsed?.videoId || !parsed?.sessionId) {
      return null
    }
    return {
      ...parsed,
      ranges: Array.isArray(parsed.ranges)
        ? parsed.ranges.filter((range): range is ByteRange => (
            typeof range?.start === 'number' &&
            typeof range?.end === 'number' &&
            Number.isFinite(range.start) &&
            Number.isFinite(range.end) &&
            range.end >= range.start
          ))
        : [],
    }
  } catch {
    return null
  }
}

function mergeByteRange(ranges: ByteRange[], start: number, end: number): ByteRange[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return ranges
  }

  const next = [...ranges, { start, end }].sort((left, right) => left.start - right.start)
  const merged: ByteRange[] = []

  for (const range of next) {
    const last = merged[merged.length - 1]
    if (!last) {
      merged.push(range)
      continue
    }

    if (range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end)
      continue
    }

    merged.push(range)
  }

  return merged
}

function getTrackedBytes(ranges: ByteRange[]): number {
  return ranges.reduce((total, range) => total + ((range.end - range.start) + 1), 0)
}

function calculateAverageMbps(bytesTransferred: number, durationMs: number): number | null {
  if (bytesTransferred <= 0 || durationMs <= 0) return null
  return (bytesTransferred * 8) / (durationMs / 1000) / (1024 * 1024)
}

async function finalizeTrackedDownload(
  record: DownloadTrackingRecord,
  eventType: 'DOWNLOAD_SUCCEEDED' | 'DOWNLOAD_FAILED',
  details: Record<string, unknown>,
) {
  const redis = getRedis()
  const finalized = await redis.set(
    getFinalizedKey(record.downloadId),
    eventType,
    'EX',
    DOWNLOAD_TRACKING_FINALIZED_TTL_SECONDS,
    'NX',
  )

  if (!finalized) {
    await redis.del(getTrackingKey(record.downloadId)).catch(() => undefined)
    return
  }

  await redis.del(getTrackingKey(record.downloadId)).catch(() => undefined)

  const settings = await getSecuritySettings()
  if (!settings.trackAnalytics) {
    return
  }

  await prisma.videoAnalytics.create({
    data: {
      videoId: record.videoId,
      projectId: record.projectId,
      eventType,
      assetId: record.assetId,
      assetIds: record.assetIds ? JSON.stringify(record.assetIds) : undefined,
      ipAddress: record.ipAddress || undefined,
      sessionId: record.sessionId,
      accessMethod: record.accessMethod || undefined,
      email: record.email || undefined,
      details: details as any,
    },
  })

  if (eventType === 'DOWNLOAD_SUCCEEDED') {
    console.log('[DOWNLOAD] Completed successfully', {
      downloadId: record.downloadId,
      videoId: record.videoId,
      videoName: record.videoName,
      versionLabel: record.versionLabel,
      averageMbps: details.averageMbps,
      bytesTransferred: details.bytesTransferred,
    })
    return
  }

  console.warn('[DOWNLOAD] Marked failed', {
    downloadId: record.downloadId,
    videoId: record.videoId,
    videoName: record.videoName,
    versionLabel: record.versionLabel,
    bytesTransferred: details.bytesTransferred,
    failureReason: details.failureReason,
  })
}

export async function registerTrackedDownload(input: RegisterTrackedDownloadInput): Promise<void> {
  if (!input.downloadId || !input.sessionId || input.sessionId.startsWith('admin:')) {
    return
  }

  const redis = getRedis()
  const key = getTrackingKey(input.downloadId)
  const nowIso = new Date().toISOString()
  const record: DownloadTrackingRecord = {
    downloadId: input.downloadId,
    projectId: input.projectId,
    videoId: input.videoId,
    videoName: input.videoName,
    versionLabel: input.versionLabel ?? null,
    assetId: input.assetId ?? null,
    assetIds: input.assetIds ?? null,
    fileSizeBytes: input.fileSizeBytes ?? null,
    sessionId: input.sessionId,
    ipAddress: input.ipAddress ?? null,
    accessMethod: input.accessMethod ?? null,
    email: input.email ?? null,
    startedAt: nowIso,
    lastProgressAt: nowIso,
    ranges: [],
  }

  const created = await redis.set(key, JSON.stringify(record), 'EX', DOWNLOAD_TRACKING_TTL_SECONDS, 'NX')

  if (created) {
    console.log('[DOWNLOAD] Started', {
      downloadId: input.downloadId,
      videoId: input.videoId,
      videoName: input.videoName,
      versionLabel: input.versionLabel ?? null,
      fileSizeBytes: input.fileSizeBytes ?? null,
      assetId: input.assetId ?? null,
      assetIds: input.assetIds ?? null,
    })
  }
}

export async function recordTrackedDownloadProgress(input: RecordTrackedDownloadProgressInput): Promise<void> {
  if (!input.downloadId) {
    return
  }

  const redis = getRedis()
  const key = getTrackingKey(input.downloadId)
  const record = parseTrackingRecord(await redis.get(key))
  if (!record) {
    return
  }

  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  let ranges = record.ranges

  if (input.bytesSent > 0) {
    ranges = mergeByteRange(ranges, input.rangeStart, input.rangeStart + input.bytesSent - 1)
  }

  const bytesTransferred = getTrackedBytes(ranges)
  const durationMs = Math.max(0, now - new Date(record.startedAt).getTime())
  const averageMbps = calculateAverageMbps(bytesTransferred, durationMs)

  if (input.completeOnRequestEnd || (record.fileSizeBytes != null && bytesTransferred >= record.fileSizeBytes)) {
    await finalizeTrackedDownload(record, 'DOWNLOAD_SUCCEEDED', {
      downloadId: record.downloadId,
      bytesTransferred,
      durationMs,
      averageMbps,
      fileSizeBytes: record.fileSizeBytes,
      failed: false,
      legacy: false,
    })
    return
  }

  const nextRecord: DownloadTrackingRecord = {
    ...record,
    lastProgressAt: input.bytesSent > 0 ? nowIso : record.lastProgressAt,
    ranges,
  }

  await redis.set(key, JSON.stringify(nextRecord), 'EX', DOWNLOAD_TRACKING_TTL_SECONDS)
}

export async function failTrackedDownloadNow(downloadId: string, failureReason: string): Promise<void> {
  if (!downloadId) {
    return
  }

  const redis = getRedis()
  const key = getTrackingKey(downloadId)
  const record = parseTrackingRecord(await redis.get(key))
  if (!record) {
    return
  }

  const lastProgressAt = new Date(record.lastProgressAt).getTime()
  const bytesTransferred = getTrackedBytes(record.ranges)
  const durationMs = Math.max(0, lastProgressAt - new Date(record.startedAt).getTime())

  await finalizeTrackedDownload(record, 'DOWNLOAD_FAILED', {
    downloadId: record.downloadId,
    bytesTransferred,
    durationMs,
    averageMbps: calculateAverageMbps(bytesTransferred, durationMs),
    fileSizeBytes: record.fileSizeBytes,
    failureReason,
    failed: true,
    legacy: false,
  })
}

export async function cleanupStaleTrackedDownloads(limit: number = 250): Promise<number> {
  const redis = getRedis()
  const now = Date.now()
  let cleaned = 0

  const stream = redis.scanStream({ match: `${DOWNLOAD_TRACKING_PREFIX}*`, count: 100 })

  for await (const keys of stream) {
    for (const key of keys as string[]) {
      if (cleaned >= limit) {
        return cleaned
      }

      const record = parseTrackingRecord(await redis.get(key))
      if (!record) {
        await redis.del(key).catch(() => undefined)
        continue
      }

      const lastProgressAt = new Date(record.lastProgressAt).getTime()
      if (!Number.isFinite(lastProgressAt) || (now - lastProgressAt) < DOWNLOAD_TRACKING_STALE_MS) {
        continue
      }

      const bytesTransferred = getTrackedBytes(record.ranges)
      const durationMs = Math.max(0, lastProgressAt - new Date(record.startedAt).getTime())

      await finalizeTrackedDownload(record, 'DOWNLOAD_FAILED', {
        downloadId: record.downloadId,
        bytesTransferred,
        durationMs,
        averageMbps: calculateAverageMbps(bytesTransferred, durationMs),
        fileSizeBytes: record.fileSizeBytes,
        failureReason: 'stalled',
        failed: true,
        legacy: false,
      })

      cleaned += 1
    }
  }

  return cleaned
}