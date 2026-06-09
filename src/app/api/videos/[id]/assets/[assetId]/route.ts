import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { getCurrentUserFromRequest, requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getFilePath, deleteFile, sanitizeFilenameForHeader } from '@/lib/storage'
import { getStoredFilePath, deleteStoredFilesForEntity } from '@/lib/stored-file'
import { verifyProjectAccess } from '@/lib/project-access'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { buildProjectStorageRoot, buildVideoThumbnailStoragePath } from '@/lib/project-storage-paths'
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

    // Check if this asset is being used as the video's thumbnail (via StoredFile)
    const assetThumbPath = await getStoredFilePath('VIDEO_ASSET', assetId, 'THUMBNAIL')
    const videoThumbPath = await getStoredFilePath('VIDEO', asset.video.id, 'THUMBNAIL')
    const isCurrentThumbnail = videoThumbPath && assetThumbPath && videoThumbPath === assetThumbPath

    // Only delete the physical file if no other assets reference the same storage path
    const assetOrigPath = await getStoredFilePath('VIDEO_ASSET', assetId, 'ORIGINAL')
    const sharedCount = assetOrigPath ? await prisma.storedFile.count({
      where: {
        storagePath: assetOrigPath,
        entityType: 'VIDEO_ASSET',
        entityId: { not: assetId },
      },
    }) : 0

    if (sharedCount === 0 && assetOrigPath) {
      await deleteFile(assetOrigPath)
    }

    // If this asset was the current thumbnail, revert to system-generated thumbnail
    if (isCurrentThumbnail) {
      const projectStoragePath = asset.video.project.storagePath
        || buildProjectStorageRoot(asset.video.project.client?.name || asset.video.project.companyName || 'Client', asset.video.project.title)
      const systemThumbnailPath = buildVideoThumbnailStoragePath(
        projectStoragePath,
        asset.video.storageFolderName || asset.video.name || videoId,
        asset.video.versionLabel || `v${asset.video.version}`,
      )

      // Register thumbnail in StoredFile
      await prisma.storedFile.create({ data: {
        entityType: 'VIDEO', entityId: videoId, fileRole: 'THUMBNAIL',
        storagePath: systemThumbnailPath, fileName: 'thumbnail.jpg',
      } })
    }

    // Delete database record
    await prisma.videoAsset.delete({
      where: { id: assetId },
    })

    // Clean up StoredFile rows for this asset
    await deleteStoredFilesForEntity('VIDEO_ASSET', assetId).catch(() => {})

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
