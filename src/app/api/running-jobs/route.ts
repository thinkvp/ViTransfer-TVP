import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getUserPermissions } from '@/lib/rbac-api'
import { getCpuAllocation, loadCpuConfigOverrides } from '@/lib/cpu-config'
import { getRedis } from '@/lib/redis'
import { getVideoQueue, getAlbumPhotoZipQueue, getAlbumPhotoThumbnailQueue, getFolderRenameQueue } from '@/lib/queue'
import { getAlbumZipJobId, type AlbumZipVariant } from '@/lib/album-photo-zip'
import { getAlbumThumbnailQueueJobId } from '@/lib/album-photo-thumbnail'
import { getStoredFileRecords } from '@/lib/stored-file'

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
        // queueStatus is known falsy in this branch (handled above).
        status = (video.processingProgress ?? 0) > 0 ? 'PROCESSING' : 'QUEUED'
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

    // Also include asset and upload timeline jobs.
    // Scope to projects the user may see, matching the visibility rules applied
    // to every other query in this route (system admins see all; others only
    // their assigned projects, filtered by allowed project statuses).
    const projectVisibilityFilter = {
      status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
      ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId: authResult.id } } }),
    }

    const [assetJobs, uploadJobs] = await Promise.all([
      prisma.videoAsset.findMany({
        where: { processingPhase: { not: null }, video: { project: projectVisibilityFilter } },
        select: { id: true, fileName: true, processingPhase: true, processingProgress: true,
          video: { select: { id: true, name: true, projectId: true, project: { select: { title: true } } } },
        },
      }),
      prisma.shareUploadFile.findMany({
        where: { processingPhase: { not: null }, project: projectVisibilityFilter },
        select: { id: true, fileName: true, processingPhase: true, processingProgress: true,
          projectId: true, project: { select: { title: true } },
        },
      }),
    ])

    const extraJobs = [
      ...assetJobs.map((a) => ({
        id: a.id,
        projectId: a.video.projectId,
        projectName: a.video.project.title,
        videoName: `${a.video.name} / ${a.fileName}`,
        versionLabel: 'asset',
        status: (a.processingProgress ?? 0) > 0 ? 'PROCESSING' as const : 'QUEUED' as const,
        processingProgress: a.processingProgress ?? 0,
        processingPhase: a.processingPhase,
      })),
      ...uploadJobs.map((u) => ({
        id: u.id,
        projectId: u.projectId,
        projectName: u.project.title,
        videoName: u.fileName,
        versionLabel: 'upload',
        status: (u.processingProgress ?? 0) > 0 ? 'PROCESSING' as const : 'QUEUED' as const,
        processingProgress: u.processingProgress ?? 0,
        processingPhase: u.processingPhase,
      })),
    ]

    const allJobs = [...resolvedJobs, ...extraJobs]

    await loadCpuConfigOverrides(getRedis())
    const alloc = getCpuAllocation()
    const activeProcessingCount = allJobs.filter((job) => job.status === 'PROCESSING').length
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

    const jobs = allJobs.map((job) => {
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

    // -----------------------------------------------------------------------
    // Run remaining queries in parallel.  Each promise has its own .catch()
    // so one failing builder doesn't break the whole response.
    // -----------------------------------------------------------------------
    const [
      completedProcessingVideos,
      erroredProcessingVideos,
      albumZipJobs,
      albumThumbnailJobs,
      folderRenameJobs,
      videoAssetPreviewJobs,
      albumSocialJobs,
    ] = await Promise.all([
      prisma.video.findMany({
        where: {
          status: 'READY', processingPhase: null, processingProgress: 100,
          updatedAt: { gte: recentCompletionCutoff },
          project: {
            status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
            ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId: authResult.id } } }),
          },
        },
        select: { id: true, name: true, versionLabel: true, projectId: true, updatedAt: true, project: { select: { title: true } } },
        orderBy: { updatedAt: 'desc' },
      }).catch((err) => { console.error('[running-jobs] completed-processing query failed:', err); return [] }),
      prisma.video.findMany({
        where: {
          status: 'ERROR',
          updatedAt: { gte: recentCompletionCutoff },
          project: {
            status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
            ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId: authResult.id } } }),
          },
        },
        select: { id: true, name: true, versionLabel: true, projectId: true, updatedAt: true, project: { select: { title: true } } },
        orderBy: { updatedAt: 'desc' },
      }).catch((err) => { console.error('[running-jobs] errored-processing query failed:', err); return [] }),
      buildAlbumZipJobs({ isSystemAdmin, userId: authResult.id, allowedStatuses }).catch((err) => { console.error('[running-jobs] album-zip builder failed:', err); return { active: [], completed: [] } }),
      buildAlbumThumbnailJobs().catch((err) => { console.error('[running-jobs] album-thumbnail builder failed:', err); return { active: [], completed: [] } }),
      buildFolderRenameJobs().catch((err) => { console.error('[running-jobs] folder-rename builder failed:', err); return { active: [], completed: [] } }),
      buildVideoAssetPreviewJobs({ isSystemAdmin, userId: authResult.id, allowedStatuses }).catch((err) => { console.error('[running-jobs] video-asset-preview builder failed:', err); return { active: [], completed: [] } }),
      buildAlbumSocialJobs({ isSystemAdmin, userId: authResult.id, allowedStatuses }).catch((err) => { console.error('[running-jobs] album-social builder failed:', err); return { active: [], completed: [] } }),
    ])

    const completedProcessingJobs = completedProcessingVideos.map((video) => ({
      id: video.id,
      type: 'processing' as const,
      label: video.name + (video.versionLabel ? ` ${video.versionLabel}` : ''),
      sublabel: video.project.title,
      projectId: video.projectId,
      completedAt: video.updatedAt.getTime(),
    }))

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
      albumThumbnailJobs,
      folderRenameJobs,
      videoAssetPreviewJobs,
      albumSocialJobs,
    })
  } catch (err: any) {
    console.error('[running-jobs]', err)
    return NextResponse.json({ error: err?.message || 'Unknown error' }, { status: 500 })
  }
}

