import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { getCurrentUserFromRequest, requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getFilePath, deleteFile, deleteDirectory, sanitizeFilenameForHeader } from '@/lib/storage'
// Video routes verify project access separately; getStoredFilePathForProject requires projectId plumbing.
// eslint-disable-next-line no-restricted-imports
import { deleteStoredFilesForEntity, getStoredFilePath, countStoredFilesByPath, deleteStoredFilesByCriteria, getStoredFileRecords } from '@/lib/stored-file'
import { getVideoQueue } from '@/lib/queue'
import { verifyProjectAccess } from '@/lib/project-access'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getTransferTuningSettings } from '@/lib/settings'
import { isS3Mode, s3GetPresignedDownloadUrl } from '@/lib/s3-storage'
import { createReadStream } from 'fs'
import fs from 'fs'
export const runtime = 'nodejs'

function isValidMimeType(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 255) return false
  // Basic type/subtype check; disallow parameters and obviously invalid placeholders.
  return /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(trimmed)
}




// GET /api/videos/[id]/assets/[assetId] - Download asset
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> }
) {
  const { id: videoId, assetId } = await params

  // Rate limiting
  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 30,
      message: 'Too many download requests. Please slow down.',
    },
    'video-asset-download'
  )
  if (rateLimitResult) return rateLimitResult

  try {
    // Get asset with video and project info
    const asset = await prisma.videoAsset.findUnique({
      where: { id: assetId },
      include: {
        video: {
          include: {
            project: {
              include: { assignedUsers: { select: { userId: true } } },
            },
          },
        },
      },
    })

    if (!asset || asset.videoId !== videoId) {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
    }

    const project = asset.video.project

    // SECURITY: Verify user has access to this project (admin OR valid share session)
    const accessCheck = await verifyProjectAccess(request, project.id, project.sharePassword, project.authMode)
    if (!accessCheck.authorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    // If this is an admin request, also enforce app-role RBAC.
    if (accessCheck.isAdmin) {
      const adminUser = await getCurrentUserFromRequest(request)
      if (!adminUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

      const forbiddenMenu = requireMenuAccess(adminUser, 'projects')
      if (forbiddenMenu) return forbiddenMenu

      const forbiddenAction = requireActionAccess(adminUser, 'uploadVideosOnProjects')
      if (forbiddenAction) return forbiddenAction

      if (adminUser.appRoleIsSystemAdmin !== true) {
        const assigned = project.assignedUsers?.some((u: any) => u.userId === adminUser.id)
        if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

        if (!isVisibleProjectStatusForUser(adminUser, project.status)) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }
      }
    }

    // For non-admins, verify video approval
    if (!accessCheck.isAdmin) {
      // Check if video is approved (assets only available for approved videos)
      if (!asset.video.approved) {
        return NextResponse.json(
          { error: 'Assets are only available for approved videos' },
          { status: 403 }
        )
      }
    }

    const sanitizedFilename = sanitizeFilenameForHeader(asset.fileName)
    const contentType = isValidMimeType(asset.fileType) ? asset.fileType : 'application/octet-stream'

    // Get storage path from StoredFile
    const { getStoredFilePath } = await import('@/lib/stored-file')
    const assetStoragePath = await getStoredFilePath('VIDEO_ASSET', assetId, 'ORIGINAL')
    if (!assetStoragePath) return NextResponse.json({ error: 'File not found' }, { status: 404 })

    if (isS3Mode()) {
      const presignedUrl = await s3GetPresignedDownloadUrl(assetStoragePath, 300, asset.fileName, contentType)
      return NextResponse.redirect(presignedUrl, { status: 302, headers: { 'Cache-Control': 'no-store' } })
    }

    // Get the full file path and check if exists
    const fullPath = getFilePath(assetStoragePath)
    const stat = await fs.promises.stat(fullPath)
    if (!stat.isFile()) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    // Stream file with proper Node.js to Web API stream conversion
    const { downloadChunkSizeBytes } = await getTransferTuningSettings()
    const fileStream = createReadStream(fullPath, { highWaterMark: downloadChunkSizeBytes })

    // Convert Node.js stream to Web API ReadableStream
    let closed = false
    const readableStream = new ReadableStream({
      start(controller) {
        fileStream.on('data', (chunk) => {
          if (!closed) controller.enqueue(chunk)
        })
        fileStream.on('end', () => {
          if (!closed) { closed = true; controller.close() }
        })
        fileStream.on('error', (err) => {
          if (!closed) { closed = true; controller.error(err) }
        })
      },
      cancel() {
        closed = true
        fileStream.destroy()
      },
    })

    return new NextResponse(readableStream, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${sanitizedFilename}"`,
        'Content-Length': stat.size.toString(),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-cache',
      },
    })
  } catch (error) {
    console.error('Error downloading asset:', error)
    return NextResponse.json(
      { error: 'Failed to download asset' },
      { status: 500 }
    )
  }
}

