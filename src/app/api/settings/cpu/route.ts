import os from 'os'
import { NextRequest, NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getRedis } from '@/lib/redis'
import { getCpuAllocation, CPU_CONFIG_REDIS_KEY, loadCpuConfigOverrides, CpuConfigOverrides, readWorkerCpuInfo } from '@/lib/cpu-config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_FFMPEG_THREADS = 12

function parseRedisOverrideInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60_000, maxRequests: 60, message: 'Too many requests.' },
    'cpu-settings-read'
  )
  if (rateLimitResult) return rateLimitResult

  const redis = getRedis()
  await loadCpuConfigOverrides(redis)
  const raw = await redis.hgetall(CPU_CONFIG_REDIS_KEY)
  const overrides: Record<string, number | boolean | null> = {
    ffmpegThreadsPerJob: raw.ffmpegThreadsPerJob ? parseInt(raw.ffmpegThreadsPerJob, 10) : null,
    videoWorkerConcurrency: raw.videoWorkerConcurrency ? parseInt(raw.videoWorkerConcurrency, 10) : null,
    dynamicThreadAllocation: raw.dynamicThreadAllocation !== undefined ? raw.dynamicThreadAllocation !== 'false' : null,
  }

  // Prefer the worker-published CPU snapshot: in split deployments (app and
  // worker on different hosts) the app's own os.cpus() describes the wrong
  // machine — the worker is where FFmpeg actually runs.
  const workerReport = await readWorkerCpuInfo(redis)

  if (workerReport) {
    const { info, stale } = workerReport
    return NextResponse.json({
      system: {
        detectedThreads: info.effectiveThreads,
        reservedSystemThreads: info.reservedSystemThreads,
        budgetThreads: info.budgetThreads,
        maxFfmpegThreadsPerJob: MAX_FFMPEG_THREADS,
      },
      current: {
        ffmpegThreadsPerJob: info.ffmpegThreadsPerJob,
        videoWorkerConcurrency: info.videoWorkerConcurrency,
        dynamicThreadAllocation: info.dynamicThreadAllocation,
      },
      overrides,
      worker: {
        hostname: info.hostname,
        updatedAt: info.updatedAt,
        stale,
        runningVideoConcurrency: info.runningVideoConcurrency,
      },
    })
  }

  // No worker snapshot (worker not yet updated/started) — fall back to
  // detecting this host, as before.
  const detectedThreads = os.cpus().length
  const allocation = getCpuAllocation()

  return NextResponse.json({
    system: {
      detectedThreads,
      reservedSystemThreads: allocation.reservedSystemThreads,
      budgetThreads: allocation.budgetThreads,
      maxFfmpegThreadsPerJob: MAX_FFMPEG_THREADS,
    },
    current: {
      ffmpegThreadsPerJob: allocation.ffmpegThreadsPerJob,
      videoWorkerConcurrency: allocation.videoWorkerConcurrency,
      dynamicThreadAllocation: allocation.dynamicThreadAllocation,
    },
    overrides,
    worker: null,
  })
}

