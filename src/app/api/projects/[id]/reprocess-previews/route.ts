import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import type { VideoStatus } from '@prisma/client'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { deleteDirectory, deleteFile } from '@/lib/storage'
import { getStoredFilePathForProject, deleteStoredFilesByCriteria, getStoredFileRecords, getVideosWithCustomThumbnail } from '@/lib/stored-file'
import type { FileRole } from '@/lib/stored-file'
import {
  enqueueShareUploadPreview,
  getAlbumPhotoSocialQueue,
  getAssetTimelineQueue,
  getShareUploadPreviewQueue,
  getUploadTimelineQueue,
  getVideoQueue,
} from '@/lib/queue'
import { enqueueAlbumThumbnailJob } from '@/lib/album-photo-thumbnail'
import { recalculateAndStoreProjectDiskBytes, recalculateAndStoreProjectPreviewBytes, recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { cancelProjectJobs } from '@/lib/cancel-project-jobs'
import { z } from 'zod'

export const runtime = 'nodejs'

const reprocessPreviewsSchema = z.object({
  videoIds: z.array(z.string().min(1)).max(50).optional(),
})

function isPreviewableFileType(fileType: string | null | undefined): boolean {
  const normalized = String(fileType || '').toLowerCase()
  return normalized.startsWith('image/') || normalized.startsWith('video/')
}

async function getProjectReprocessPreviewsStatus(projectId: string) {
  const [queuedOrProcessingVideos, pendingUploadPreviews, pendingVideoAssetPreviews, pendingPhotoSocial, pendingPhotoThumbnails] = await Promise.all([
    prisma.video.count({ where: { projectId, status: { in: ['QUEUED', 'PROCESSING'] } } }),
    prisma.shareUploadFile.count({ where: { projectId, previewStatus: { in: ['PENDING', 'PROCESSING'] } } }),
    prisma.videoAsset.count({ where: { video: { projectId }, previewStatus: { in: ['PENDING', 'PROCESSING'] } } }),
    prisma.albumPhoto.count({ where: { album: { projectId }, socialStatus: { in: ['PENDING', 'PROCESSING'] } } }),
    prisma.albumPhoto.count({ where: { album: { projectId }, thumbnailStatus: { in: ['PENDING', 'PROCESSING'] } } }),
  ])
  const counts = { queuedOrProcessingVideos, pendingUploadPreviews, pendingVideoAssetPreviews, pendingPhotoSocial, pendingPhotoThumbnails }
  return { inProgress: Object.values(counts).reduce((s, v) => s + v, 0) > 0, remainingJobs: Object.values(counts).reduce((s, v) => s + v, 0), counts }
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
  const rateLimitResult = await rateLimit(request, { windowMs: 60 * 1000, maxRequests: 5, message: 'Too many preview reprocess requests. Please slow down.' }, 'project-reprocess-previews')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id: projectId } = await params
    const body = await request.json().catch(() => ({}))
    const parsed = reprocessPreviewsSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 })
    }
    const { videoIds: scopedVideoIds } = parsed.data

    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, status: true } })
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!isVisibleProjectStatusForUser(authResult, project.status)) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (project.status === 'CLOSED') return NextResponse.json({ error: 'Closed projects cannot queue preview regeneration jobs.' }, { status: 409 })

    const { cancelled: cancelledJobs } = await cancelProjectJobs(projectId)

    const isScoped = Array.isArray(scopedVideoIds) && scopedVideoIds.length > 0

    // Query entities — paths come from StoredFile
    const reprocessStatuses: VideoStatus[] = ['READY', 'ERROR']
    const videoWhere = isScoped
      ? { projectId, id: { in: scopedVideoIds }, status: { in: reprocessStatuses } }
      : { projectId, status: { in: reprocessStatuses } }
    const videoAssetWhere = isScoped
      ? { video: { projectId, id: { in: scopedVideoIds } } }
      : { video: { projectId } }

    const [videos, uploadFiles, videoAssets, albumPhotos] = await Promise.all([
      prisma.video.findMany({ where: videoWhere, select: { id: true, status: true } }),
      isScoped ? Promise.resolve([] as any[]) : prisma.shareUploadFile.findMany({ where: { projectId }, select: { id: true, fileType: true, fileName: true, mediaDurationSeconds: true } }),
      prisma.videoAsset.findMany({ where: videoAssetWhere, select: { id: true, videoId: true, fileType: true, fileName: true } }),
      isScoped ? Promise.resolve([] as any[]) : prisma.albumPhoto.findMany({ where: { album: { projectId }, status: 'READY' }, select: { id: true, albumId: true } }),
    ])

    const videoIds = videos.map(v => v.id)
    const uploadFileIds = uploadFiles.map(f => f.id)
    const videoAssetIds = videoAssets.map(a => a.id)
    const albumPhotoIds = albumPhotos.map(p => p.id)

    // Videos whose THUMBNAIL points at one of their own asset files (custom thumbnail).
    // Their THUMBNAIL must be preserved during reprocess, else we delete the shared
    // asset original from storage (breaking its preview + lightbox).
    const customThumbnailVideoIds = videoIds.length > 0
      ? await getVideosWithCustomThumbnail(videoIds)
      : new Set<string>()

    // Build StoredFile role groups for deletion
    const roleGroups: Array<{ entityType: string; entityIds: string[]; fileRoles: FileRole[] }> = []
    // For videos: exclude THUMBNAIL role for videos that have custom (asset-based) thumbnails
    if (videoIds.length) {
      const videoIdsWithoutCustomThumb = videoIds.filter(id => !customThumbnailVideoIds.has(id))
      const videoIdsWithCustomThumb = videoIds.filter(id => customThumbnailVideoIds.has(id))
      if (videoIdsWithoutCustomThumb.length) {
        roleGroups.push({ entityType: 'VIDEO', entityIds: videoIdsWithoutCustomThumb, fileRoles: ['PREVIEW_480', 'PREVIEW_720', 'PREVIEW_1080', 'THUMBNAIL', 'TIMELINE_VTT', 'TIMELINE_SPRITES', 'HLS_PLAYLIST', 'HLS_SEGMENTS'] })
      }
      if (videoIdsWithCustomThumb.length) {
        roleGroups.push({ entityType: 'VIDEO', entityIds: videoIdsWithCustomThumb, fileRoles: ['PREVIEW_480', 'PREVIEW_720', 'PREVIEW_1080', 'TIMELINE_VTT', 'TIMELINE_SPRITES', 'HLS_PLAYLIST', 'HLS_SEGMENTS'] })
      }
    }
    if (uploadFileIds.length) roleGroups.push({ entityType: 'SHARE_UPLOAD_FILE', entityIds: uploadFileIds, fileRoles: ['PREVIEW_IMAGE', 'PREVIEW_MP4', 'TIMELINE_VTT', 'TIMELINE_SPRITES'] })
    if (videoAssetIds.length) roleGroups.push({ entityType: 'VIDEO_ASSET', entityIds: videoAssetIds, fileRoles: ['PREVIEW_IMAGE', 'PREVIEW_MP4', 'TIMELINE_VTT', 'TIMELINE_SPRITES', 'HLS_PLAYLIST', 'HLS_SEGMENTS'] })
    if (albumPhotoIds.length) roleGroups.push({ entityType: 'ALBUM_PHOTO', entityIds: albumPhotoIds, fileRoles: ['SOCIAL', 'THUMBNAIL'] })

    // Fetch paths to delete — one query per entity type group.
    // Include entityType so we can trace failures back to the owning entity.
    const storedResults = await Promise.all(roleGroups.map(g =>
      g.entityIds.length > 0
        ? getStoredFileRecords(g.entityType as any, g.entityIds, { fileRoles: g.fileRoles, select: { storagePath: true, fileRole: true, entityId: true, entityType: true } })
        : []
    ))
    const storedFilesToDelete = storedResults.flat()
    const filePathsToDelete = new Set(storedFilesToDelete.map(f => f.storagePath))
    const directoryPathsToDelete = new Set<string>()

    // Also delete directory-style roles (timeline sprites + HLS bundle) as whole trees.
    const dirRoleFiles = storedFilesToDelete.filter(f => f.fileRole === 'TIMELINE_SPRITES' || f.fileRole === 'HLS_SEGMENTS')
    dirRoleFiles.forEach(f => directoryPathsToDelete.add(f.storagePath))

    // Build a map from storagePath → { entityType, entityId } so we can
    // skip StoredFile deletion for any entity whose file deletion failed.
    const pathToEntity = new Map<string, { entityType: string; entityId: string }>()
    for (const sf of storedFilesToDelete) {
      const et = (sf as any).entityType as string | undefined
      if (et) pathToEntity.set(sf.storagePath, { entityType: et, entityId: sf.entityId })
    }

    // Delete files from storage — track failures so we don't orphan StoredFile records
    const failedPaths = new Set<string>()
    const filePathArray = [...filePathsToDelete]
    const fileResults = await Promise.allSettled(
      filePathArray.map(p => deleteFile(p))
    )
    for (let i = 0; i < fileResults.length; i++) {
      const result = fileResults[i]
      if (result.status === 'rejected') {
        failedPaths.add(filePathArray[i])
        console.warn(`[reprocess-previews] Failed to delete file, keeping StoredFile record: ${filePathArray[i]} — ${result.reason}`)
      }
    }
    const dirPathArray = [...directoryPathsToDelete]
    const dirResults = await Promise.allSettled(
      dirPathArray.map(p => deleteDirectory(p))
    )
    for (let i = 0; i < dirResults.length; i++) {
      const result = dirResults[i]
      if (result.status === 'rejected') {
        failedPaths.add(dirPathArray[i])
        console.warn(`[reprocess-previews] Failed to delete directory, keeping StoredFile records: ${dirPathArray[i]} — ${result.reason}`)
      }
    }

    // Collect (entityType, entityId) pairs whose file/dir deletions failed
    const failedEntityKeys = new Set<string>()
    for (const fp of failedPaths) {
      const ent = pathToEntity.get(fp)
      if (ent) failedEntityKeys.add(`${ent.entityType}:${ent.entityId}`)
    }

    // Delete StoredFile records — skip entities with failed file deletions
    // so the record survives and can be retried on next reprocess.
    for (const group of roleGroups) {
      if (!group.entityIds.length) continue
      const survivingIds = group.entityIds.filter(id => !failedEntityKeys.has(`${group.entityType}:${id}`))
      if (survivingIds.length) {
        await deleteStoredFilesByCriteria({ entityType: group.entityType as any, entityIds: survivingIds, fileRoles: group.fileRoles })
      }
    }

    // Queue video reprocessing
    const videoQueue = getVideoQueue()
    let queuedVideoJobs = 0
    for (const video of videos) {
      const originalPath = await getStoredFilePathForProject('VIDEO', video.id, 'ORIGINAL', projectId)
      await prisma.video.update({ where: { id: video.id }, data: { status: 'QUEUED', processingProgress: 0, processingPhase: null, processingError: null } })
      await videoQueue.add('process-video', { videoId: video.id, storagePath: originalPath || '', projectId })
      queuedVideoJobs++
    }

    // Queue share upload reprocessing
    const previewableUploadFiles = uploadFiles.filter(f => isPreviewableFileType(f.fileType))
    const shareUploadPreviewQueue = getShareUploadPreviewQueue()
    const uploadTimelineQueue = getUploadTimelineQueue()
    const assetTimelineQueue = getAssetTimelineQueue()
    let queuedUploadPreviewJobs = 0, queuedUploadTimelineJobs = 0
    for (const file of previewableUploadFiles) {
      const isVideo = String(file.fileType || '').toLowerCase().startsWith('video/')
      const originalPath = await getStoredFilePathForProject('SHARE_UPLOAD_FILE', file.id, 'ORIGINAL', projectId) || ''
      await prisma.shareUploadFile.update({ where: { id: file.id }, data: { previewStatus: 'PENDING', previewError: null, previewGeneratedAt: null, previewAttempts: 0, previewQueuedAt: null, ...(isVideo ? { timelinePreviewsReady: false } : {}) } })
      await shareUploadPreviewQueue.remove(`share-preview:shareUploadFile:${file.id}`).catch(() => {})
      await enqueueShareUploadPreview({ type: 'shareUploadFile', recordId: file.id, storagePath: originalPath, fileType: file.fileType, fileName: file.fileName, durationSeconds: file.mediaDurationSeconds })
      queuedUploadPreviewJobs++
      if (isVideo) { await uploadTimelineQueue.add('process-upload-timeline', { uploadFileId: file.id, projectId, storagePath: originalPath, durationSeconds: typeof file.mediaDurationSeconds === 'number' ? file.mediaDurationSeconds : 0, width: 0, height: 0 }); queuedUploadTimelineJobs++ }
    }

    // Queue video asset reprocessing
    const previewableVideoAssets = videoAssets.filter(a => isPreviewableFileType(a.fileType))
    let queuedVideoAssetPreviewJobs = 0, queuedAssetTimelineJobs = 0
    for (const asset of previewableVideoAssets) {
      const isVideo = String(asset.fileType || '').toLowerCase().startsWith('video/')
      const originalPath = await getStoredFilePathForProject('VIDEO_ASSET', asset.id, 'ORIGINAL', projectId) || ''
      await prisma.videoAsset.update({ where: { id: asset.id }, data: { previewStatus: 'PENDING', previewError: null, previewGeneratedAt: null, previewAttempts: 0, previewQueuedAt: null, ...(isVideo ? { timelinePreviewsReady: false } : {}) } })
      await shareUploadPreviewQueue.remove(`share-preview:videoAsset:${asset.id}`).catch(() => {})
      await enqueueShareUploadPreview({ type: 'videoAsset', recordId: asset.id, storagePath: originalPath, fileType: asset.fileType, fileName: asset.fileName })
      queuedVideoAssetPreviewJobs++
      if (isVideo) { await assetTimelineQueue.add('process-asset-timeline', { assetId: asset.id, videoId: asset.videoId, projectId, storagePath: originalPath, durationSeconds: 0, width: 0, height: 0 }); queuedAssetTimelineJobs++ }
    }

    // Queue album photo reprocessing
    if (albumPhotoIds.length > 0) {
      await prisma.albumPhoto.updateMany({ where: { id: { in: albumPhotoIds } }, data: { socialStatus: 'PENDING', socialError: null, socialGeneratedAt: null, thumbnailStatus: 'PENDING', thumbnailError: null, thumbnailGeneratedAt: null } })
    }
    const albumPhotoSocialQueue = getAlbumPhotoSocialQueue()
    let queuedAlbumPhotoSocialJobs = 0
    for (const photo of albumPhotos) {
      await albumPhotoSocialQueue.remove(`album-photo-social-${photo.id}`).catch(() => {})
      await albumPhotoSocialQueue.add('process-album-photo-social', { photoId: photo.id }, { jobId: `album-photo-social-${photo.id}` })
      queuedAlbumPhotoSocialJobs++
    }
    const albumIds = [...new Set(albumPhotos.map(p => p.albumId))]
    let queuedAlbumThumbnailJobs = 0
    for (const albumId of albumIds) {
      const jobId = await enqueueAlbumThumbnailJob({ albumId })
      if (jobId) queuedAlbumThumbnailJobs++
    }

    await Promise.allSettled([recalculateAndStoreProjectPreviewBytes(projectId), recalculateAndStoreProjectDiskBytes(projectId), recalculateAndStoreProjectTotalBytes(projectId)])

    return NextResponse.json({ success: true, cancelledJobs, deletedFilesAttempted: filePathsToDelete.size, deletedDirectoriesAttempted: directoryPathsToDelete.size, queuedVideoJobs, queuedUploadPreviewJobs, queuedUploadTimelineJobs, queuedVideoAssetPreviewJobs, queuedAssetTimelineJobs, queuedAlbumPhotoSocialJobs, queuedAlbumThumbnailJobs })
  } catch (error) {
    console.error('Error reprocessing project previews:', error)
    return NextResponse.json({ error: 'Failed to reprocess project previews' }, { status: 500 })
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult
  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu
  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction
  try {
    const { id: projectId } = await params
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, status: true } })
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!isVisibleProjectStatusForUser(authResult, project.status)) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    return NextResponse.json(await getProjectReprocessPreviewsStatus(projectId))
  } catch (error) {
    console.error('Error checking project preview reprocess status:', error)
    return NextResponse.json({ error: 'Failed to check preview reprocess status' }, { status: 500 })
  }
}