import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import * as path from 'path'
import { statfs } from 'fs/promises'
import { getAlbumZipStoragePath } from '@/lib/album-photo-zip'
import { buildProjectStorageRoot } from '@/lib/project-storage-paths'
import { s3GetFileSize, s3SumPrefixSize } from '@/lib/s3-storage'

export const runtime = 'nodejs'

function asNumber(v: unknown): number {
  if (typeof v === 'bigint') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  return 0
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'settings-storage-overview'
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const storageProvider = (process.env.STORAGE_PROVIDER || 'local').toLowerCase()
    const isS3Provider = storageProvider === 's3'
    const storageRoot = process.env.STORAGE_ROOT || path.join(process.cwd(), 'uploads')

    const [
      videoAgg,
      assetAgg,
      commentFileAgg,
      projectFileAgg,
      projectEmailAgg,
      projectEmailAttachmentAgg,
      albumPhotoAgg,
      albumAgg,
      s3Albums,
      s3Videos,
      clientFileAgg,
      userFileAgg,
      projectTotals,
      projectsWithDisk,
    ] = await Promise.all([
      prisma.video.aggregate({ _sum: { originalFileSize: true } }),
      prisma.videoAsset.aggregate({ _sum: { fileSize: true } }),
      prisma.commentFile.aggregate({ _sum: { fileSize: true } }),
      prisma.projectFile.aggregate({ _sum: { fileSize: true } }),
      prisma.projectEmail.aggregate({ _sum: { rawFileSize: true } }),
      prisma.projectEmailAttachment.aggregate({ _sum: { fileSize: true } }),
      prisma.albumPhoto.aggregate({ _sum: { fileSize: true, socialFileSize: true } }),
      prisma.album.aggregate({ _sum: { fullZipFileSize: true, socialZipFileSize: true } }),
      isS3Provider
        ? prisma.album.findMany({
            select: {
              name: true,
              storageFolderName: true,
              project: {
                select: {
                  storagePath: true,
                  title: true,
                  companyName: true,
                  client: { select: { name: true } },
                },
              },
            },
          })
        : Promise.resolve([]),
      isS3Provider
        ? prisma.video.findMany({
            select: {
              preview480Path: true,
              preview720Path: true,
              preview1080Path: true,
              thumbnailPath: true,
              timelinePreviewVttPath: true,
              timelinePreviewSpritesPath: true,
            },
          })
        : Promise.resolve([]),
      prisma.clientFile.aggregate({ _sum: { fileSize: true } }),
      prisma.userFile.aggregate({ _sum: { fileSize: true } }),
      prisma.project.aggregate({ _sum: { totalBytes: true } }),
      // For estimating preview bytes: compare disk vs. DB-tracked for the same set of projects
      isS3Provider
        ? Promise.resolve({ _sum: { totalBytes: 0, diskBytes: 0 } } as any)
        : prisma.project.aggregate({
            where: { diskBytes: { not: null } },
            _sum: { totalBytes: true, diskBytes: true },
          }),
    ])

    const originalVideosBytes = asNumber(videoAgg._sum.originalFileSize)
    const videoAssetsBytes = asNumber(assetAgg._sum.fileSize)
    const commentAttachmentsBytes = asNumber(commentFileAgg._sum.fileSize)
    const communicationsBytes =
      asNumber(projectEmailAgg._sum.rawFileSize) +
      asNumber(projectEmailAttachmentAgg._sum.fileSize)
    const projectFilesBytes = asNumber(projectFileAgg._sum.fileSize)
    const originalPhotosBytes = asNumber(albumPhotoAgg._sum.fileSize)
    const storedAlbumZipFullBytes = asNumber(albumAgg._sum.fullZipFileSize)
    const storedAlbumZipSocialBytes = asNumber(albumAgg._sum.socialZipFileSize)
    let albumZipFullBytes = storedAlbumZipFullBytes
    let albumZipSocialBytes = storedAlbumZipSocialBytes

    if (isS3Provider && s3Albums.length > 0) {
      const zipSizes = await Promise.all(
        s3Albums.flatMap((album) => {
          const projectStoragePath = album.project.storagePath
            || buildProjectStorageRoot(
              album.project.client?.name || album.project.companyName || 'Client',
              album.project.title || 'Untitled'
            )
          const albumFolderName = album.storageFolderName || album.name

          const fullPath = getAlbumZipStoragePath({
            projectStoragePath,
            albumFolderName,
            albumName: album.name,
            variant: 'full',
          })
          const socialPath = getAlbumZipStoragePath({
            projectStoragePath,
            albumFolderName,
            albumName: album.name,
            variant: 'social',
          })
          return [s3GetFileSize(fullPath), s3GetFileSize(socialPath)]
        })
      )

      let liveFull = 0
      let liveSocial = 0
      for (let i = 0; i < zipSizes.length; i += 2) {
        liveFull += Math.max(0, Number(zipSizes[i] || 0))
        liveSocial += Math.max(0, Number(zipSizes[i + 1] || 0))
      }

      albumZipFullBytes = liveFull
      albumZipSocialBytes = liveSocial
    }

    const photoZipBytes =
      asNumber(albumPhotoAgg._sum.socialFileSize) +
      albumZipFullBytes +
      albumZipSocialBytes
    const clientFilesBytes = asNumber(clientFileAgg._sum.fileSize)
    const userFilesBytes = asNumber(userFileAgg._sum.fileSize)

    // In S3 mode, derive preview bytes from live preview objects.
    // In local mode, preserve the existing disk-vs-tracked estimate.
    let videoPreviewsBytes = 0
    if (isS3Provider) {
      const previewFilePaths = new Set<string>()
      const spritePrefixes = new Set<string>()

      for (const video of s3Videos) {
        if (video.preview480Path) previewFilePaths.add(video.preview480Path)
        if (video.preview720Path) previewFilePaths.add(video.preview720Path)
        if (video.preview1080Path) previewFilePaths.add(video.preview1080Path)
        if (video.thumbnailPath && !video.thumbnailPath.includes('/videos/assets/')) {
          previewFilePaths.add(video.thumbnailPath)
        }
        if (video.timelinePreviewVttPath) previewFilePaths.add(video.timelinePreviewVttPath)
        if (video.timelinePreviewSpritesPath) spritePrefixes.add(video.timelinePreviewSpritesPath)
      }

      const [fileSizes, prefixSizes] = await Promise.all([
        Promise.all([...previewFilePaths].map((p) => s3GetFileSize(p))),
        Promise.all([...spritePrefixes].map((p) => s3SumPrefixSize(p))),
      ])

      const filesTotal = fileSizes.reduce<number>((sum, size) => sum + Math.max(0, Number(size || 0)), 0)
      const prefixesTotal = prefixSizes.reduce<number>((sum, size) => sum + Math.max(0, Number(size || 0)), 0)
      videoPreviewsBytes = Math.max(0, filesTotal + prefixesTotal)
    } else {
      const diskBytesForProjects = asNumber(projectsWithDisk._sum.diskBytes)
      const totalBytesForProjectsWithDisk = asNumber(projectsWithDisk._sum.totalBytes)
      videoPreviewsBytes = Math.max(0, diskBytesForProjects - totalBytesForProjectsWithDisk)
    }

    const allProjectTotalBytes = asNumber(projectTotals._sum.totalBytes)
    const zipBytesDelta =
      (albumZipFullBytes + albumZipSocialBytes) -
      (storedAlbumZipFullBytes + storedAlbumZipSocialBytes)
    const totalBytes =
      allProjectTotalBytes + zipBytesDelta + videoPreviewsBytes + clientFilesBytes + userFilesBytes

    let capacityBytes: number | null = null
    let availableBytes: number | null = null
    if (!isS3Provider) {
      try {
        const s = await statfs(storageRoot)
        const bsize = asNumber(s.bsize)
        capacityBytes = Math.round(bsize * asNumber(s.blocks))
        availableBytes = Math.round(bsize * asNumber(s.bavail))
      } catch {
        // storage root may not be accessible in all environments
      }
    }

    return NextResponse.json({
      provider: storageProvider === 'dropbox' ? 'dropbox' : isS3Provider ? 's3' : 'local',
      totalBytes,
      capacityBytes,
      availableBytes,
      breakdown: {
        originalVideosBytes,
        videoPreviewsBytes,
        videoAssetsBytes,
        commentAttachmentsBytes,
        originalPhotosBytes,
        photoZipBytes,
        communicationsBytes,
        projectFilesBytes,
        clientFilesBytes,
        userFilesBytes,
      },
    })
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || 'Failed to load storage overview' },
      { status: 500 }
    )
  }
}
