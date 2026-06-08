import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { getVideoQueue, getAssetTimelineQueue, getUploadTimelineQueue } from '@/lib/queue'
import { deleteDirectory } from '@/lib/storage'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { z } from 'zod'

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
      // Find all videos that have timeline previews
      const videosWithPreviews = await prisma.video.findMany({
        where: {
          projectId,
          timelinePreviewsReady: true,
        },
        select: {
          id: true,
          timelinePreviewSpritesPath: true,
        },
      })

      // Delete sprite directories from storage
      const deletions = videosWithPreviews
        .filter(v => v.timelinePreviewSpritesPath)
        .map(v => deleteDirectory(v.timelinePreviewSpritesPath!).catch(err => {
          console.error(`[TIMELINE] Failed to delete sprites for video ${v.id}:`, err)
        }))

      await Promise.allSettled(deletions)

      // Clear DB fields for all project videos, assets, and uploads
      await Promise.all([
        prisma.video.updateMany({
          where: { projectId },
          data: {
            timelinePreviewsReady: false,
            timelinePreviewVttPath: null,
            timelinePreviewSpritesPath: null,
          },
        }),
        prisma.videoAsset.updateMany({
          where: { video: { projectId }, timelinePreviewsReady: true },
          data: { timelinePreviewsReady: false, timelinePreviewVttPath: null, timelinePreviewSpritesPath: null },
        }),
        prisma.shareUploadFile.updateMany({
          where: { projectId, timelinePreviewsReady: true },
          data: { timelinePreviewsReady: false, timelinePreviewVttPath: null, timelinePreviewSpritesPath: null },
        }),
      ])

      // Also delete asset and upload sprite directories
      const [assetSprites, uploadSprites] = await Promise.all([
        prisma.videoAsset.findMany({ where: { video: { projectId }, timelinePreviewSpritesPath: { not: null } }, select: { timelinePreviewSpritesPath: true } }),
        prisma.shareUploadFile.findMany({ where: { projectId, timelinePreviewSpritesPath: { not: null } }, select: { timelinePreviewSpritesPath: true } }),
      ])
      await Promise.allSettled([
        ...assetSprites.map(a => deleteDirectory(a.timelinePreviewSpritesPath!).catch(() => {})),
        ...uploadSprites.map(u => deleteDirectory(u.timelinePreviewSpritesPath!).catch(() => {})),
      ])

      return NextResponse.json({
        success: true,
        action: 'remove',
        count: videosWithPreviews.length,
      })
    }

    // action === 'generate'
    const [readyVideos, eligibleAssets, eligibleUploads] = await Promise.all([
      prisma.video.findMany({
        where: { projectId, status: 'READY', timelinePreviewsReady: false },
        select: { id: true, originalStoragePath: true, name: true, versionLabel: true },
      }),
      prisma.videoAsset.findMany({
        where: {
          video: { projectId, status: 'READY', approved: true },
          timelinePreviewsReady: false,
          fileType: { startsWith: 'video/', mode: 'insensitive' },
        },
        select: { id: true, videoId: true, storagePath: true, fileName: true, mediaDurationSeconds: true, mediaWidth: true, mediaHeight: true, video: { select: { id: true, name: true, projectId: true } } },
      }),
      prisma.shareUploadFile.findMany({
        where: {
          projectId,
          timelinePreviewsReady: false,
          fileType: { startsWith: 'video/', mode: 'insensitive' },
        },
        select: { id: true, storagePath: true, fileName: true, mediaDurationSeconds: true, mediaWidth: true, mediaHeight: true, projectId: true },
      }),
    ])

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
      await prisma.video.update({ where: { id: video.id }, data: { processingPhase: 'timeline', processingProgress: 0 } })
      try {
        await videoQueue.add('process-video', { videoId: video.id, originalStoragePath: video.originalStoragePath, projectId, timelineOnly: true })
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
          storagePath: asset.storagePath,
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
          storagePath: upload.storagePath,
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
