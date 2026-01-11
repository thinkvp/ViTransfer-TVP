import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import * as path from 'path'
import { statfs } from 'fs/promises'

export const runtime = 'nodejs'

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

    const storageRoot = process.env.STORAGE_ROOT || path.join(process.cwd(), 'uploads')

    // Only count persisted objects that have a size column; this reflects what the project is storing in your backend.
    const [
      videoAgg,
      assetAgg,
      commentFileAgg,
      projectFileAgg,
      albumPhotoAgg,
    ] = await Promise.all([
      prisma.video.aggregate({ where: { projectId }, _sum: { originalFileSize: true } }),
      prisma.videoAsset.aggregate({ where: { video: { projectId } }, _sum: { fileSize: true } }),
      prisma.commentFile.aggregate({ where: { projectId }, _sum: { fileSize: true } }),
      prisma.projectFile.aggregate({ where: { projectId }, _sum: { fileSize: true } }),
      prisma.albumPhoto.aggregate({ where: { album: { projectId } }, _sum: { fileSize: true } }),
    ])

    const videosBytes = asNumberBigInt(videoAgg._sum.originalFileSize)
    const videoAssetsBytes = asNumberBigInt(assetAgg._sum.fileSize)
    const commentAttachmentsBytes = asNumberBigInt(commentFileAgg._sum.fileSize)
    const projectFilesBytes = asNumberBigInt(projectFileAgg._sum.fileSize)
    const photosBytes = asNumberBigInt(albumPhotoAgg._sum.fileSize)

    const totalBytes = videosBytes + videoAssetsBytes + commentAttachmentsBytes + photosBytes + projectFilesBytes

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
      capacityBytes,
      availableBytes,
      breakdown: {
        videosBytes,
        videoAssetsBytes,
        commentAttachmentsBytes,
        photosBytes,
        projectFilesBytes,
      },
    })
  } catch (error) {
    console.error('[API] Error fetching project storage summary:', error)
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}
