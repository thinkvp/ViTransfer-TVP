import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import {
  buildAlbumPhotoThumbnailStoragePath,
  buildProjectStorageRoot,
  buildProjectUploadVideoThumbnailStoragePath,
  buildVideoAssetPreviewStoragePath,
  buildVideoPreviewStoragePath,
  buildVideoThumbnailStoragePath,
  buildVideoTimelineStorageRoot,
} from '@/lib/project-storage-paths'
import { deleteDirectory, deleteFile } from '@/lib/storage'
import {
  enqueueShareUploadPreview,
  getAlbumPhotoSocialQueue,
  getShareUploadPreviewQueue,
  getVideoQueue,
} from '@/lib/queue'
import { enqueueAlbumThumbnailJob } from '@/lib/album-photo-thumbnail'
import {
  recalculateAndStoreProjectDiskBytes,
  recalculateAndStoreProjectPreviewBytes,
  recalculateAndStoreProjectTotalBytes,
} from '@/lib/project-total-bytes'
import { cancelProjectJobs } from '@/lib/cancel-project-jobs'

export const runtime = 'nodejs'

async function getProjectReprocessPreviewsStatus(projectId: string) {
  const [queuedOrProcessingVideos, pendingUploadPreviews, pendingVideoAssetPreviews, pendingPhotoSocial, pendingPhotoThumbnails] = await Promise.all([
    prisma.video.count({
      where: {
        projectId,
        status: { in: ['QUEUED', 'PROCESSING'] },
      },
    }),
    prisma.shareUploadFile.count({
      where: {
        projectId,
        previewStatus: { in: ['PENDING', 'PROCESSING'] },
      },
    }),
    prisma.videoAsset.count({
      where: {
        video: { projectId },
        previewStatus: { in: ['PENDING', 'PROCESSING'] },
      },
    }),
    prisma.albumPhoto.count({
      where: {
        album: { projectId },
        socialStatus: { in: ['PENDING', 'PROCESSING'] },
      },
    }),
    prisma.albumPhoto.count({
      where: {
        album: { projectId },
        thumbnailStatus: { in: ['PENDING', 'PROCESSING'] },
      },
    }),
  ])

  const counts = {
    queuedOrProcessingVideos,
    pendingUploadPreviews,
    pendingVideoAssetPreviews,
    pendingPhotoSocial,
    pendingPhotoThumbnails,
  }

  const remainingJobs = Object.values(counts).reduce((sum, value) => sum + value, 0)
  return {
    inProgress: remainingJobs > 0,
    remainingJobs,
    counts,
  }
}

function resolveProjectStoragePath(project: {
  storagePath: string | null
  title: string
  companyName: string | null
  client?: { name: string | null } | null
}): string {
  return project.storagePath || buildProjectStorageRoot(project.client?.name || project.companyName || 'Client', project.title)
}

function isPreviewableFileType(fileType: string | null | undefined): boolean {
  const normalized = String(fileType || '').toLowerCase()
  return normalized.startsWith('image/') || normalized.startsWith('video/')
}

function hasCustomVideoThumbnail(thumbnailPath: string | null | undefined, videoAssetStoragePaths: Set<string>): boolean {
  if (!thumbnailPath) return false
  // The old '/videos/assets/' check never matched — actual path is '/videos/{folder}/{version}/assets/'.
  // Use an exact storagePath lookup, mirroring what video-processor-helpers.ts does.
  return videoAssetStoragePaths.has(thumbnailPath)
}

