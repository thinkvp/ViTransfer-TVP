import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getFilePath } from '@/lib/storage'
import {
  isDropboxStorageConfigured,
  isDropboxStoragePath,
  stripDropboxStoragePrefix,
  toDropboxStoragePath,
} from '@/lib/storage-provider-dropbox'
import {
  buildVideoAssetStoragePath,
  buildVideoAssetDropboxPath,
  buildProjectStorageRoot,
  getStoragePathBasename,
} from '@/lib/project-storage-paths'
import { recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
import { z } from 'zod'
export const runtime = 'nodejs'

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
        dropboxEnabled: true,
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

    // Get all requested assets
    const assets = await prisma.videoAsset.findMany({
      where: {
        id: { in: assetIds },
        videoId: sourceVideoId,
      },
    })

    if (assets.length === 0) {
      return NextResponse.json({ error: 'No valid assets found' }, { status: 404 })
    }

    // Resolve project and target version path components
    const clientName = project.client?.name || project.companyName || 'Client'
    const projectStoragePath =
      project.storagePath ||
      buildProjectStorageRoot(clientName, project.title)
    const targetVideoFolderName = targetVideo.storageFolderName || targetVideo.name
    const targetVersionLabel = targetVideo.versionLabel || `v${targetVideo.version}`
    const autoDropbox = targetVideo.dropboxEnabled === true && isDropboxStorageConfigured()

    // Physically copy each asset file to the target version's assets folder
    const copiedAssets = await Promise.all(
      assets.map(async (asset) => {
        // Resolve source local path (strip dropbox: prefix if present)
        const sourceLocalRelPath = isDropboxStoragePath(asset.storagePath)
          ? stripDropboxStoragePrefix(asset.storagePath)
          : asset.storagePath
        const sourceAbsPath = getFilePath(sourceLocalRelPath)

        // Build target paths
        const targetLocalRelPath = buildVideoAssetStoragePath(
          projectStoragePath,
          targetVideoFolderName,
          targetVersionLabel,
          asset.fileName,
        )
        const targetAbsPath = getFilePath(targetLocalRelPath)

        // Ensure target directory exists and copy the file
        await fs.promises.mkdir(path.dirname(targetAbsPath), { recursive: true })
        await fs.promises.copyFile(sourceAbsPath, targetAbsPath)

        // Determine the storage path for the new DB record
        const newStoragePath = autoDropbox
          ? toDropboxStoragePath(targetLocalRelPath)
          : targetLocalRelPath

        // Build Dropbox human-friendly path if applicable
        const newDropboxPath = autoDropbox
          ? buildVideoAssetDropboxPath(
              clientName,
              getStoragePathBasename(projectStoragePath) || project.title,
              targetVideoFolderName,
              targetVersionLabel,
              asset.fileName,
            )
          : null

        // Create the new asset DB record pointing to the copied file
        return prisma.videoAsset.create({
          data: {
            videoId: targetVideoId,
            fileName: asset.fileName,
            fileSize: asset.fileSize,
            fileType: asset.fileType,
            storagePath: newStoragePath,
            category: asset.category,
            uploadedByName: asset.uploadedByName,
            ...(autoDropbox
              ? {
                  dropboxEnabled: true,
                  dropboxPath: newDropboxPath,
                  dropboxUploadStatus: 'PENDING',
                  dropboxUploadProgress: 0,
                }
              : {}),
          },
        })
      })
    )

    // Queue Dropbox uploads for copied assets if applicable
    if (autoDropbox) {
      const { getDropboxUploadQueue } = await import('@/lib/queue')
      const dropboxQueue = getDropboxUploadQueue()
      await Promise.all(
        copiedAssets.map((newAsset) =>
          dropboxQueue.add('upload-asset-to-dropbox', {
            videoId: targetVideoId,
            localPath: isDropboxStoragePath(newAsset.storagePath)
              ? stripDropboxStoragePrefix(newAsset.storagePath)
              : newAsset.storagePath,
            dropboxPath: newAsset.storagePath,
            dropboxRelPath: newAsset.dropboxPath,
            fileSizeBytes: Number(newAsset.fileSize),
            assetId: newAsset.id,
          })
        )
      )
    }

    await recalculateAndStoreProjectTotalBytes(sourceVideo.projectId)

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
