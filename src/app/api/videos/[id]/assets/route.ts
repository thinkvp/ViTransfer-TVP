import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { prisma } from '@/lib/db'
import { getCurrentUserFromRequest, requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { validateAssetFile } from '@/lib/file-validation'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { allocateUniqueStorageName, buildProjectStorageRoot, buildVideoAssetStoragePath } from '@/lib/project-storage-paths'
import { getStoredFileRecords, registerStoredFile } from '@/lib/stored-file'
import { generateVideoAccessToken } from '@/lib/video-access'
import { isS3Mode, s3GetPresignedStreamUrl } from '@/lib/s3-storage'
import { z } from 'zod'
export const runtime = 'nodejs'




const createAssetSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z.union([z.number(), z.string()])
    .transform(val => Number(val))
    .refine(val => Number.isFinite(val) && Number.isInteger(val) && val > 0 && val <= Number.MAX_SAFE_INTEGER, {
      message: 'fileSize must be a positive integer',
    }),
  category: z.string().max(100).nullable().optional(),
  mimeType: z.string().max(255).optional(),
})

// GET /api/videos/[id]/assets - List all assets for a video
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: videoId } = await params

  // Rate limiting
  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Too many requests. Please slow down.',
    },
    'video-assets-list'
  )
  if (rateLimitResult) return rateLimitResult

  try {
    // Verify video exists
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      include: {
        project: {
          include: { client: { select: { name: true } }, assignedUsers: { select: { userId: true } } },
        },
      },
    })

    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    const project = video.project

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

    if (!accessCheck.isAdmin && !video.approved) {
      return NextResponse.json(
        { error: 'Assets are only available for approved videos' },
        { status: 403 }
      )
    }

    // Get all assets for this video
    const assets = await prisma.videoAsset.findMany({
      where: { videoId },
      orderBy: { createdAt: 'desc' },
    })

        // Resolve file sizes from StoredFile
    const assetIds = assets.map(a => a.id)
    const storedSizes = assetIds.length > 0 ? await getStoredFileRecords('VIDEO_ASSET', assetIds, { fileRoles: ['ORIGINAL'], select: { entityId: true, fileSize: true, storagePath: true } }) : []
    const sizeByAssetId = new Map(storedSizes.map(s => [s.entityId, s.fileSize ? String(s.fileSize) : '0']))

    // Resolve current thumbnail path from StoredFile
    const thumbnailRecord = await prisma.storedFile.findUnique({
      where: { entityType_entityId_fileRole: { entityType: 'VIDEO', entityId: videoId, fileRole: 'THUMBNAIL' } },
      select: { storagePath: true },
    })
    const currentThumbnailPath = thumbnailRecord?.storagePath ?? null

    // Resolve still-image preview availability so the asset list can render thumbnails.
    // Mirrors the gating in the asset download-token route: image/video assets with a
    // READY generated preview get a tokenised `assetPreview=1` URL served by the content route.
    const imageExtensions = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif']
    const videoExtensions = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'mxf']
    const previewImageStored = assetIds.length > 0
      ? await getStoredFileRecords('VIDEO_ASSET', assetIds, { fileRoles: ['PREVIEW_IMAGE'], select: { entityId: true, storagePath: true } })
      : []
    const hasPreviewImage = new Set(previewImageStored.map((s) => s.entityId))
    const previewImagePathByAssetId = new Map(previewImageStored.map((s) => [s.entityId, s.storagePath as string]))

    // 2-hour TTL matches the download-token route so thumbnails outlive a normal session window.
    const DOWNLOAD_TOKEN_TTL = 2 * 60 * 60
    const sessionId = accessCheck.shareTokenSessionId
      || (accessCheck.isAdmin ? `admin:${Date.now()}` : `guest:${Date.now()}`)

    // S3 mode: presign the generated preview image directly so each asset tile loads from R2,
    // skipping the /api/content round-trip (token + DB + existence HEAD + redirect) per asset.
    // Mirrors the content route's assetPreview path resolution: image assets use the stored
    // PREVIEW_IMAGE path; video assets use the computed preview-image path.
    const s3 = isS3Mode()

    const thumbnailUrlByAssetId = new Map<string, string>()
    await Promise.all(
      assets.map(async (asset) => {
        const ft = String(asset.fileType || '').toLowerCase()
        const ext = asset.fileName.includes('.')
          ? asset.fileName.slice(asset.fileName.lastIndexOf('.') + 1).toLowerCase()
          : ''
        const isImage = ft.startsWith('image/') || imageExtensions.includes(ext)
        const isVideo = ft.startsWith('video/') || videoExtensions.includes(ext)
        const hasReadyPreview = asset.previewStatus === 'READY' && (isVideo || hasPreviewImage.has(asset.id))
        if (!((isImage || isVideo) && hasReadyPreview)) return

        if (s3) {
          // Both video assets (companion JPG) and image assets register their
          // thumbnail under PREVIEW_IMAGE in StoredFile (ID-keyed previews).
          const previewPath = previewImagePathByAssetId.get(asset.id) ?? null
          if (previewPath) {
            try {
              thumbnailUrlByAssetId.set(asset.id, await s3GetPresignedStreamUrl(previewPath, DOWNLOAD_TOKEN_TTL, 'image/jpeg'))
              return
            } catch {
              // Fall through to the token URL below.
            }
          }
        }

        try {
          const token = await generateVideoAccessToken(videoId, project.id, 'asset-download', request, sessionId, DOWNLOAD_TOKEN_TTL)
          thumbnailUrlByAssetId.set(asset.id, `/api/content/${token}?assetId=${asset.id}&assetPreview=1`)
        } catch {
          // Best-effort; the UI falls back to the file-type icon.
        }
      })
    )

    // Convert to serializable format
    const serializedAssets = assets.map(asset => ({
      ...asset,
      fileSize: sizeByAssetId.get(asset.id) ?? '0',
      previewFileSize: null as string | null,
      thumbnailUrl: thumbnailUrlByAssetId.get(asset.id) ?? null,
    }))

    return NextResponse.json({
      assets: serializedAssets,
      currentThumbnailPath,
    })
  } catch (error) {
    console.error('Error fetching video assets:', error)
    return NextResponse.json(
      { error: 'Failed to fetch video assets' },
      { status: 500 }
    )
  }
}

