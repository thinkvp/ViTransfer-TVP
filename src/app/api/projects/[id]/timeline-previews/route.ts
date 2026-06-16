import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { getVideoQueue, getAssetTimelineQueue, getUploadTimelineQueue } from '@/lib/queue'
import { deleteDirectory } from '@/lib/storage'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { z } from 'zod'
import { getStoredFileRecords, deleteStoredFilesByCriteria } from '@/lib/stored-file'

export const runtime = 'nodejs'

const bodySchema = z.object({
  action: z.enum(['remove', 'generate']),
})

/**
 * Manage timeline previews for all videos in a project.
 *
 * - `action: 'remove'`   — delete sprite files from storage and clear DB fields.
 * - `action: 'generate'` — queue timeline-only worker jobs for every READY video
 *                           that doesn't already have previews generated.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 10,
    message: 'Too many timeline preview requests. Please slow down.',
  }, 'timeline-previews')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id: projectId } = await params
    const body = await request.json().catch(() => ({}))
    const parsed = bodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 })
    }

    const { action } = parsed.data

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, status: true },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (!isVisibleProjectStatusForUser(authResult, project.status)) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (project.status === 'CLOSED' && action === 'generate') {
      return NextResponse.json(
        { error: 'Closed projects cannot queue timeline preview generation jobs.' },
        { status: 409 }
      )
    }

    if (action === 'remove') {
      // Pre-fetch entity IDs
      const [videoEntities, assetEntities, uploadEntities] = await Promise.all([
        prisma.video.findMany({ where: { projectId }, select: { id: true } }),
        prisma.videoAsset.findMany({ where: { video: { projectId } }, select: { id: true } }),
        prisma.shareUploadFile.findMany({ where: { projectId }, select: { id: true } }),
      ])
      const vIds = videoEntities.map(v => v.id)
      const aIds = assetEntities.map(a => a.id)
      const uIds = uploadEntities.map(u => u.id)

      // Find all timeline sprite StoredFile records
      const [videoSprites, assetSprites, uploadSprites] = await Promise.all([
        vIds.length > 0 ? getStoredFileRecords('VIDEO', vIds, { fileRoles: ['TIMELINE_SPRITES'], select: { storagePath: true } }) : [],
        aIds.length > 0 ? getStoredFileRecords('VIDEO_ASSET', aIds, { fileRoles: ['TIMELINE_SPRITES'], select: { storagePath: true } }) : [],
        uIds.length > 0 ? getStoredFileRecords('SHARE_UPLOAD_FILE', uIds, { fileRoles: ['TIMELINE_SPRITES'], select: { storagePath: true } }) : [],
      ])

      const allSprites = [...videoSprites, ...assetSprites, ...uploadSprites]
      await Promise.allSettled(allSprites.map(s => deleteDirectory(s.storagePath).catch(() => {})))

      // Also delete VTT files
      const videoVttPaths = vIds.length > 0 ? await getStoredFileRecords('VIDEO', vIds, { fileRoles: ['TIMELINE_VTT'], select: { storagePath: true } }) : []
      await Promise.allSettled(videoVttPaths.map(s => deleteDirectory(s.storagePath).catch(() => {})))

      // Clear timelinePreviewsReady on VideoAsset, ShareUploadFile, and Video
      // Update VideoAsset/ShareUploadFile/Video timelinePreviewsReady flags
      await Promise.all([
        prisma.video.updateMany({ where: { projectId }, data: { timelinePreviewsReady: false } }),
        prisma.videoAsset.updateMany({ where: { video: { projectId } }, data: { timelinePreviewsReady: false } }),
        prisma.shareUploadFile.updateMany({ where: { projectId }, data: { timelinePreviewsReady: false } }),
      ])

      // Delete StoredFile records for timeline roles (reuse previously fetched IDs)
      await deleteStoredFilesByCriteria({ entityType: 'VIDEO', entityIds: vIds, fileRoles: ['TIMELINE_VTT', 'TIMELINE_SPRITES'] })
      await deleteStoredFilesByCriteria({ entityType: 'VIDEO_ASSET', entityIds: aIds, fileRoles: ['TIMELINE_VTT', 'TIMELINE_SPRITES'] })
      await deleteStoredFilesByCriteria({ entityType: 'SHARE_UPLOAD_FILE', entityIds: uIds, fileRoles: ['TIMELINE_VTT', 'TIMELINE_SPRITES'] })

      return NextResponse.json({ success: true, action: 'remove', count: allSprites.length })
    }

    // action === 'generate'
    const [readyVideos, eligibleAssets, eligibleUploads] = await Promise.all([
      prisma.video.findMany({
        where: { projectId, status: 'READY' },
        select: { id: true, name: true, versionLabel: true },
      }),
      prisma.videoAsset.findMany({
        where: {
          video: { projectId, status: 'READY', approved: true },
          timelinePreviewsReady: false,
          fileType: { startsWith: 'video/', mode: 'insensitive' },
        },
        select: { id: true, videoId: true, fileName: true, mediaDurationSeconds: true, mediaWidth: true, mediaHeight: true, video: { select: { id: true, name: true, projectId: true } } },
      }),
      prisma.shareUploadFile.findMany({
        where: {
          projectId,
          timelinePreviewsReady: false,
          fileType: { startsWith: 'video/', mode: 'insensitive' },
        },
        select: { id: true, fileName: true, mediaDurationSeconds: true, mediaWidth: true, mediaHeight: true, projectId: true },
      }),
    ])

    // Batch-load StoredFile ORIGINAL paths for videos
    const videoIds = readyVideos.map(v => v.id)
    const videoOrigPaths = new Map<string, string>()
    if (videoIds.length > 0) {
      const origRecords = await getStoredFileRecords('VIDEO', videoIds, { fileRoles: ['ORIGINAL'], select: { entityId: true, storagePath: true } })
      for (const r of origRecords) videoOrigPaths.set(r.entityId, r.storagePath)
    }

    const totalCount = readyVideos.length + eligibleAssets.length + eligibleUploads.length
    if (totalCount === 0) {
      return NextResponse.json({ success: true, action: 'generate', count: 0, message: 'No videos, assets, or uploads need timeline preview generation' })
    }

    const videoQueue = getVideoQueue()
    const assetTimelineQueue = getAssetTimelineQueue()
    const uploadTimelineQueue = getUploadTimelineQueue()

    let queuedVideos = 0
    let queuedAssets = 0
    let queuedUploads = 0

    for (const video of readyVideos) {
      const origPath = videoOrigPaths.get(video.id)
      if (!origPath) continue
      await prisma.video.update({ where: { id: video.id }, data: { processingPhase: 'timeline', processingProgress: 0 } })
      try {
        await videoQueue.add('process-video', { videoId: video.id, originalStoragePath: origPath, projectId, timelineOnly: true })
        queuedVideos++
      } catch (error) {
        await prisma.video.update({ where: { id: video.id }, data: { processingPhase: null, processingProgress: 0 } }).catch(() => {})
        throw error
      }
    }

    for (const asset of eligibleAssets) {
      await prisma.videoAsset.update({ where: { id: asset.id }, data: { processingPhase: 'timeline', processingProgress: 0 } })
      try {
        await assetTimelineQueue.add('process-asset-timeline', {
          assetId: asset.id, videoId: asset.videoId, projectId,
          storagePath: '', // Worker resolves from StoredFile
          durationSeconds: asset.mediaDurationSeconds ?? 0,
          width: asset.mediaWidth ?? 0, height: asset.mediaHeight ?? 0,
        })
        queuedAssets++
      } catch (error) {
        await prisma.videoAsset.update({ where: { id: asset.id }, data: { processingPhase: null, processingProgress: 0 } }).catch(() => {})
        throw error
      }
    }

    for (const upload of eligibleUploads) {
      await prisma.shareUploadFile.update({ where: { id: upload.id }, data: { processingPhase: 'timeline', processingProgress: 0 } })
      try {
        await uploadTimelineQueue.add('process-upload-timeline', {
          uploadFileId: upload.id, projectId,
          storagePath: '', // Worker resolves from StoredFile
          durationSeconds: upload.mediaDurationSeconds ?? 0,
          width: upload.mediaWidth ?? 0, height: upload.mediaHeight ?? 0,
        })
        queuedUploads++
      } catch (error) {
        await prisma.shareUploadFile.update({ where: { id: upload.id }, data: { processingPhase: null, processingProgress: 0 } }).catch(() => {})
        throw error
      }
    }

    return NextResponse.json({
      success: true,
      action: 'generate',
      count: totalCount,
      videos: readyVideos.map(v => ({ id: v.id, name: v.name, versionLabel: v.versionLabel })),
      assets: eligibleAssets.map(a => ({ id: a.id, fileName: a.fileName, videoName: a.video.name })),
      uploads: eligibleUploads.map(u => ({ id: u.id, fileName: u.fileName })),
      summary: { videos: queuedVideos, assets: queuedAssets, uploads: queuedUploads },
    })
  } catch (error) {
    console.error('[TIMELINE] Error managing timeline previews:', error)
    return NextResponse.json(
      { error: 'Failed to manage timeline previews' },
      { status: 500 }
    )
  }
}
