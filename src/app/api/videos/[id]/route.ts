import path from 'path'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { deleteDirectory, deleteFile, moveDirectory, pruneEmptyParentDirectories, getFilePath } from '@/lib/storage'
import { requireApiUser } from '@/lib/auth'
import { getAutoApproveProject } from '@/lib/settings'
import { getSecuritySettings } from '@/lib/video-access'
import { getClientIpAddress } from '@/lib/utils'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireAnyActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { isS3Mode } from '@/lib/s3-storage'
import { getFolderRenameQueue } from '@/lib/queue'
import {
  allocateUniqueStorageName,
  buildVideoAssetPreviewStoragePath,
  buildProjectStorageRoot,
  buildVideoAssetsStorageRoot,
  buildVideoStorageRoot,
  buildVideoVersionRoot,
  buildVideoVersionPreviewsRoot,
  replaceStoredStoragePathPrefix,
} from '@/lib/project-storage-paths'
export const runtime = 'nodejs'

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
    maxRequests: 120,
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
      },
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

async function checkAllVideosApproved(projectId: string): Promise<boolean> {
  const allVideos = await prisma.video.findMany({
    where: { projectId },
    select: { approved: true, name: true },
  })

  const videosByName = allVideos.reduce((acc: Record<string, Array<{ approved: boolean; name: string }>>, video) => {
    if (!acc[video.name]) acc[video.name] = []
    acc[video.name].push(video)
    return acc
  }, {})

  return Object.values(videosByName).every((versions) => versions.some((version) => version.approved))
}

