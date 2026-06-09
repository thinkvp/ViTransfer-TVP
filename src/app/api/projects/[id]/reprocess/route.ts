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
import { getStoredFilePath, deleteStoredFilesByCriteria } from '@/lib/stored-file'
import type { FileRole } from '@/lib/stored-file'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import {
  buildProjectStorageRoot,
  buildVideoAssetPreviewStoragePath,
  buildVideoTimelineStorageRoot,
} from '@/lib/project-storage-paths'
import {
  recalculateAndStoreProjectDiskBytes,
  recalculateAndStoreProjectPreviewBytes,
  recalculateAndStoreProjectTotalBytes,
} from '@/lib/project-total-bytes'
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
      return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 })
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
    const videoStoredFiles = await prisma.storedFile.findMany({
      where: { entityType: 'VIDEO', entityId: { in: reprocessVideoIds } },
      select: { entityId: true, fileRole: true, storagePath: true },
    })

    const storedByVideo = new Map<string, Map<string, string>>()
    for (const sf of videoStoredFiles) {
      let map = storedByVideo.get(sf.entityId)
      if (!map) { map = new Map(); storedByVideo.set(sf.entityId, map) }
      map.set(sf.fileRole, sf.storagePath)
    }

    // Check for custom thumbnails (asset-based) via StoredFile
    const assetThumbnailStored = await prisma.storedFile.findMany({
      where: { entityType: 'VIDEO_ASSET', entityId: { in: videoIds }, fileRole: 'THUMBNAIL' },
      select: { entityId: true },
    })
    const customThumbnailVideoIds = new Set(assetThumbnailStored.map(s => s.entityId))

    for (const video of videosToReprocess) {
      const stored = storedByVideo.get(video.id) ?? new Map()
      const hasCustomThumbnail = customThumbnailVideoIds.has(video.id)

      // Collect StoredFile roles to delete
      const rolesToDelete: FileRole[] = []

      // Preview roles
      const resolutionRoles: Record<string, FileRole> = {
        '480p': 'PREVIEW_480',
        '720p': 'PREVIEW_720',
        '1080p': 'PREVIEW_1080',
      }

      if (thumbnailOnlyMode) {
        // Only thumbnail
      } else if (targetedPreviewGeneration) {
        for (const res of previewResolutions!) {
          rolesToDelete.push(resolutionRoles[res])
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

      // Delete files from storage
      const pathsToDelete = rolesToDelete
        .map(role => stored.get(role))
        .filter((p): p is string => !!p)

      await Promise.allSettled(
        pathsToDelete.map(fp => deleteFile(fp))
      )

      // Delete StoredFile records
      if (rolesToDelete.length > 0) {
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
        },
      })

      // Get original path from StoredFile
      const originalPath = stored.get('ORIGINAL')
      if (!originalPath) continue

      // Re-queue video for processing
      await videoQueue.add('process-video', {
        videoId: video.id,
        originalStoragePath: originalPath,
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
    const assetStoredFiles = await prisma.storedFile.findMany({
      where: { entityType: 'VIDEO_ASSET', entityId: { in: assetIds } },
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
    const assetRolesToDelete: FileRole[] = ['PREVIEW_IMAGE', 'PREVIEW_MP4', 'TIMELINE_VTT', 'TIMELINE_SPRITES']

    for (const asset of previewableAssets) {
      const stored = storedByAsset.get(asset.id)
      if (!stored) continue

      const previewImage = stored.get('PREVIEW_IMAGE')
      const previewMp4 = stored.get('PREVIEW_MP4')
      const timelineVtt = stored.get('TIMELINE_VTT')
      const timelineSprites = stored.get('TIMELINE_SPRITES')

      if (previewImage) assetFilePathsToDelete.push(previewImage)
      if (previewMp4) assetFilePathsToDelete.push(previewMp4)
      if (timelineVtt) assetFilePathsToDelete.push(timelineVtt)
      if (timelineSprites) assetDirPathsToDelete.push(timelineSprites)
    }

    await Promise.allSettled([
      ...assetFilePathsToDelete.map((fp) => deleteFile(fp)),
      ...assetDirPathsToDelete.map((dp) => deleteDirectory(dp)),
    ])

    // Delete StoredFile records for all reprocessed assets
    if (assetIds.length > 0) {
      await deleteStoredFilesByCriteria({
        entityType: 'VIDEO_ASSET',
        entityIds: assetIds,
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
