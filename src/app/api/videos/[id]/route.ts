import path from 'path'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { deleteDirectory, deleteFile, moveDirectory, pruneEmptyParentDirectories } from '@/lib/storage'
import { getFilePath } from '@/lib/storage'
import { requireApiUser } from '@/lib/auth'
import { getAutoApproveProject } from '@/lib/settings'
import { getSecuritySettings } from '@/lib/video-access'
import { getClientIpAddress } from '@/lib/utils'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireAnyActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { isDropboxStorageConfigured, toDropboxStoragePath, deleteDropboxFile, isDropboxStoragePath, stripDropboxStoragePrefix, moveDropboxPath } from '@/lib/storage-provider-dropbox'
import {
  allocateUniqueStorageName,
  buildProjectStorageRoot,
  buildVideoAssetDropboxPath,
  buildVideoAssetsStorageRoot,
  buildVideoStorageRoot,
  buildVideoVersionRoot,
  buildVideoDropboxRoot,
  buildVideoOriginalDropboxPath,
  getStoragePathBasename,
  replaceStoredStoragePathPrefix,
} from '@/lib/project-storage-paths'
import { resolveVideoOriginalPath } from '@/lib/resolve-video-original'
import { clearResolvedDropboxStorageIssueEntities } from '@/lib/dropbox-storage-inconsistency-log'
export const runtime = 'nodejs'

function findExistingVideoOriginalPath(video: Parameters<typeof resolveVideoOriginalPath>[0]): string | null {
  return resolveVideoOriginalPath(video)
}




// GET /api/videos/[id] - Get video status (for polling during processing)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // SECURITY: Require admin authentication
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) {
    return authResult
  }

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  // Status polling is needed both for uploaders and for users who can access project settings.
  const forbiddenAction = requireAnyActionAccess(authResult, ['accessProjectSettings', 'uploadVideosOnProjects'])
  if (forbiddenAction) return forbiddenAction

  // Rate limit status checks (allow frequent polling)
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 120, // Allow 2 requests per second for polling
    message: 'Too many video status requests. Please slow down.',
  }, 'video-status')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id } = await params
    
    const video = await prisma.video.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        status: true,
        processingProgress: true,
        processingError: true,
        duration: true,
        width: true,
        height: true,
        projectId: true,
      }
    })

    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    if (authResult.appRoleIsSystemAdmin !== true) {
      const project = await prisma.project.findUnique({
        where: { id: video.projectId },
        select: { status: true, assignedUsers: { select: { userId: true } } },
      })
      if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

      const assigned = project.assignedUsers?.some((u) => u.userId === authResult.id)
      if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

      if (!isVisibleProjectStatusForUser(authResult, project.status)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    return NextResponse.json(video)
  } catch (error) {
    console.error('Error fetching video status:', error)
    return NextResponse.json(
      { error: 'Failed to fetch video status' },
      { status: 500 }
    )
  }
}

// Helper: Check if all videos have at least one approved version
async function checkAllVideosApproved(projectId: string): Promise<boolean> {
  const allVideos = await prisma.video.findMany({
    where: { projectId },
    select: { approved: true, name: true }
  })

  // Group by video name
  const videosByName = allVideos.reduce((acc: Record<string, any[]>, video) => {
    if (!acc[video.name]) acc[video.name] = []
    acc[video.name].push(video)
    return acc
  }, {})

  // Check if each unique video has at least one approved version
  return Object.values(videosByName).every((versions: any[]) =>
    versions.some(v => v.approved)
  )
}

