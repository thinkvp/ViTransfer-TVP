import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getUserPermissions } from '@/lib/rbac-api'
import { getCpuAllocation, loadCpuConfigOverrides } from '@/lib/cpu-config'
import { getRedis } from '@/lib/redis'
import { getVideoQueue, getAlbumPhotoZipQueue, getAlbumPhotoThumbnailQueue, getFolderRenameQueue, getShareUploadPreviewQueue, getAssetTimelineQueue, getUploadTimelineQueue } from '@/lib/queue'
import { getAlbumZipJobId, type AlbumZipVariant } from '@/lib/album-photo-zip'
import { getAlbumThumbnailQueueJobId } from '@/lib/album-photo-thumbnail'

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
        version: true,
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

    // Visibility filter reused by the queries below (system admins see all;
    // others only their assigned projects, filtered by allowed project statuses).
    const projectVisibilityFilter = {
      status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
      ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId: authResult.id } } }),
    }

    // -----------------------------------------------------------------------
    // Read every queue that feeds a video-version composite or the uploads wave
    // in one shot: video transcode, asset/upload previews, and both timeline
    // queues. The queues are the authoritative record of in-flight work — a
    // video version's entry rolls up its transcode + its assets' previews +
    // timelines, and uploads roll up into one per-project wave.
    // -----------------------------------------------------------------------
    const videoQueue = getVideoQueue()
    const previewQueue = getShareUploadPreviewQueue()
    const assetTimelineQueue = getAssetTimelineQueue()
    const uploadTimelineQueue = getUploadTimelineQueue()
    const previewCutoff = Date.now() - 30 * 60 * 1000

    const [
      vActiveJobs, vWaitingJobs,
      pActiveJobs, pWaitingJobs, pCompletedJobs,
      atActiveJobs, atWaitingJobs,
      utActiveJobs, utWaitingJobs,
    ] = await Promise.all([
      videoQueue.getJobs(['active']),
      videoQueue.getJobs(['waiting', 'prioritized', 'delayed']),
      previewQueue.getJobs(['active']),
      previewQueue.getJobs(['waiting', 'prioritized', 'delayed']),
      previewQueue.getJobs(['completed']),
      assetTimelineQueue.getJobs(['active']),
      assetTimelineQueue.getJobs(['waiting', 'prioritized', 'delayed']),
      uploadTimelineQueue.getJobs(['active']),
      uploadTimelineQueue.getJobs(['waiting', 'prioritized', 'delayed']),
    ])

    // Transcode leg state per video (PROCESSING wins over QUEUED).
    const queueStatusByVideoId = new Map<string, 'QUEUED' | 'PROCESSING'>()
    for (const job of vActiveJobs) {
      const id = job.data?.videoId
      if (id) queueStatusByVideoId.set(id, 'PROCESSING')
    }
    for (const job of vWaitingJobs) {
      const id = job.data?.videoId
      if (id && !queueStatusByVideoId.has(id)) queueStatusByVideoId.set(id, 'QUEUED')
    }

    // Per-record leg state from the preview + timeline queues. 'active' beats 'pending'.
    type LegState = 'active' | 'pending'
    const noteLeg = (map: Map<string, LegState>, id: unknown, state: LegState) => {
      if (typeof id !== 'string' || !id) return
      if (state === 'active' || !map.has(id)) map.set(id, state)
    }
    const assetPreviewLeg = new Map<string, LegState>()
    const uploadPreviewLeg = new Map<string, LegState>()
    const assetTimelineLeg = new Map<string, LegState>()
    const uploadTimelineLeg = new Map<string, LegState>()
    for (const job of pActiveJobs) {
      if (job.data?.type === 'videoAsset') noteLeg(assetPreviewLeg, job.data.recordId, 'active')
      else if (job.data?.type === 'shareUploadFile') noteLeg(uploadPreviewLeg, job.data.recordId, 'active')
    }
    for (const job of pWaitingJobs) {
      if (job.data?.type === 'videoAsset') noteLeg(assetPreviewLeg, job.data.recordId, 'pending')
      else if (job.data?.type === 'shareUploadFile') noteLeg(uploadPreviewLeg, job.data.recordId, 'pending')
    }
    for (const job of atActiveJobs) noteLeg(assetTimelineLeg, job.data?.assetId, 'active')
    for (const job of atWaitingJobs) noteLeg(assetTimelineLeg, job.data?.assetId, 'pending')
    for (const job of utActiveJobs) noteLeg(uploadTimelineLeg, job.data?.uploadFileId, 'active')
    for (const job of utWaitingJobs) noteLeg(uploadTimelineLeg, job.data?.uploadFileId, 'pending')

    // Recently-completed previews give a stable "done" denominator for the wave
    // (retained 1h > 30-min window; counts jobs that finished between polls).
    const assetPreviewDone = new Map<string, number>()
    const uploadPreviewDone = new Map<string, number>()
    for (const job of pCompletedJobs) {
      const finishedOn = job.finishedOn
      const recordId = job.data?.recordId
      if (typeof recordId !== 'string' || !finishedOn || finishedOn < previewCutoff) continue
      const map = job.data?.type === 'videoAsset' ? assetPreviewDone
        : job.data?.type === 'shareUploadFile' ? uploadPreviewDone : null
      if (!map) continue
      const prev = map.get(recordId)
      if (!prev || finishedOn > prev) map.set(recordId, finishedOn)
    }

    // Combine a record's preview + timeline legs into a single status.
    const combineLegs = (
      previewState: LegState | undefined,
      timelineState: LegState | undefined,
      doneAt: number | undefined,
    ): 'active' | 'queued' | 'done' | null => {
      if (previewState === 'active' || timelineState === 'active') return 'active'
      if (previewState === 'pending' || timelineState === 'pending') return 'queued'
      if (doneAt) return 'done'
      return null
    }

    // ---- Video-version composites ------------------------------------------
    // Assets in flight (or recently done) pull in their parent video version,
    // even when that version's own transcode has already finished — so the
    // entry persists until transcode + all its assets are complete.
    const candidateAssetIds = new Set<string>([
      ...assetPreviewLeg.keys(),
      ...assetTimelineLeg.keys(),
      ...assetPreviewDone.keys(),
    ])
    const assetRows = candidateAssetIds.size > 0
      ? await prisma.videoAsset.findMany({
          where: { id: { in: [...candidateAssetIds] }, video: { project: projectVisibilityFilter } },
          select: { id: true, fileName: true, videoId: true },
        })
      : []

    const assetsByVideo = new Map<string, Array<{ id: string; fileName: string; status: 'active' | 'queued' | 'done' }>>()
    for (const a of assetRows) {
      const status = combineLegs(assetPreviewLeg.get(a.id), assetTimelineLeg.get(a.id), assetPreviewDone.get(a.id))
      if (!status) continue
      const arr = assetsByVideo.get(a.videoId) ?? []
      arr.push({ id: a.id, fileName: a.fileName, status })
      assetsByVideo.set(a.videoId, arr)
    }

    // `videos` (fetched above) are the transcode-in-flight candidates; pull in any
    // additional videos that only have asset work running.
    const transcodeVideoIds = new Set(videos.map((v) => v.id))
    const extraVideoIds = [...assetsByVideo.keys()].filter((id) => !transcodeVideoIds.has(id))
    const extraVideos = extraVideoIds.length > 0
      ? await prisma.video.findMany({
          where: { id: { in: extraVideoIds }, project: projectVisibilityFilter },
          select: {
            id: true, name: true, version: true, versionLabel: true, status: true,
            processingProgress: true, processingPhase: true, projectId: true,
            project: { select: { title: true } },
          },
        })
      : []
    const allCompositeVideos = [...videos, ...extraVideos]

    const assetStatusRank = { active: 0, queued: 1, done: 2 }
    const composites = allCompositeVideos
      .map((video) => {
        const processingPhase = video.processingPhase ?? null
        const queueStatus = queueStatusByVideoId.get(video.id)
        let transcodeStatus: 'QUEUED' | 'PROCESSING' | 'DONE'
        if (queueStatus) transcodeStatus = queueStatus
        else if (video.status === 'QUEUED') transcodeStatus = 'QUEUED'
        else if (video.status === 'PROCESSING') transcodeStatus = 'PROCESSING'
        else if (video.status === 'READY' && processingPhase) transcodeStatus = (video.processingProgress ?? 0) > 0 ? 'PROCESSING' : 'QUEUED'
        else transcodeStatus = 'DONE'

        const transcodeInWave = transcodeStatus === 'QUEUED' || transcodeStatus === 'PROCESSING'

        const assets = (assetsByVideo.get(video.id) ?? []).slice().sort(
          (a, b) => assetStatusRank[a.status] - assetStatusRank[b.status] || a.fileName.localeCompare(b.fileName),
        )
        const assetActive = assets.filter((a) => a.status === 'active').length
        const assetPending = assets.filter((a) => a.status === 'queued').length
        const assetDone = assets.filter((a) => a.status === 'done').length
        const assetTotal = assets.length

        // Nothing in flight → it has finished; let it surface as a completion
        // (the client detects the disappearance from the active list).
        if (!transcodeInWave && assetActive + assetPending === 0) return null

        const status: 'QUEUED' | 'PROCESSING' =
          transcodeStatus === 'PROCESSING' || assetActive > 0 ? 'PROCESSING' : 'QUEUED'

        const totalUnits = (transcodeInWave ? 1 : 0) + assetTotal
        const doneUnits =
          (transcodeInWave && transcodeStatus === 'PROCESSING' ? (video.processingProgress ?? 0) / 100 : 0) + assetDone
        const processingProgress = status === 'QUEUED' || totalUnits === 0
          ? 0
          : Math.round((doneUnits / totalUnits) * 100)

        return {
          id: video.id,
          projectId: video.projectId,
          projectName: video.project.title,
          videoName: video.name,
          // Always surface a version label; fall back to v{version} for blank
          // (older/imported) rows, matching the worker/delete paths.
          versionLabel: video.versionLabel || `v${video.version}`,
          status,
          processingProgress,
          // Phase drives the transcode-side label; null once only assets remain.
          processingPhase: transcodeInWave ? processingPhase : null,
          transcodeInWave,
          assets,
          assetTotal,
          assetActive,
          assetPending,
          assetDone,
        }
      })
      .filter((j): j is NonNullable<typeof j> => j !== null)

    const compositeVideoIdSet = new Set(composites.map((j) => j.id))

    await loadCpuConfigOverrides(getRedis())
    const alloc = getCpuAllocation()
    const configuredThreadPool = alloc.maxThreadsUsedEstimate
    const activeTranscodeCount = composites.filter(
      (j) => j.transcodeInWave && j.status === 'PROCESSING' && j.processingPhase !== 'thumbnail',
    ).length

    let dynamicThreadsPerJob: number
    if (!alloc.dynamicThreadAllocation || activeTranscodeCount === 0) {
      dynamicThreadsPerJob = alloc.ffmpegThreadsPerJob
    } else {
      dynamicThreadsPerJob = Math.max(
        1,
        Math.min(Math.floor(configuredThreadPool / activeTranscodeCount), configuredThreadPool),
      )
    }

    const jobs = composites.map((job) => {
      let allocatedThreads: number | null = null
      if (job.transcodeInWave && job.status === 'PROCESSING') {
        allocatedThreads = job.processingPhase === 'thumbnail'
          ? alloc.timelineThreadsPerJob
          : dynamicThreadsPerJob
      }
      return {
        id: job.id,
        projectId: job.projectId,
        projectName: job.projectName,
        videoName: job.videoName,
        versionLabel: job.versionLabel,
        status: job.status,
        processingProgress: job.processingProgress,
        processingPhase: job.processingPhase,
        allocatedThreads,
        threadBudget: allocatedThreads ? configuredThreadPool : null,
        // Composite asset rollup (preview + timeline legs per asset).
        assets: job.assets,
        assetTotal: job.assetTotal,
        assetActive: job.assetActive,
        assetPending: job.assetPending,
        assetDone: job.assetDone,
      }
    })

    // ---- Uploads wave (one composite entry per project) --------------------
    // Reuses the (legacy-named) `videoAssetPreviewJobs` response channel: video
    // assets now live inside their version's composite above, freeing this
    // channel for the UPLOADS area, which has no sub-entity to attach to.
    const candidateUploadIds = new Set<string>([
      ...uploadPreviewLeg.keys(),
      ...uploadTimelineLeg.keys(),
      ...uploadPreviewDone.keys(),
    ])
    const uploadRows = candidateUploadIds.size > 0
      ? await prisma.shareUploadFile.findMany({
          where: { id: { in: [...candidateUploadIds] }, project: projectVisibilityFilter },
          select: { id: true, fileName: true, projectId: true, project: { select: { title: true } } },
        })
      : []

    const uploadProjectMap = new Map<string, {
      projectId: string
      projectName: string
      pendingCount: number
      processingCount: number
      doneCount: number
      latestDoneAt: number
      activeFiles: Array<{ id: string; fileName: string; status: 'active' | 'queued' }>
    }>()
    for (const u of uploadRows) {
      const status = combineLegs(uploadPreviewLeg.get(u.id), uploadTimelineLeg.get(u.id), uploadPreviewDone.get(u.id))
      if (!status) continue
      let entry = uploadProjectMap.get(u.projectId)
      if (!entry) {
        entry = { projectId: u.projectId, projectName: u.project.title, pendingCount: 0, processingCount: 0, doneCount: 0, latestDoneAt: 0, activeFiles: [] }
        uploadProjectMap.set(u.projectId, entry)
      }
      if (status === 'active') { entry.processingCount++; entry.activeFiles.push({ id: u.id, fileName: u.fileName, status: 'active' }) }
      else if (status === 'queued') { entry.pendingCount++; entry.activeFiles.push({ id: u.id, fileName: u.fileName, status: 'queued' }) }
      else { entry.doneCount++; entry.latestDoneAt = Math.max(entry.latestDoneAt, uploadPreviewDone.get(u.id) ?? 0) }
    }

    // An uploads area can hold 100+ files — cap sub-items, keep true counts.
    const UPLOAD_SUBITEM_CAP = 8
    const uploadsJobs = {
      active: [...uploadProjectMap.values()]
        .filter((e) => e.pendingCount + e.processingCount > 0)
        .map((e) => {
          const sorted = e.activeFiles.sort(
            (a, b) => (a.status === b.status ? a.fileName.localeCompare(b.fileName) : a.status === 'active' ? -1 : 1),
          )
          return {
            projectId: e.projectId,
            projectName: e.projectName,
            pendingCount: e.pendingCount,
            processingCount: e.processingCount,
            doneCount: e.doneCount,
            totalCount: e.pendingCount + e.processingCount,
            assets: sorted.slice(0, UPLOAD_SUBITEM_CAP).map((f) => ({
              id: f.id, fileName: f.fileName, videoName: '', versionLabel: null,
              status: f.status === 'active' ? 'PROCESSING' as const : 'PENDING' as const,
            })),
          }
        }),
      completed: [...uploadProjectMap.values()]
        .filter((e) => e.pendingCount + e.processingCount === 0 && e.doneCount > 0)
        .map((e) => ({
          id: e.projectId,
          type: 'videoAssetPreview' as const,
          label: `${e.doneCount} upload${e.doneCount !== 1 ? 's' : ''}`,
          sublabel: e.projectName,
          projectName: e.projectName,
          projectId: e.projectId,
          completedAt: e.latestDoneAt || Date.now(),
        })),
    }

    const recentCompletionCutoff = new Date(Date.now() - 30 * 60 * 1000)

    // -----------------------------------------------------------------------
    // Accurate "recently finished" detection for video processing.
    //
    // Inferring completion from Video.updatedAt is unreliable: ANY mutation
    // (rename, approval toggle, notes edit, allowApproval) bumps updatedAt, so a
    // long-finished READY video would resurface as a phantom "Processing
    // complete" for 30 minutes after an unrelated edit. Instead, use the
    // video-processing queue's completed set as the authoritative signal — a
    // completed BullMQ job only exists for a real processing run. Completed jobs
    // are retained for 1h (see queue.ts), comfortably longer than the 30-min UI
    // window, and carry finishedOn for an accurate completion time.
    // -----------------------------------------------------------------------
    // The same reasoning applies to failures: a video's status stays ERROR until
    // it is reprocessed, so `status:ERROR + updatedAt` would resurface a stale
    // failure after any edit. The queue's failed set (retained 24h) carries the
    // real finishedOn of the last failed run.
    const recentlyCompletedVideoFinishedAt = new Map<string, number>()
    const recentlyFailedVideoFinishedAt = new Map<string, number>()
    const recordLatest = (map: Map<string, number>, videoId: unknown, finishedOn: number | undefined) => {
      if (typeof videoId !== 'string' || !finishedOn || finishedOn < recentCompletionCutoff.getTime()) return
      const existing = map.get(videoId)
      if (!existing || finishedOn > existing) map.set(videoId, finishedOn)
    }
    try {
      const videoQueue = getVideoQueue()
      const [completedVideoJobs, failedVideoJobs] = await Promise.all([
        videoQueue.getJobs(['completed']),
        videoQueue.getJobs(['failed']),
      ])
      for (const job of completedVideoJobs) recordLatest(recentlyCompletedVideoFinishedAt, job.data?.videoId, job.finishedOn)
      for (const job of failedVideoJobs) recordLatest(recentlyFailedVideoFinishedAt, job.data?.videoId, job.finishedOn)
    } catch (err) {
      console.error('[running-jobs] video-queue completion lookup failed:', err)
    }
    // A video whose transcode finished but whose assets are still generating is
    // still an active composite — don't also surface it as "complete" yet.
    const recentlyCompletedVideoIds = [...recentlyCompletedVideoFinishedAt.keys()].filter((id) => !compositeVideoIdSet.has(id))
    const recentlyFailedVideoIds = [...recentlyFailedVideoFinishedAt.keys()]

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
      albumSocialJobs,
    ] = await Promise.all([
      prisma.video.findMany({
        where: {
          status: 'READY', processingPhase: null, processingProgress: 100,
          // Authoritative completion signal — only videos with a recent completed
          // queue job, not anything merely updated recently (see above).
          id: { in: recentlyCompletedVideoIds },
          project: {
            status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
            ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId: authResult.id } } }),
          },
        },
        select: { id: true, name: true, version: true, versionLabel: true, projectId: true, updatedAt: true, project: { select: { title: true } } },
      }).catch((err) => { console.error('[running-jobs] completed-processing query failed:', err); return [] }),
      prisma.video.findMany({
        where: {
          status: 'ERROR',
          // Authoritative failure signal — only videos with a recent failed queue
          // job, not anything merely updated recently (see above).
          id: { in: recentlyFailedVideoIds },
          project: {
            status: allowedStatuses.length > 0 ? { in: allowedStatuses as any } : undefined,
            ...(isSystemAdmin ? {} : { assignedUsers: { some: { userId: authResult.id } } }),
          },
        },
        select: { id: true, name: true, version: true, versionLabel: true, projectId: true, updatedAt: true, project: { select: { title: true } } },
      }).catch((err) => { console.error('[running-jobs] errored-processing query failed:', err); return [] }),
      buildAlbumZipJobs({ isSystemAdmin, userId: authResult.id, allowedStatuses }).catch((err) => { console.error('[running-jobs] album-zip builder failed:', err); return { active: [], completed: [] } }),
      buildAlbumThumbnailJobs().catch((err) => { console.error('[running-jobs] album-thumbnail builder failed:', err); return { active: [], completed: [] } }),
      buildFolderRenameJobs().catch((err) => { console.error('[running-jobs] folder-rename builder failed:', err); return { active: [], completed: [] } }),
      buildAlbumSocialJobs({ isSystemAdmin, userId: authResult.id, allowedStatuses }).catch((err) => { console.error('[running-jobs] album-social builder failed:', err); return { active: [], completed: [] } }),
    ])

    const completedProcessingJobs = completedProcessingVideos.map((video) => ({
      id: video.id,
      type: 'processing' as const,
      label: `${video.name} ${video.versionLabel || `v${video.version}`}`,
      sublabel: video.project.title,
      projectId: video.projectId,
      completedAt: recentlyCompletedVideoFinishedAt.get(video.id) ?? video.updatedAt.getTime(),
    }))

    const erroredProcessingJobs = erroredProcessingVideos.map((video) => ({
      id: video.id,
      type: 'processing' as const,
      label: `${video.name} ${video.versionLabel || `v${video.version}`}`,
      sublabel: video.project.title,
      projectId: video.projectId,
      completedAt: recentlyFailedVideoFinishedAt.get(video.id) ?? video.updatedAt.getTime(),
      error: true,
    }))

    return NextResponse.json({
      jobs,
      completedProcessingJobs,
      erroredProcessingJobs,
      albumZipJobs,
      albumThumbnailJobs,
      folderRenameJobs,
      // Legacy channel name — now carries the per-project UPLOADS wave (video
      // assets moved into their version's composite in `jobs`).
      videoAssetPreviewJobs: uploadsJobs,
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
    const [activeZipQueueJobs, waitingZipQueueJobs, completedZipQueueJobs] = await Promise.all([
      albumZipQueue.getJobs(['active']),
      albumZipQueue.getJobs(['waiting', 'prioritized', 'delayed']),
      albumZipQueue.getJobs(['completed']),
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

    // Authoritative completion signal: a completed BullMQ zip job (retained 1h,
    // longer than the 30-min window) carries albumId+variant+finishedOn. This
    // replaces inferring completion from album.updatedAt, which bumps on any
    // album edit (rename, reorder, settings) and produced phantom "ZIP complete".
    const completedZipFinishedAt = new Map<string, number>() // `${albumId}:${variant}` → finishedOn
    const completedAlbumIds = new Set<string>()
    for (const qj of completedZipQueueJobs) {
      const { albumId, variant } = qj.data ?? {}
      const finishedOn = qj.finishedOn
      if (albumId && variant && finishedOn && finishedOn >= cutoff.getTime()) {
        const key = `${albumId}:${variant}`
        const existing = completedZipFinishedAt.get(key)
        if (!existing || finishedOn > existing) completedZipFinishedAt.set(key, finishedOn)
        completedAlbumIds.add(albumId)
      }
    }

    // Fetch album details for both active and recently-completed jobs in one query.
    const neededAlbumIds = new Set<string>([...activeAlbumIds, ...completedAlbumIds])
    let albums: Array<{ id: string; name: string; projectId: string; project: { title: string } }> = []
    if (neededAlbumIds.size > 0) {
      albums = await prisma.album.findMany({
        where: {
          id: { in: [...neededAlbumIds] },
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
    const albumById = new Map(albums.map((a) => [a.id, a] as const))

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

    // Build completed entries straight from the completed queue jobs. The job
    // payload tells us the exact album+variant, so no StoredFile size probe or
    // updatedAt heuristic is needed. Skip variants still active (a fresh rebuild
    // in flight takes precedence over a prior completion).
    const activeAlbumVariantSet = new Set(active.map((j) => `${j.albumId}:${j.variant}`))

    const completed: Array<{
      id: string
      type: 'albumZip'
      label: string
      sublabel: string
      projectId: string
      completedAt: number
    }> = []

    for (const [key, finishedOn] of completedZipFinishedAt) {
      if (activeAlbumVariantSet.has(key)) continue
      const [albumId, variant] = key.split(':') as [string, 'full' | 'social']
      const album = albumById.get(albumId)
      if (!album) continue // not visible to this user, or deleted
      const variantLabel = variant === 'full' ? 'Full Res ZIP' : 'Social Sized ZIP'
      completed.push({
        id: key,
        type: 'albumZip',
        label: album.name,
        sublabel: `${album.project.title} · ${variantLabel} complete`,
        projectId: album.projectId,
        completedAt: finishedOn,
      })
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
