import path from 'path'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { moveDirectory } from '@/lib/storage'
import { isS3Mode } from '@/lib/s3-storage'
import { getFolderRenameQueue } from '@/lib/queue'
import {
  allocateUniqueStorageName,
  buildVideoAssetPreviewStoragePath,
  buildProjectPreviewsRoot,
  buildProjectStorageRoot,
  buildVideoStorageRoot,
  getStoragePathBasename,
  replaceStoredStoragePathPrefix,
} from '@/lib/project-storage-paths'
export const runtime = 'nodejs'




export async function PATCH(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) {
    return authResult
  }

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  // Rate limiting: 60 requests per minute for batch operations
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: 'Too many batch operations. Please slow down.'
  }, 'admin-batch-ops')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const body = await request.json()
    const { videoIds, name, confirmed } = body

    if (!Array.isArray(videoIds) || videoIds.length === 0) {
      return NextResponse.json(
        { error: 'Invalid request' },
        { status: 400 }
      )
    }

    // Batch size limit: max 100 items
    if (videoIds.length > 100) {
      return NextResponse.json(
        { error: 'Batch size limit exceeded' },
        { status: 400 }
      )
    }

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json(
        { error: 'name must be a non-empty string' },
        { status: 400 }
      )
    }

    const trimmedName = name.trim()

    const selectedVideos = await prisma.video.findMany({
      where: { id: { in: videoIds } },
      select: {
        id: true,
        projectId: true,
        name: true,
        storageFolderName: true,
        versionLabel: true,
        originalStoragePath: true,
        preview480Path: true,
        preview720Path: true,
        preview1080Path: true,
        thumbnailPath: true,
        timelinePreviewVttPath: true,
        timelinePreviewSpritesPath: true,
        project: { select: { title: true, companyName: true, storagePath: true, client: { select: { name: true } } } },
      },
    })

    const projectIds = Array.from(new Set(selectedVideos.map((video) => video.projectId)))
    const otherVideoFolderRows = await prisma.video.findMany({
      where: {
        projectId: { in: projectIds },
        id: { notIn: videoIds },
      },
      select: { projectId: true, storageFolderName: true, name: true },
    })
    const usedFolderNamesByProject = new Map<string, string[]>()
    for (const row of otherVideoFolderRows) {
      const current = usedFolderNamesByProject.get(row.projectId) || []
      current.push(row.storageFolderName || row.name)
      usedFolderNamesByProject.set(row.projectId, current)
    }

    const groupedVideos = new Map<string, typeof selectedVideos>()
    for (const video of selectedVideos) {
      const folderName = video.storageFolderName || video.name
      const key = `${video.projectId}:${folderName}`
      const current = groupedVideos.get(key) || []
      current.push(video)
      groupedVideos.set(key, current)
    }

    for (const group of groupedVideos.values()) {
      const sampleVideo = group[0]
      const currentFolderName = sampleVideo.storageFolderName || sampleVideo.name
      const projectStoragePath = sampleVideo.project.storagePath
        || buildProjectStorageRoot(sampleVideo.project.client?.name || sampleVideo.project.companyName || 'Client', sampleVideo.project.title)
      const usedFolderNames = usedFolderNamesByProject.get(sampleVideo.projectId) || []
      const nextFolderName = allocateUniqueStorageName(trimmedName, usedFolderNames)
      usedFolderNames.push(nextFolderName)
      usedFolderNamesByProject.set(sampleVideo.projectId, usedFolderNames)

      const oldVideoStorageRoot = buildVideoStorageRoot(projectStoragePath, currentFolderName)
      const newVideoStorageRoot = buildVideoStorageRoot(projectStoragePath, nextFolderName)
      // Preview files live under .previews/videos/{folder}/ (sibling to videos/{folder}/)
      const oldVideoPreviewRoot = `${buildProjectPreviewsRoot(projectStoragePath)}/videos/${path.posix.basename(oldVideoStorageRoot)}`
      const newVideoPreviewRoot = `${buildProjectPreviewsRoot(projectStoragePath)}/videos/${path.posix.basename(newVideoStorageRoot)}`

      if (oldVideoStorageRoot !== newVideoStorageRoot) {
        if (isS3Mode()) {
          // In S3 mode, check for an active job and optionally require confirmation.
          const activeRenameJob = await prisma.folderRenameJob.findFirst({
            where: {
              entityType: 'VIDEO_GROUP',
              entityId: sampleVideo.projectId,
              oldPrefix: oldVideoStorageRoot,
              status: { in: ['PENDING', 'IN_PROGRESS'] },
            },
          })
          if (activeRenameJob) {
            return NextResponse.json(
              { error: 'A folder rename is already in progress for this video group. Please wait for it to complete.' },
              { status: 423 },
            )
          }

          if (!confirmed) {
            return NextResponse.json(
              {
                requiresJobConfirmation: true,
                proposedName: nextFolderName,
              },
              { status: 202 },
            )
          }

          // User confirmed — schedule a background job to move the folder.
          // The DB name fields are updated below; path fields will be updated by the worker.
          const folderRenameJob = await prisma.folderRenameJob.create({
            data: {
              entityType: 'VIDEO_GROUP',
              entityId: sampleVideo.projectId,
              entityName: nextFolderName,
              oldPrefix: oldVideoStorageRoot,
              newPrefix: newVideoStorageRoot,
              status: 'PENDING',
            },
          })
          await getFolderRenameQueue().add('folder-rename', { folderRenameJobId: folderRenameJob.id })
        } else {
          // Local mode: move both the main video folder and its .previews mirror.
          await moveDirectory(oldVideoStorageRoot, newVideoStorageRoot)
          await moveDirectory(oldVideoPreviewRoot, newVideoPreviewRoot)
        }
      }

      const needsPathRebase = oldVideoStorageRoot !== newVideoStorageRoot && !isS3Mode()

      const groupAssets = needsPathRebase
        ? await prisma.videoAsset.findMany({
            where: { videoId: { in: group.map((video) => video.id) } },
            select: { id: true, videoId: true, storagePath: true, previewPath: true, fileType: true },
          })
        : []

      await prisma.$transaction(async (tx) => {
        for (const video of group) {
          await tx.video.update({
            where: { id: video.id },
            data: {
              name: trimmedName,
              storageFolderName: nextFolderName,
              ...(needsPathRebase ? {
                // originalStoragePath lives under the main videos/{folder}/ root
                originalStoragePath: replaceStoredStoragePathPrefix(video.originalStoragePath, oldVideoStorageRoot, newVideoStorageRoot)!,
                // Preview paths live under .previews/videos/{folder}/ — use the preview prefix pair
                preview480Path: replaceStoredStoragePathPrefix(video.preview480Path, oldVideoPreviewRoot, newVideoPreviewRoot),
                preview720Path: replaceStoredStoragePathPrefix(video.preview720Path, oldVideoPreviewRoot, newVideoPreviewRoot),
                preview1080Path: replaceStoredStoragePathPrefix(video.preview1080Path, oldVideoPreviewRoot, newVideoPreviewRoot),
                thumbnailPath: replaceStoredStoragePathPrefix(video.thumbnailPath, oldVideoPreviewRoot, newVideoPreviewRoot),
                timelinePreviewVttPath: replaceStoredStoragePathPrefix(video.timelinePreviewVttPath, oldVideoPreviewRoot, newVideoPreviewRoot),
                timelinePreviewSpritesPath: replaceStoredStoragePathPrefix(video.timelinePreviewSpritesPath, oldVideoPreviewRoot, newVideoPreviewRoot),
              } : {}),
            },
          })
        }

        if (needsPathRebase) {
          const groupByVideoId = new Map(group.map((video) => [video.id, video] as const))

          for (const asset of groupAssets) {
            const assetVideo = groupByVideoId.get(asset.videoId)
            if (!assetVideo) continue

            const rebasedStoragePath = replaceStoredStoragePathPrefix(asset.storagePath, oldVideoStorageRoot, newVideoStorageRoot)!
            const currentPreviewExt = path.posix.extname(String(asset.previewPath || '')).toLowerCase()
            const desiredPreviewExt = currentPreviewExt === '.mp4' || currentPreviewExt === '.jpg'
              ? currentPreviewExt
              : String(asset.fileType || '').toLowerCase().startsWith('video/')
                ? '.mp4'
                : '.jpg'
            const rebasedPreviewPath = asset.previewPath
              ? buildVideoAssetPreviewStoragePath(
                  projectStoragePath,
                  nextFolderName,
                  assetVideo.versionLabel,
                  rebasedStoragePath,
                  desiredPreviewExt,
                )
              : null

            await tx.videoAsset.update({
              where: { id: asset.id },
              data: {
                storagePath: rebasedStoragePath,
                previewPath: rebasedPreviewPath,
              },
            })
          }
        }
      })
    }

    const response = NextResponse.json({
      success: true,
      updated: selectedVideos.length
    })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('Error batch updating videos:', error)
    return NextResponse.json(
      { error: 'Failed to update videos' },
      { status: 500 }
    )
  }
}
