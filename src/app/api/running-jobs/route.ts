import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getUserPermissions } from '@/lib/rbac-api'
import { getCpuAllocation } from '@/lib/cpu-config'

export const runtime = 'nodejs'

const MAX_FFMPEG_THREADS_PER_JOB = 12

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

    const alloc = getCpuAllocation()
    const activeProcessingCount = videos.filter(
      (v) => v.status === 'PROCESSING' || (v.status === 'READY' && v.processingPhase),
    ).length
    const dynamicThreadsPerJob = activeProcessingCount > 0
      ? Math.max(
          1,
          Math.min(
            Math.floor(alloc.budgetThreads / activeProcessingCount),
            alloc.overrides.FFMPEG_THREADS_PER_JOB ?? MAX_FFMPEG_THREADS_PER_JOB,
          ),
        )
      : alloc.ffmpegThreadsPerJob

    const jobs = videos.map((v) => {
      const processingPhase = v.processingPhase ?? null
      const isActive = v.status === 'PROCESSING' || (v.status === 'READY' && processingPhase === 'timeline')

      let allocatedThreads: number | null = null
      if (isActive) {
        allocatedThreads = processingPhase === 'thumbnail'
          ? alloc.timelineThreadsPerJob
          : dynamicThreadsPerJob
      }

      return {
        id: v.id,
        projectId: v.projectId,
        projectName: v.project.title,
        videoName: v.name,
        status: v.status,
        processingProgress: v.processingProgress ?? 0,
        processingPhase,
        allocatedThreads,
        threadBudget: allocatedThreads ? alloc.budgetThreads : null,
      }
    })

    return NextResponse.json({ jobs })
  } catch (err: any) {
    console.error('[running-jobs]', err)
    return NextResponse.json({ error: err?.message || 'Unknown error' }, { status: 500 })
  }
}