function addPathCandidate(target: Set<string>, candidate: string | null | undefined) {
  const value = String(candidate || '').trim()
  if (!value) return
  target.add(value)
}

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
    maxRequests: 5,
    message: 'Too many preview reprocess requests. Please slow down.',
  }, 'project-reprocess-previews')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id: projectId } = await params

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        status: true,
        title: true,
        storagePath: true,
        companyName: true,
        client: { select: { name: true } },
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
        { status: 409 },
      )
    }

    const projectStoragePath = resolveProjectStoragePath(project)

    const { cancelled: cancelledJobs } = await cancelProjectJobs(projectId)

    const [videos, uploadFiles, videoAssets, albumPhotos] = await Promise.all([
      prisma.video.findMany({
        where: {
          projectId,
          status: { in: ['READY', 'ERROR'] },
        },
        select: {
          id: true,
          name: true,
          storageFolderName: true,
          versionLabel: true,
          originalStoragePath: true,
          status: true,
          preview480Path: true,
          preview720Path: true,
          preview1080Path: true,
          thumbnailPath: true,
          timelinePreviewVttPath: true,
          timelinePreviewSpritesPath: true,
        },
      }),
      prisma.shareUploadFile.findMany({
        where: { projectId },
        select: {
          id: true,
          storagePath: true,
          fileType: true,
          fileName: true,
          mediaDurationSeconds: true,
          previewPath: true,
        },
      }),
      prisma.videoAsset.findMany({
        where: { video: { projectId } },
        select: {
          id: true,
          storagePath: true,
          fileType: true,
          fileName: true,
          previewPath: true,
          video: {
            select: {
              projectId: true,
              name: true,
              storageFolderName: true,
              versionLabel: true,
            },
          },
        },
      }),
      prisma.albumPhoto.findMany({
        where: {
          album: { projectId },
          status: 'READY',
        },
        select: {
          id: true,
          albumId: true,
          storagePath: true,
          socialStoragePath: true,
          thumbnailStoragePath: true,
        },
      }),
    ])

    const filePathsToDelete = new Set<string>()
    const directoryPathsToDelete = new Set<string>()

    // Build a set of all video asset storage paths so we can detect when a video's thumbnailPath
    // points to one of them (custom thumbnail set via "Set as video thumbnail").
    const videoAssetStoragePathSet = new Set<string>(
      videoAssets.map(a => a.storagePath).filter(Boolean) as string[]
    )

    for (const video of videos) {
      const videoFolderName = video.storageFolderName || video.name
      addPathCandidate(filePathsToDelete, video.preview480Path)
      addPathCandidate(filePathsToDelete, video.preview720Path)
      addPathCandidate(filePathsToDelete, video.preview1080Path)
      addPathCandidate(filePathsToDelete, buildVideoPreviewStoragePath(projectStoragePath, videoFolderName, video.versionLabel, '480p'))
      addPathCandidate(filePathsToDelete, buildVideoPreviewStoragePath(projectStoragePath, videoFolderName, video.versionLabel, '720p'))
      addPathCandidate(filePathsToDelete, buildVideoPreviewStoragePath(projectStoragePath, videoFolderName, video.versionLabel, '1080p'))

      if (!hasCustomVideoThumbnail(video.thumbnailPath, videoAssetStoragePathSet)) {
        addPathCandidate(filePathsToDelete, video.thumbnailPath)
        addPathCandidate(filePathsToDelete, buildVideoThumbnailStoragePath(projectStoragePath, videoFolderName, video.versionLabel))
      }

      addPathCandidate(filePathsToDelete, video.timelinePreviewVttPath)
      addPathCandidate(filePathsToDelete, `${buildVideoTimelineStorageRoot(projectStoragePath, videoFolderName, video.versionLabel)}/index.vtt`)
      addPathCandidate(directoryPathsToDelete, video.timelinePreviewSpritesPath)
      addPathCandidate(directoryPathsToDelete, buildVideoTimelineStorageRoot(projectStoragePath, videoFolderName, video.versionLabel))
    }

    const previewableUploadFiles = uploadFiles.filter((file) => isPreviewableFileType(file.fileType))
    for (const file of previewableUploadFiles) {
      addPathCandidate(filePathsToDelete, file.previewPath)
      addPathCandidate(filePathsToDelete, buildProjectUploadVideoThumbnailStoragePath(projectStoragePath, file.storagePath))
    }

    const previewableVideoAssets = videoAssets.filter((asset) => isPreviewableFileType(asset.fileType))
    for (const asset of previewableVideoAssets) {
      const videoFolderName = asset.video.storageFolderName || asset.video.name
      addPathCandidate(filePathsToDelete, asset.previewPath)
      addPathCandidate(filePathsToDelete, buildVideoAssetPreviewStoragePath(projectStoragePath, videoFolderName, asset.video.versionLabel, asset.storagePath, '.jpg'))
      addPathCandidate(filePathsToDelete, buildVideoAssetPreviewStoragePath(projectStoragePath, videoFolderName, asset.video.versionLabel, asset.storagePath, '.mp4'))
    }

    for (const photo of albumPhotos) {
      addPathCandidate(filePathsToDelete, photo.socialStoragePath)
      addPathCandidate(filePathsToDelete, `${photo.storagePath}-social.jpg`)
      addPathCandidate(filePathsToDelete, photo.thumbnailStoragePath)
      addPathCandidate(filePathsToDelete, buildAlbumPhotoThumbnailStoragePath(projectStoragePath, photo.storagePath))
    }

    await Promise.allSettled([
      ...[...filePathsToDelete].map((filePath) => deleteFile(filePath)),
      ...[...directoryPathsToDelete].map((dirPath) => deleteDirectory(dirPath)),
    ])

    const videoQueue = getVideoQueue()
    let queuedVideoJobs = 0
    for (const video of videos) {
      const preserveCustomThumbnail = hasCustomVideoThumbnail(video.thumbnailPath, videoAssetStoragePathSet)
      await prisma.video.update({
        where: { id: video.id },
        data: {
          status: 'QUEUED',
          processingProgress: 0,
          processingPhase: null,
          processingError: null,
          preview480Path: null,
          preview720Path: null,
          preview1080Path: null,
          thumbnailPath: preserveCustomThumbnail ? video.thumbnailPath : null,
          timelinePreviewsReady: false,
          timelinePreviewVttPath: null,
          timelinePreviewSpritesPath: null,
        },
      })

      await videoQueue.add('process-video', {
        videoId: video.id,
        originalStoragePath: video.originalStoragePath,
        projectId,
        ...(preserveCustomThumbnail ? { regenerateThumbnail: false } : {}),
      })
      queuedVideoJobs += 1
    }

    const shareUploadPreviewQueue = getShareUploadPreviewQueue()
    let queuedUploadPreviewJobs = 0
    for (const file of previewableUploadFiles) {
      await prisma.shareUploadFile.update({
        where: { id: file.id },
        data: {
          previewStatus: null,
          previewPath: null,
          previewError: null,
          previewGeneratedAt: null,
          previewFileSize: null,
          previewAttempts: 0,
          previewQueuedAt: null,
        },
      })

      await shareUploadPreviewQueue.remove(`share-preview:shareUploadFile:${file.id}`).catch(() => {})
      await enqueueShareUploadPreview({
        type: 'shareUploadFile',
        recordId: file.id,
        storagePath: file.storagePath,
        fileType: file.fileType,
        fileName: file.fileName,
        durationSeconds: file.mediaDurationSeconds,
      })
      queuedUploadPreviewJobs += 1
    }

    let queuedVideoAssetPreviewJobs = 0
    for (const asset of previewableVideoAssets) {
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
        },
      })

      await shareUploadPreviewQueue.remove(`share-preview:videoAsset:${asset.id}`).catch(() => {})
      await enqueueShareUploadPreview({
        type: 'videoAsset',
        recordId: asset.id,
        storagePath: asset.storagePath,
        fileType: asset.fileType,
        fileName: asset.fileName,
      })
      queuedVideoAssetPreviewJobs += 1
    }

    const albumPhotoIds = albumPhotos.map((photo) => photo.id)
    if (albumPhotoIds.length > 0) {
      await prisma.albumPhoto.updateMany({
        where: { id: { in: albumPhotoIds } },
        data: {
          socialStoragePath: null,
          socialStatus: 'PENDING',
          socialError: null,
          socialGeneratedAt: null,
          socialFileSize: BigInt(0),
          thumbnailStoragePath: null,
          thumbnailStatus: 'PENDING',
          thumbnailError: null,
          thumbnailGeneratedAt: null,
          thumbnailFileSize: BigInt(0),
        },
      })
    }

    const albumPhotoSocialQueue = getAlbumPhotoSocialQueue()
    let queuedAlbumPhotoSocialJobs = 0
    for (const photo of albumPhotos) {
      await albumPhotoSocialQueue.remove(`album-photo-social-${photo.id}`).catch(() => {})
      await albumPhotoSocialQueue.add(
        'process-album-photo-social',
        { photoId: photo.id },
        { jobId: `album-photo-social-${photo.id}` },
      )
      queuedAlbumPhotoSocialJobs += 1
    }

    const albumIds = [...new Set(albumPhotos.map((photo) => photo.albumId))]
    let queuedAlbumThumbnailJobs = 0
    for (const albumId of albumIds) {
      const jobId = await enqueueAlbumThumbnailJob({ albumId })
      if (jobId) {
        queuedAlbumThumbnailJobs += 1
      }
    }

    await Promise.allSettled([
      recalculateAndStoreProjectPreviewBytes(projectId),
      recalculateAndStoreProjectDiskBytes(projectId),
      recalculateAndStoreProjectTotalBytes(projectId),
    ])

    return NextResponse.json({
      success: true,
      cancelledJobs,
      deletedFilesAttempted: filePathsToDelete.size,
      deletedDirectoriesAttempted: directoryPathsToDelete.size,
      queuedVideoJobs,
      queuedUploadPreviewJobs,
      queuedVideoAssetPreviewJobs,
      queuedAlbumPhotoSocialJobs,
      queuedAlbumThumbnailJobs,
    })
  } catch (error) {
    console.error('Error reprocessing project previews:', error)
    return NextResponse.json(
      { error: 'Failed to reprocess project previews' },
      { status: 500 },
    )
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  try {
    const { id: projectId } = await params

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        status: true,
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (!isVisibleProjectStatusForUser(authResult, project.status)) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const status = await getProjectReprocessPreviewsStatus(projectId)
    return NextResponse.json(status)
  } catch (error) {
    console.error('Error checking project preview reprocess status:', error)
    return NextResponse.json(
      { error: 'Failed to check preview reprocess status' },
      { status: 500 },
    )
  }
}