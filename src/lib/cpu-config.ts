import os from 'os'

const MAX_FFMPEG_THREADS_PER_JOB = 12

export interface CpuAllocation {
  effectiveThreads: number
  reservedSystemThreads: number
  budgetThreads: number
  videoWorkerConcurrency: number
  ffmpegThreadsPerJob: number
  timelineThreadsPerJob: number
  maxThreadsUsedEstimate: number
  dynamicThreadAllocation: boolean
  overrides: {
    CPU_THREADS?: number
    VIDEO_WORKER_CONCURRENCY?: number
    FFMPEG_THREADS_PER_JOB?: number
    TIMELINE_FFMPEG_THREADS_PER_JOB?: number
  }
}

// ---------------------------------------------------------------------------
// Redis-backed overrides — the admin settings page can persist CPU config
// overrides to Redis so the worker process picks them up without needing
// env-var changes or container restarts.  The overrides are loaded
// asynchronously and cached in process-level variables so the synchronous
// getCpuAllocation() can read them.
// ---------------------------------------------------------------------------
export const CPU_CONFIG_REDIS_KEY = 'cpu:config'

export interface CpuConfigOverrides {
  ffmpegThreadsPerJob?: number
  videoWorkerConcurrency?: number
  dynamicThreadAllocation?: boolean
}

let _cachedOverrides: CpuConfigOverrides = {}

/**
 * Load CPU config overrides from Redis into process-level cache.
 * Call periodically in the worker (e.g. every 60s) and on startup.
 */
export async function loadCpuConfigOverrides(redis: { hgetall: (key: string) => Promise<Record<string, string>> }): Promise<CpuConfigOverrides> {
  try {
    const raw = await redis.hgetall(CPU_CONFIG_REDIS_KEY)
    if (!raw || Object.keys(raw).length === 0) {
      _cachedOverrides = {}
      return _cachedOverrides
    }

    _cachedOverrides = {}
    if (raw.ffmpegThreadsPerJob) {
      const v = parseInt(raw.ffmpegThreadsPerJob, 10)
      if (Number.isFinite(v) && v > 0) _cachedOverrides.ffmpegThreadsPerJob = v
    }
    if (raw.videoWorkerConcurrency) {
      const v = parseInt(raw.videoWorkerConcurrency, 10)
      if (Number.isFinite(v) && v > 0) _cachedOverrides.videoWorkerConcurrency = v
    }
    if (raw.dynamicThreadAllocation !== undefined) {
      _cachedOverrides.dynamicThreadAllocation = raw.dynamicThreadAllocation !== 'false'
    }
    return _cachedOverrides
  } catch (error) {
    console.error('[CPU CONFIG] Failed to load overrides from Redis:', error)
    return _cachedOverrides
  }
}

/** Get the currently cached Redis overrides (synchronous). */
export function getCachedCpuConfigOverrides(): CpuConfigOverrides {
  return _cachedOverrides
}

// ---------------------------------------------------------------------------
// Dynamic thread scaling — when fewer jobs are active than max concurrency,
// each running FFmpeg process is allowed more threads so idle CPU budget
// isn't wasted.  The counter is process-global (worker is single-process).
// ---------------------------------------------------------------------------
let _activeVideoJobs = 0

/** Call when a video processing job starts (before FFmpeg). */
export function incrementActiveVideoJobs(): void {
  _activeVideoJobs++
}

/** Call when a video processing job finishes or fails (in `finally`). */
export function decrementActiveVideoJobs(): void {
  _activeVideoJobs = Math.max(0, _activeVideoJobs - 1)
}

/** Current number of active video processing jobs. */
export function getActiveVideoJobs(): number {
  return _activeVideoJobs
}

/**
 * Return the number of FFmpeg threads a single job should use *right now*,
 * taking the current active-job count into account.
 *
 * Formula: `floor(configuredFfmpegPool / max(1, activeJobs))`, where the
 * configured pool is `ffmpegThreadsPerJob * videoWorkerConcurrency`.
 *
 * This means a single running job can consume the full configured FFmpeg
 * allocation, while multiple concurrent jobs divide that same configured pool.
 */
