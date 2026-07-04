import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import {
  enqueueShareUploadPreview,
  getAssetTimelineQueue,
  getShareUploadPreviewQueue,
  getVideoQueue,
} from '@/lib/queue'
import { deleteDirectory, deleteFile } from '@/lib/storage'
import { deleteStoredFilesByCriteria, getStoredFileRecords, getVideosWithCustomThumbnail, RESOLUTION_TO_FILE_ROLE } from '@/lib/stored-file'
import type { FileRole } from '@/lib/stored-file'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import {
  recalculateAndStoreProjectDiskBytes,
  recalculateAndStoreProjectPreviewBytes,
  recalculateAndStoreProjectTotalBytes,
} from '@/lib/project-total-bytes'
import { cancelProjectJobs } from '@/lib/cancel-project-jobs'
import { z } from 'zod'
export const runtime = 'nodejs'

const VALID_RESOLUTIONS = ['480p', '720p', '1080p'] as const




const reprocessSchema = z.object({
  videoIds: z.array(z.string().min(1)).max(50).optional(),
  previewResolutions: z.array(z.enum(VALID_RESOLUTIONS)).min(1).optional(),
  regenerateThumbnail: z.boolean().optional(),
  regenerateTimelinePreviews: z.boolean().optional(),
  thumbnailOnly: z.boolean().optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Check authentication - only admins can reprocess
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectStatuses')
  if (forbiddenAction) return forbiddenAction

  // Rate limit to avoid enqueue abuse
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 10,
    message: 'Too many reprocess requests. Please slow down.',
  }, 'project-reprocess')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id: projectId } = await params
    const body = await request.json().catch(() => ({}))
    const parsed = reprocessSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 })
    }
    const {
      videoIds,
      previewResolutions,
      regenerateThumbnail,
      regenerateTimelinePreviews,
      thumbnailOnly,
    } = parsed.data

    // Get project with videos
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        videos: true,
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (!isVisibleProjectStatusForUser(authResult, project.status)) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (project.status === 'CLOSED') {
      return NextResponse.json(
        { error: 'Closed projects cannot queue preview regeneration jobs.' },
        { status: 409 }
      )
    }

    // Cancel existing jobs for this project before re-queuing
    await cancelProjectJobs(project.id)

    // Filter videos: only READY or ERROR status
    let videosToReprocess = project.videos.filter(
      video => video.status === 'READY' || video.status === 'ERROR'
    )

    // If videoIds array provided, filter to only those specific videos
    if (videoIds && Array.isArray(videoIds) && videoIds.length > 0) {
      videosToReprocess = videosToReprocess.filter(video => videoIds.includes(video.id))
    }

    if (videosToReprocess.length === 0) {
      return NextResponse.json({
        error: 'No videos available for reprocessing',
      }, { status: 400 })
    }

    const videoQueue = getVideoQueue()
    const reprocessed: Array<{ id: string; name: string; versionLabel: string }> = []
    const targetedPreviewGeneration = Array.isArray(previewResolutions) && previewResolutions.length > 0
    const thumbnailOnlyMode = thumbnailOnly === true

    // Batch-load StoredFile records for all videos to reprocess
    const reprocessVideoIds = videosToReprocess.map(v => v.id)
    const videoStoredFiles = await getStoredFileRecords('VIDEO', reprocessVideoIds, {
      select: { entityId: true, fileRole: true, storagePath: true },
    })

    const storedByVideo = new Map<string, Map<string, string>>()
    for (const sf of videoStoredFiles) {
      let map = storedByVideo.get(sf.entityId)
      if (!map) { map = new Map(); storedByVideo.set(sf.entityId, map) }
      map.set(sf.fileRole, sf.storagePath)
    }

    // Check for custom thumbnails: videos whose THUMBNAIL points at one of their own
    // asset files. These must NOT have their THUMBNAIL deleted during reprocess, or we
    // would delete the shared asset original from storage (breaking its preview + lightbox).
    const customThumbnailVideoIds = await getVideosWithCustomThumbnail(reprocessVideoIds)

    for (const video of videosToReprocess) {
      const stored = storedByVideo.get(video.id) ?? new Map()
      const hasCustomThumbnail = customThumbnailVideoIds.has(video.id)

      // Collect StoredFile roles to delete
      const rolesToDelete: FileRole[] = []

      if (thumbnailOnlyMode) {
        // Only thumbnail
      } else if (targetedPreviewGeneration) {
        for (const res of previewResolutions!) {
          rolesToDelete.push(RESOLUTION_TO_FILE_ROLE[res])
        }
      } else {
        rolesToDelete.push('PREVIEW_480', 'PREVIEW_720', 'PREVIEW_1080')
      }

      // Thumbnail
      if ((thumbnailOnlyMode || !targetedPreviewGeneration) && !hasCustomThumbnail) {
        rolesToDelete.push('THUMBNAIL')
      } else if (regenerateThumbnail === true) {
        if (!hasCustomThumbnail) rolesToDelete.push('THUMBNAIL')
      }

      // Timeline + HLS files (always delete when doing full or targeted preview reprocessing,
      // so a shrinking rendition set can't leave stale segments behind).
      if (!thumbnailOnlyMode) {
        if (stored.has('TIMELINE_VTT')) rolesToDelete.push('TIMELINE_VTT')
        if (stored.has('TIMELINE_SPRITES')) rolesToDelete.push('TIMELINE_SPRITES')
        if (stored.has('HLS_PLAYLIST')) rolesToDelete.push('HLS_PLAYLIST')
        if (stored.has('HLS_SEGMENTS')) rolesToDelete.push('HLS_SEGMENTS')
      }

      // Delete files from storage. Directory-style roles (timeline sprites + the HLS bundle)
      // must use deleteDirectory; everything else is a single file. Classify by role rather
      // than by path suffix so the routing can't drift from the storage layout.
      const DIRECTORY_ROLES = new Set<FileRole>(['TIMELINE_SPRITES', 'HLS_SEGMENTS'])
      const filePaths: string[] = []
      const dirPaths: string[] = []
      for (const role of rolesToDelete) {
        const p = stored.get(role)
        if (!p) continue
        if (DIRECTORY_ROLES.has(role)) dirPaths.push(p)
        else filePaths.push(p)
      }

      // Delete files — track failures so we don't orphan StoredFile records
      let anyDeleteFailed = false
      const results = await Promise.allSettled([
        ...filePaths.map(fp => deleteFile(fp)),
        ...dirPaths.map(dp => deleteDirectory(dp)),
      ])
      for (const r of results) {
        if (r.status === 'rejected') {
          anyDeleteFailed = true
          console.warn(`[reprocess] Failed to delete file/dir for video ${video.id}: ${r.reason}`)
        }
      }

      // Only delete StoredFile records if all file deletions succeeded
      if (!anyDeleteFailed && rolesToDelete.length > 0) {
        await deleteStoredFilesByCriteria({
          entityType: 'VIDEO',
          entityIds: [video.id],
          fileRoles: rolesToDelete,
        })
      }

      // Reset video status
      await prisma.video.update({
        where: { id: video.id },
        data: {
          status: 'QUEUED',
          processingProgress: 0,
          processingPhase: null,
          processingError: null,
        },
      })

      // Get original path from StoredFile
      const originalPath = stored.get('ORIGINAL')
      if (!originalPath) continue

      // Re-queue video for processing
      await videoQueue.add('process-video', {
        videoId: video.id,
        storagePath: originalPath,
        projectId: project.id,
        ...(thumbnailOnlyMode ? { thumbnailOnly: true } : {}),
        ...(targetedPreviewGeneration ? { requestedPreviewResolutions: previewResolutions } : {}),
        ...(regenerateThumbnail !== undefined ? { regenerateThumbnail } : {}),
        ...(regenerateTimelinePreviews !== undefined ? { regenerateTimelinePreviews } : {}),
      })

      reprocessed.push({
        id: video.id,
        name: video.name,
        versionLabel: video.versionLabel,
      })
    }

    // --- Also reprocess video assets (attached files) for these videos ---
    const reprocessedVideoIds = reprocessed.map((v) => v.id)
    if (reprocessedVideoIds.length === 0) {
      return NextResponse.json({
        success: true,
        count: 0,
        videos: [],
        queuedAssetPreviewJobs: 0,
        queuedAssetTimelineJobs: 0,
      })
    }

    const videoAssets = await prisma.videoAsset.findMany({
      where: { videoId: { in: reprocessedVideoIds } },
      select: {
        id: true,
        videoId: true,
        fileType: true,
        fileName: true,
        video: {
          select: {
            projectId: true,
            name: true,
            storageFolderName: true,
            versionLabel: true,
          },
        },
      },
    })

    const previewableAssets = videoAssets.filter((a) => {
      const ft = String(a.fileType || '').toLowerCase()
      return ft.startsWith('image/') || ft.startsWith('video/')
    })

    // Batch-load StoredFile records for all assets
    const assetIds = previewableAssets.map(a => a.id)
    const assetStoredFiles = await getStoredFileRecords('VIDEO_ASSET', assetIds, {
      select: { entityId: true, fileRole: true, storagePath: true },
    })

    const storedByAsset = new Map<string, Map<string, string>>()
    for (const sf of assetStoredFiles) {
      let map = storedByAsset.get(sf.entityId)
      if (!map) { map = new Map(); storedByAsset.set(sf.entityId, map) }
      map.set(sf.fileRole, sf.storagePath)
    }

    // Delete old asset preview/timeline files and StoredFile records
    const assetFilePathsToDelete: string[] = []
    const assetDirPathsToDelete: string[] = []
    // HLS_SEGMENTS (the asset's hls/ dir) is deleted as a directory; it contains the master.m3u8
    // (HLS_PLAYLIST) too, so HLS_PLAYLIST is dropped via the StoredFile row cleanup, not a file delete.
    const assetRolesToDelete: FileRole[] = ['PREVIEW_IMAGE', 'PREVIEW_MP4', 'TIMELINE_VTT', 'TIMELINE_SPRITES', 'HLS_PLAYLIST', 'HLS_SEGMENTS']

    // Build a map from path → assetId for failure tracking
    const pathToAssetId = new Map<string, string>()
    for (const asset of previewableAssets) {
      const stored = storedByAsset.get(asset.id)
      if (!stored) continue

      const previewImage = stored.get('PREVIEW_IMAGE')
      const previewMp4 = stored.get('PREVIEW_MP4')
      const timelineVtt = stored.get('TIMELINE_VTT')
      const timelineSprites = stored.get('TIMELINE_SPRITES')
      const hlsSegments = stored.get('HLS_SEGMENTS')

      if (previewImage) { assetFilePathsToDelete.push(previewImage); pathToAssetId.set(previewImage, asset.id) }
      if (previewMp4) { assetFilePathsToDelete.push(previewMp4); pathToAssetId.set(previewMp4, asset.id) }
      if (timelineVtt) { assetFilePathsToDelete.push(timelineVtt); pathToAssetId.set(timelineVtt, asset.id) }
      if (timelineSprites) { assetDirPathsToDelete.push(timelineSprites); pathToAssetId.set(timelineSprites, asset.id) }
      if (hlsSegments) { assetDirPathsToDelete.push(hlsSegments); pathToAssetId.set(hlsSegments, asset.id) }
    }

    // Delete files — track which assets had failures
    const failedAssetIds = new Set<string>()
    const fileResults = await Promise.allSettled(
      assetFilePathsToDelete.map((fp) => deleteFile(fp))
    )
    for (let i = 0; i < fileResults.length; i++) {
      if (fileResults[i].status === 'rejected') {
        const aid = pathToAssetId.get(assetFilePathsToDelete[i])
        if (aid) failedAssetIds.add(aid)
        console.warn(`[reprocess] Failed to delete asset file: ${assetFilePathsToDelete[i]} — ${(fileResults[i] as any).reason}`)
      }
    }
    const dirResults = await Promise.allSettled(
      assetDirPathsToDelete.map((dp) => deleteDirectory(dp))
    )
    for (let i = 0; i < dirResults.length; i++) {
      if (dirResults[i].status === 'rejected') {
        const aid = pathToAssetId.get(assetDirPathsToDelete[i])
        if (aid) failedAssetIds.add(aid)
        console.warn(`[reprocess] Failed to delete asset directory: ${assetDirPathsToDelete[i]} — ${(dirResults[i] as any).reason}`)
      }
    }

    // Only delete StoredFile records for assets whose files were all deleted
    const survivingAssetIds = assetIds.filter(id => !failedAssetIds.has(id))
    if (survivingAssetIds.length > 0) {
      await deleteStoredFilesByCriteria({
        entityType: 'VIDEO_ASSET',
        entityIds: survivingAssetIds,
        fileRoles: assetRolesToDelete,
      })
    }

    // Reset asset preview status and enqueue reprocessing jobs
    const shareUploadPreviewQueue = getShareUploadPreviewQueue()
    const assetTimelineQueue = getAssetTimelineQueue()
    let queuedAssetPreviewJobs = 0
    let queuedAssetTimelineJobs = 0

    for (const asset of previewableAssets) {
      const isVideo = String(asset.fileType || '').toLowerCase().startsWith('video/')

      await prisma.videoAsset.update({
        where: { id: asset.id },
        data: {
          previewStatus: null,
          previewError: null,
          previewGeneratedAt: null,
          previewAttempts: 0,
          previewQueuedAt: null,
          ...(isVideo
            ? { timelinePreviewsReady: false }
            : {}),
        },
      })

      await shareUploadPreviewQueue
        .remove(`share-preview:videoAsset:${asset.id}`)
        .catch(() => {})
      await enqueueShareUploadPreview({
        type: 'videoAsset',
        recordId: asset.id,
        storagePath: '', // Worker resolves from StoredFile
        fileType: asset.fileType,
        fileName: asset.fileName,
      })
      queuedAssetPreviewJobs += 1

      if (isVideo) {
        await assetTimelineQueue.add('process-asset-timeline', {
          assetId: asset.id,
          videoId: asset.videoId,
          projectId: project.id,
          storagePath: '', // Worker resolves from StoredFile
          durationSeconds: 0,
          width: 0,
          height: 0,
        })
        queuedAssetTimelineJobs += 1
      }
    }

    // Recalculate project byte totals
    await Promise.allSettled([
      recalculateAndStoreProjectPreviewBytes(project.id),
      recalculateAndStoreProjectDiskBytes(project.id),
      recalculateAndStoreProjectTotalBytes(project.id),
    ])

    return NextResponse.json({
      success: true,
      count: reprocessed.length,
      videos: reprocessed,
      queuedAssetPreviewJobs,
      queuedAssetTimelineJobs,
    })
  } catch (error) {
    console.error('Error reprocessing videos:', error)
    return NextResponse.json(
      { error: 'Failed to reprocess videos' },
      { status: 500 }
    )
  }
}