export async function PATCH(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeSettings')
  if (forbiddenAction) return forbiddenAction

  const body = await request.json()
  const { ffmpegThreadsPerJob, videoWorkerConcurrency, dynamicThreadAllocation } = body

  if (ffmpegThreadsPerJob !== undefined && ffmpegThreadsPerJob !== null) {
    const val = parseInt(ffmpegThreadsPerJob, 10)
    if (!Number.isFinite(val) || val < 1 || val > MAX_FFMPEG_THREADS) {
      return NextResponse.json(
        { error: `FFmpeg threads per job must be between 1 and ${MAX_FFMPEG_THREADS}` },
        { status: 400 }
      )
    }
  }

  if (videoWorkerConcurrency !== undefined && videoWorkerConcurrency !== null) {
    const val = parseInt(videoWorkerConcurrency, 10)
    if (!Number.isFinite(val) || val < 1 || val > 20) {
      return NextResponse.json(
        { error: 'Worker concurrency must be between 1 and 20' },
        { status: 400 }
      )
    }
  }

  const redis = getRedis()
  await loadCpuConfigOverrides(redis)
  const raw = await redis.hgetall(CPU_CONFIG_REDIS_KEY)

  const proposedOverrides: CpuConfigOverrides = {}

  if (ffmpegThreadsPerJob === undefined) {
    const currentThreadsPerJob = parseRedisOverrideInt(raw.ffmpegThreadsPerJob)
    if (currentThreadsPerJob !== undefined) {
      proposedOverrides.ffmpegThreadsPerJob = currentThreadsPerJob
    }
  } else if (ffmpegThreadsPerJob !== null && ffmpegThreadsPerJob !== '') {
    proposedOverrides.ffmpegThreadsPerJob = parseInt(ffmpegThreadsPerJob, 10)
  }

  if (videoWorkerConcurrency === undefined) {
    const currentConcurrency = parseRedisOverrideInt(raw.videoWorkerConcurrency)
    if (currentConcurrency !== undefined) {
      proposedOverrides.videoWorkerConcurrency = currentConcurrency
    }
  } else if (videoWorkerConcurrency !== null && videoWorkerConcurrency !== '') {
    proposedOverrides.videoWorkerConcurrency = parseInt(videoWorkerConcurrency, 10)
  }

  if (dynamicThreadAllocation === undefined) {
    if (raw.dynamicThreadAllocation !== undefined) {
      proposedOverrides.dynamicThreadAllocation = raw.dynamicThreadAllocation !== 'false'
    }
  } else if (dynamicThreadAllocation !== null) {
    proposedOverrides.dynamicThreadAllocation = !!dynamicThreadAllocation
  }

  // Validate against the worker's CPU when a worker snapshot exists: in split
  // deployments the app host's core count is irrelevant (and typically much
  // smaller), so validating locally would wrongly reject valid configs.
  // A cleared override falls back to the worker's currently-computed value —
  // clearing always reverts toward a computed default within budget, so this
  // is safe even if the snapshot is a few minutes old.
  const workerReport = await readWorkerCpuInfo(redis)

  let estimatedMaxThreads: number
  let systemLimitThreads: number
  let budgetThreads: number
  if (workerReport) {
    const proposedThreadsPerJob = proposedOverrides.ffmpegThreadsPerJob ?? workerReport.info.ffmpegThreadsPerJob
    const proposedConcurrency = proposedOverrides.videoWorkerConcurrency ?? workerReport.info.videoWorkerConcurrency
    estimatedMaxThreads = proposedThreadsPerJob * proposedConcurrency
    systemLimitThreads = workerReport.info.effectiveThreads
    budgetThreads = workerReport.info.budgetThreads
  } else {
    const nextAllocation = getCpuAllocation(proposedOverrides)
    estimatedMaxThreads = nextAllocation.videoWorkerConcurrency * nextAllocation.ffmpegThreadsPerJob
    systemLimitThreads = nextAllocation.effectiveThreads
    budgetThreads = nextAllocation.budgetThreads
  }

  if (estimatedMaxThreads > systemLimitThreads) {
    return NextResponse.json(
      {
        error: `The configured allocation would use ${estimatedMaxThreads} threads, which exceeds the ${workerReport ? "worker's" : 'system'} limit of ${systemLimitThreads}. Reduce FFmpeg threads per job or concurrent jobs.`
      },
      { status: 400 }
    )
  }

  const fields: Record<string, string> = {}

  if (ffmpegThreadsPerJob !== undefined) {
    if (ffmpegThreadsPerJob === null || ffmpegThreadsPerJob === '') {
      await redis.hdel(CPU_CONFIG_REDIS_KEY, 'ffmpegThreadsPerJob')
    } else {
      fields.ffmpegThreadsPerJob = String(parseInt(ffmpegThreadsPerJob, 10))
    }
  }

  if (videoWorkerConcurrency !== undefined) {
    if (videoWorkerConcurrency === null || videoWorkerConcurrency === '') {
      await redis.hdel(CPU_CONFIG_REDIS_KEY, 'videoWorkerConcurrency')
    } else {
      fields.videoWorkerConcurrency = String(parseInt(videoWorkerConcurrency, 10))
    }
  }

  if (dynamicThreadAllocation !== undefined) {
    if (dynamicThreadAllocation === null) {
      await redis.hdel(CPU_CONFIG_REDIS_KEY, 'dynamicThreadAllocation')
    } else {
      fields.dynamicThreadAllocation = String(!!dynamicThreadAllocation)
    }
  }

  if (Object.keys(fields).length > 0) {
    await redis.hset(CPU_CONFIG_REDIS_KEY, fields)
  }

  const warnings: string[] = []
  if (estimatedMaxThreads === systemLimitThreads) {
    warnings.push(
      `The configured allocation uses ${estimatedMaxThreads} of ${systemLimitThreads} available threads, ` +
        'leaving no headroom for the OS and app. Consider reducing threads or concurrency.'
    )
  } else if (estimatedMaxThreads > budgetThreads) {
    warnings.push(
      `The configured allocation uses ${estimatedMaxThreads} threads, which exceeds the recommended FFmpeg budget of ${budgetThreads}. This may cause contention under load.`
    )
  }

  return NextResponse.json({
    success: true,
    warnings: warnings.length > 0 ? warnings : undefined,
  })
}