export function getDynamicThreadsPerJob(): { threads: number; activeJobs: number } {
  const alloc = getCpuAllocation()
  const active = Math.max(1, _activeVideoJobs)

  // When dynamic allocation is disabled, always use the static baseline
  if (!alloc.dynamicThreadAllocation) {
    return { threads: alloc.ffmpegThreadsPerJob, activeJobs: active }
  }

  const configuredPool = Math.max(1, alloc.maxThreadsUsedEstimate)

  const threads = clampInt(
    Math.floor(configuredPool / active),
    1,
    configuredPool
  )

  return { threads, activeJobs: active }
}

function parsePositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function getReservedSystemThreads(effectiveThreads: number): number {
  if (effectiveThreads <= 4) return 2
  return 4
}

function getDesiredVideoConcurrency(effectiveThreads: number): number {
  // Mirrors the fork's existing heuristic (previously based on cores).
  if (effectiveThreads <= 4) return 1
  if (effectiveThreads <= 8) return 2
  return 3
}

/**
 * Centralized CPU allocation for video processing.
 *
 * Goal: reserve a small number of CPU threads for the OS/app stack and allow
 * FFmpeg workload (videos + timeline sprites) to use the remaining threads.
 *
 * Why env-based?
 * - In containers, `os.cpus().length` can reflect host CPU, not the container quota.
 * - These settings are infra-level controls, not per-project settings.
 */
export function getCpuAllocation(redisOverrides: CpuConfigOverrides = _cachedOverrides): CpuAllocation {
  const overrideCpuThreads = parsePositiveIntEnv('CPU_THREADS')
  const overrideConcurrency = parsePositiveIntEnv('VIDEO_WORKER_CONCURRENCY')
  const overrideThreadsPerJob = parsePositiveIntEnv('FFMPEG_THREADS_PER_JOB')

  const detectedThreads = os.cpus().length
  const effectiveThreads = overrideCpuThreads ?? detectedThreads

  const reservedSystemThreads = Math.min(
    Math.max(0, effectiveThreads - 1),
    getReservedSystemThreads(effectiveThreads)
  )
  const budgetThreads = Math.max(1, effectiveThreads - reservedSystemThreads)

  const desiredConcurrency = getDesiredVideoConcurrency(effectiveThreads)
  // Redis override → env override → computed default
  const effectiveConcurrencyOverride = redisOverrides.videoWorkerConcurrency ?? overrideConcurrency
  const videoWorkerConcurrency = effectiveConcurrencyOverride
    ? clampInt(effectiveConcurrencyOverride, 1, 999)
    : clampInt(desiredConcurrency, 1, budgetThreads)

  const computedThreadsPerJob = clampInt(
    Math.floor(budgetThreads / Math.max(1, videoWorkerConcurrency)),
    1,
    MAX_FFMPEG_THREADS_PER_JOB
  )

  // Redis override → env override → computed default
  const effectiveThreadsPerJobOverride = redisOverrides.ffmpegThreadsPerJob ?? overrideThreadsPerJob
  const ffmpegThreadsPerJob = effectiveThreadsPerJobOverride
    ? clampInt(effectiveThreadsPerJobOverride, 1, MAX_FFMPEG_THREADS_PER_JOB)
    : computedThreadsPerJob

  // Auxiliary image extraction (currently thumbnails) can be tuned separately
  // from main transcodes via TIMELINE_FFMPEG_THREADS_PER_JOB.
  const overrideTimelineThreadsPerJob = parsePositiveIntEnv('TIMELINE_FFMPEG_THREADS_PER_JOB')
  const timelineThreadsPerJob = overrideTimelineThreadsPerJob
    ? clampInt(overrideTimelineThreadsPerJob, 1, MAX_FFMPEG_THREADS_PER_JOB)
    : ffmpegThreadsPerJob

  const maxThreadsUsedEstimate = videoWorkerConcurrency * ffmpegThreadsPerJob

  const dynamicThreadAllocation = redisOverrides.dynamicThreadAllocation ?? true

  return {
    effectiveThreads,
    reservedSystemThreads,
    budgetThreads,
    videoWorkerConcurrency,
    ffmpegThreadsPerJob,
    timelineThreadsPerJob,
    maxThreadsUsedEstimate,
    dynamicThreadAllocation,
    overrides: {
      CPU_THREADS: overrideCpuThreads,
      VIDEO_WORKER_CONCURRENCY: effectiveConcurrencyOverride,
      FFMPEG_THREADS_PER_JOB: effectiveThreadsPerJobOverride,
      TIMELINE_FFMPEG_THREADS_PER_JOB: overrideTimelineThreadsPerJob,
    },
  }
}