/**
 * POST /api/running-jobs
 *
 * Clears a queued running job from the UI and best-effort removes the
 * matching BullMQ job / DB record.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(request, { windowMs: 10 * 1000, maxRequests: 20 }, 'running-jobs-clear')
  if (rateLimitResult) return rateLimitResult

  const body = await request.json().catch(() => ({}))
  const type = body?.type
  const id = typeof body?.id === 'string' ? body.id : ''

  if (!id || !['processing', 'albumZip', 'albumThumbnail', 'folderRename'].includes(type)) {
    return NextResponse.json({ error: 'Invalid running job target' }, { status: 400 })
  }

  // Visibility context — a user may only clear jobs for projects they can see.
  const isSystemAdmin = authResult.appRoleIsSystemAdmin === true
  const permissions = getUserPermissions(authResult)
  const allowedStatuses = permissions.projectVisibility?.statuses ?? []
  const projectVisibilityFilter = {
    status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
    ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId: authResult.id } } }),
  }
  // System admins always pass; others must have the project in their visible set.
  const canSeeProject = async (projectId: string | null | undefined): Promise<boolean> => {
    if (isSystemAdmin) return true
    if (!projectId) return false
    const match = await prisma.project.findFirst({
      where: { id: projectId, ...projectVisibilityFilter },
      select: { id: true },
    })
    return match !== null
  }
  const forbidden = () => NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    if (type === 'processing') {
      const video = await prisma.video.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          projectId: true,
        },
      })

      if (!video) {
        return NextResponse.json({ error: 'Video not found' }, { status: 404 })
      }

      if (!(await canSeeProject(video.projectId))) {
        return forbidden()
      }

      if (video.status !== 'QUEUED') {
        return NextResponse.json({ error: 'Only queued video jobs can be cleared' }, { status: 409 })
      }

      const videoQueue = getVideoQueue()
      const queuedJobs = await videoQueue.getJobs(['waiting', 'prioritized', 'delayed'])
      let removedJobs = 0

      for (const job of queuedJobs) {
        if (job?.data?.videoId === id) {
          await job.remove().catch(() => {})
          removedJobs++
        }
      }

      await prisma.video.update({
        where: { id },
        data: {
          status: 'READY',
          processingPhase: null,
          processingError: null,
        },
      })

      return NextResponse.json({ ok: true, type, id, removedJobs })
    }

    if (type === 'albumZip') {
      const [albumId, variant] = id.split(':') as [string, AlbumZipVariant | undefined]
      if (!albumId || (variant !== 'full' && variant !== 'social')) {
        return NextResponse.json({ error: 'Invalid album ZIP job id' }, { status: 400 })
      }

      const album = await prisma.album.findUnique({ where: { id: albumId }, select: { projectId: true } })
      if (!album) {
        return NextResponse.json({ error: 'Album not found' }, { status: 404 })
      }
      if (!(await canSeeProject(album.projectId))) {
        return forbidden()
      }

      const albumZipQueue = getAlbumPhotoZipQueue()
      const queueJobId = getAlbumZipJobId({ albumId, variant })
      const queueJob = await albumZipQueue.getJob(queueJobId)
      if (queueJob) {
        await queueJob.remove().catch(() => {})
      }

      return NextResponse.json({ ok: true, type, id, removedJobs: queueJob ? 1 : 0 })
    }

    if (type === 'albumThumbnail') {
      const albumThumbnailJob = await prisma.albumThumbnailJob.findUnique({
        where: { id },
        select: {
          id: true,
          albumId: true,
          projectId: true,
          status: true,
        },
      })

      if (!albumThumbnailJob) {
        return NextResponse.json({ error: 'Album thumbnail job not found' }, { status: 404 })
      }

      if (!(await canSeeProject(albumThumbnailJob.projectId))) {
        return forbidden()
      }

      if (albumThumbnailJob.status !== 'PENDING') {
        return NextResponse.json({ error: 'Only queued album thumbnail jobs can be cleared' }, { status: 409 })
      }

      const thumbnailQueue = getAlbumPhotoThumbnailQueue()
      const queueJob = await thumbnailQueue.getJob(getAlbumThumbnailQueueJobId(albumThumbnailJob.albumId))
      if (queueJob) {
        await queueJob.remove().catch(() => {})
      }

      await prisma.albumThumbnailJob.delete({ where: { id } })

      return NextResponse.json({ ok: true, type, id, removedJobs: queueJob ? 1 : 0 })
    }

    if (type === 'folderRename') {
      const folderRenameJob = await prisma.folderRenameJob.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          entityType: true,
          entityId: true,
        },
      })

      if (!folderRenameJob) {
        return NextResponse.json({ error: 'Folder rename job not found' }, { status: 404 })
      }

      // Only PROJECT renames map to a single project we can scope by id.
      // CLIENT (and any other) renames span projects — restrict those to system admins.
      if (folderRenameJob.entityType === 'PROJECT') {
        if (!(await canSeeProject(folderRenameJob.entityId))) {
          return forbidden()
        }
      } else if (!isSystemAdmin) {
        return forbidden()
      }

      if (folderRenameJob.status !== 'PENDING') {
        return NextResponse.json({ error: 'Only queued folder rename jobs can be cleared' }, { status: 409 })
      }

      const folderRenameQueue = getFolderRenameQueue()
      const queuedJobs = await folderRenameQueue.getJobs(['waiting', 'prioritized', 'delayed'])
      let removedJobs = 0

      for (const job of queuedJobs) {
        if (job?.data?.folderRenameJobId === id) {
          await job.remove().catch(() => {})
          removedJobs++
        }
      }

      await prisma.folderRenameJob.delete({ where: { id } })

      return NextResponse.json({ ok: true, type, id, removedJobs })
    }

    // Valid type string but no handler matched — should never happen.
    return NextResponse.json({ error: `Unhandled job type: ${type}` }, { status: 400 })
  } catch (err: any) {
    console.error('[running-jobs-clear]', err)
    return NextResponse.json({ error: err?.message || 'Unknown error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// Album ZIP generation jobs helper
// ---------------------------------------------------------------------------

async function buildAlbumZipJobs({
  isSystemAdmin,
  userId,
  allowedStatuses,
}: {
  isSystemAdmin: boolean
  userId: string
  allowedStatuses: string[]
}) {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000)

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

    // Fetch album details for active jobs
    let albums: Array<{ id: string; name: string; projectId: string; project: { title: string } }> = []
    if (activeAlbumIds.size > 0) {
      albums = await prisma.album.findMany({
        where: {
          id: { in: [...activeAlbumIds] },
          project: {
            status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
            ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId } } }),
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
    }

    const active: Array<{
      id: string
      albumId: string
      albumName: string
      projectId: string
      projectName: string
      variant: 'full' | 'social'
      status: 'PENDING' | 'ACTIVE'
    }> = []

    for (const album of albums) {
      for (const variant of ['full', 'social'] as const) {
        const status = albumZipJobMap.get(`${album.id}:${variant}`)
        if (status) {
          active.push({
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

    // Detect recently completed ZIPs: albums with non-zero ZIP sizes updated recently
    // that are NOT currently in the active BullMQ set.
    const recentlyUpdatedAlbums = await prisma.album.findMany({
      where: {
        updatedAt: { gte: cutoff },
        project: {
          status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
          ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId } } }),
        },
      },
      select: {
        id: true,
        name: true,
        projectId: true,
        project: { select: { title: true } },
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    })

    // Check StoredFile for ZIP sizes (legacy album columns dropped)
    const albumIds = recentlyUpdatedAlbums.map(a => a.id)
    const albumZipSizes = albumIds.length > 0 ? await getStoredFileRecords('ALBUM', albumIds, { fileRoles: ['ZIP_FULL', 'ZIP_SOCIAL'], select: { entityId: true, fileRole: true, fileSize: true } }) : []
    const zipSizeByAlbum = new Map<string, { full: bigint; social: bigint }>()
    for (const az of albumZipSizes) {
      let entry = zipSizeByAlbum.get(az.entityId)
      if (!entry) { entry = { full: BigInt(0), social: BigInt(0) }; zipSizeByAlbum.set(az.entityId, entry) }
      if (az.fileRole === 'ZIP_FULL') entry.full = az.fileSize ?? BigInt(0)
      else if (az.fileRole === 'ZIP_SOCIAL') entry.social = az.fileSize ?? BigInt(0)
    }

    const activeAlbumVariantSet = new Set(active.map((j) => `${j.albumId}:${j.variant}`))

    const completed: Array<{
      id: string
      type: 'albumZip'
      label: string
      sublabel: string
      projectId: string
      completedAt: number
    }> = []

    for (const album of recentlyUpdatedAlbums) {
      const sizes = zipSizeByAlbum.get(album.id) ?? { full: BigInt(0), social: BigInt(0) }
      for (const variant of ['full', 'social'] as const) {
        const size = variant === 'full' ? sizes.full : sizes.social
        if (size > 0 && !activeAlbumVariantSet.has(`${album.id}:${variant}`)) {
          const variantLabel = variant === 'full' ? 'Full Res ZIP' : 'Social Sized ZIP'
          completed.push({
            id: `${album.id}:${variant}`,
            type: 'albumZip',
            label: album.name,
            sublabel: `${album.project.title} · ${variantLabel} complete`,
            projectId: album.projectId,
            completedAt: album.updatedAt.getTime(),
          })
        }
      }
    }

    return { active, completed }
  } catch {
    return { active: [], completed: [] }
  }
}

async function buildAlbumThumbnailJobs() {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000)
  const now = Date.now()

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
      take: 50,
    }),
  ])

  const queueStatusByAlbumId = new Map<string, 'PENDING' | 'IN_PROGRESS'>()
  const queueDbJobIds = new Set<string>()
  let queueStateLoaded = false

  try {
    const thumbnailQueue = getAlbumPhotoThumbnailQueue()
    const [activeQueueJobs, waitingQueueJobs] = await Promise.all([
      thumbnailQueue.getJobs(['active']),
      thumbnailQueue.getJobs(['waiting', 'prioritized', 'delayed']),
    ])

    const queueIdPrefix = 'album-photo-thumbnail-'

    for (const qj of activeQueueJobs) {
      const queuedDbJobId = qj.data?.albumThumbnailJobId
      if (queuedDbJobId) queueDbJobIds.add(String(queuedDbJobId))

      const qid = String(qj.id ?? '')
      if (qid.startsWith(queueIdPrefix)) {
        queueStatusByAlbumId.set(qid.slice(queueIdPrefix.length), 'IN_PROGRESS')
      }
    }

    for (const qj of waitingQueueJobs) {
      const queuedDbJobId = qj.data?.albumThumbnailJobId
      if (queuedDbJobId) queueDbJobIds.add(String(queuedDbJobId))

      const qid = String(qj.id ?? '')
      if (qid.startsWith(queueIdPrefix)) {
        const albumId = qid.slice(queueIdPrefix.length)
        if (!queueStatusByAlbumId.has(albumId)) {
          queueStatusByAlbumId.set(albumId, 'PENDING')
        }
      }
    }

    queueStateLoaded = true
  } catch {
    // Queue may be unavailable — fall back to DB statuses only.
  }

  const active = activeJobs
    .filter((job) => {
      if (!queueStateLoaded) return true

      // Keep jobs explicitly represented in the queue (album-level id or db job id).
      if (queueStatusByAlbumId.has(job.albumId) || queueDbJobIds.has(job.id)) {
        return true
      }

      // If a worker just transitioned state, allow a short grace window.
      return now - job.updatedAt.getTime() < 90_000
    })
    .map((job) => {
      const queueStatus = queueStatusByAlbumId.get(job.albumId)
      return {
        id: job.id,
        albumId: job.albumId,
        albumName: job.albumName,
        projectId: job.projectId,
        projectName: job.projectName,
        status: queueStatus ?? job.status,
        totalPhotos: job.totalPhotos,
        processedPhotos: job.processedPhotos,
        totalBytes: job.totalBytes.toString(),
        processedBytes: job.processedBytes.toString(),
      }
    })

  const latestCompletedByAlbum = new Map<string, {
    id: string
    type: 'albumThumbnail'
    label: string
    sublabel: string
    projectId: string
    completedAt: number
    error?: true
  }>()

  const completedEntries: Array<{
    albumId: string
    id: string
    type: 'albumThumbnail'
    label: string
    sublabel: string
    projectId: string
    completedAt: number
    error?: true
  }> = [
    ...completedJobs.map((job) => ({
      albumId: job.albumId,
      id: job.id,
      type: 'albumThumbnail' as const,
      label: job.albumName,
      sublabel: `${job.projectName} · Album thumbnails complete`,
      projectId: job.projectId,
      completedAt: (job.completedAt ?? job.updatedAt).getTime(),
    })),
    ...failedJobs.map((job) => ({
      albumId: job.albumId,
      id: job.id,
      type: 'albumThumbnail' as const,
      label: job.albumName,
      sublabel: `${job.projectName} · Album thumbnails failed`,
      projectId: job.projectId,
      completedAt: (job.completedAt ?? job.updatedAt).getTime(),
      error: true as const,
    })),
  ]

  for (const entry of completedEntries) {
    const existing = latestCompletedByAlbum.get(entry.albumId)
    if (!existing || entry.completedAt > existing.completedAt) {
      latestCompletedByAlbum.set(entry.albumId, {
        id: entry.id,
        type: entry.type,
        label: entry.label,
        sublabel: entry.sublabel,
        projectId: entry.projectId,
        completedAt: entry.completedAt,
        error: entry.error,
      })
    }
  }

  const completed = [...latestCompletedByAlbum.values()]

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
    // Failed (no time cutoff — persist until manually dismissed; capped to bound payload)
    prisma.folderRenameJob.findMany({
      where: { status: 'FAILED' },
      orderBy: { completedAt: 'desc' },
      take: 50,
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
      sublabel: j.entityType === 'PROJECT' ? 'Project rename complete'
        : j.entityType === 'CLIENT' ? 'Client rename complete'
        : j.entityType === 'VIDEO_GROUP' ? 'Video rename complete'
        : j.entityType === 'VIDEO_VERSION' ? 'Video version rename complete'
        : 'Album rename complete',
      projectId: j.entityType === 'PROJECT' ? j.entityId : '',
      completedAt: (j.completedAt ?? j.updatedAt).getTime(),
    })),
    ...failedJobs.map((j) => ({
      id: j.id,
      type: 'folderRename' as const,
      label: j.entityName,
      sublabel: j.entityType === 'PROJECT' ? 'Project rename failed'
        : j.entityType === 'CLIENT' ? 'Client rename failed'
        : j.entityType === 'VIDEO_GROUP' ? 'Video rename failed'
        : j.entityType === 'VIDEO_VERSION' ? 'Video version rename failed'
        : 'Album rename failed',
      projectId: j.entityType === 'PROJECT' ? j.entityId : '',
      completedAt: (j.completedAt ?? j.updatedAt).getTime(),
      error: true,
    })),
  ]

  return { active, completed }
}

// -----------------------------------------------------------------------
// Video Asset Preview jobs helper
// -----------------------------------------------------------------------

async function buildVideoAssetPreviewJobs({
  isSystemAdmin,
  userId,
  allowedStatuses,
}: {
  isSystemAdmin: boolean
  userId: string
  allowedStatuses: string[]
}) {
  try {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000)

    const [activeAssets, recentlyReady] = await Promise.all([
      prisma.videoAsset.findMany({
        where: {
          previewStatus: { in: ['PENDING', 'PROCESSING'] },
          video: {
            project: {
              status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
              ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId } } }),
            },
          },
        },
        select: {
          id: true,
          fileName: true,
          previewStatus: true,
          video: {
            select: {
              name: true,
              versionLabel: true,
              projectId: true,
              project: { select: { title: true } },
            },
          },
        },
      }),
      prisma.videoAsset.findMany({
        where: {
          previewStatus: 'READY',
          previewGeneratedAt: { gte: cutoff },
          video: {
            project: {
              status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
              ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId } } }),
            },
          },
        },
        select: {
          id: true,
          fileName: true,
          previewGeneratedAt: true,
          video: {
            select: {
              name: true,
              versionLabel: true,
              projectId: true,
              project: { select: { title: true } },
            },
          },
        },
        orderBy: { previewGeneratedAt: 'desc' },
      }),
    ])

    const projectMap = new Map<string, {
      projectId: string
      projectName: string
      pendingCount: number
      processingCount: number
      assets: Array<{
        id: string
        fileName: string
        videoName: string
        versionLabel: string | null
        status: 'PENDING' | 'PROCESSING'
      }>
    }>()

    for (const asset of activeAssets) {
      const projectId = asset.video.projectId
      if (!projectMap.has(projectId)) {
        projectMap.set(projectId, {
          projectId,
          projectName: asset.video.project.title,
          pendingCount: 0,
          processingCount: 0,
          assets: [],
        })
      }
      const entry = projectMap.get(projectId)!
      const status = asset.previewStatus as 'PENDING' | 'PROCESSING'
      if (status === 'PENDING') entry.pendingCount++
      else entry.processingCount++
      entry.assets.push({
        id: asset.id,
        fileName: asset.fileName,
        videoName: asset.video.name,
        versionLabel: asset.video.versionLabel,
        status,
      })
    }

    // Sort assets within each project: processing first, then pending
    for (const entry of projectMap.values()) {
      entry.assets.sort((a, b) => {
        if (a.status !== b.status) return a.status === 'PROCESSING' ? -1 : 1
        return a.fileName.localeCompare(b.fileName)
      })
    }

    // Count assets in each project's wave that have already finished recently.
    // This gives a stable denominator (done + remaining) so the UI can show a
    // real "X of Y processed" figure and a monotonic progress bar, rather than
    // conflating the live concurrency count with completed work.
    const doneByProject = new Map<string, number>()
    for (const asset of recentlyReady) {
      const pid = asset.video.projectId
      doneByProject.set(pid, (doneByProject.get(pid) ?? 0) + 1)
    }

    const active = [...projectMap.values()].map((e) => {
      const doneCount = doneByProject.get(e.projectId) ?? 0
      const remainingCount = e.pendingCount + e.processingCount
      return {
        projectId: e.projectId,
        projectName: e.projectName,
        pendingCount: e.pendingCount,
        processingCount: e.processingCount,
        doneCount,
        // `totalCount` is remaining work (pending + processing) — used for the
        // active-items badge. The full wave size is `doneCount + totalCount`.
        totalCount: remainingCount,
        assets: e.assets,
      }
    })

    const activeProjectIds = new Set(projectMap.keys())

    const completed = (() => {
      const completedByProject = new Map<string, {
        id: string
        type: 'videoAssetPreview'
        label: string
        sublabel: string
        projectId: string
        completedAt: number
        assets: Array<{ id: string; fileName: string; videoName: string; versionLabel: string | null; status: 'PENDING' | 'PROCESSING' }>
      }>()

      for (const asset of recentlyReady) {
        const projectId = asset.video.projectId
        if (!completedByProject.has(projectId)) {
          completedByProject.set(projectId, {
            id: projectId,
            type: 'videoAssetPreview',
            label: 'Asset previews',
            sublabel: asset.video.project.title,
            projectId,
            completedAt: (asset.previewGeneratedAt ?? new Date()).getTime(),
            assets: [],
          })
        }
        const entry = completedByProject.get(projectId)!
        entry.completedAt = Math.max(entry.completedAt, (asset.previewGeneratedAt ?? new Date()).getTime())
        entry.assets.push({
          id: asset.id,
          fileName: asset.fileName,
          videoName: asset.video.name,
          versionLabel: asset.video.versionLabel,
          status: 'PROCESSING', // For completed entries, the status is just for display — we use it for the dot color but all are done
        })
      }

      // Sort assets within each project by filename
      for (const entry of completedByProject.values()) {
        entry.assets.sort((a, b) => a.fileName.localeCompare(b.fileName))
        entry.label = `${entry.assets.length} asset preview${entry.assets.length !== 1 ? 's' : ''}`
      }

      // Don't surface a "complete" summary for a project that still has preview
      // work in flight — otherwise it shows a periodically-updating "N asset
      // previews complete" row alongside the active progress row. Once the wave
      // fully finishes the project drops out of `active` and the completion
      // surfaces (here and via the client-side disappearance detector).
      return [...completedByProject.values()].filter((e) => !activeProjectIds.has(e.projectId))
    })()

    return { active, completed }
  } catch {
    return { active: [], completed: [] }
  }
}

// -----------------------------------------------------------------------
// Album Photo Social Derivative jobs helper
// -----------------------------------------------------------------------

async function buildAlbumSocialJobs({
  isSystemAdmin,
  userId,
  allowedStatuses,
}: {
  isSystemAdmin: boolean
  userId: string
  allowedStatuses: string[]
}) {
  try {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000)

    const [activePhotos, recentlyReady] = await Promise.all([
      prisma.albumPhoto.findMany({
        where: {
          socialStatus: { in: ['PENDING', 'PROCESSING'] as any },
          album: {
            project: {
              status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
              ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId } } }),
            },
          },
        },
        select: {
          albumId: true,
          socialStatus: true,
          album: {
            select: {
              name: true,
              projectId: true,
              project: { select: { title: true } },
            },
          },
        },
      }),
      prisma.albumPhoto.findMany({
        where: {
          socialStatus: 'READY',
          socialGeneratedAt: { gte: cutoff },
          album: {
            project: {
              status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
              ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId } } }),
            },
          },
        },
        select: {
          id: true,
          albumId: true,
          socialGeneratedAt: true,
          album: {
            select: {
              name: true,
              projectId: true,
              project: { select: { title: true } },
            },
          },
        },
        orderBy: { socialGeneratedAt: 'desc' },
      }),
    ])

    const albumMap = new Map<string, {
      albumId: string
      albumName: string
      projectId: string
      projectName: string
      pendingCount: number
      processingCount: number
    }>()

    for (const photo of activePhotos) {
      const albumId = photo.albumId
      if (!albumMap.has(albumId)) {
        albumMap.set(albumId, {
          albumId,
          albumName: photo.album.name,
          projectId: photo.album.projectId,
          projectName: photo.album.project.title,
          pendingCount: 0,
          processingCount: 0,
        })
      }
      const entry = albumMap.get(albumId)!
      if (String(photo.socialStatus) === 'PENDING') entry.pendingCount++
      else entry.processingCount++
    }

    const active = [...albumMap.values()].map((e) => ({
      ...e,
      totalCount: e.pendingCount + e.processingCount,
    }))

    const completed = recentlyReady.map((photo) => ({
      id: photo.id,
      type: 'albumSocial' as const,
      label: photo.album.name,
      sublabel: `${photo.album.project.title} · Social copies complete`,
      projectId: photo.album.projectId,
      completedAt: (photo.socialGeneratedAt ?? new Date()).getTime(),
    }))

    return { active, completed }
  } catch {
    return { active: [], completed: [] }
  }
}
