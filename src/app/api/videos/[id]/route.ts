import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { recalculateAndStoreProjectPreviewBytes, recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { deleteDirectory, deleteFile, moveDirectory, pruneEmptyParentDirectories, getFilePath } from '@/lib/storage'
// eslint-disable-next-line no-restricted-imports
import { renameStoredPaths, deleteStoredFilesForEntity, getStoredFilePath, countStoredFilesByPath, deleteStoredFilesByCriteria, getStoredFileRecords } from '@/lib/stored-file'
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
  buildProjectAllVideosRoot,
  buildProjectStorageRoot,
  buildVideoAssetsStorageRoot,
  buildVideoPreviewsRoot,
  buildVideoStorageRoot,
  buildVideoVersionRoot,
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
          videoAssets: Array<{ id: string }>
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
          }>
          siblingAssets: Array<{
            id: string
            videoId: string
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
          select: { id: true, videoId: true, previewStatus: true, fileType: true },
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
          // Only the originals version folder moves — previews are ID-keyed and
          // unaffected by the version label.
          const videoAssets = await prisma.videoAsset.findMany({
            where: { videoId: id },
            select: { id: true, previewStatus: true },
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
            // Local mode: plan an inline directory move + StoredFile path rebase
            // for the originals folder only.
            versionLabelRenamePlan = {
              oldMainPrefix,
              newMainPrefix,
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

          // StoredFile handles path rebasing via renameStoredPaths()
          await renameStoredPaths('VIDEO', [siblingVideo.id], oldVideoStorageRoot, newVideoStorageRoot)

          await tx.video.update({
            where: { id: siblingVideo.id },
            data:
              siblingVideo.id === id
                ? { ...updateData, name: updateData.name, storageFolderName: videoRenamePlan.newVideoFolderName }
                : {
                    name: updateData.name,
                    storageFolderName: videoRenamePlan.newVideoFolderName,
                    ...(approved ? { approved: false, approvedAt: null } : {}),
                  },
          })
        }

        for (const asset of videoRenamePlan.siblingAssets) {
          const oldFolderName = siblingFolderByVideoId.get(asset.videoId)
          if (!oldFolderName) continue

          const oldVideoStorageRoot = buildVideoStorageRoot(videoRenamePlan.projectStoragePath, oldFolderName)

          // StoredFile handles path rebasing
          await renameStoredPaths('VIDEO_ASSET', [asset.id], oldVideoStorageRoot, newVideoStorageRoot)
        }
      })
    } else if (versionLabelRenamePlan) {
      // Move the originals version folder, then rebase StoredFile originals paths.
      // Previews are ID-keyed (rename-immune) — no preview move/rebase needed.
      await moveDirectory(versionLabelRenamePlan.oldMainPrefix, versionLabelRenamePlan.newMainPrefix)

      const { oldMainPrefix, newMainPrefix } = versionLabelRenamePlan

      await prisma.$transaction(async (tx) => {
        await tx.video.update({
          where: { id },
          data: updateData,
        })

        // Rename StoredFile paths for this video and its assets (OLD prefix → NEW prefix)
        if (oldMainPrefix !== newMainPrefix) {
          await renameStoredPaths('VIDEO', [id], oldMainPrefix, newMainPrefix)
          const assetIds = versionLabelRenamePlan.videoAssets.map(a => a.id)
          if (assetIds.length > 0) {
            await renameStoredPaths('VIDEO_ASSET', assetIds, oldMainPrefix, newMainPrefix)
          }
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
    const projectStoragePath = video.project.storagePath
      || buildProjectStorageRoot(video.project.client?.name || video.project.companyName || 'Client', video.project.title)
    const videoFolderName = video.storageFolderName || video.name || id
    const versionLabel = video.versionLabel || `v${video.version}`
    // Previews are ID-keyed: previews/{projectId}/videos/{videoId}/… — deleting this
    // root removes preview mp4s, thumbnail, timeline sprites, and all asset derivatives.
    const previewRoot = buildVideoPreviewsRoot(projectId, id)

    // Collect comment file IDs before any deletion so we can clean up
    // StoredFile rows even if the pre-deletion file removal fails.
    let commentFileIdsToDelete: string[] = []

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
        },
      })

      commentFileIdsToDelete = commentFiles.map((f) => f.id)
      // Delete comment file physical files via StoredFile
      if (commentFileIdsToDelete.length > 0) {
        const cfPaths = await getStoredFileRecords('COMMENT_FILE', commentFileIdsToDelete, {
          select: { storagePath: true, entityId: true },
        })
        for (const cf of cfPaths) {
          // Comment file paths are unique per upload (timestamped) — never shared.
          try { await deleteFile(cf.storagePath) } catch {}
        }
        // Delete the StoredFile records
        await deleteStoredFilesByCriteria({
          entityType: 'COMMENT_FILE',
          entityIds: commentFileIdsToDelete,
        })
      }

      // Delete asset files via StoredFile
      for (const asset of video.assets) {
        const assetPath = await getStoredFilePath('VIDEO_ASSET', asset.id, 'ORIGINAL')
        if (assetPath) {
          const sharedCount = await countStoredFilesByPath(assetPath, { excludeEntityType: 'VIDEO_ASSET', excludeEntityId: asset.id })
          if (sharedCount === 0) {
            await deleteFile(assetPath)
          }
        }
      }

      // Delete original file (path from StoredFile registry)
      const origPath = await getStoredFilePath('VIDEO', id, 'ORIGINAL')
      if (origPath) {
        await deleteFile(origPath)
      }

      // Delete the entire preview tree for this video version. That covers preview mp4s,
      // timeline assets, the canonical thumbnail.jpg, and all video-asset preview derivatives.
      await deleteDirectory(previewRoot).catch(() => {})

      // If the selected thumbnail points outside the generated preview tree (for example,
      // a custom thumbnail set from an asset), delete that physical file only when it is
      // not referenced by any other video or asset.
      const thumbPath = await getStoredFilePath('VIDEO', id, 'THUMBNAIL')
      if (thumbPath && !thumbPath.startsWith(`${previewRoot}/`)) {
        const thumbnailSharedAssets = await countStoredFilesByPath(thumbPath, { excludeEntityType: 'VIDEO_ASSET', excludeEntityId: id })
        const thumbnailSharedVideos = await countStoredFilesByPath(thumbPath, { excludeEntityType: 'VIDEO', excludeEntityId: id })

        // Only delete if no other assets or videos reference this thumbnail path
        if (thumbnailSharedAssets === 0 && thumbnailSharedVideos === 0) {
          await deleteFile(thumbPath)
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

    // Clean up StoredFile rows for this video and its assets
    await deleteStoredFilesForEntity('VIDEO', id).catch(() => {})
    for (const asset of video.assets) {
      await deleteStoredFilesForEntity('VIDEO_ASSET', asset.id).catch(() => {})
    }
    // Safety net: ensure COMMENT_FILE StoredFile rows are cleaned up even if
    // the pre-deletion pass above failed.  At this point the Comment/CommentFile
    // rows are already cascade-deleted, so any remaining StoredFile rows would
    // be orphans pointing to non-existent entities.
    if (commentFileIdsToDelete.length > 0) {
      await deleteStoredFilesByCriteria({
        entityType: 'COMMENT_FILE',
        entityIds: commentFileIdsToDelete,
      }).catch(() => {})
    }

    // Update the stored project data totals
    await Promise.allSettled([
      recalculateAndStoreProjectTotalBytes(projectId),
      recalculateAndStoreProjectPreviewBytes(projectId),
    ])

    const pruneStopAt = buildProjectAllVideosRoot(projectStoragePath)

    try {
      await pruneEmptyParentDirectories(
        buildVideoAssetsStorageRoot(projectStoragePath, videoFolderName, versionLabel),
        pruneStopAt,
      )
      await pruneEmptyParentDirectories(
        buildVideoVersionRoot(projectStoragePath, videoFolderName, versionLabel),
        pruneStopAt,
      )
      // The ID-keyed preview tree (previews/{projectId}/videos/{videoId}) was deleted
      // above; orphan-cleanup prunes any now-empty preview parent dirs in local mode.
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
