import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { buildProjectStorageRoot, buildVideoThumbnailStoragePath } from '@/lib/project-do storage-paths'
import { deleteFile } from '@/lib/storage'
// eslint-disable-next-line no-restricted-imports
import { getStoredFileRecords, getStoredFilePath, deleteStoredFilesByCriteria, registerStoredFile } from '@/lib/stored-file'
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
            storagePath: true,
            title: true,
            companyName: true,
            client: { select: { name: true } },
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

    // If action is 'remove', revert to system-generated thumbnail
    if (action === 'remove') {
      const projectStoragePath = video.project.storagePath
        || buildProjectStorageRoot(video.project.client?.name || video.project.companyName || 'Client', video.project.title)
      const systemThumbnailPath = buildVideoThumbnailStoragePath(
        projectStoragePath,
        video.storageFolderName || video.name || videoId,
        video.versionLabel || `v${video.version}`,
      )

      // Delete custom thumbnail from StoredFile, reverting to system-generated
      await deleteStoredFilesByCriteria({
        entityType: 'VIDEO', entityIds: [videoId], fileRoles: ['THUMBNAIL'],
      }).catch(() => {})

      return NextResponse.json({
        success: true,
        message: 'Reverted to system-generated thumbnail',
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

    // Update StoredFile thumbnail path (Video.thumbnailPath column dropped)
    const assetStoragePath = await getStoredFilePath('VIDEO_ASSET', assetId, 'ORIGINAL')
    if (assetStoragePath) {
      await registerStoredFile({
        entityType: 'VIDEO', entityId: videoId, fileRole: 'THUMBNAIL', storagePath: assetStoragePath, status: 'READY',
      })
    }

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
