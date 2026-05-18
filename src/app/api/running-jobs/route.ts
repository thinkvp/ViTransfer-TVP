import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getUserPermissions } from '@/lib/rbac-api'
import { getCpuAllocation, loadCpuConfigOverrides } from '@/lib/cpu-config'
import { getRedis } from '@/lib/redis'
import { getVideoQueue, getAlbumPhotoZipQueue } from '@/lib/queue'

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

  const rateLimitResult = await rateLimit(request, { windowMs: 10 * 1000, maxRequests: 20 }, 'running-jobs')
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
      if (queueStatus) {
        status = queueStatus
      } else if (video.status === 'READY' && processingPhase) {
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

    const recentCompletionCutoff = new Date(Date.now() - 30 * 60 * 1000)

    const completedProcessingVideos = await prisma.video.findMany({
      where: {
        status: 'READY',
        processingPhase: null,
        processingProgress: 100,
        updatedAt: { gte: recentCompletionCutoff },
        project: {
          status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
          ...(isSystemAdmin
            ? {}
            : { assignedUsers: { some: { userId: authResult.id } } }),
        },
      },
      select: {
        id: true,
        name: true,
        versionLabel: true,
        projectId: true,
        updatedAt: true,
        project: { select: { title: true } },
      },
      orderBy: { updatedAt: 'desc' },
    })

    const completedProcessingJobs = completedProcessingVideos.map((video) => ({
      id: video.id,
      type: 'processing' as const,
      label: video.name + (video.versionLabel ? ` ${video.versionLabel}` : ''),
      sublabel: video.project.title,
      projectId: video.projectId,
      completedAt: video.updatedAt.getTime(),
    }))

    // -----------------------------------------------------------------------
    // Album ZIP generation jobs (queried from BullMQ)
    // -----------------------------------------------------------------------
    const albumZipJobs: Array<{
      id: string
      albumId: string
      albumName: string
      projectId: string
      projectName: string
      variant: 'full' | 'social'
      status: 'PENDING' | 'ACTIVE'
    }> = []

    try {
      const albumZipQueue = getAlbumPhotoZipQueue()
      const [activeZipQueueJobs, waitingZipQueueJobs] = await Promise.all([
        albumZipQueue.getJobs(['active']),
        albumZipQueue.getJobs(['waiting', 'prioritized', 'delayed']),
      ])

      // Map albumId:variant → status
      const albumZipJobMap = new Map<string, 'ACTIVE' | 'PENDING'>()
      const activeAlbumIds = new Set<string>()

      for (const qj of activeZipQueueJobs) {
        const { albumId, variant } = qj.data ?? {}
        if (albumId && variant) {
          albumZipJobMap.set(`${albumId}:${variant}`, 'ACTIVE')
          activeAlbumIds.add(albumId)
        }
      }
      for (const qj of waitingZipQueueJobs) {
        const { albumId, variant } = qj.data ?? {}
        if (albumId && variant) {
          const key = `${albumId}:${variant}`
          if (!albumZipJobMap.has(key)) {
            albumZipJobMap.set(key, 'PENDING')
            activeAlbumIds.add(albumId)
          }
        }
      }

      if (activeAlbumIds.size > 0) {
        const albums = await prisma.album.findMany({
          where: {
            id: { in: [...activeAlbumIds] },
            project: {
              status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
              ...(isSystemAdmin
                ? {}
                : { assignedUsers: { some: { userId: authResult.id } } }),
            },
          },
          select: {
            id: true,
            name: true,
            projectId: true,
            project: { select: { title: true } },
          },
          orderBy: { createdAt: 'asc' },
        })

        for (const album of albums) {
          for (const variant of ['full', 'social'] as const) {
            const status = albumZipJobMap.get(`${album.id}:${variant}`)
            if (status) {
              albumZipJobs.push({
                id: `${album.id}:${variant}`,
                albumId: album.id,
                albumName: album.name,
                projectId: album.projectId,
                projectName: album.project.title,
                variant,
                status,
              })
            }
          }
        }
      }
    } catch {
      // Queue may be unavailable — degrade gracefully
    }

    // -----------------------------------------------------------------------
    // Errored video processing jobs (persist until resolved/deleted)
    // -----------------------------------------------------------------------
    const erroredProcessingVideos = await prisma.video.findMany({
      where: {
        status: 'ERROR',
        updatedAt: { gte: recentCompletionCutoff },
        project: {
          status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
          ...(isSystemAdmin
            ? {}
            : { assignedUsers: { some: { userId: authResult.id } } }),
        },
      },
      select: {
        id: true,
        name: true,
        versionLabel: true,
        projectId: true,
        updatedAt: true,
        project: { select: { title: true } },
      },
      orderBy: { updatedAt: 'desc' },
    })

    const erroredProcessingJobs = erroredProcessingVideos.map((video) => ({
      id: video.id,
      type: 'processing' as const,
      label: video.name + (video.versionLabel ? ` ${video.versionLabel}` : ''),
      sublabel: video.project.title,
      projectId: video.projectId,
      completedAt: video.updatedAt.getTime(),
      error: true,
    }))

    return NextResponse.json({
      jobs,
      completedProcessingJobs,
      erroredProcessingJobs,
      albumZipJobs,
      albumThumbnailJobs: await buildAlbumThumbnailJobs(),
      folderRenameJobs: await buildFolderRenameJobs(),
    })
  } catch (err: any) {
    console.error('[running-jobs]', err)
    return NextResponse.json({ error: err?.message || 'Unknown error' }, { status: 500 })
  }
}