// Helper: Update project status based on approval changes
async function updateProjectStatus(
  projectId: string,
  videoId: string,
  approved: boolean,
  currentStatus: string,
  changedById: string
): Promise<void> {
  const allApproved = await checkAllVideosApproved(projectId)

  // Check if auto-approve is enabled
  const autoApprove = await getAutoApproveProject()

  if (allApproved && approved && autoApprove) {
    // All videos approved AND auto-approve enabled → mark project as approved
    if (currentStatus === 'APPROVED') {
      // Already approved: keep behavior of refreshing approvedAt/approvedVideoId,
      // but do not emit a status-change event.
      await prisma.project.update({
        where: { id: projectId },
        data: {
          approvedAt: new Date(),
          approvedVideoId: videoId,
        },
      })
    } else {
      await prisma.$transaction([
        prisma.project.update({
          where: { id: projectId },
          data: {
            status: 'APPROVED',
            approvedAt: new Date(),
            approvedVideoId: videoId,
          },
        }),
        prisma.projectStatusChange.create({
          data: {
            projectId,
            previousStatus: currentStatus as any,
            currentStatus: 'APPROVED',
            source: 'ADMIN',
            changedById,
          },
        }),
      ])
    }
  } else if (!approved && currentStatus === 'APPROVED') {
    // Unapproving when project was approved → revert to IN_REVIEW
    await prisma.$transaction([
      prisma.project.update({
        where: { id: projectId },
        data: {
          status: 'IN_REVIEW',
          approvedAt: null,
          approvedVideoId: null,
        },
      }),
      prisma.projectStatusChange.create({
        data: {
          projectId,
          previousStatus: 'APPROVED',
          currentStatus: 'IN_REVIEW',
          source: 'ADMIN',
          changedById,
        },
      }),
    ])
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // SECURITY: Require admin authentication
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) {
    return authResult
  }
  const admin = authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  // Rate limit admin toggles
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: 'Too many video update requests. Please slow down.',
  }, 'video-update')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id } = await params
    const body = await request.json()
    const { approved, name, versionLabel, videoNotes, allowApproval, dropboxEnabled } = body

    // Validate inputs
    if (approved !== undefined && typeof approved !== 'boolean') {
      return NextResponse.json(
        { error: 'Invalid request: approved must be a boolean' },
        { status: 400 }
      )
    }

    if (name !== undefined && (!name || typeof name !== 'string' || name.trim().length === 0)) {
      return NextResponse.json(
        { error: 'Invalid request: name must be a non-empty string' },
        { status: 400 }
      )
    }

    if (versionLabel !== undefined && (!versionLabel || typeof versionLabel !== 'string' || versionLabel.trim().length === 0)) {
      return NextResponse.json(
        { error: 'Invalid request: versionLabel must be a non-empty string' },
        { status: 400 }
      )
    }

    if (videoNotes !== undefined && typeof videoNotes !== 'string') {
      return NextResponse.json(
        { error: 'Invalid request: videoNotes must be a string' },
        { status: 400 }
      )
    }

    if (allowApproval !== undefined && typeof allowApproval !== 'boolean') {
      return NextResponse.json(
        { error: 'Invalid request: allowApproval must be a boolean' },
        { status: 400 }
      )
    }

    if (dropboxEnabled !== undefined && typeof dropboxEnabled !== 'boolean') {
      return NextResponse.json(
        { error: 'Invalid request: dropboxEnabled must be a boolean' },
        { status: 400 }
      )
    }

    if (typeof videoNotes === 'string' && videoNotes.trim().length > 500) {
      return NextResponse.json(
        { error: 'Invalid request: videoNotes must be 500 characters or fewer' },
        { status: 400 }
      )
    }

    // At least one field must be provided
    if (approved === undefined && name === undefined && versionLabel === undefined && videoNotes === undefined && allowApproval === undefined && dropboxEnabled === undefined) {
      return NextResponse.json(
        { error: 'Invalid request: at least one field must be provided' },
        { status: 400 }
      )
    }

    // Get video details
    const video = await prisma.video.findUnique({
      where: { id },
      include: {
        project: {
          include: {
            assignedUsers: { select: { userId: true } },
            client: { select: { name: true } },
          },
        },
      },
    })

    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    if (authResult.appRoleIsSystemAdmin !== true) {
      const assigned = video.project.assignedUsers?.some((u: any) => u.userId === authResult.id)
      if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

      if (!isVisibleProjectStatusForUser(authResult, video.project.status)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    // RBAC: conservative - any admin-side mutation requires Projects Full Control.
    if (approved !== undefined || name !== undefined || versionLabel !== undefined || videoNotes !== undefined || allowApproval !== undefined || dropboxEnabled !== undefined) {
      const forbidden = requireActionAccess(authResult, 'projectsFullControl')
      if (forbidden) return forbidden
    }

    let autoUnapprovedIds: string[] = []
    let videoRenamePlan:
      | {
          projectStoragePath: string
          newVideoFolderName: string
          siblingVideos: Array<{
            id: string
            name: string
            storageFolderName: string | null
            originalStoragePath: string
            preview480Path: string | null
            preview720Path: string | null
            preview1080Path: string | null
            thumbnailPath: string | null
            timelinePreviewVttPath: string | null
            timelinePreviewSpritesPath: string | null
          }>
          siblingAssets: Array<{
            id: string
            videoId: string
            storagePath: string
          }>
        }
      | null = null

    // If approving this video, unapprove all other versions of the SAME video
    if (approved) {
      const autoUnapproved = await prisma.video.findMany({
        where: {
          projectId: video.projectId,
          name: video.name,
          id: { not: id },
          approved: true,
        },
        select: { id: true },
      })
      autoUnapprovedIds = autoUnapproved.map((row) => row.id)

      await prisma.video.updateMany({
        where: {
          projectId: video.projectId,
          name: video.name, // Same video name
          id: { not: id }, // But different version
        },
        data: {
          approved: false,
          approvedAt: null,
        },
      })
    }

    // Build update data object
    const updateData: any = {}

    if (approved !== undefined) {
      updateData.approved = approved
      updateData.approvedAt = approved ? new Date() : null
    }

    if (name !== undefined) {
      const trimmedName = name.trim()
      updateData.name = trimmedName

      // Rename Dropbox video folder if the video has Dropbox enabled
      if (video.dropboxEnabled && video.dropboxPath && trimmedName !== video.name) {
        const clientName = video.project.client?.name || video.project.companyName || 'Client'
        const projectFolderName = getStoragePathBasename(video.project.storagePath) || video.project.title
        const oldVideoFolder = buildVideoDropboxRoot(clientName, projectFolderName, video.name)
        const newVideoFolder = buildVideoDropboxRoot(clientName, projectFolderName, trimmedName)
        if (oldVideoFolder !== newVideoFolder) {
          moveDropboxPath(oldVideoFolder, newVideoFolder).catch((err) => {
            console.error(`[DROPBOX] Failed to rename video folder from ${oldVideoFolder} to ${newVideoFolder}:`, err)
          })

          // Update dropboxPath for this video and all sibling versions
          const siblingVideos = await prisma.video.findMany({
            where: { projectId: video.projectId, name: video.name, dropboxPath: { not: null } },
            select: { id: true, dropboxPath: true },
          })
          for (const sib of siblingVideos) {
            if (sib.dropboxPath) {
              const updatedPath = sib.dropboxPath.replace(oldVideoFolder + '/', newVideoFolder + '/')
              await prisma.video.update({ where: { id: sib.id }, data: { dropboxPath: updatedPath } })
            }
          }
          // Update dropboxPath for assets of all sibling versions
          const siblingIds = siblingVideos.map(s => s.id)
          const siblingAssets = await prisma.videoAsset.findMany({
            where: { videoId: { in: siblingIds }, dropboxPath: { not: null } },
            select: { id: true, dropboxPath: true },
          })
          for (const asset of siblingAssets) {
            if (asset.dropboxPath) {
              const updatedPath = asset.dropboxPath.replace(oldVideoFolder + '/', newVideoFolder + '/')
              await prisma.videoAsset.update({ where: { id: asset.id }, data: { dropboxPath: updatedPath } })
            }
          }

          // Update this video's dropboxPath too
          if (video.dropboxPath) {
            updateData.dropboxPath = video.dropboxPath.replace(oldVideoFolder + '/', newVideoFolder + '/')
          }
        }
      }

      if (trimmedName !== video.name) {
        const projectStoragePath = video.project.storagePath
          || buildProjectStorageRoot(video.project.client?.name || video.project.companyName || 'Client', video.project.title)
        const siblingVideos = await prisma.video.findMany({
          where: { projectId: video.projectId, name: video.name },
          select: {
            id: true,
            name: true,
            storageFolderName: true,
            originalStoragePath: true,
            preview480Path: true,
            preview720Path: true,
            preview1080Path: true,
            thumbnailPath: true,
            timelinePreviewVttPath: true,
            timelinePreviewSpritesPath: true,
          },
        })
        const otherVideoFolderRows = await prisma.video.findMany({
          where: {
            projectId: video.projectId,
            name: { not: video.name },
          },
          select: { storageFolderName: true, name: true },
        })
        const newVideoFolderName = allocateUniqueStorageName(
          trimmedName,
          otherVideoFolderRows.map((row) => row.storageFolderName || row.name).filter(Boolean) as string[],
        )
        updateData.storageFolderName = newVideoFolderName

        const siblingAssets = await prisma.videoAsset.findMany({
          where: { videoId: { in: siblingVideos.map((row) => row.id) } },
          select: { id: true, videoId: true, storagePath: true },
        })

        videoRenamePlan = {
          projectStoragePath,
          newVideoFolderName,
          siblingVideos,
          siblingAssets,
        }
      }
    }

    if (versionLabel !== undefined) {
      updateData.versionLabel = versionLabel.trim()
    }

    if (videoNotes !== undefined) {
      const trimmed = videoNotes.trim()
      updateData.videoNotes = trimmed ? trimmed : null
    }

    if (allowApproval !== undefined) {
      updateData.allowApproval = allowApproval
    }

    // Handle Dropbox toggle
    if (dropboxEnabled !== undefined) {
      if (dropboxEnabled && !isDropboxStorageConfigured()) {
        return NextResponse.json({ error: 'Dropbox is not configured' }, { status: 400 })
      }

      updateData.dropboxEnabled = dropboxEnabled

      if (dropboxEnabled) {
        const resolvedLocalOriginalPath = findExistingVideoOriginalPath(video)
        if (!resolvedLocalOriginalPath) {
          return NextResponse.json(
            { error: 'Local original file could not be found for this video. Run the storage migration repair before enabling Dropbox.' },
            { status: 409 }
          )
        }

        // Enable: update storagePath to dropbox prefix (if not already) and enqueue upload
        const dropboxStoragePath = toDropboxStoragePath(resolvedLocalOriginalPath)
        if (video.originalStoragePath !== dropboxStoragePath) {
          updateData.originalStoragePath = dropboxStoragePath
        }

        if (!video.dropboxPath) {
          const cleanFileName = video.originalFileName.replace(/^(?:original|asset|photo)-\d+-/, '')
          updateData.dropboxPath = buildVideoOriginalDropboxPath(
            video.project.client?.name || video.project.companyName || 'Client',
            getStoragePathBasename(video.project.storagePath) || video.project.title,
            video.storageFolderName || video.name,
            video.versionLabel,
            cleanFileName,
          )
        }

        if (!video.dropboxEnabled || video.dropboxUploadStatus === 'ERROR' || video.dropboxUploadStatus === null) {
          updateData.dropboxUploadStatus = 'PENDING'
          updateData.dropboxUploadProgress = 0
          updateData.dropboxUploadError = null
        }

        const assets = await prisma.videoAsset.findMany({
          where: { videoId: id },
          select: {
            id: true,
            fileName: true,
            fileSize: true,
            storagePath: true,
            dropboxEnabled: true,
            dropboxPath: true,
            dropboxUploadStatus: true,
          },
        })

        for (const asset of assets) {
          const assetUpdateData: {
            dropboxEnabled?: boolean
            storagePath?: string
            dropboxPath?: string
            dropboxUploadStatus?: 'PENDING'
            dropboxUploadProgress?: number
            dropboxUploadError?: null
          } = {}

          const assetDropboxPath = buildVideoAssetDropboxPath(
            video.project.client?.name || video.project.companyName || 'Client',
            getStoragePathBasename(video.project.storagePath) || video.project.title,
            video.storageFolderName || video.name,
            video.versionLabel,
            asset.fileName,
          )

          if (!asset.dropboxEnabled) {
            assetUpdateData.dropboxEnabled = true
          }

          const assetDropboxStoragePath = isDropboxStoragePath(asset.storagePath)
            ? asset.storagePath
            : toDropboxStoragePath(asset.storagePath)

          if (asset.storagePath !== assetDropboxStoragePath) {
            assetUpdateData.storagePath = assetDropboxStoragePath
            assetUpdateData.dropboxPath = assetDropboxPath
            assetUpdateData.dropboxUploadStatus = 'PENDING'
            assetUpdateData.dropboxUploadProgress = 0
            assetUpdateData.dropboxUploadError = null
          } else if (asset.dropboxUploadStatus === 'ERROR' || asset.dropboxUploadStatus === null) {
            assetUpdateData.dropboxPath = assetDropboxPath
            assetUpdateData.dropboxUploadStatus = 'PENDING'
            assetUpdateData.dropboxUploadProgress = 0
            assetUpdateData.dropboxUploadError = null
          } else if (asset.dropboxPath !== assetDropboxPath) {
            assetUpdateData.dropboxPath = assetDropboxPath
          }

          if (Object.keys(assetUpdateData).length === 0) {
            continue
          }

          await prisma.videoAsset.update({
            where: { id: asset.id },
            data: assetUpdateData,
          })
        }
      } else {
        // Disable: remove dropbox prefix from storagePath, delete from Dropbox
        const currentPath = video.originalStoragePath
        if (isDropboxStoragePath(currentPath)) {
          updateData.originalStoragePath = stripDropboxStoragePrefix(currentPath)
          // Delete from Dropbox in background (don't block the response)
          deleteDropboxFile(currentPath, video.dropboxPath).catch((err) => {
            console.error(`[DROPBOX] Failed to delete video ${id} from Dropbox:`, err)
          })
        }
        updateData.dropboxUploadStatus = null
        updateData.dropboxUploadProgress = 0
        updateData.dropboxUploadError = null
        updateData.dropboxPath = null

        // Cascade: also disable Dropbox for all assets of this video
        const assets = await prisma.videoAsset.findMany({
          where: { videoId: id, dropboxEnabled: true },
          select: { id: true, storagePath: true, dropboxPath: true },
        })
        for (const asset of assets) {
          if (isDropboxStoragePath(asset.storagePath)) {
            deleteDropboxFile(asset.storagePath, asset.dropboxPath).catch((err) => {
              console.error(`[DROPBOX] Failed to delete asset ${asset.id} from Dropbox:`, err)
            })
          }
        }
        if (assets.length > 0) {
          await prisma.videoAsset.updateMany({
            where: { videoId: id, dropboxEnabled: true },
            data: {
              dropboxEnabled: false,
              dropboxUploadStatus: null,
              dropboxUploadProgress: 0,
              dropboxUploadError: null,
              dropboxPath: null,
            },
          })
          // Strip dropbox: prefix from each asset's storagePath individually
          for (const asset of assets) {
            if (isDropboxStoragePath(asset.storagePath)) {
              await prisma.videoAsset.update({
                where: { id: asset.id },
                data: { storagePath: stripDropboxStoragePrefix(asset.storagePath) },
              })
            }
          }
          console.log(`[VIDEO] Disabled Dropbox for ${assets.length} asset(s) of video ${id}`)
        }

        await clearResolvedDropboxStorageIssueEntities([
          {
            entityType: 'video',
            entityId: id,
            projectId: video.projectId,
          },
          ...assets.map((asset) => ({
            entityType: 'asset' as const,
            entityId: asset.id,
            projectId: video.projectId,
          })),
        ])
      }
    }

    if (videoRenamePlan) {
      const siblingFolderByVideoId = new Map(
        videoRenamePlan.siblingVideos.map((row) => [row.id, row.storageFolderName || row.name] as const)
      )
      const newVideoStorageRoot = buildVideoStorageRoot(
        videoRenamePlan.projectStoragePath,
        videoRenamePlan.newVideoFolderName,
      )
      const oldVideoRoots = Array.from(
        new Set(
          videoRenamePlan.siblingVideos
            .map((row) => buildVideoStorageRoot(videoRenamePlan.projectStoragePath, row.storageFolderName || row.name))
            .filter((root) => root !== newVideoStorageRoot)
        )
      )

      for (const oldVideoRoot of oldVideoRoots) {
        await moveDirectory(oldVideoRoot, newVideoStorageRoot, { merge: true })
      }

      await prisma.$transaction(async (tx) => {
        for (const siblingVideo of videoRenamePlan!.siblingVideos) {
          const oldVideoStorageRoot = buildVideoStorageRoot(
            videoRenamePlan!.projectStoragePath,
            siblingVideo.storageFolderName || siblingVideo.name,
          )
          const rebasedVideoData = {
            name: updateData.name,
            storageFolderName: videoRenamePlan!.newVideoFolderName,
            originalStoragePath: replaceStoredStoragePathPrefix(
              siblingVideo.id === id ? (updateData.originalStoragePath || siblingVideo.originalStoragePath) : siblingVideo.originalStoragePath,
              oldVideoStorageRoot,
              newVideoStorageRoot,
            )!,
            preview480Path: replaceStoredStoragePathPrefix(siblingVideo.preview480Path, oldVideoStorageRoot, newVideoStorageRoot),
            preview720Path: replaceStoredStoragePathPrefix(siblingVideo.preview720Path, oldVideoStorageRoot, newVideoStorageRoot),
            preview1080Path: replaceStoredStoragePathPrefix(siblingVideo.preview1080Path, oldVideoStorageRoot, newVideoStorageRoot),
            thumbnailPath: replaceStoredStoragePathPrefix(siblingVideo.thumbnailPath, oldVideoStorageRoot, newVideoStorageRoot),
            timelinePreviewVttPath: replaceStoredStoragePathPrefix(
              siblingVideo.timelinePreviewVttPath,
              oldVideoStorageRoot,
              newVideoStorageRoot,
            ),
            timelinePreviewSpritesPath: replaceStoredStoragePathPrefix(
              siblingVideo.timelinePreviewSpritesPath,
              oldVideoStorageRoot,
              newVideoStorageRoot,
            ),
          }

          await tx.video.update({
            where: { id: siblingVideo.id },
            data: siblingVideo.id === id ? { ...updateData, ...rebasedVideoData } : rebasedVideoData,
          })
        }

        for (const asset of videoRenamePlan!.siblingAssets) {
          const oldFolderName = siblingFolderByVideoId.get(asset.videoId)
          if (!oldFolderName) continue

          const oldVideoStorageRoot = buildVideoStorageRoot(videoRenamePlan!.projectStoragePath, oldFolderName)
          await tx.videoAsset.update({
            where: { id: asset.id },
            data: {
              storagePath: replaceStoredStoragePathPrefix(
                asset.storagePath,
                oldVideoStorageRoot,
                newVideoStorageRoot,
              )!,
            },
          })
        }
      })
    } else {
      await prisma.video.update({
        where: { id },
        data: updateData
      })
    }

    // Enqueue Dropbox upload job if we just enabled it
    if (dropboxEnabled === true && updateData.dropboxUploadStatus === 'PENDING') {
      const localPath = findExistingVideoOriginalPath({
        ...video,
        originalStoragePath: updateData.originalStoragePath || video.originalStoragePath,
      })

      if (!localPath) {
        return NextResponse.json(
          { error: 'Local original file could not be found for this video. Run the storage migration repair before enabling Dropbox.' },
          { status: 409 }
        )
      }

      const dropboxStoragePath = updateData.originalStoragePath || video.originalStoragePath
      const { getDropboxUploadQueue } = await import('@/lib/queue')
      const dropboxQueue = getDropboxUploadQueue()
      await dropboxQueue.add('upload-to-dropbox', {
        videoId: id,
        localPath,
        dropboxPath: dropboxStoragePath,
        dropboxRelPath: updateData.dropboxPath || null,
        fileSizeBytes: Number(video.originalFileSize),
      })
      console.log(`[VIDEO] Video ${id} queued for Dropbox upload (toggled on)`)

      const assetsToQueue = await prisma.videoAsset.findMany({
        where: {
          videoId: id,
          dropboxEnabled: true,
          dropboxUploadStatus: 'PENDING',
        },
        select: {
          id: true,
          fileSize: true,
          storagePath: true,
          dropboxPath: true,
        },
      })

      for (const asset of assetsToQueue) {
        await dropboxQueue.add('upload-asset-to-dropbox', {
          videoId: id,
          localPath: stripDropboxStoragePrefix(asset.storagePath),
          dropboxPath: asset.storagePath,
          dropboxRelPath: asset.dropboxPath,
          fileSizeBytes: Number(asset.fileSize),
          assetId: asset.id,
        })
      }

      if (assetsToQueue.length > 0) {
        console.log(`[VIDEO] Queued ${assetsToQueue.length} asset Dropbox upload(s) for video ${id}`)
      }
    }

    // Update project status if approval changed
    if (approved !== undefined) {
      try {
        const settings = await getSecuritySettings()
        if (settings.trackAnalytics) {
          await prisma.videoAnalytics.create({
            data: {
              videoId: id,
              projectId: video.projectId,
              eventType: approved ? 'VIDEO_APPROVED' : 'VIDEO_UNAPPROVED',
              sessionId: `admin:${admin.id}`,
              ipAddress: getClientIpAddress(request) || null,
            },
          })

          if (approved && autoUnapprovedIds.length > 0) {
            await prisma.videoAnalytics.createMany({
              data: autoUnapprovedIds.map((videoId) => ({
                videoId,
                projectId: video.projectId,
                eventType: 'VIDEO_UNAPPROVED',
                sessionId: `admin:${admin.id}`,
                ipAddress: getClientIpAddress(request) || null,
              }))
            })
          }
        }
      } catch (error) {
        console.warn('[VIDEO-APPROVAL] Failed to log approval analytics:', error)
      }

      console.log(`[VIDEO-APPROVAL] Admin toggled approval for video ${id} to ${approved}`)
      await updateProjectStatus(video.projectId, id, approved, video.project.status, admin.id)

      // NOTE: Admin-toggled approvals/unapprovals do NOT send email notifications
      // Only client-initiated approvals (via /approve route) send emails immediately
      // This prevents spam when admins are managing multiple videos
      console.log('[VIDEO-APPROVAL] Admin approval - emails NOT sent (by design)')
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to update video approval' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // SECURITY: Require admin authentication
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) {
    return authResult
  }

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  // Conservative: video deletion is a destructive project content operation.
  const forbiddenAction = requireActionAccess(authResult, 'projectsFullControl')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 30,
    message: 'Too many video delete requests. Please slow down.',
  }, 'video-delete')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id } = await params
    // Get video details
    const video = await prisma.video.findUnique({
      where: { id },
      include: {
        assets: true,
        project: {
          select: {
            status: true,
            title: true,
            storagePath: true,
            companyName: true,
            client: { select: { name: true } },
            assignedUsers: { select: { userId: true } },
          },
        },
      }
    })

    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    if (authResult.appRoleIsSystemAdmin !== true) {
      const assigned = video.project.assignedUsers?.some((u) => u.userId === authResult.id)
      if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

      if (!isVisibleProjectStatusForUser(authResult, video.project.status)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    const projectId = video.projectId

    // Delete all associated files from storage
    try {
      // Delete comment attachment files for this video/version (best-effort).
      // Note: deleting Comment rows will cascade-delete CommentFile rows in DB,
      // but we must remove the physical files separately.
      const commentFiles = await prisma.commentFile.findMany({
        where: {
          projectId,
          comment: {
            videoId: id,
          },
        },
        select: {
          id: true,
          storagePath: true,
        },
      })

      const commentFileIdsToDelete = commentFiles.map((f) => f.id)
      for (const file of commentFiles) {
        try {
          // Only delete if no other CommentFile row references the same storagePath
          // outside of the set that will be cascade-deleted.
          const sharedCount = await prisma.commentFile.count({
            where: {
              storagePath: file.storagePath,
              id: { notIn: commentFileIdsToDelete },
            },
          })

          if (sharedCount === 0) {
            await deleteFile(file.storagePath)
          }
        } catch {
          // Ignore per-file errors to avoid blocking video deletion
        }
      }

      // Delete asset files only if no other assets point to the same storage path
      for (const asset of video.assets) {
        const sharedCount = await prisma.videoAsset.count({
          where: {
            storagePath: asset.storagePath,
            id: { not: asset.id },
          },
        })

        if (sharedCount === 0) {
          await deleteFile(asset.storagePath)
        }
      }

      // Delete original file
      if (video.originalStoragePath) {
        await deleteFile(video.originalStoragePath)
      }

      // Delete preview files
      if (video.preview480Path) {
        await deleteFile(video.preview480Path)
      }
      if (video.preview1080Path) {
        await deleteFile(video.preview1080Path)
      }
      if (video.preview720Path) {
        await deleteFile(video.preview720Path)
      }

      if (video.timelinePreviewSpritesPath) {
        await deleteDirectory(video.timelinePreviewSpritesPath).catch(() => {})
      } else if (video.timelinePreviewVttPath) {
        await deleteFile(video.timelinePreviewVttPath).catch(() => {})
      }

      // Delete thumbnail
      if (video.thumbnailPath) {
        const thumbnailSharedAssets = await prisma.videoAsset.count({
          where: {
            storagePath: video.thumbnailPath,
            videoId: { not: id },
          },
        })
        const thumbnailSharedVideos = await prisma.video.count({
          where: {
            thumbnailPath: video.thumbnailPath,
            id: { not: id },
          },
        })

        // Only delete if no other assets or videos reference this thumbnail path
        if (thumbnailSharedAssets === 0 && thumbnailSharedVideos === 0) {
          await deleteFile(video.thumbnailPath)
        }
      }
    } catch (error) {
      console.error(`Failed to delete files for video ${video.id}:`, error)
      // Continue with database deletion even if storage deletion fails
    }

    // Delete the video (associated comments cascade via FK on Comment.videoId)
    await prisma.video.delete({
      where: { id },
    })

    // Update the stored project data total
    await recalculateAndStoreProjectTotalBytes(projectId)

    const projectStoragePath = video.project.storagePath
      || buildProjectStorageRoot(video.project.client?.name || video.project.companyName || 'Client', video.project.title)
    const videoFolderName = video.storageFolderName || video.name || id
    const versionLabel = video.versionLabel || `v${video.version}`
    const pruneStopAt = path.posix.join(projectStoragePath, 'videos')

    try {
      await pruneEmptyParentDirectories(
        buildVideoAssetsStorageRoot(projectStoragePath, videoFolderName, versionLabel),
        pruneStopAt,
      )
      await pruneEmptyParentDirectories(
        buildVideoVersionRoot(projectStoragePath, videoFolderName, versionLabel),
        pruneStopAt,
      )
    } catch (error) {
      console.error(`Failed to prune empty folders for video ${video.id}:`, error)
    }

    return NextResponse.json({
      success: true,
      message: 'Video and all related files deleted successfully',
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to delete video' },
      { status: 500 }
    )
  }
}
