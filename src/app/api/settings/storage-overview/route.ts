import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import * as path from 'path'
import { statfs } from 'fs/promises'
import { getStoredFileAggregate } from '@/lib/stored-file'

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
      shareUploadFileAgg,
      projectFileAgg,
      projectEmailAgg,
      projectEmailAttachmentAgg,
      albumPhotoAgg,
      albumZipAgg,
      albumPhotoSocialAgg,
      clientFileAgg,
      userFileAgg,
      projectTotals,
      projectsWithDisk,
      accountingTotal,
    ] = await Promise.all([
      // All file sizes now come from StoredFile registry
      getStoredFileAggregate({ entityType: 'VIDEO', fileRole: 'ORIGINAL' }),
      getStoredFileAggregate({ entityType: 'VIDEO_ASSET' }),
      getStoredFileAggregate({ entityType: 'COMMENT_FILE' }),
      getStoredFileAggregate({ entityType: 'SHARE_UPLOAD_FILE' }),
      getStoredFileAggregate({ entityType: 'PROJECT_FILE' }),
      getStoredFileAggregate({ entityType: 'PROJECT_EMAIL' }),
      getStoredFileAggregate({ entityType: 'PROJECT_EMAIL_ATTACHMENT' }),
      getStoredFileAggregate({ entityType: 'ALBUM_PHOTO', fileRole: 'ORIGINAL' }),
      getStoredFileAggregate({ entityType: 'ALBUM', fileRole: { in: ['ZIP_FULL', 'ZIP_SOCIAL', 'SOCIAL', 'THUMBNAIL'] } }),
      getStoredFileAggregate({ entityType: 'ALBUM_PHOTO', fileRole: { in: ['SOCIAL', 'THUMBNAIL'] } }),
      getStoredFileAggregate({ entityType: 'CLIENT_FILE' }),
      getStoredFileAggregate({ entityType: 'USER_FILE' } as any),
      prisma.project.aggregate({ _sum: { totalBytes: true, previewBytes: true } }),
      isS3Provider
        ? Promise.resolve({ _sum: { totalBytes: 0, diskBytes: 0 } } as any)
        : prisma.project.aggregate({
            where: { diskBytes: { not: null } },
            _sum: { totalBytes: true, diskBytes: true },
          }),
      // Accounting files total from StoredFile
      getStoredFileAggregate({ entityType: 'ACCOUNTING_ATTACHMENT' } as any),
    ])

    const originalVideosBytes = asNumber(videoAgg._sum.fileSize)
    const videoAssetsBytes = asNumber(assetAgg._sum.fileSize)
    const commentAttachmentsBytes = asNumber(commentFileAgg._sum.fileSize)
    const uploadsFilesBytes = asNumber(shareUploadFileAgg._sum.fileSize)
    const communicationsBytes =
      asNumber(projectEmailAgg._sum.fileSize) +
      asNumber(projectEmailAttachmentAgg._sum.fileSize)
    const projectFilesBytes = asNumber(projectFileAgg._sum.fileSize)
    const originalPhotosBytes = asNumber(albumPhotoAgg._sum.fileSize)
    const photoZipBytes = asNumber(albumZipAgg._sum.fileSize) + asNumber(albumPhotoSocialAgg._sum.fileSize)
    const clientFilesBytes = asNumber(clientFileAgg._sum.fileSize)
    const userFilesBytes = asNumber(userFileAgg._sum.fileSize)
    const accountingFilesBytes = asNumber((accountingTotal as any)._sum.fileSize)

    // In S3 mode, use DB-backed previewBytes (reconciled daily) instead of a live S3 scan.
    // In local mode, estimate preview bytes as the difference between disk total and DB-tracked total.
    let videoPreviewsBytes = 0
    if (isS3Provider) {
      videoPreviewsBytes = asNumber((projectTotals as any)._sum.previewBytes)
    } else {
      const diskBytesForProjects = asNumber((projectsWithDisk as any)._sum.diskBytes)
      const totalBytesForProjectsWithDisk = asNumber((projectsWithDisk as any)._sum.totalBytes)
      videoPreviewsBytes = Math.max(0, diskBytesForProjects - totalBytesForProjectsWithDisk)
    }

    const allProjectTotalBytes = asNumber((projectTotals as any)._sum.totalBytes)
    const totalBytes =
      allProjectTotalBytes + videoPreviewsBytes + clientFilesBytes + userFilesBytes + accountingFilesBytes

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
      provider: isS3Provider ? 's3' : 'local',
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
        uploadsFilesBytes,
        projectFilesBytes,
        clientFilesBytes,
        userFilesBytes,
        accountingFilesBytes,
      },
    })
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || 'Failed to load storage overview' },
      { status: 500 }
    )
  }
}
