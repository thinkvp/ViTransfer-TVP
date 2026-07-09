import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { moveDirectory } from '@/lib/storage'
import { renameStoredPaths } from '@/lib/stored-file'
import { isS3Mode } from '@/lib/s3-storage'
import { getFolderRenameQueue } from '@/lib/queue'
import { publishProjectEvent } from '@/lib/project-events'
import {
  allocateUniqueStorageName,
  buildProjectStorageRoot,
  buildVideoStorageRoot,
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
        versionLabel: true, project: { select: { title: true, companyName: true, storagePath: true, client: { select: { name: true } } } },
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
      // Previews are ID-keyed (previews/{projectId}/videos/{videoId}/…) and never move
      // on rename — only the name-based originals folder is touched below.

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
          // Local mode: move the originals folder (previews are ID-keyed, untouched).
          await moveDirectory(oldVideoStorageRoot, newVideoStorageRoot)
        }
      }

      const needsPathRebase = oldVideoStorageRoot !== newVideoStorageRoot && !isS3Mode()

      const groupAssets = needsPathRebase
        ? await prisma.videoAsset.findMany({
            where: { videoId: { in: group.map((video) => video.id) } },
            select: { id: true, videoId: true, fileType: true },
          })
        : []

      await prisma.$transaction(async (tx) => {
        for (const video of group) {
          await tx.video.update({
            where: { id: video.id },
            data: {
              name: trimmedName,
              storageFolderName: nextFolderName,
            },
          })

          if (needsPathRebase) {
            // StoredFile handles path rebasing (originals only — previews are ID-keyed)
            await renameStoredPaths('VIDEO', [video.id], oldVideoStorageRoot, newVideoStorageRoot)
          }
        }

        if (needsPathRebase) {
          const groupByVideoId = new Map(group.map((video) => [video.id, video] as const))

          for (const asset of groupAssets) {
            const assetVideo = groupByVideoId.get(asset.videoId)
            if (!assetVideo) continue
            // StoredFile handles path rebasing (originals only — asset previews are ID-keyed)
            await renameStoredPaths('VIDEO_ASSET', [asset.id], oldVideoStorageRoot, newVideoStorageRoot)
          }
        }
      })
    }

    // Notify open share pages / admin views (one event per affected project).
    for (const pid of projectIds) {
      await publishProjectEvent(pid, 'video')
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
