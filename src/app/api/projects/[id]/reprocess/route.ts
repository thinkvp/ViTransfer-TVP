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
    const reprocessed = []
    const targetedPreviewGeneration = Array.isArray(previewResolutions) && previewResolutions.length > 0
    const thumbnailOnlyMode = thumbnailOnly === true

    for (const video of videosToReprocess) {
      // Preserve user-uploaded thumbnails (asset-based) so reprocessing doesn't delete them
      const hasCustomThumbnail = video.thumbnailPath
        ? !!(await prisma.videoAsset.findFirst({
            where: {
              videoId: video.id,
              storagePath: video.thumbnailPath,
            },
            select: { id: true },
          }))
        : false

      // Delete old preview files (keep original safe)
      const previewFieldsByResolution = {
        '480p': video.preview480Path,
        '720p': video.preview720Path,
        '1080p': video.preview1080Path,
      } as const

      const filesToDelete = [
        ...(thumbnailOnlyMode
          ? []
          : targetedPreviewGeneration
          ? previewResolutions.map((resolution) => previewFieldsByResolution[resolution]).filter(Boolean)
          : [video.preview480Path, video.preview720Path, video.preview1080Path]),
        // Only delete system-generated thumbnails; keep custom assets intact
        ((thumbnailOnlyMode || !targetedPreviewGeneration) && !hasCustomThumbnail) || regenerateThumbnail === true
          ? (hasCustomThumbnail ? null : video.thumbnailPath)
          : null,
      ].filter(Boolean) as string[]

      await Promise.allSettled(
        filesToDelete.map(filePath => deleteFile(filePath))
      )

      // Reset video status and clear preview paths.
      // Use QUEUED (not PROCESSING) so the worker advances the status
      // when it actually picks up the job — matching the upload flow.
      await prisma.video.update({
        where: { id: video.id },
        data: {
          status: 'QUEUED',
          processingProgress: 0,
          processingPhase: null,
          ...(thumbnailOnlyMode
            ? {}
            : targetedPreviewGeneration
            ? {
                ...(previewResolutions.includes('480p') ? { preview480Path: null } : {}),
                ...(previewResolutions.includes('720p') ? { preview720Path: null } : {}),
                ...(previewResolutions.includes('1080p') ? { preview1080Path: null } : {}),
              }
            : {
                preview480Path: null,
                preview720Path: null,
                preview1080Path: null,
              }),
          ...((regenerateThumbnail === true || !targetedPreviewGeneration)
            ? {
                // Keep custom thumbnails; regenerate only system thumbnails
                thumbnailPath: hasCustomThumbnail ? video.thumbnailPath : null,
              }
            : {}),
        },
      })

      // Re-queue video for processing
      await videoQueue.add('process-video', {
        videoId: video.id,
        originalStoragePath: video.originalStoragePath,
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
    const videoAssets = await prisma.videoAsset.findMany({
      where: { videoId: { in: reprocessedVideoIds } },
      select: {
        id: true,
        videoId: true,
        storagePath: true,
        fileType: true,
        fileName: true,
        previewPath: true,
        timelinePreviewVttPath: true,
        timelinePreviewSpritesPath: true,
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

    const projectStoragePath =
      project.storagePath ||
      buildProjectStorageRoot(project.companyName || 'Studio', project.title)

    const previewableAssets = videoAssets.filter((a) => {
      const ft = String(a.fileType || '').toLowerCase()
      return ft.startsWith('image/') || ft.startsWith('video/')
    })

    // Delete old asset preview files
    const assetFilePathsToDelete = new Set<string>()
    const assetDirPathsToDelete = new Set<string>()

    for (const asset of previewableAssets) {
      const videoFolderName = asset.video.storageFolderName || asset.video.name
      if (asset.previewPath) assetFilePathsToDelete.add(asset.previewPath)
      assetFilePathsToDelete.add(
        buildVideoAssetPreviewStoragePath(
          projectStoragePath,
          videoFolderName,
          asset.video.versionLabel,
          asset.storagePath,
          '.jpg',
        ),
      )
      assetFilePathsToDelete.add(
        buildVideoAssetPreviewStoragePath(
          projectStoragePath,
          videoFolderName,
          asset.video.versionLabel,
          asset.storagePath,
          '.mp4',
        ),
      )
      if (asset.timelinePreviewVttPath) assetFilePathsToDelete.add(asset.timelinePreviewVttPath)
      if (asset.timelinePreviewSpritesPath) assetDirPathsToDelete.add(asset.timelinePreviewSpritesPath)
      assetDirPathsToDelete.add(
        buildVideoTimelineStorageRoot(projectStoragePath, videoFolderName, asset.video.versionLabel),
      )
    }

    await Promise.allSettled([
      ...[...assetFilePathsToDelete].map((fp) => deleteFile(fp)),
      ...[...assetDirPathsToDelete].map((dp) => deleteDirectory(dp)),
    ])

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
          previewPath: null,
          previewError: null,
          previewGeneratedAt: null,
          previewFileSize: null,
          previewAttempts: 0,
          previewQueuedAt: null,
          ...(isVideo
            ? {
                timelinePreviewsReady: false,
                timelinePreviewVttPath: null,
                timelinePreviewSpritesPath: null,
              }
            : {}),
        },
      })

      await shareUploadPreviewQueue
        .remove(`share-preview:videoAsset:${asset.id}`)
        .catch(() => {})
      await enqueueShareUploadPreview({
        type: 'videoAsset',
        recordId: asset.id,
        storagePath: asset.storagePath,
        fileType: asset.fileType,
        fileName: asset.fileName,
      })
      queuedAssetPreviewJobs += 1

      if (isVideo) {
        await assetTimelineQueue.add('process-asset-timeline', {
          assetId: asset.id,
          videoId: asset.videoId,
          projectId: project.id,
          storagePath: asset.storagePath,
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
