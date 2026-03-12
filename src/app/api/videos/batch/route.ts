import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { moveDirectory } from '@/lib/storage'
import {
  allocateUniqueStorageName,
  buildProjectStorageRoot,
  buildVideoDropboxRoot,
  buildVideoStorageRoot,
  getStoragePathBasename,
  replaceStoredStoragePathPrefix,
} from '@/lib/project-storage-paths'
import { moveDropboxPath } from '@/lib/storage-provider-dropbox'
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
    const { videoIds, name } = body

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

    // Before bulk update, handle Dropbox renames for videos that have a dropboxPath
    const videosWithDropbox = await prisma.video.findMany({
      where: { id: { in: videoIds }, dropboxPath: { not: null } },
      select: { id: true, name: true, dropboxPath: true, project: { select: { title: true, storagePath: true, companyName: true, client: { select: { name: true } } } } },
    })
    for (const v of videosWithDropbox) {
      if (v.name === trimmedName) continue
      const clientName = v.project.client?.name || v.project.companyName || 'Client'
      const projectFolderName = getStoragePathBasename(v.project.storagePath) || v.project.title
      const oldVideoFolder = buildVideoDropboxRoot(clientName, projectFolderName, v.name)
      const newVideoFolder = buildVideoDropboxRoot(clientName, projectFolderName, trimmedName)
      if (oldVideoFolder !== newVideoFolder) {
        void moveDropboxPath(oldVideoFolder, newVideoFolder).catch(() => {})
        // Update dropboxPath for this video and its sibling versions
        const siblings = await prisma.video.findMany({
          where: { dropboxPath: { startsWith: oldVideoFolder + '/' } },
          select: { id: true, dropboxPath: true },
        })
        for (const sib of siblings) {
          if (sib.dropboxPath) {
            await prisma.video.update({
              where: { id: sib.id },
              data: { dropboxPath: newVideoFolder + sib.dropboxPath.slice(oldVideoFolder.length) },
            })
          }
        }
        // Update asset dropboxPaths
        const assets = await prisma.videoAsset.findMany({
          where: { dropboxPath: { startsWith: oldVideoFolder + '/' } },
          select: { id: true, dropboxPath: true },
        })
        for (const a of assets) {
          if (a.dropboxPath) {
            await prisma.videoAsset.update({
              where: { id: a.id },
              data: { dropboxPath: newVideoFolder + a.dropboxPath.slice(oldVideoFolder.length) },
            })
          }
        }
      }
    }

    const selectedVideos = await prisma.video.findMany({
      where: { id: { in: videoIds } },
      select: {
        id: true,
        projectId: true,
        name: true,
        storageFolderName: true,
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

      if (oldVideoStorageRoot !== newVideoStorageRoot) {
        await moveDirectory(oldVideoStorageRoot, newVideoStorageRoot)
      }

      const groupAssets = await prisma.videoAsset.findMany({
        where: { videoId: { in: group.map((video) => video.id) } },
        select: { id: true, storagePath: true },
      })

      await prisma.$transaction(async (tx) => {
        for (const video of group) {
          await tx.video.update({
            where: { id: video.id },
            data: {
              name: trimmedName,
              storageFolderName: nextFolderName,
              originalStoragePath: replaceStoredStoragePathPrefix(video.originalStoragePath, oldVideoStorageRoot, newVideoStorageRoot)!,
              preview480Path: replaceStoredStoragePathPrefix(video.preview480Path, oldVideoStorageRoot, newVideoStorageRoot),
              preview720Path: replaceStoredStoragePathPrefix(video.preview720Path, oldVideoStorageRoot, newVideoStorageRoot),
              preview1080Path: replaceStoredStoragePathPrefix(video.preview1080Path, oldVideoStorageRoot, newVideoStorageRoot),
              thumbnailPath: replaceStoredStoragePathPrefix(video.thumbnailPath, oldVideoStorageRoot, newVideoStorageRoot),
              timelinePreviewVttPath: replaceStoredStoragePathPrefix(video.timelinePreviewVttPath, oldVideoStorageRoot, newVideoStorageRoot),
              timelinePreviewSpritesPath: replaceStoredStoragePathPrefix(video.timelinePreviewSpritesPath, oldVideoStorageRoot, newVideoStorageRoot),
            },
          })
        }

        for (const asset of groupAssets) {
          await tx.videoAsset.update({
            where: { id: asset.id },
            data: {
              storagePath: replaceStoredStoragePathPrefix(asset.storagePath, oldVideoStorageRoot, newVideoStorageRoot)!,
            },
          })
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