async function buildAlbumThumbnailJobs() {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000)

  const [activeJobs, completedJobs, failedJobs] = await Promise.all([
    prisma.albumThumbnailJob.findMany({
      where: { status: { in: ['PENDING', 'IN_PROGRESS'] } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.albumThumbnailJob.findMany({
      where: { status: 'COMPLETED', completedAt: { gte: cutoff } },
      orderBy: { completedAt: 'desc' },
    }),
    prisma.albumThumbnailJob.findMany({
      where: { status: 'FAILED' },
      orderBy: { completedAt: 'desc' },
    }),
  ])

  const active = activeJobs.map((job) => ({
    id: job.id,
    albumId: job.albumId,
    albumName: job.albumName,
    projectId: job.projectId,
    projectName: job.projectName,
    status: job.status,
    totalPhotos: job.totalPhotos,
    processedPhotos: job.processedPhotos,
    totalBytes: job.totalBytes.toString(),
    processedBytes: job.processedBytes.toString(),
  }))

  const completed = [
    ...completedJobs.map((job) => ({
      id: job.id,
      type: 'albumThumbnail' as const,
      label: job.albumName,
      sublabel: `${job.projectName} · Album thumbnails complete`,
      projectId: job.projectId,
      completedAt: (job.completedAt ?? job.updatedAt).getTime(),
    })),
    ...failedJobs.map((job) => ({
      id: job.id,
      type: 'albumThumbnail' as const,
      label: job.albumName,
      sublabel: `${job.projectName} · Album thumbnails failed`,
      projectId: job.projectId,
      completedAt: (job.completedAt ?? job.updatedAt).getTime(),
      error: true,
    })),
  ]

  return { active, completed }
}

// ---------------------------------------------------------------------------
// Folder rename jobs helper
// ---------------------------------------------------------------------------

async function buildFolderRenameJobs() {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000)

  const [activeJobs, completedJobs, failedJobs] = await Promise.all([
    // Active: PENDING or IN_PROGRESS
    prisma.folderRenameJob.findMany({
      where: { status: { in: ['PENDING', 'IN_PROGRESS'] } },
      orderBy: { createdAt: 'asc' },
    }),
    // Recently completed (within 30 min)
    prisma.folderRenameJob.findMany({
      where: { status: 'COMPLETED', completedAt: { gte: cutoff } },
      orderBy: { completedAt: 'desc' },
    }),
    // Failed (no time cutoff — persist until manually dismissed)
    prisma.folderRenameJob.findMany({
      where: { status: 'FAILED' },
      orderBy: { completedAt: 'desc' },
    }),
  ])

  const active = activeJobs.map((j) => ({
    id: j.id,
    entityType: j.entityType,
    entityId: j.entityId,
    entityName: j.entityName,
    status: j.status,
    totalObjects: j.totalObjects,
    copiedObjects: j.copiedObjects,
    totalBytes: j.totalBytes.toString(),
    copiedBytes: j.copiedBytes.toString(),
  }))

  const completed = [
    ...completedJobs.map((j) => ({
      id: j.id,
      type: 'folderRename' as const,
      label: j.entityName,
      sublabel: j.entityType === 'PROJECT' ? 'Project rename complete' : 'Client rename complete',
      projectId: j.entityType === 'PROJECT' ? j.entityId : '',
      completedAt: (j.completedAt ?? j.updatedAt).getTime(),
    })),
    ...failedJobs.map((j) => ({
      id: j.id,
      type: 'folderRename' as const,
      label: j.entityName,
      sublabel: j.entityType === 'PROJECT' ? 'Project rename failed' : 'Client rename failed',
      projectId: j.entityType === 'PROJECT' ? j.entityId : '',
      completedAt: (j.completedAt ?? j.updatedAt).getTime(),
      error: true,
    })),
  ]

  return { active, completed }
}
