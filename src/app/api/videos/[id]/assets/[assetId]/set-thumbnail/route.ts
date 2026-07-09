import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { deleteFile } from '@/lib/storage'
import { getVideoQueue } from '@/lib/queue'
// eslint-disable-next-line no-restricted-imports
import { getStoredFilePath, deleteStoredFilesByCriteria, registerStoredFile, countStoredFilesByPath } from '@/lib/stored-file'
import { publishProjectEvent } from '@/lib/project-events'
export const runtime = 'nodejs'




// POST /api/videos/[id]/assets/[assetId]/set-thumbnail - Set asset as video thumbnail
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> }
) {
  // 1. AUTHENTICATION
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) {
    return authResult
  }

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'projectsFullControl')
  if (forbiddenAction) return forbiddenAction

  // 3. RATE LIMITING
  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 30,
      message: 'Too many thumbnail update requests. Please slow down.',
    },
    'set-asset-thumbnail'
  )
  if (rateLimitResult) return rateLimitResult

  const { id: videoId, assetId } = await params

  try {
    // Get the action from request body (default to 'set')
    const body = await request.json()
    const action = body.action || 'set'

    // Verify video exists
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      include: {
        project: {
          select: {
            status: true,
            assignedUsers: { select: { userId: true } },
          },
        },
      },
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

    // If action is 'remove', revert to a system-generated thumbnail.
    //
    // The custom thumbnail simply points the THUMBNAIL StoredFile at a VideoAsset
    // file; setting it deleted the old generated thumbnail (see below), so there is
    // no generated file left to fall back to.  We therefore drop the custom THUMBNAIL
    // row and re-queue a thumbnail-only reprocess to regenerate the system thumbnail.
    if (action === 'remove') {
      // Remove the custom thumbnail pointer. We do NOT delete the underlying file:
      // it is the asset's own ORIGINAL, still owned by the VideoAsset StoredFile row.
      await deleteStoredFilesByCriteria({
        entityType: 'VIDEO', entityIds: [videoId], fileRoles: ['THUMBNAIL'],
      }).catch(() => {})

      // Regenerate the system thumbnail from the original video. With the custom
      // THUMBNAIL row gone, the worker's finalize step will register the freshly
      // generated thumbnail under the THUMBNAIL role.
      const originalPath = await getStoredFilePath('VIDEO', videoId, 'ORIGINAL')
      if (originalPath) {
        await prisma.video.update({
          where: { id: videoId },
          data: { status: 'QUEUED', processingProgress: 0, processingPhase: null, processingError: null },
        })
        await getVideoQueue().add('process-video', {
          videoId,
          storagePath: originalPath,
          projectId: video.projectId,
          thumbnailOnly: true,
        })
      }

      return NextResponse.json({
        success: true,
        message: 'Reverting to system-generated thumbnail',
      })
    }

    // For 'set' action, verify asset and set it as thumbnail
    const asset = await prisma.videoAsset.findUnique({
      where: { id: assetId },
    })

    if (!asset || asset.videoId !== videoId) {
      return NextResponse.json(
        { error: 'Asset not found or does not belong to this video' },
        { status: 404 }
      )
    }

    // Verify asset is an image.
    // The fileType starts as 'application/octet-stream' and is updated asynchronously by the
    // asset-processor worker after magic-byte validation.  To avoid a race where the user
    // clicks "set as thumbnail" before the worker has run, we also accept assets whose
    // filename has a known image extension — matching the same logic in canSetAsThumbnail()
    // on the frontend.  We still reject any asset the worker explicitly flagged as INVALID.
    const imageTypes = ['image/jpeg', 'image/png', 'image/jpg']
    const imageExtensions = ['.jpg', '.jpeg', '.png']
    const assetFilenameLower = asset.fileName.toLowerCase()
    const assetExt = assetFilenameLower.includes('.')
      ? assetFilenameLower.slice(assetFilenameLower.lastIndexOf('.'))
      : ''

    const validByMime = imageTypes.includes(asset.fileType.toLowerCase())
    const validByExt = imageExtensions.includes(assetExt)
    const markedInvalid = asset.fileType.startsWith('INVALID')

    if ((!validByMime && !validByExt) || markedInvalid) {
      return NextResponse.json(
        { error: 'Only JPG and PNG images can be set as thumbnails' },
        { status: 400 }
      )
    }

    // Resolve the asset's stored file (the image we are promoting to thumbnail).
    const assetStoragePath = await getStoredFilePath('VIDEO_ASSET', assetId, 'ORIGINAL')
    if (!assetStoragePath) {
      return NextResponse.json(
        { error: 'Asset file is not ready yet. Please try again in a moment.' },
        { status: 409 }
      )
    }

    // Capture the thumbnail currently in use before we overwrite it. If it is a
    // generated thumbnail (not shared by any other entity such as a VideoAsset),
    // it becomes unreferenced once we repoint THUMBNAIL at the asset — delete it
    // so it does not linger as an orphan file in storage.
    const previousThumbnailPath = await getStoredFilePath('VIDEO', videoId, 'THUMBNAIL')

    // Point the video's THUMBNAIL at the asset file.
    await registerStoredFile({
      entityType: 'VIDEO', entityId: videoId, fileRole: 'THUMBNAIL', storagePath: assetStoragePath, status: 'READY',
    })

    if (previousThumbnailPath && previousThumbnailPath !== assetStoragePath) {
      // Count references excluding this video's own rows (the THUMBNAIL row we just
      // repointed). If nothing else references the old path it is the generated
      // system thumbnail and is now an orphan — remove it from storage.
      const stillReferenced = await countStoredFilesByPath(previousThumbnailPath, {
        excludeEntityType: 'VIDEO',
        excludeEntityId: videoId,
      })
      if (stillReferenced === 0) {
        await deleteFile(previousThumbnailPath).catch(() => {})
      }
    }

    // Notify open share pages / admin views so the new playback thumbnail appears live.
    await publishProjectEvent(video.projectId, 'video')

    return NextResponse.json({
      success: true,
      message: 'Thumbnail updated successfully',
    })
  } catch (error) {
    console.error('Error setting asset as thumbnail:', error)
    return NextResponse.json(
      { error: 'Failed to set thumbnail' },
      { status: 500 }
    )
  }
}