// POST /api/videos/[id]/assets - Create asset record for TUS upload
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: videoId } = await params

  // Authentication
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) {
    return authResult
  }

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'uploadVideosOnProjects')
  if (forbiddenAction) return forbiddenAction

  // Rate limiting
  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 50,
      message: 'Too many upload requests. Please slow down.',
    },
    'video-assets-create'
  )
  if (rateLimitResult) return rateLimitResult

  try {
    // Verify video exists
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      include: {
        project: {
          include: { client: { select: { name: true } }, assignedUsers: { select: { userId: true } } },
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

    // Get current user for tracking
    const currentUser = await getCurrentUserFromRequest(request)
    if (!currentUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Parse request body
    const body = await request.json()
    const parsed = createAssetSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 })
    }
    const { fileName, fileSize, category, mimeType } = parsed.data
    const normalizedCategory = category ?? undefined

    // Validate required fields
    if (!fileName || !fileSize) {
      return NextResponse.json(
        { error: 'fileName and fileSize are required' },
        { status: 400 }
      )
    }

    // Validate asset file
    const assetValidation = validateAssetFile(fileName, mimeType || 'application/octet-stream', normalizedCategory)

    if (!assetValidation.valid) {
      return NextResponse.json(
        { error: assetValidation.error || 'Invalid asset file' },
        { status: 400 }
      )
    }

    // Create storage path (use sanitized filename from validation)
    const timestamp = Date.now()
    const sanitizedFileName = assetValidation.sanitizedFilename || fileName.replace(/[^a-zA-Z0-9 ._&-]/g, '_').substring(0, 255)
    const projectStoragePath = video.project.storagePath
      || buildProjectStorageRoot(video.project.client?.name || video.project.companyName || 'Client', video.project.title)
    const videoFolderName = video.storageFolderName || video.name
    const versionLabel = video.versionLabel || `v${video.version}`
    const existingAssetNames = await prisma.videoAsset.findMany({
      where: { videoId },
      select: { fileName: true },
    })
    const reservedStorageNames = existingAssetNames.map((asset) => asset.fileName)
    const uniqueStorageFileName = allocateUniqueStorageName(sanitizedFileName, reservedStorageNames)
    const localPath = buildVideoAssetStoragePath(projectStoragePath, videoFolderName, versionLabel, uniqueStorageFileName)

    const storagePath = localPath

    // Use detected category if not provided
    const finalCategory = normalizedCategory || assetValidation.detectedCategory || 'other'

    // Create database record (TUS will upload the file later)
    const asset = await prisma.videoAsset.create({
      data: {
        videoId,
        fileName: sanitizedFileName,
        fileType: 'application/octet-stream',
        category: finalCategory,
        uploadedByName: currentUser.name || currentUser.email,
      },
    })

    // Register in StoredFile
    await registerStoredFile({
      entityType: 'VIDEO_ASSET', entityId: asset.id, fileRole: 'ORIGINAL',
      storagePath, fileName: sanitizedFileName, fileSize: BigInt(fileSize),
    })

    await recalculateAndStoreProjectTotalBytes(video.projectId)

    // Return assetId for TUS upload
    return NextResponse.json({
      assetId: asset.id,
    })
  } catch (error) {
    console.error('Error creating video asset:', error)
    return NextResponse.json(
      { error: 'Failed to create video asset' },
      { status: 500 }
    )
  }
}
