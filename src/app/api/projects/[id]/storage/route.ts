import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { getFilePath } from '@/lib/storage'
import { getAlbumZipStoragePath } from '@/lib/album-photo-zip'
import { buildPreviewsRoot, buildProjectStorageRoot, buildProjectUploadsRoot } from '@/lib/project-storage-paths'
import { computeProjectPreviewBytes } from '@/lib/project-total-bytes'
import { getStoredFileAggregate, getStoredFileRecords } from '@/lib/stored-file'
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
    const storageProvider = (process.env.STORAGE_PROVIDER || 'local').toLowerCase()
    const isS3Provider = storageProvider === 's3'
    const includeDisk = !isS3Provider && url.searchParams.get('includeDisk') === '1'

    const storageRoot = process.env.STORAGE_ROOT || path.join(process.cwd(), 'uploads')

    // Use stored project totalBytes for consistency with the dashboard.
    // Breakdown is computed from DB fields for UI display.
    // Pre-fetch entity IDs for StoredFile aggregates
    const [videoIds, assetIds, commentFileIds, shareUploadFileIds, projectFileIds,
           projectEmailIds, projectEmailAttachmentIds, albumIds, albumPhotoIds] = await Promise.all([
      prisma.video.findMany({ where: { projectId }, select: { id: true } }).then(rows => rows.map(r => r.id)),
      prisma.videoAsset.findMany({ where: { video: { projectId } }, select: { id: true } }).then(rows => rows.map(r => r.id)),
      prisma.commentFile.findMany({ where: { projectId }, select: { id: true } }).then(rows => rows.map(r => r.id)),
      prisma.shareUploadFile.findMany({ where: { projectId }, select: { id: true } }).then(rows => rows.map(r => r.id)),
      prisma.projectFile.findMany({ where: { projectId }, select: { id: true } }).then(rows => rows.map(r => r.id)),
      prisma.projectEmail.findMany({ where: { projectId }, select: { id: true } }).then(rows => rows.map(r => r.id)),
      prisma.projectEmailAttachment.findMany({ where: { projectEmail: { projectId } }, select: { id: true } }).then(rows => rows.map(r => r.id)),
      prisma.album.findMany({ where: { projectId }, select: { id: true } }).then(rows => rows.map(r => r.id)),
      prisma.albumPhoto.findMany({ where: { album: { projectId } }, select: { id: true } }).then(rows => rows.map(r => r.id)),
    ])

    const [
      project,
      videoAgg,
      videoOrigAgg,
      assetAgg,
      commentFileAgg,
      shareUploadFileAgg,
      projectFileAgg,
      projectEmailAgg,
      projectEmailAttachmentAgg,
      albumPhotoAgg,
      albumPhotoOrigAgg,
      albumAgg,
    ] = await Promise.all([
      prisma.project.findUnique({
        where: { id: projectId },
        select: {
          totalBytes: true,
          previewBytes: true,
          diskBytes: true,
          title: true,
          storagePath: true,
          client: { select: { name: true } },
        },
      }),
      getStoredFileAggregate({ entityType: 'VIDEO', entityId: { in: videoIds } }),
      getStoredFileAggregate({ entityType: 'VIDEO', entityId: { in: videoIds }, fileRole: 'ORIGINAL' }),
      getStoredFileAggregate({ entityType: 'VIDEO_ASSET', entityId: { in: assetIds } }),
      getStoredFileAggregate({ entityType: 'COMMENT_FILE', entityId: { in: commentFileIds } }),
      getStoredFileAggregate({ entityType: 'SHARE_UPLOAD_FILE', entityId: { in: shareUploadFileIds } }),
      getStoredFileAggregate({ entityType: 'PROJECT_FILE', entityId: { in: projectFileIds } }),
      getStoredFileAggregate({ entityType: 'PROJECT_EMAIL', entityId: { in: projectEmailIds } }),
      getStoredFileAggregate({ entityType: 'PROJECT_EMAIL_ATTACHMENT', entityId: { in: projectEmailAttachmentIds } }),
      getStoredFileAggregate({ entityType: 'ALBUM_PHOTO', entityId: { in: albumPhotoIds } }),
      getStoredFileAggregate({ entityType: 'ALBUM_PHOTO', entityId: { in: albumPhotoIds }, fileRole: 'ORIGINAL' }),
      getStoredFileAggregate({ entityType: 'ALBUM', entityId: { in: albumIds } }),
    ])

    const videosBytes = asNumberBigInt(videoAgg._sum.fileSize)
    const originalVideosBytes = asNumberBigInt(videoOrigAgg._sum.fileSize)
    const videoAssetsBytes = asNumberBigInt(assetAgg._sum.fileSize)
    const commentAttachmentsBytes = asNumberBigInt(commentFileAgg._sum.fileSize)
    const uploadsFilesBytes = asNumberBigInt(shareUploadFileAgg._sum.fileSize)

    const projectFilesBytes = asNumberBigInt(projectFileAgg._sum.fileSize)
    const communicationsBytes =
      asNumberBigInt(projectEmailAgg._sum.fileSize) +
      asNumberBigInt(projectEmailAttachmentAgg._sum.fileSize)

    const photosBytes = asNumberBigInt(albumPhotoAgg._sum.fileSize)
    const originalPhotosBytes = asNumberBigInt(albumPhotoOrigAgg._sum.fileSize)
    // photoZipBytes = derived photo files (social + thumbnails) + album ZIPs
    const photoZipBytes =
      Math.max(0, photosBytes - originalPhotosBytes) +
      asNumberBigInt(albumAgg._sum.fileSize)
    // S3 video previews: use computeProjectPreviewBytes which fetches live S3 sizes
    // (StoredFile.fileSize is null for preview entries from migration backfill)
    let s3VideoPreviewsBytes = 0
    if (isS3Provider) {
      s3VideoPreviewsBytes = Number(await computeProjectPreviewBytes(projectId, prisma))
    }
    // Local: previews are tracked in StoredFile with real sizes (already part of totalBytes),
    // so read the reconciled previewBytes column for display. Overwritten with a precise
    // on-disk walk below when includeDisk=1.
    let videoPreviewsBytes = isS3Provider ? s3VideoPreviewsBytes : asNumberBigInt(project?.previewBytes)

    const totalBytesStored = asNumberBigInt(project?.totalBytes)
    const previewBytesDelta = isS3Provider ? s3VideoPreviewsBytes : 0
    const totalBytes = Math.max(0, totalBytesStored + previewBytesDelta)
    const storedDiskBytes = asNumberBigInt(project?.diskBytes)

    // Optional: compute on-disk totals by walking the project directory.
    // This matches the bytes you see in the volume (including derived/transcoded files
    // such as previews, thumbnails, timeline sprites/VTT, etc. that may not be tracked
    // in DB size fields).
    let diskTotalBytes: number | null = isS3Provider
      ? null
      : project?.diskBytes == null
        ? null
        : Math.max(0, storedDiskBytes)
    let diskOtherBytes: number | null = null
    let diskBreakdown:
      | {
          originalVideosBytes: number
          videoPreviewsBytes: number
          videosBytes: number
          videoAssetsBytes: number
          commentAttachmentsBytes: number
          uploadsFilesBytes: number
          originalPhotosBytes: number
          photoZipBytes: number
          photosBytes: number
          communicationsBytes: number
          projectFilesBytes: number
        }
      | null = null

    if (includeDisk) {
      const projectRootRel = project?.storagePath || buildProjectStorageRoot(project?.client?.name || 'Client', project?.title || projectId)
      const commentsRel = `${projectRootRel}/comments`
      const communicationRel = `${projectRootRel}/communication`
      const filesRel = `${projectRootRel}/files`
      const uploadsRel = buildProjectUploadsRoot(projectRootRel)

      const [projectRootAbs, commentsAbs, communicationAbs, filesAbs, uploadsAbs] = [
        projectRootRel,
        commentsRel,
        communicationRel,
        filesRel,
        uploadsRel,
      ].map((p) => getFilePath(p))

      // ID-keyed previews live outside the project tree at previews/{projectId}/… —
      // walk them too so the on-disk total matches the project's true footprint.
      const previewsRootAbs = getFilePath(buildPreviewsRoot(projectId))

      const [
        videoEntries,
        videoAssetEntries,
        albumPhotoEntries,
        albumEntries,
        projectTreeBytes,
        previewsTreeBytes,
        commentsBytesDisk,
        communicationBytesDisk,
        filesBytesDisk,
        uploadsBytesDisk,
      ] = await Promise.all([
        prisma.video.findMany({
          where: { projectId },
          select: { id: true },
        }),
        prisma.videoAsset.findMany({
          where: { video: { projectId } },
          select: { id: true },
        }),
        prisma.albumPhoto.findMany({
          where: { album: { projectId } },
          select: { id: true },
        }),
        prisma.album.findMany({
          where: { projectId },
          select: { id: true, name: true, storageFolderName: true },
        }),
        computeDirectorySizeBytes(projectRootAbs),
        computeDirectorySizeBytes(previewsRootAbs),
        computeDirectorySizeBytes(commentsAbs),
        computeDirectorySizeBytes(communicationAbs),
        computeDirectorySizeBytes(filesAbs),
        computeDirectorySizeBytes(uploadsAbs),
      ])

      const rootBytes = projectTreeBytes + previewsTreeBytes

      const videoAssetStoragePaths = new Set<string>()
      // Disk bytes via StoredFile — batch-load all paths for this project's entities
      const [videoStored, assetStored, photoStored] = await Promise.all([
        getStoredFileRecords('VIDEO', videoEntries.map(v => v.id), {
          select: { storagePath: true, fileRole: true, entityId: true },
        }),
        getStoredFileRecords('VIDEO_ASSET', videoAssetEntries.map(a => a.id), {
          select: { storagePath: true },
        }),
        getStoredFileRecords('ALBUM_PHOTO', albumPhotoEntries.map(p => p.id), {
          select: { storagePath: true, fileRole: true },
        }),
      ])

      // Asset original paths
      const assetOrigPaths = assetStored.map(s => s.storagePath).filter(Boolean)
      videoAssetStoragePaths as any // unused now — StoredFile has canonical paths

      const originalVideoPaths = videoStored.filter(s => s.fileRole === 'ORIGINAL').map(s => s.storagePath)
      const previewVideoPaths = videoStored.filter(s => ['PREVIEW_480', 'PREVIEW_720', 'PREVIEW_1080', 'THUMBNAIL', 'TIMELINE_VTT', 'TIMELINE_SPRITES'].includes(s.fileRole)).map(s => s.storagePath)
      const originalPhotoPaths = photoStored.filter(s => s.fileRole === 'ORIGINAL').map(s => s.storagePath)
      const socialPhotoPaths = photoStored.filter(s => s.fileRole === 'SOCIAL').map(s => s.storagePath)
      const thumbnailPhotoPaths = photoStored.filter(s => s.fileRole === 'THUMBNAIL').map(s => s.storagePath)

      const [originalVideosBytesDisk, videoPreviewsBytesDisk, videoAssetsBytesDisk, originalPhotosBytesDisk, photoZipBytesDisk] = await Promise.all([
        sumStorageEntrySizes(originalVideoPaths),
        sumStorageEntrySizes(previewVideoPaths),
        sumStorageEntrySizes(assetOrigPaths),
        sumStorageEntrySizes(originalPhotoPaths),
        Promise.all([
          sumStorageEntrySizes(socialPhotoPaths),
          sumStorageEntrySizes(thumbnailPhotoPaths),
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
        ]).then(([socialPhotoBytesDisk, thumbnailPhotoBytesDisk, albumZipBytesDisk]) => socialPhotoBytesDisk + thumbnailPhotoBytesDisk + albumZipBytesDisk),
      ])

      videoPreviewsBytes = Math.max(0, videoPreviewsBytesDisk)
      const projectFilesBytesDisk = Math.max(0, filesBytesDisk)
      const uploadsFilesBytesDisk = Math.max(0, uploadsBytesDisk)
      const communicationsBytesDisk = Math.max(0, communicationBytesDisk)

      diskTotalBytes = Math.max(0, rootBytes)
      const known =
        Math.max(0, commentsBytesDisk) +
        Math.max(0, originalPhotosBytesDisk) +
        Math.max(0, photoZipBytesDisk) +
        Math.max(0, communicationsBytesDisk) +
        Math.max(0, uploadsFilesBytesDisk) +
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
        uploadsFilesBytes: Math.max(0, uploadsFilesBytesDisk),
        originalPhotosBytes: Math.max(0, originalPhotosBytesDisk),
        photoZipBytes: Math.max(0, photoZipBytesDisk),
        photosBytes: Math.max(0, originalPhotosBytesDisk + photoZipBytesDisk),
        communicationsBytes: communicationsBytesDisk,
        projectFilesBytes: Math.max(0, projectFilesBytesDisk),
      }
    }

    // Available/capacity reflect the host filesystem where STORAGE_ROOT is mounted.
    // In Docker this is typically the volume backing your uploads directory.
    let capacityBytes: number | null = null
    let availableBytes: number | null = null
    if (!isS3Provider) {
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
    }

    return NextResponse.json({
      projectId,
      provider: isS3Provider ? 's3' : 'local',
      totalBytes,
      diskTotalBytes,
      diskOtherBytes,
      capacityBytes,
      availableBytes,
      breakdown: {
        originalVideosBytes,
        videosBytes,
        videoPreviewsBytes,
        videosBytesTotal: originalVideosBytes + videoPreviewsBytes + videoAssetsBytes,
        videoAssetsBytes,
        commentAttachmentsBytes,
        uploadsFilesBytes,
        originalPhotosBytes,
        photosBytes,
        photoZipBytes,
        photosTotal: originalPhotosBytes + photoZipBytes,
        communicationsBytes,
        projectFilesBytes,
      },
      diskBreakdown,
    })
  } catch (error) {
    console.error('[API] Error fetching project storage summary:', error)
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}