// DELETE /api/videos/[id]/assets/[assetId] - Delete asset
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> }
) {
  const { id: videoId, assetId } = await params

  // Authentication - admin only
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) {
    return authResult
  }

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'projectsFullControl')
  if (forbiddenAction) return forbiddenAction

  // Rate limiting
  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 20,
      message: 'Too many delete requests. Please slow down.',
    },
    'video-asset-delete'
  )
  if (rateLimitResult) return rateLimitResult

  try {
    // Get asset with video info
    const asset = await prisma.videoAsset.findUnique({
      where: { id: assetId },
      include: {
        video: {
          include: {
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
          },
        },
      },
    })

    if (!asset || asset.videoId !== videoId) {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
    }

    if (authResult.appRoleIsSystemAdmin !== true) {
      const assigned = asset.video.project.assignedUsers?.some((u) => u.userId === authResult.id)
      if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

      if (!isVisibleProjectStatusForUser(authResult, asset.video.project.status)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    // Detect whether this asset is the video's *custom* thumbnail. A custom thumbnail
    // is recorded by repointing VIDEO/THUMBNAIL at the asset's own ORIGINAL file — there
    // is no VIDEO_ASSET/THUMBNAIL row — so we compare the resolved paths.
    const assetOrigPath = await getStoredFilePath('VIDEO_ASSET', assetId, 'ORIGINAL')
    const videoThumbPath = await getStoredFilePath('VIDEO', videoId, 'THUMBNAIL')
    const isCurrentThumbnail = !!(assetOrigPath && videoThumbPath && assetOrigPath === videoThumbPath)

    // If this asset was the live custom thumbnail, drop the THUMBNAIL pointer and
    // regenerate a system thumbnail from the video original (mirrors the 'remove'
    // action in set-thumbnail). Done BEFORE the orphan check below so the asset's
    // original file is no longer referenced by THUMBNAIL and can be deleted.
    if (isCurrentThumbnail) {
      await deleteStoredFilesByCriteria({
        entityType: 'VIDEO', entityIds: [videoId], fileRoles: ['THUMBNAIL'],
      }).catch(() => {})

      const videoOriginalPath = await getStoredFilePath('VIDEO', videoId, 'ORIGINAL')
      if (videoOriginalPath) {
        await prisma.video.update({
          where: { id: videoId },
          data: { status: 'QUEUED', processingProgress: 0, processingPhase: null, processingError: null },
        })
        await getVideoQueue().add('process-video', {
          videoId,
          storagePath: videoOriginalPath,
          projectId: asset.video.projectId,
          thumbnailOnly: true,
        })
      }
    }

    // Only delete the asset's physical original if nothing else references it now
    // (the THUMBNAIL pointer, if any, was just removed above).
    const sharedCount = assetOrigPath
      ? await countStoredFilesByPath(assetOrigPath, { excludeEntityType: 'VIDEO_ASSET', excludeEntityId: assetId })
      : 0
    if (sharedCount === 0 && assetOrigPath) {
      await deleteFile(assetOrigPath)
    }

                                    // Fetch all stored file records for this asset so we can delete physical files
    // HLS_SEGMENTS is the hls/ directory; deleting it removes the master.m3u8 (HLS_PLAYLIST)
    // and every segment in one shot, so HLS_PLAYLIST needn't be fetched for the physical delete
    // (its StoredFile row is cleared by deleteStoredFilesForEntity below).
    const storedRecords = await getStoredFileRecords('VIDEO_ASSET', [assetId], {
      fileRoles: ['PREVIEW_IMAGE', 'PREVIEW_MP4', 'TIMELINE_VTT', 'TIMELINE_SPRITES', 'HLS_SEGMENTS'],
      select: { fileRole: true, storagePath: true },
    })

    // Delete physical preview/timeline files from storage.
    // Attempt all deletions in parallel, logging any failures.
    // The storage integrity scan will clean up orphaned files on its next non-dry-run pass.
    const deleteResults = await Promise.allSettled(
      storedRecords.map(async (record) => {
        if (!record.storagePath) return
        if (record.fileRole === 'TIMELINE_SPRITES' || record.fileRole === 'HLS_SEGMENTS') {
          await deleteDirectory(record.storagePath)
        } else {
          await deleteFile(record.storagePath)
        }
      })
    )
    let hasFailures = false
    for (let i = 0; i < deleteResults.length; i++) {
      const result = deleteResults[i]
      if (result.status === 'rejected') {
        hasFailures = true
        const path = storedRecords[i]?.storagePath || 'unknown'
        console.warn(`[DELETE ASSET] Failed to delete file for asset ${assetId}: ${path} — ${result.reason}`)
      }
    }

    // Delete database record
    await prisma.videoAsset.delete({
      where: { id: assetId },
    })

        // Clean up StoredFile rows for this asset
    try {
      await deleteStoredFilesForEntity('VIDEO_ASSET', assetId)
    } catch (err) {
      console.warn(`[DELETE ASSET] Failed to delete StoredFile records for asset ${assetId}: ${err}`)
    }

    // Update the stored project data total
    await recalculateAndStoreProjectTotalBytes(asset.video.projectId)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting asset:', error)
    return NextResponse.json(
      { error: 'Failed to delete asset' },
      { status: 500 }
    )
  }
}

// PATCH /api/videos/[id]/assets/[assetId] - deprecated asset update endpoint
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> }
) {
  const { id: videoId, assetId } = await params

  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'projectsFullControl')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 30,
    message: 'Too many update requests. Please slow down.',
  }, 'video-asset-update')
  if (rateLimitResult) return rateLimitResult

  try {
    const body = await request.json()

    const asset = await prisma.videoAsset.findUnique({
      where: { id: assetId },
      include: {
        video: {
          include: {
            project: {
              select: {
                status: true,
                title: true,
                storagePath: true,
                companyName: true,
                assignedUsers: { select: { userId: true } },
                client: { select: { name: true } },
              },
            },
          },
        },
      },
    })

    if (!asset || asset.videoId !== videoId) {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
    }

    if (authResult.appRoleIsSystemAdmin !== true) {
      const assigned = asset.video.project.assignedUsers?.some((u) => u.userId === authResult.id)
      if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

      if (!isVisibleProjectStatusForUser(authResult, asset.video.project.status)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    return NextResponse.json({ error: 'Asset updates are no longer supported on this endpoint' }, { status: 410 })
  } catch (error) {
    console.error('Error updating asset:', error)
    return NextResponse.json({ error: 'Failed to update asset' }, { status: 500 })
  }
}
