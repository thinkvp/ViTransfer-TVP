import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { downloadFile, getFilePath, uploadFile } from '@/lib/storage'
import {
  buildVideoAssetPreviewStoragePath,
} from '@/lib/project-storage-paths'
import {
  allocateUniqueStorageName,
  buildVideoAssetStoragePath,
  buildProjectStorageRoot,
} from '@/lib/project-storage-paths'
import { recalculateAndStoreProjectPreviewBytes, recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { isS3Mode, s3GetFileSize } from '@/lib/s3-storage'
import { z } from 'zod'
export const runtime = 'nodejs'

async function getLogicalFileSize(filePath: string): Promise<number> {
  if (isS3Mode()) {
    const size = await s3GetFileSize(filePath)
    if (typeof size === 'number' && size >= 0) return size
    throw new Error(`Failed to determine file size for ${filePath}`)
  }

  const stats = await fs.promises.stat(getFilePath(filePath))
  return stats.size
}

async function copyLogicalFile(
  sourcePath: string,
  destinationPath: string,
  size: number,
  contentType: string,
): Promise<void> {
  const sourceStream = await downloadFile(sourcePath)
  await uploadFile(destinationPath, sourceStream, size, contentType)
}

const copyAssetsSchema = z.object({
  assetIds: z.array(z.string().min(1)).min(1, 'No assets selected for copying').max(50, 'Too many assets selected'),
  targetVideoId: z.string().min(1, 'Target video version not specified'),
})

// POST /api/videos/[id]/assets/copy-to-version - Copy assets to another video version
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
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

  // 2. RATE LIMITING
  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 20,
      message: 'Too many asset copy requests. Please slow down.',
    },
    'copy-assets-to-version'
  )
  if (rateLimitResult) return rateLimitResult

  const { id: sourceVideoId } = await params

  try {
    const body = await request.json()
    const parsed = copyAssetsSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0].message },
        { status: 400 }
      )
    }
    const { assetIds, targetVideoId } = parsed.data

    // Verify source video exists and fetch project context
    const sourceVideo = await prisma.video.findUnique({
      where: { id: sourceVideoId },
      select: {
        id: true,
        projectId: true,
        name: true,
        storageFolderName: true,
        version: true,
        versionLabel: true,
        project: {
          select: {
            status: true,
            storagePath: true,
            title: true,
            companyName: true,
            assignedUsers: { select: { userId: true } },
            client: { select: { name: true } },
          },
        },
      },
    })

    if (!sourceVideo) {
      return NextResponse.json({ error: 'Source video not found' }, { status: 404 })
    }

    const project = sourceVideo.project
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    if (authResult.appRoleIsSystemAdmin !== true) {
      const assigned = project.assignedUsers?.some((u) => u.userId === authResult.id)
      if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

      if (!isVisibleProjectStatusForUser(authResult, project.status)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    // Verify target video exists and is in same project; fetch storage fields
    const targetVideo = await prisma.video.findUnique({
      where: { id: targetVideoId },
      select: {
        id: true,
        projectId: true,
        name: true,
        storageFolderName: true,
        version: true,
        versionLabel: true,
      },
    })

    if (!targetVideo) {
      return NextResponse.json({ error: 'Target video not found' }, { status: 404 })
    }

    if (sourceVideo.projectId !== targetVideo.projectId) {
      return NextResponse.json(
        { error: 'Cannot copy assets between different projects' },
        { status: 400 }
      )
    }

    // Get all requested assets with their StoredFile records
    const assets = await prisma.videoAsset.findMany({
      where: {
        id: { in: assetIds },
        videoId: sourceVideoId,
      },
    })

    if (assets.length === 0) {
      return NextResponse.json({ error: 'No valid assets found' }, { status: 404 })
    }

    // Batch-load StoredFile for all assets
    const assetStoredFiles = await prisma.storedFile.findMany({
      where: { entityType: 'VIDEO_ASSET', entityId: { in: assets.map(a => a.id) } },
      select: { entityId: true, fileRole: true, storagePath: true, fileSize: true },
    })
    const storedByAsset = new Map<string, Map<string, { path: string; size: bigint | null }>>()
    for (const sf of assetStoredFiles) {
      let map = storedByAsset.get(sf.entityId)
      if (!map) { map = new Map(); storedByAsset.set(sf.entityId, map) }
      map.set(sf.fileRole, { path: sf.storagePath, size: sf.fileSize })
    }

    // Resolve project and target version path components
    const clientName = project.client?.name || project.companyName || 'Client'
    const projectStoragePath =
      project.storagePath ||
      buildProjectStorageRoot(clientName, project.title)
    const targetVideoFolderName = targetVideo.storageFolderName || targetVideo.name
    const targetVersionLabel = targetVideo.versionLabel || `v${targetVideo.version}`
    const targetExistingAssets = await prisma.storedFile.findMany({
      where: { entityType: 'VIDEO_ASSET', entityId: { in: (await prisma.videoAsset.findMany({ where: { videoId: targetVideoId }, select: { id: true } })).map(a => a.id) } },
      select: { storagePath: true },
    })
    const reservedStorageNames = new Set(
      targetExistingAssets
        .map((asset) => path.posix.basename(String(asset.storagePath || '')))
        .filter(Boolean)
    )

    // Physically copy each asset file to the target version's assets folder
    const copiedAssets = [] as Array<unknown>
    for (const asset of assets) {
      const stored = storedByAsset.get(asset.id)
      const originalStored = stored?.get('ORIGINAL')
      const sourcePath = originalStored?.path
      if (!sourcePath) continue // Skip assets without registered original path

      const uniqueStorageFileName = allocateUniqueStorageName(asset.fileName, reservedStorageNames)
      reservedStorageNames.add(uniqueStorageFileName)

      // Build target paths
      const targetLocalRelPath = buildVideoAssetStoragePath(
        projectStoragePath,
        targetVideoFolderName,
        targetVersionLabel,
        uniqueStorageFileName,
      )

      // Determine the storage path for the new DB record
      const newStoragePath = targetLocalRelPath

      await copyLogicalFile(
        sourcePath,
        newStoragePath,
        originalStored.size != null ? Number(originalStored.size) : 0,
        asset.fileType || 'application/octet-stream',
      )

      const normalizedType = String(asset.fileType || '').toLowerCase()
      const hasReadyPreview = asset.previewStatus === 'READY'
      const isVideoAsset = normalizedType.startsWith('video/')
      const isImageAsset = normalizedType.startsWith('image/')
      let newPreviewPath: string | null = null
      let newPreviewStatus: string | null = null
      let newPreviewGeneratedAt: Date | null = null
      let newPreviewFileSize: bigint | null = null

      const previewMp4 = stored?.get('PREVIEW_MP4')
      const previewImage = stored?.get('PREVIEW_IMAGE')
      const previewStored = previewMp4 || previewImage
      const previewSourcePath = previewStored?.path

      if (hasReadyPreview && previewSourcePath) {
        if (isVideoAsset && previewMp4) {
          const sourceCompanionPreviewPath = buildVideoAssetPreviewStoragePath(
            projectStoragePath,
            sourceVideo.storageFolderName || sourceVideo.name,
            sourceVideo.versionLabel || `v${sourceVideo.version}`,
            sourcePath,
            '.jpg',
          )
          const targetCompanionPreviewPath = buildVideoAssetPreviewStoragePath(
            projectStoragePath,
            targetVideoFolderName,
            targetVersionLabel,
            newStoragePath,
            '.jpg',
          )
          const targetPlaybackPreviewPath = buildVideoAssetPreviewStoragePath(
            projectStoragePath,
            targetVideoFolderName,
            targetVersionLabel,
            newStoragePath,
            '.mp4',
          )

          await copyLogicalFile(
            previewSourcePath,
            targetPlaybackPreviewPath,
            previewMp4.size != null ? Number(previewMp4.size) : await getLogicalFileSize(previewSourcePath),
            'video/mp4',
          )
          await copyLogicalFile(
            sourceCompanionPreviewPath,
            targetCompanionPreviewPath,
            await getLogicalFileSize(sourceCompanionPreviewPath),
            'image/jpeg',
          )

          newPreviewPath = targetPlaybackPreviewPath
          newPreviewStatus = 'READY'
          newPreviewGeneratedAt = asset.previewGeneratedAt
          newPreviewFileSize = previewMp4.size ?? null
        } else if (isImageAsset || previewSourcePath) {
          const targetImagePreviewPath = buildVideoAssetPreviewStoragePath(
            projectStoragePath,
            targetVideoFolderName,
            targetVersionLabel,
            newStoragePath,
            '.jpg',
          )

          await copyLogicalFile(
            previewSourcePath,
            targetImagePreviewPath,
            previewStored.size != null ? Number(previewStored.size) : await getLogicalFileSize(previewSourcePath),
            'image/jpeg',
          )

          newPreviewPath = targetImagePreviewPath
          newPreviewStatus = 'READY'
          newPreviewGeneratedAt = asset.previewGeneratedAt
          newPreviewFileSize = previewStored.size != null
            ? previewStored.size
            : BigInt(await getLogicalFileSize(previewSourcePath))
        }
      }

      // Create the new asset DB record — register original file via StoredFile
      const newAsset = await prisma.videoAsset.create({
        data: {
          videoId: targetVideoId,
          fileName: asset.fileName,
          fileType: asset.fileType,
          category: asset.category,
          uploadedByName: asset.uploadedByName,
          previewStatus: newPreviewStatus,
          previewGeneratedAt: newPreviewGeneratedAt,
        },
      })

      // Register original and preview files in StoredFile
      await prisma.storedFile.create({
        data: {
          entityType: 'VIDEO_ASSET',
          entityId: newAsset.id,
          fileRole: 'ORIGINAL',
          storagePath: newStoragePath,
          fileName: asset.fileName,
          fileSize: originalStored.size ?? BigInt(0),
        },
      })
      if (newPreviewPath) {
        const previewRole = normalizedType.startsWith('video/') ? 'PREVIEW_MP4' as const : 'PREVIEW_IMAGE' as const
        await prisma.storedFile.create({
          data: {
            entityType: 'VIDEO_ASSET',
            entityId: newAsset.id,
            fileRole: previewRole,
            storagePath: newPreviewPath,
            fileName: asset.fileName,
            fileSize: newPreviewFileSize ?? BigInt(0),
          },
        })
      }

      copiedAssets.push(newAsset)
    }

    await Promise.allSettled([
      recalculateAndStoreProjectTotalBytes(sourceVideo.projectId),
      recalculateAndStoreProjectPreviewBytes(sourceVideo.projectId),
    ])

    return NextResponse.json({
      success: true,
      message: `Successfully copied ${copiedAssets.length} asset(s) to target version`,
      copiedCount: copiedAssets.length,
    })
  } catch (error) {
    console.error('Error copying assets to version:', error)
    return NextResponse.json(
      { error: 'Failed to copy assets' },
      { status: 500 }
    )
  }
}