export function logCpuAllocation(allocation: CpuAllocation): void {
  const utilizationPercent = Math.round((allocation.maxThreadsUsedEstimate / allocation.effectiveThreads) * 100)

  const overrideParts: string[] = []
  if (allocation.overrides.CPU_THREADS) overrideParts.push(`CPU_THREADS=${allocation.overrides.CPU_THREADS}`)
  if (allocation.overrides.VIDEO_WORKER_CONCURRENCY)
    overrideParts.push(`VIDEO_WORKER_CONCURRENCY=${allocation.overrides.VIDEO_WORKER_CONCURRENCY}`)
  if (allocation.overrides.FFMPEG_THREADS_PER_JOB)
    overrideParts.push(`FFMPEG_THREADS_PER_JOB=${allocation.overrides.FFMPEG_THREADS_PER_JOB}`)
  if (allocation.overrides.TIMELINE_FFMPEG_THREADS_PER_JOB)
    overrideParts.push(`TIMELINE_FFMPEG_THREADS_PER_JOB=${allocation.overrides.TIMELINE_FFMPEG_THREADS_PER_JOB}`)

  console.log(`[CPU CONFIG] Available threads: ${allocation.effectiveThreads}`)
  console.log(`[CPU CONFIG] Reserved for system/app: ${allocation.reservedSystemThreads}`)
  console.log(`[CPU CONFIG] Budget (videos/sprites): ${allocation.budgetThreads}`)
  console.log(`[CPU CONFIG] Video worker concurrency: ${allocation.videoWorkerConcurrency}`)
  console.log(`[CPU CONFIG] FFmpeg threads/job (static baseline): ${allocation.ffmpegThreadsPerJob}`)
  const dynamicMaxThreads = allocation.dynamicThreadAllocation
    ? allocation.maxThreadsUsedEstimate
    : allocation.ffmpegThreadsPerJob
  console.log(`[CPU CONFIG] FFmpeg threads/job (dynamic range): ${allocation.ffmpegThreadsPerJob}–${dynamicMaxThreads} (scales up when fewer jobs are active)`)
  console.log(`[CPU CONFIG] Auxiliary image threads/job: ${allocation.timelineThreadsPerJob} (set TIMELINE_FFMPEG_THREADS_PER_JOB to override)`)
  console.log(`[CPU CONFIG] Estimated max FFmpeg threads used: ${allocation.maxThreadsUsedEstimate}/${allocation.effectiveThreads} (~${utilizationPercent}%)`)

  if (overrideParts.length > 0) {
    console.log(`[CPU CONFIG] Overrides: ${overrideParts.join(', ')}`)
  }

  if (allocation.maxThreadsUsedEstimate > allocation.budgetThreads) {
    console.warn(
      `[CPU CONFIG] WARNING: configured max FFmpeg threads (${allocation.maxThreadsUsedEstimate}) exceeds budget (${allocation.budgetThreads}). ` +
        `Consider lowering VIDEO_WORKER_CONCURRENCY or FFMPEG_THREADS_PER_JOB.`
    )
  }
}
