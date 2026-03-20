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

    // Query active Dropbox uploads (separate from processing jobs)
    const dropboxUploads = await prisma.video.findMany({
      where: {
        dropboxUploadStatus: { in: ['PENDING', 'UPLOADING'] },
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
        originalFileSize: true,
        dropboxUploadStatus: true,
        dropboxUploadProgress: true,
        projectId: true,
        project: { select: { title: true } },
      },
      orderBy: { createdAt: 'asc' },
    })

    const dropboxJobs = dropboxUploads.map((v) => ({
      id: v.id,
      projectId: v.projectId,
      projectName: v.project.title,
      videoName: v.name,
      versionLabel: v.versionLabel,
      status: v.dropboxUploadStatus as string,
      progress: v.dropboxUploadProgress,
      fileSizeBytes: Number(v.originalFileSize),
    }))

    // Query active Dropbox uploads for assets
    const assetDropboxUploads = await prisma.videoAsset.findMany({
      where: {
        dropboxUploadStatus: { in: ['PENDING', 'UPLOADING'] },
        video: {
          project: {
            status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
            ...(isSystemAdmin
              ? {}
              : { assignedUsers: { some: { userId: authResult.id } } }),
          },
        },
      },
      select: {
        id: true,
        fileName: true,
        fileSize: true,
        dropboxUploadStatus: true,
        dropboxUploadProgress: true,
        video: {
          select: {
            name: true,
            versionLabel: true,
            projectId: true,
            project: { select: { title: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    const assetDropboxJobs = assetDropboxUploads.map((a) => ({
      id: a.id,
      projectId: a.video.projectId,
      projectName: a.video.project.title,
      videoName: a.fileName,
      versionLabel: a.video.name,
      status: a.dropboxUploadStatus as string,
      progress: a.dropboxUploadProgress ?? 0,
      fileSizeBytes: Number(a.fileSize ?? 0),
    }))

    const recentDropboxCompletionCutoff = new Date(Date.now() - 30 * 60 * 1000)

    const [completedDropboxVideos, completedDropboxAssets, erroredDropboxVideos, erroredDropboxAssets, completedProcessingVideos] = await Promise.all([
      prisma.video.findMany({
        where: {
          dropboxUploadStatus: 'COMPLETE',
          updatedAt: { gte: recentDropboxCompletionCutoff },
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
          updatedAt: true,
          project: { select: { title: true } },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.videoAsset.findMany({
        where: {
          dropboxUploadStatus: 'COMPLETE',
          updatedAt: { gte: recentDropboxCompletionCutoff },
          video: {
            project: {
              status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
              ...(isSystemAdmin
                ? {}
                : { assignedUsers: { some: { userId: authResult.id } } }),
            },
          },
        },
        select: {
          id: true,
          fileName: true,
          updatedAt: true,
          video: {
            select: {
              projectId: true,
              project: { select: { title: true } },
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      // Errored Dropbox video uploads (no time cutoff — persist until resolved)
      prisma.video.findMany({
        where: {
          dropboxUploadStatus: 'ERROR',
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
          updatedAt: true,
          project: { select: { title: true } },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      // Errored Dropbox asset uploads (no time cutoff — persist until resolved)
      prisma.videoAsset.findMany({
        where: {
          dropboxUploadStatus: 'ERROR',
          video: {
            project: {
              status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
              ...(isSystemAdmin
                ? {}
                : { assignedUsers: { some: { userId: authResult.id } } }),
            },
          },
        },
        select: {
          id: true,
          fileName: true,
          updatedAt: true,
          video: {
            select: {
              projectId: true,
              project: { select: { title: true } },
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.video.findMany({
        where: {
          status: 'READY',
          processingPhase: null,
          processingProgress: 100,
          updatedAt: { gte: recentDropboxCompletionCutoff },
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
      }),
    ])

    const completedDropboxJobs = [
      ...completedDropboxVideos.map((video) => ({
        id: video.id,
        type: 'dropbox' as const,
        label: video.name,
        sublabel: video.project.title,
        projectId: video.projectId,
        completedAt: video.updatedAt.getTime(),
      })),
      ...completedDropboxAssets.map((asset) => ({
        id: asset.id,
        type: 'dropbox' as const,
        label: asset.fileName,
        sublabel: asset.video.project.title,
        projectId: asset.video.projectId,
        completedAt: asset.updatedAt.getTime(),
      })),
      // Errored uploads — included as completed entries with error flag
      ...erroredDropboxVideos.map((video) => ({
        id: video.id,
        type: 'dropbox' as const,
        label: video.name,
        sublabel: video.project.title,
        projectId: video.projectId,
        completedAt: video.updatedAt.getTime(),
        error: true,
      })),
      ...erroredDropboxAssets.map((asset) => ({
        id: asset.id,
        type: 'dropbox' as const,
        label: asset.fileName,
        sublabel: asset.video.project.title,
        projectId: asset.video.projectId,
        completedAt: asset.updatedAt.getTime(),
        error: true,
      })),
    ]

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
    // Album ZIP Dropbox upload jobs (tracked in DB)
    // -----------------------------------------------------------------------
    const rawAlbumZipDropboxAlbums = await prisma.album.findMany({
      where: {
        OR: [
          { fullZipDropboxStatus: { in: ['PENDING', 'UPLOADING'] } },
          { socialZipDropboxStatus: { in: ['PENDING', 'UPLOADING'] } },
        ],
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
        fullZipFileSize: true,
        fullZipDropboxStatus: true,
        fullZipDropboxProgress: true,
        socialZipFileSize: true,
        socialZipDropboxStatus: true,
        socialZipDropboxProgress: true,
        project: { select: { title: true } },
      },
      orderBy: { createdAt: 'asc' },
    })

    // Expand into one entry per active variant
    const albumZipDropboxJobs: Array<{
      id: string
      albumId: string
      albumName: string
      projectId: string
      projectName: string
      variant: 'full' | 'social'
      status: string
      progress: number
      fileSizeBytes: number
    }> = []

    for (const a of rawAlbumZipDropboxAlbums) {
      if (a.fullZipDropboxStatus === 'PENDING' || a.fullZipDropboxStatus === 'UPLOADING') {
        albumZipDropboxJobs.push({
          id: `${a.id}:full:dropbox`,
          albumId: a.id,
          albumName: a.name,
          projectId: a.projectId,
          projectName: a.project.title,
          variant: 'full',
          status: a.fullZipDropboxStatus,
          progress: a.fullZipDropboxProgress,
          fileSizeBytes: Number(a.fullZipFileSize),
        })
      }
      if (a.socialZipDropboxStatus === 'PENDING' || a.socialZipDropboxStatus === 'UPLOADING') {
        albumZipDropboxJobs.push({
          id: `${a.id}:social:dropbox`,
          albumId: a.id,
          albumName: a.name,
          projectId: a.projectId,
          projectName: a.project.title,
          variant: 'social',
          status: a.socialZipDropboxStatus,
          progress: a.socialZipDropboxProgress,
          fileSizeBytes: Number(a.socialZipFileSize),
        })
      }
    }

    // -----------------------------------------------------------------------
    // Errored album ZIP Dropbox uploads (persist until resolved)
    // -----------------------------------------------------------------------
    const erroredAlbumZipDropboxAlbums = await prisma.album.findMany({
      where: {
        OR: [
          { fullZipDropboxStatus: 'ERROR' },
          { socialZipDropboxStatus: 'ERROR' },
        ],
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
        fullZipDropboxStatus: true,
        socialZipDropboxStatus: true,
        updatedAt: true,
        project: { select: { title: true } },
      },
      orderBy: { updatedAt: 'desc' },
    })

    const erroredAlbumZipDropboxJobs: Array<{
      id: string
      type: 'albumZipDropbox'
      label: string
      sublabel: string
      projectId: string
      completedAt: number
      error: boolean
    }> = []

    for (const a of erroredAlbumZipDropboxAlbums) {
      if (a.fullZipDropboxStatus === 'ERROR') {
        erroredAlbumZipDropboxJobs.push({
          id: `${a.id}:full:dropbox`,
          type: 'albumZipDropbox',
          label: a.name,
          sublabel: `${a.project.title} · Full Res ZIP`,
          projectId: a.projectId,
          completedAt: a.updatedAt.getTime(),
          error: true,
        })
      }
      if (a.socialZipDropboxStatus === 'ERROR') {
        erroredAlbumZipDropboxJobs.push({
          id: `${a.id}:social:dropbox`,
          type: 'albumZipDropbox',
          label: a.name,
          sublabel: `${a.project.title} · Social Sized ZIP`,
          projectId: a.projectId,
          completedAt: a.updatedAt.getTime(),
          error: true,
        })
      }
    }

    // -----------------------------------------------------------------------
    // Errored video processing jobs (persist until resolved/deleted)
    // -----------------------------------------------------------------------
    const erroredProcessingVideos = await prisma.video.findMany({
      where: {
        status: 'ERROR',
        updatedAt: { gte: recentDropboxCompletionCutoff },
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
      dropboxJobs: [...dropboxJobs, ...assetDropboxJobs],
      completedProcessingJobs,
      completedDropboxJobs,
      erroredProcessingJobs,
      albumZipJobs,
      albumZipDropboxJobs,
      erroredAlbumZipDropboxJobs,
    })
  } catch (err: any) {
    console.error('[running-jobs]', err)
    return NextResponse.json({ error: err?.message || 'Unknown error' }, { status: 500 })
  }
}
