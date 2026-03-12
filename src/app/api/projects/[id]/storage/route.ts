import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getFilePath } from '@/lib/storage'
import { getAlbumZipStoragePath } from '@/lib/album-photo-zip'
import { buildProjectStorageRoot } from '@/lib/project-storage-paths'
import * as path from 'path'
import { readdir, statfs } from 'fs/promises'
import * as fs from 'fs'

export const runtime = 'nodejs'

async function computeDirectorySizeBytes(absolutePath: string): Promise<number> {
  try {
    const rootStat = await fs.promises.lstat(absolutePath)
    if (!rootStat.isDirectory()) return rootStat.isFile() ? rootStat.size : 0
  } catch {
    return 0
  }

  let total = 0
  const stack: string[] = [absolutePath]

  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name)

      // Avoid following symlinks (safety + prevents escaping storage root).
      if (entry.isSymbolicLink()) {
        continue
      }

      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }

      if (entry.isFile()) {
        try {
          const st = await fs.promises.lstat(full)
          total += asNumberBigInt(st.size)
        } catch {
          // ignore
        }
      }
    }
  }

  return total
}

function asNumberBigInt(v: unknown): number {
  if (typeof v === 'bigint') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

async function computeStorageEntrySizeBytes(storagePath: string | null | undefined): Promise<number> {
  if (!storagePath) return 0

  try {
    return await computeDirectorySizeBytes(getFilePath(storagePath))
  } catch {
    return 0
  }
}

async function sumStorageEntrySizes(paths: Array<string | null | undefined>): Promise<number> {
  const sizes = await Promise.all(paths.map((storagePath) => computeStorageEntrySizeBytes(storagePath)))
  return sizes.reduce((total, size) => total + size, 0)
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'accessProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Too many requests. Please slow down.',
    },
    'project-storage'
  )

  if (rateLimitResult) return rateLimitResult

  try {
    const { id: projectId } = await params

    const url = new URL(request.url)
    const includeDisk = url.searchParams.get('includeDisk') === '1'

    const storageRoot = process.env.STORAGE_ROOT || path.join(process.cwd(), 'uploads')

    // Use stored project totalBytes for consistency with the dashboard.
    // Breakdown is computed from DB fields for UI display.
    const [
      project,
      videoAgg,
      assetAgg,
      commentFileAgg,
      projectFileAgg,
      projectEmailAgg,
      projectEmailAttachmentAgg,
      albumPhotoAgg,
      albumAgg,
    ] = await Promise.all([
      prisma.project.findUnique({
        where: { id: projectId },
        select: {
          totalBytes: true,
          title: true,
          storagePath: true,
          client: { select: { name: true } },
        },
      }),
      prisma.video.aggregate({ where: { projectId }, _sum: { originalFileSize: true } }),
      prisma.videoAsset.aggregate({ where: { video: { projectId } }, _sum: { fileSize: true } }),
      prisma.commentFile.aggregate({ where: { projectId }, _sum: { fileSize: true } }),
      prisma.projectFile.aggregate({ where: { projectId }, _sum: { fileSize: true } }),
      prisma.projectEmail.aggregate({ where: { projectId }, _sum: { rawFileSize: true } }),
      prisma.projectEmailAttachment.aggregate({ where: { projectEmail: { projectId } }, _sum: { fileSize: true } }),
      prisma.albumPhoto.aggregate({ where: { album: { projectId } }, _sum: { fileSize: true, socialFileSize: true } }),
      prisma.album.aggregate({ where: { projectId }, _sum: { fullZipFileSize: true, socialZipFileSize: true } }),
    ])

    const videosBytes = asNumberBigInt(videoAgg._sum.originalFileSize)
    const videoAssetsBytes = asNumberBigInt(assetAgg._sum.fileSize)
    const commentAttachmentsBytes = asNumberBigInt(commentFileAgg._sum.fileSize)

    const projectFilesBytesRaw = asNumberBigInt(projectFileAgg._sum.fileSize)
    const communicationsBytes =
      asNumberBigInt(projectEmailAgg._sum.rawFileSize) +
      asNumberBigInt(projectEmailAttachmentAgg._sum.fileSize)

    const photosOriginalBytes = asNumberBigInt(albumPhotoAgg._sum.fileSize)
    const socialPhotosBytes = asNumberBigInt(albumPhotoAgg._sum.socialFileSize)

    const albumZipFullBytes = asNumberBigInt(albumAgg._sum.fullZipFileSize)
    const albumZipSocialBytes = asNumberBigInt(albumAgg._sum.socialZipFileSize)
    const originalVideosBytes = videosBytes
    const originalPhotosBytes = photosOriginalBytes + socialPhotosBytes
    const photoZipBytes = albumZipFullBytes + albumZipSocialBytes

    // Fold sub-categories into the existing breakdown rows used by the UI.
    const photosBytes = originalPhotosBytes + photoZipBytes
    const projectFilesBytes = projectFilesBytesRaw + communicationsBytes
    let videoPreviewsBytes = 0

    const totalBytes = asNumberBigInt(project?.totalBytes)

    // Optional: compute on-disk totals by walking the project directory.
    // This matches the bytes you see in the volume (including derived/transcoded files
    // such as previews, thumbnails, timeline sprites/VTT, etc. that may not be tracked
    // in DB size fields).
    let diskTotalBytes: number | null = null
    let diskOtherBytes: number | null = null
    let diskBreakdown:
      | {
          originalVideosBytes: number
          videoPreviewsBytes: number
          videosBytes: number
          videoAssetsBytes: number
          commentAttachmentsBytes: number
          originalPhotosBytes: number
          photoZipBytes: number
          photosBytes: number
          projectFilesBytes: number
        }
      | null = null

    if (includeDisk) {
      const projectRootRel = project?.storagePath || buildProjectStorageRoot(project?.client?.name || 'Client', project?.title || projectId)
      const videoAssetsRel = `${projectRootRel}/videos/assets`
      const commentsRel = `${projectRootRel}/comments`
      const communicationRel = `${projectRootRel}/communication`
      const filesRel = `${projectRootRel}/files`

      const [projectRootAbs, videoAssetsAbs, commentsAbs, communicationAbs, filesAbs] = [
        projectRootRel,
        videoAssetsRel,
        commentsRel,
        communicationRel,
        filesRel,
      ].map((p) => getFilePath(p))

      const [
        videoEntries,
        albumPhotoEntries,
        albumEntries,
        rootBytes,
        videoAssetsBytesDisk,
        commentsBytesDisk,
        communicationBytesDisk,
        filesBytesDisk,
      ] = await Promise.all([
        prisma.video.findMany({
          where: { projectId },
          select: {
            originalStoragePath: true,
            preview480Path: true,
            preview720Path: true,
            preview1080Path: true,
            thumbnailPath: true,
            timelinePreviewVttPath: true,
            timelinePreviewSpritesPath: true,
          },
        }),
        prisma.albumPhoto.findMany({
          where: { album: { projectId } },
          select: {
            storagePath: true,
            socialStoragePath: true,
          },
        }),
        prisma.album.findMany({
          where: { projectId },
          select: { id: true, name: true, storageFolderName: true },
        }),
        computeDirectorySizeBytes(projectRootAbs),
        computeDirectorySizeBytes(videoAssetsAbs),
        computeDirectorySizeBytes(commentsAbs),
        computeDirectorySizeBytes(communicationAbs),
        computeDirectorySizeBytes(filesAbs),
      ])

      const [originalVideosBytesDisk, videoPreviewsBytesDisk, originalPhotosBytesDisk, photoZipBytesDisk] = await Promise.all([
        sumStorageEntrySizes(videoEntries.map((video) => video.originalStoragePath)),
        sumStorageEntrySizes(
          videoEntries.flatMap((video) => {
            const previewPaths: string[] = []

            if (video.preview480Path) previewPaths.push(video.preview480Path)
            if (video.preview720Path) previewPaths.push(video.preview720Path)
            if (video.preview1080Path) previewPaths.push(video.preview1080Path)
            if (video.thumbnailPath && !video.thumbnailPath.includes('/videos/assets/')) {
              previewPaths.push(video.thumbnailPath)
            }
            if (video.timelinePreviewSpritesPath) {
              previewPaths.push(video.timelinePreviewSpritesPath)
            } else if (video.timelinePreviewVttPath) {
              previewPaths.push(video.timelinePreviewVttPath)
            }

            return previewPaths
          })
        ),
        sumStorageEntrySizes(
          albumPhotoEntries.flatMap((photo) => [photo.storagePath, photo.socialStoragePath])
        ),
        sumStorageEntrySizes(
          albumEntries.flatMap((album) => [
            getAlbumZipStoragePath({
              projectId,
              albumId: album.id,
              projectStoragePath: projectRootRel,
              albumFolderName: album.storageFolderName || album.name || album.id,
              albumName: album.name,
              variant: 'full',
            }),
            getAlbumZipStoragePath({
              projectId,
              albumId: album.id,
              projectStoragePath: projectRootRel,
              albumFolderName: album.storageFolderName || album.name || album.id,
              albumName: album.name,
              variant: 'social',
            }),
          ])
        ),
      ])

      videoPreviewsBytes = Math.max(0, videoPreviewsBytesDisk)
      const projectFilesBytesDisk = Math.max(0, filesBytesDisk + communicationBytesDisk)

      diskTotalBytes = Math.max(0, rootBytes)
      const known =
        Math.max(0, commentsBytesDisk) +
        Math.max(0, originalPhotosBytesDisk) +
        Math.max(0, photoZipBytesDisk) +
        Math.max(0, projectFilesBytesDisk) +
        Math.max(0, originalVideosBytesDisk) +
        Math.max(0, videoPreviewsBytesDisk) +
        Math.max(0, videoAssetsBytesDisk)
      diskOtherBytes = Math.max(0, diskTotalBytes - known)

      diskBreakdown = {
        originalVideosBytes: Math.max(0, originalVideosBytesDisk),
        videoPreviewsBytes: Math.max(0, videoPreviewsBytesDisk),
        videosBytes: Math.max(0, originalVideosBytesDisk + videoPreviewsBytesDisk),
        videoAssetsBytes: Math.max(0, videoAssetsBytesDisk),
        commentAttachmentsBytes: Math.max(0, commentsBytesDisk),
        originalPhotosBytes: Math.max(0, originalPhotosBytesDisk),
        photoZipBytes: Math.max(0, photoZipBytesDisk),
        photosBytes: Math.max(0, originalPhotosBytesDisk + photoZipBytesDisk),
        projectFilesBytes: Math.max(0, projectFilesBytesDisk),
      }
    }

    // Available/capacity reflect the host filesystem where STORAGE_ROOT is mounted.
    // In Docker this is typically the volume backing your uploads directory.
    let capacityBytes: number | null = null
    let availableBytes: number | null = null
    try {
      const s = await statfs(storageRoot)
      const bsize = asNumberBigInt(s.bsize)
      const blocks = asNumberBigInt(s.blocks)
      const bavail = asNumberBigInt(s.bavail)
      if (bsize > 0 && blocks > 0) {
        capacityBytes = Math.max(0, blocks * bsize)
        availableBytes = Math.max(0, bavail * bsize)
      }
    } catch {
      // Not supported on all platforms / runtimes; omit values.
      capacityBytes = null
      availableBytes = null
    }

    return NextResponse.json({
      projectId,
      totalBytes,
      diskTotalBytes,
      diskOtherBytes,
      capacityBytes,
      availableBytes,
      breakdown: {
        originalVideosBytes,
        videoPreviewsBytes,
        videosBytes,
        videoAssetsBytes,
        commentAttachmentsBytes,
        originalPhotosBytes,
        photoZipBytes,
        photosBytes,
        projectFilesBytes,
      },
      diskBreakdown,
    })
  } catch (error) {
    console.error('[API] Error fetching project storage summary:', error)
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}
