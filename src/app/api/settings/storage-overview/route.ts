import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import * as path from 'path'
import { statfs } from 'fs/promises'

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
      prisma.clientFile.aggregate({ _sum: { fileSize: true } }),
      prisma.userFile.aggregate({ _sum: { fileSize: true } }),
      prisma.project.aggregate({ _sum: { totalBytes: true } }),
      // For estimating preview bytes: compare disk vs. DB-tracked for the same set of projects
      prisma.project.aggregate({
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
    const photoZipBytes =
      asNumber(albumPhotoAgg._sum.socialFileSize) +
      asNumber(albumAgg._sum.fullZipFileSize) +
      asNumber(albumAgg._sum.socialZipFileSize)
    const clientFilesBytes = asNumber(clientFileAgg._sum.fileSize)
    const userFilesBytes = asNumber(userFileAgg._sum.fileSize)

    // Estimate preview/derived bytes as the on-disk overhead above the DB-tracked total.
    // Uses only projects that have had diskBytes computed so the difference is meaningful.
    const diskBytesForProjects = asNumber(projectsWithDisk._sum.diskBytes)
    const totalBytesForProjectsWithDisk = asNumber(projectsWithDisk._sum.totalBytes)
    const videoPreviewsBytes = Math.max(0, diskBytesForProjects - totalBytesForProjectsWithDisk)

    const allProjectTotalBytes = asNumber(projectTotals._sum.totalBytes)
    const totalBytes =
      allProjectTotalBytes + videoPreviewsBytes + clientFilesBytes + userFilesBytes

    let capacityBytes: number | null = null
    let availableBytes: number | null = null
    try {
      const s = await statfs(storageRoot)
      const bsize = asNumber(s.bsize)
      capacityBytes = Math.round(bsize * asNumber(s.blocks))
      availableBytes = Math.round(bsize * asNumber(s.bavail))
    } catch {
      // storage root may not be accessible in all environments
    }

    return NextResponse.json({
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