async function updateProjectStatus(
  projectId: string,
  videoId: string,
  approved: boolean,
  currentStatus: string,
  changedById: string
): Promise<void> {
  const allApproved = await checkAllVideosApproved(projectId)
  const autoApprove = await getAutoApproveProject()

  if (allApproved && approved && autoApprove) {
    if (currentStatus === 'APPROVED') {
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
    const { approved, name, versionLabel, videoNotes, allowApproval, confirmed } = body

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

    if (typeof videoNotes === 'string' && videoNotes.trim().length > 500) {
      return NextResponse.json(
        { error: 'Invalid request: videoNotes must be 500 characters or fewer' },
        { status: 400 }
      )
    }

    // At least one field must be provided
    if (approved === undefined && name === undefined && versionLabel === undefined && videoNotes === undefined && allowApproval === undefined) {
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
    if (approved !== undefined || name !== undefined || versionLabel !== undefined || videoNotes !== undefined || allowApproval !== undefined) {
      const forbidden = requireActionAccess(authResult, 'projectsFullControl')
      if (forbidden) return forbidden
    }

    let autoUnapprovedIds: string[] = []
    let versionLabelRenamePlan:
      | {
          oldMainPrefix: string
          newMainPrefix: string
          oldPreviewPrefix: string
          newPreviewPrefix: string
          currentVideo: {
            originalStoragePath: string
            preview480Path: string | null
            preview720Path: string | null
            preview1080Path: string | null
            thumbnailPath: string | null
            timelinePreviewVttPath: string | null
            timelinePreviewSpritesPath: string | null
          }
          videoAssets: Array<{ id: string; storagePath: string; previewPath: string | null }>
        }
      | null = null
    let videoRenamePlan:
      | {
          projectStoragePath: string
          newVideoFolderName: string
          siblingVideos: Array<{
            id: string
            name: string
            storageFolderName: string | null
            versionLabel: string
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
            previewPath: string | null
            fileType: string | null
          }>
        }
      | null = null

    // If approving this video, unapprove all other versions of the SAME video
    if (approved) {
      // Collect IDs of currently-approved sibling versions for analytics logging below.
      // The actual unapprove write is deferred and executed atomically with the approve
      // write further down to prevent a concurrent approval leaving two versions approved.
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

      if (trimmedName !== video.name) {
        const projectStoragePath = video.project.storagePath
          || buildProjectStorageRoot(video.project.client?.name || video.project.companyName || 'Client', video.project.title)
        const siblingVideos = await prisma.video.findMany({
          where: { projectId: video.projectId, name: video.name },
          select: {
            id: true,
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
          select: { id: true, videoId: true, storagePath: true, previewPath: true, fileType: true },
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
      const trimmedLabel = versionLabel.trim()
      updateData.versionLabel = trimmedLabel

      // If the sanitized folder name changes and we are not already doing a video name
      // rename (which would conflict), move the version subfolder in storage too.
      if (trimmedLabel !== video.versionLabel && !videoRenamePlan) {
        const projectStoragePath = video.project.storagePath
          || buildProjectStorageRoot(video.project.client?.name || (video.project as any).companyName || 'Client', video.project.title)
        const videoFolderName = (video as any).storageFolderName || video.name
        const oldMainPrefix = buildVideoVersionRoot(projectStoragePath, videoFolderName, video.versionLabel)
        const newMainPrefix = buildVideoVersionRoot(projectStoragePath, videoFolderName, trimmedLabel)

        if (oldMainPrefix !== newMainPrefix) {
          const oldPreviewPrefix = buildVideoVersionPreviewsRoot(projectStoragePath, videoFolderName, video.versionLabel)
          const newPreviewPrefix = buildVideoVersionPreviewsRoot(projectStoragePath, videoFolderName, trimmedLabel)

          const videoAssets = await prisma.videoAsset.findMany({
            where: { videoId: id },
            select: { id: true, storagePath: true, previewPath: true },
          })

          if (isS3Mode()) {
            const activeRenameJob = await prisma.folderRenameJob.findFirst({
              where: { entityType: 'VIDEO_VERSION', entityId: id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
            })
            if (activeRenameJob) {
              return NextResponse.json(
                { error: 'A rename is already in progress for this video version. Please wait for it to complete.' },
                { status: 423 },
              )
            }

            if (!confirmed) {
              return NextResponse.json(
                {
                  requiresJobConfirmation: true,
                  proposedLabel: trimmedLabel,
                },
                { status: 202 },
              )
            }

            const folderRenameJob = await prisma.folderRenameJob.create({
              data: {
                entityType: 'VIDEO_VERSION',
                entityId: id,
                entityName: trimmedLabel,
                oldPrefix: oldMainPrefix,
                newPrefix: newMainPrefix,
                status: 'PENDING',
              },
            })
            await getFolderRenameQueue().add('folder-rename', { folderRenameJobId: folderRenameJob.id })
            // In S3 mode only update the versionLabel field now; path columns will be
            // rebased by the background worker once the S3 copy completes.
          } else {
            // Local mode: plan an inline directory move + path rebase.
            versionLabelRenamePlan = {
              oldMainPrefix,
              newMainPrefix,
              oldPreviewPrefix,
              newPreviewPrefix,
              currentVideo: {
                originalStoragePath: (video as any).originalStoragePath,
                preview480Path: (video as any).preview480Path ?? null,
                preview720Path: (video as any).preview720Path ?? null,
                preview1080Path: (video as any).preview1080Path ?? null,
                thumbnailPath: (video as any).thumbnailPath ?? null,
                timelinePreviewVttPath: (video as any).timelinePreviewVttPath ?? null,
                timelinePreviewSpritesPath: (video as any).timelinePreviewSpritesPath ?? null,
              },
              videoAssets,
            }
          }
        }
      }
    }

    if (videoNotes !== undefined) {
      const trimmed = videoNotes.trim()
      updateData.videoNotes = trimmed ? trimmed : null
    }

    if (allowApproval !== undefined) {
      updateData.allowApproval = allowApproval
    }

    if (videoRenamePlan) {
      const siblingFolderByVideoId = new Map(
        videoRenamePlan.siblingVideos.map((row) => [row.id, row.storageFolderName || row.name] as const)
      )

      await prisma.$transaction(async (tx) => {
        const newVideoStorageRoot = buildVideoStorageRoot(
          videoRenamePlan.projectStoragePath,
          videoRenamePlan.newVideoFolderName,
        )

        for (const siblingVideo of videoRenamePlan.siblingVideos) {
          const oldFolderName = siblingFolderByVideoId.get(siblingVideo.id)
          if (!oldFolderName) continue

          const oldVideoStorageRoot = buildVideoStorageRoot(videoRenamePlan.projectStoragePath, oldFolderName)
          const rebasedVideoData = {
            name: updateData.name,
            storageFolderName: videoRenamePlan.newVideoFolderName,
            originalStoragePath: replaceStoredStoragePathPrefix(
              siblingVideo.originalStoragePath,
              oldVideoStorageRoot,
              newVideoStorageRoot,
            )!,
            preview480Path: replaceStoredStoragePathPrefix(
              siblingVideo.preview480Path,
              oldVideoStorageRoot,
              newVideoStorageRoot,
            ),
            preview720Path: replaceStoredStoragePathPrefix(
              siblingVideo.preview720Path,
              oldVideoStorageRoot,
              newVideoStorageRoot,
            ),
            preview1080Path: replaceStoredStoragePathPrefix(
              siblingVideo.preview1080Path,
              oldVideoStorageRoot,
              newVideoStorageRoot,
            ),
            thumbnailPath: replaceStoredStoragePathPrefix(
              siblingVideo.thumbnailPath,
              oldVideoStorageRoot,
              newVideoStorageRoot,
            ),
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
            data:
              siblingVideo.id === id
                ? { ...updateData, ...rebasedVideoData }
                : {
                    ...rebasedVideoData,
                    ...(approved ? { approved: false, approvedAt: null } : {}),
                  },
          })
        }

        for (const asset of videoRenamePlan.siblingAssets) {
          const oldFolderName = siblingFolderByVideoId.get(asset.videoId)
          if (!oldFolderName) continue

          const siblingVideo = videoRenamePlan.siblingVideos.find((row) => row.id === asset.videoId)
          if (!siblingVideo) continue

          const oldVideoStorageRoot = buildVideoStorageRoot(videoRenamePlan.projectStoragePath, oldFolderName)
          const rebasedStoragePath = replaceStoredStoragePathPrefix(
            asset.storagePath,
            oldVideoStorageRoot,
            newVideoStorageRoot,
          )!

          const currentPreviewExt = path.posix.extname(String(asset.previewPath || '')).toLowerCase()
          const desiredPreviewExt = currentPreviewExt === '.mp4' || currentPreviewExt === '.jpg'
            ? currentPreviewExt
            : String(asset.fileType || '').toLowerCase().startsWith('video/')
              ? '.mp4'
              : '.jpg'
          const rebasedPreviewPath = asset.previewPath
            ? buildVideoAssetPreviewStoragePath(
                videoRenamePlan.projectStoragePath,
                videoRenamePlan.newVideoFolderName,
                siblingVideo.versionLabel,
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
      })
    } else if (versionLabelRenamePlan) {
      // Move both the main version folder and its previews folder, then rebase all paths.
      await moveDirectory(versionLabelRenamePlan.oldMainPrefix, versionLabelRenamePlan.newMainPrefix)
      // Previews may not exist yet (unprocessed video) — moveDirectory returns early if src is absent.
      await moveDirectory(versionLabelRenamePlan.oldPreviewPrefix, versionLabelRenamePlan.newPreviewPrefix)

      const { oldMainPrefix, newMainPrefix, oldPreviewPrefix, newPreviewPrefix } = versionLabelRenamePlan

      await prisma.$transaction(async (tx) => {
        await tx.video.update({
          where: { id },
          data: {
            ...updateData,
            originalStoragePath: replaceStoredStoragePathPrefix(
              versionLabelRenamePlan.currentVideo.originalStoragePath,
              oldMainPrefix,
              newMainPrefix,
            )!,
            preview480Path: replaceStoredStoragePathPrefix(
              versionLabelRenamePlan.currentVideo.preview480Path,
              oldPreviewPrefix,
              newPreviewPrefix,
            ),
            preview720Path: replaceStoredStoragePathPrefix(
              versionLabelRenamePlan.currentVideo.preview720Path,
              oldPreviewPrefix,
              newPreviewPrefix,
            ),
            preview1080Path: replaceStoredStoragePathPrefix(
              versionLabelRenamePlan.currentVideo.preview1080Path,
              oldPreviewPrefix,
              newPreviewPrefix,
            ),
            thumbnailPath: replaceStoredStoragePathPrefix(
              versionLabelRenamePlan.currentVideo.thumbnailPath,
              oldPreviewPrefix,
              newPreviewPrefix,
            ),
            timelinePreviewVttPath: replaceStoredStoragePathPrefix(
              versionLabelRenamePlan.currentVideo.timelinePreviewVttPath,
              oldPreviewPrefix,
              newPreviewPrefix,
            ),
            timelinePreviewSpritesPath: replaceStoredStoragePathPrefix(
              versionLabelRenamePlan.currentVideo.timelinePreviewSpritesPath,
              oldPreviewPrefix,
              newPreviewPrefix,
            ),
          },
        })

        for (const asset of versionLabelRenamePlan.videoAssets) {
          await tx.videoAsset.update({
            where: { id: asset.id },
            data: {
              storagePath: replaceStoredStoragePathPrefix(asset.storagePath, oldMainPrefix, newMainPrefix)!,
              previewPath: replaceStoredStoragePathPrefix(asset.previewPath, oldPreviewPrefix, newPreviewPrefix),
            },
          })
        }
      })
    } else {
      // SECURITY: wrap unapprove-siblings + approve-target in a single transaction
      // to prevent concurrent approvals leaving two versions marked approved.
      if (approved && autoUnapprovedIds.length > 0) {
        await prisma.$transaction([
          prisma.video.updateMany({
            where: {
              projectId: video.projectId,
              name: video.name,
              id: { not: id },
            },
            data: { approved: false, approvedAt: null },
          }),
          prisma.video.update({ where: { id }, data: updateData }),
        ])
      } else {
        await prisma.video.update({
          where: { id },
          data: updateData,
        })
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
