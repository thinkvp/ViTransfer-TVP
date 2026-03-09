import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getUserPermissions } from '@/lib/rbac-api'
import { getCpuAllocation, loadCpuConfigOverrides } from '@/lib/cpu-config'
import { getRedis } from '@/lib/redis'
import { getVideoQueue } from '@/lib/queue'

export const runtime = 'nodejs'

/**
 * GET /api/running-jobs
 *
 * Returns videos currently in QUEUED or PROCESSING status (or READY
 * with an active processingPhase, e.g. timeline-only regen) that the
 * authenticated internal user has access to.  System admins see all
 * projects; other roles only see projects they are assigned to.
 *
 * Used by the Running Jobs header icon to poll server-side work.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(request, { windowMs: 10 * 1000, maxRequests: 20 })
  if (rateLimitResult) return rateLimitResult

  try {
    const isSystemAdmin = authResult.appRoleIsSystemAdmin === true
    const permissions = getUserPermissions(authResult)
    const allowedStatuses = permissions.projectVisibility?.statuses ?? []

    const videos = await prisma.video.findMany({
      where: {
        OR: [
          // Normal processing jobs (uploads, reprocessing)
          { status: { in: ['QUEUED', 'PROCESSING'] } },
          // Timeline-only regen: video stays READY but processingPhase is set
          { status: 'READY', processingPhase: { not: null } },
        ],
        project: {
          // Respect project status visibility for the user's role.
          status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
          // Non-system-admins only see projects they are assigned to.
          ...(isSystemAdmin
            ? {}
            : { assignedUsers: { some: { userId: authResult.id } } }),
        },
      },
      select: {
        id: true,
        name: true,
        versionLabel: true,
        status: true,
        processingProgress: true,
        processingPhase: true,
        projectId: true,
        project: {
          select: {
            title: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    const videoIds = new Set(videos.map((video) => video.id))
    const queueStatusByVideoId = new Map<string, 'QUEUED' | 'PROCESSING'>()

    if (videoIds.size > 0) {
      const videoQueue = getVideoQueue()
      const [activeJobs, queuedJobs] = await Promise.all([
        videoQueue.getJobs(['active']),
        videoQueue.getJobs(['waiting', 'prioritized', 'delayed']),
      ])

      for (const job of activeJobs) {
        const queuedVideoId = job.data?.videoId
        if (queuedVideoId && videoIds.has(queuedVideoId)) {
          queueStatusByVideoId.set(queuedVideoId, 'PROCESSING')
        }
      }

      for (const job of queuedJobs) {
        const queuedVideoId = job.data?.videoId
        if (queuedVideoId && videoIds.has(queuedVideoId) && !queueStatusByVideoId.has(queuedVideoId)) {
          queueStatusByVideoId.set(queuedVideoId, 'QUEUED')
        }
      }
    }

    const resolvedJobs = videos.map((video) => {
      const processingPhase = video.processingPhase ?? null
      const queueStatus = queueStatusByVideoId.get(video.id)

      let status = video.status
      if (video.status === 'READY' && processingPhase) {
        status = queueStatus ?? ((video.processingProgress ?? 0) > 0 ? 'PROCESSING' : 'QUEUED')
      }

      return {
        id: video.id,
        projectId: video.projectId,
        projectName: video.project.title,
        videoName: video.name,
        versionLabel: video.versionLabel,
        status,
        processingProgress: status === 'QUEUED' ? 0 : (video.processingProgress ?? 0),
        processingPhase,
      }
    })

    await loadCpuConfigOverrides(getRedis())
    const alloc = getCpuAllocation()
    const activeProcessingCount = resolvedJobs.filter((job) => job.status === 'PROCESSING').length
    const configuredThreadPool = alloc.maxThreadsUsedEstimate

    let dynamicThreadsPerJob: number
    if (!alloc.dynamicThreadAllocation || activeProcessingCount === 0) {
      // Dynamic scaling is off or no active jobs — use the static baseline
      dynamicThreadsPerJob = alloc.ffmpegThreadsPerJob
    } else {
      // Scale up when fewer jobs are active, capped at the configured FFmpeg pool
      dynamicThreadsPerJob = Math.max(
        1,
        Math.min(Math.floor(configuredThreadPool / activeProcessingCount), configuredThreadPool),
      )
    }

    const jobs = resolvedJobs.map((job) => {
      const isActive = job.status === 'PROCESSING'

      let allocatedThreads: number | null = null
      if (isActive) {
        allocatedThreads = job.processingPhase === 'thumbnail'
          ? alloc.timelineThreadsPerJob
          : dynamicThreadsPerJob
      }

      return {
        ...job,
        allocatedThreads,
        threadBudget: allocatedThreads ? configuredThreadPool : null,
      }
    })

    return NextResponse.json({ jobs })
  } catch (err: any) {
    console.error('[running-jobs]', err)
    return NextResponse.json({ error: err?.message || 'Unknown error' }, { status: 500 })
  }
}
