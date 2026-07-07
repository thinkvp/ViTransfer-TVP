import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { downloadFile } from '@/lib/storage'
// eslint-disable-next-line no-restricted-imports
import { getStoredFilePath } from '@/lib/stored-file'
import { parseSrt } from '@/lib/subtitles'
import { writeCuesForVideo } from '@/lib/subtitle-store'
import { recalculateAndStoreProjectPreviewBytes, recalculateAndStoreProjectTotalBytes } from '@/lib/project-total-bytes'
export const runtime = 'nodejs'

async function streamToString(storagePath: string): Promise<string> {
  const stream = await downloadFile(storagePath)
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

// POST /api/videos/[id]/assets/[assetId]/set-subtitles
// Promote an uploaded SRT asset to be the video's active playback subtitles.
// Mirrors the "Set as thumbnail" flow: the admin uploads an SRT like any other
// asset, then this endpoint makes it the canonical subtitles for the version.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> }
) {
  // 1. AUTHENTICATION + RBAC
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'projectsFullControl')
  if (forbiddenAction) return forbiddenAction

  // 2. RATE LIMITING
  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 30,
      message: 'Too many subtitle update requests. Please slow down.',
    },
    'set-asset-subtitles'
  )
  if (rateLimitResult) return rateLimitResult

  const { id: videoId, assetId } = await params

  try {
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        projectId: true,
        project: {
          select: {
            status: true,
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

    const asset = await prisma.videoAsset.findUnique({
      where: { id: assetId },
      select: { id: true, videoId: true, fileName: true, category: true },
    })

    if (!asset || asset.videoId !== videoId) {
      return NextResponse.json(
        { error: 'Asset not found or does not belong to this video' },
        { status: 404 }
      )
    }

    // Only SRT files can be promoted to subtitles.
    const fileNameLower = asset.fileName.toLowerCase()
    const isSrt =
      fileNameLower.endsWith('.srt') ||
      asset.category === 'subtitle' ||
      asset.category === 'subtitles'
    if (!isSrt) {
      return NextResponse.json(
        { error: 'Only .srt files can be set as subtitles' },
        { status: 400 }
      )
    }

    // Read the asset's SRT and parse it BEFORE mutating anything, so an
    // unreadable/empty file is rejected without leaving the video half-changed.
    const srtPath = await getStoredFilePath('VIDEO_ASSET', assetId, 'ORIGINAL')
    if (!srtPath) {
      return NextResponse.json(
        { error: 'Asset file is not ready yet. Please try again in a moment.' },
        { status: 409 }
      )
    }

    let cues
    try {
      const srtText = await streamToString(srtPath)
      cues = parseSrt(srtText)
    } catch {
      return NextResponse.json({ error: 'Could not read the subtitle file' }, { status: 400 })
    }

    if (cues.length === 0) {
      return NextResponse.json(
        { error: 'No subtitles found in this file (expected SubRip .srt format)' },
        { status: 400 }
      )
    }

    // Replace semantics: exactly one `subtitles` asset per video. Demote any
    // previous active subtitles back to a plain `subtitle` asset (kept as a
    // downloadable file the admin can re-select later), then promote this one.
    await prisma.videoAsset.updateMany({
      where: { videoId, category: 'subtitles', id: { not: assetId } },
      data: { category: 'subtitle' },
    })
    await prisma.videoAsset.update({
      where: { id: assetId },
      data: { category: 'subtitles' },
    })

    // Re-serialize SRT + playback VTT from the cues. writeCuesForVideo now finds
    // this (just-promoted) asset and regenerates both artifacts + the VTT StoredFile.
    const { cueCount } = await writeCuesForVideo(videoId, cues)

    // Surface the captions and stop auto-gen from clobbering them.
    await prisma.video.update({
      where: { id: videoId },
      data: { transcriptionStatus: 'READY', transcriptionError: null },
    })

    await Promise.allSettled([
      recalculateAndStoreProjectTotalBytes(video.projectId),
      recalculateAndStoreProjectPreviewBytes(video.projectId),
    ])

    return NextResponse.json({ success: true, cueCount })
  } catch (error) {
    console.error('Error setting asset as subtitles:', error)
    return NextResponse.json({ error: 'Failed to set subtitles' }, { status: 500 })
  }
}
