import os from 'os'

const DEFAULT_VIDEO_CPU_BUDGET_FRACTION = 0.5
const MAX_FFMPEG_THREADS_PER_JOB = 12

export interface CpuAllocation {
  effectiveThreads: number
  budgetThreads: number
  videoWorkerConcurrency: number
  ffmpegThreadsPerJob: number
  timelineThreadsPerJob: number
  maxThreadsUsedEstimate: number
  overrides: {
    CPU_THREADS?: number
    VIDEO_WORKER_CONCURRENCY?: number
    FFMPEG_THREADS_PER_JOB?: number
  }
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

function getDesiredVideoConcurrency(effectiveThreads: number): number {
  // Mirrors the fork's existing heuristic (previously based on cores).
  if (effectiveThreads <= 4) return 1
  if (effectiveThreads <= 8) return 2
  return 3
}

/**
 * Centralized CPU allocation for video processing.
 *
 * Goal: keep FFmpeg workload (videos + timeline sprites) around ~50% of available CPU threads.
 *
 * Why env-based?
 * - In containers, `os.cpus().length` can reflect host CPU, not the container quota.
 * - These settings are infra-level controls, not per-project settings.
 */
export function getCpuAllocation(): CpuAllocation {
  const overrideCpuThreads = parsePositiveIntEnv('CPU_THREADS')
  const overrideConcurrency = parsePositiveIntEnv('VIDEO_WORKER_CONCURRENCY')
  const overrideThreadsPerJob = parsePositiveIntEnv('FFMPEG_THREADS_PER_JOB')

  const detectedThreads = os.cpus().length
  const effectiveThreads = overrideCpuThreads ?? detectedThreads

  const budgetThreads = Math.max(1, Math.floor(effectiveThreads * DEFAULT_VIDEO_CPU_BUDGET_FRACTION))

  const desiredConcurrency = getDesiredVideoConcurrency(effectiveThreads)
  const videoWorkerConcurrency = overrideConcurrency
    ? clampInt(overrideConcurrency, 1, 999)
    : clampInt(desiredConcurrency, 1, budgetThreads)

  const computedThreadsPerJob = clampInt(
    Math.floor(budgetThreads / Math.max(1, videoWorkerConcurrency)),
    1,
    MAX_FFMPEG_THREADS_PER_JOB
  )

  const ffmpegThreadsPerJob = overrideThreadsPerJob
    ? clampInt(overrideThreadsPerJob, 1, MAX_FFMPEG_THREADS_PER_JOB)
    : computedThreadsPerJob

  // Keep sprites simple: same budget as transcode.
  const timelineThreadsPerJob = ffmpegThreadsPerJob

  const maxThreadsUsedEstimate = videoWorkerConcurrency * ffmpegThreadsPerJob

  return {
    effectiveThreads,
    budgetThreads,
    videoWorkerConcurrency,
    ffmpegThreadsPerJob,
    timelineThreadsPerJob,
    maxThreadsUsedEstimate,
    overrides: {
      CPU_THREADS: overrideCpuThreads,
      VIDEO_WORKER_CONCURRENCY: overrideConcurrency,
      FFMPEG_THREADS_PER_JOB: overrideThreadsPerJob,
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

  console.log(`[CPU CONFIG] Available threads: ${allocation.effectiveThreads}`)
  console.log(`[CPU CONFIG] Budget (videos/sprites): ${allocation.budgetThreads} (~${Math.round(DEFAULT_VIDEO_CPU_BUDGET_FRACTION * 100)}%)`)
  console.log(`[CPU CONFIG] Video worker concurrency: ${allocation.videoWorkerConcurrency}`)
  console.log(`[CPU CONFIG] FFmpeg threads/job: ${allocation.ffmpegThreadsPerJob}`)
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
