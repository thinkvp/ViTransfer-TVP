import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getShareContext } from '@/lib/auth'
import { generateVideoAccessToken } from '@/lib/video-access'
import { rateLimit } from '@/lib/rate-limit'
import { getStoredFileRecords } from '@/lib/stored-file'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function canIssueShareVideoToken(
  storedRoles: Set<string>,
  approved: boolean,
  quality: string,
): boolean {
  const canUseOriginal = approved

  switch (quality) {
    case '480p':
      return storedRoles.has('PREVIEW_480') || storedRoles.has('PREVIEW_720') || storedRoles.has('PREVIEW_1080') || canUseOriginal
    case '720p':
      return storedRoles.has('PREVIEW_720') || storedRoles.has('PREVIEW_1080') || storedRoles.has('PREVIEW_480') || canUseOriginal
    case '1080p':
      return storedRoles.has('PREVIEW_1080') || storedRoles.has('PREVIEW_720') || storedRoles.has('PREVIEW_480') || canUseOriginal
    case 'thumbnail':
      return storedRoles.has('THUMBNAIL')
    case 'timeline-vtt':
      return storedRoles.has('TIMELINE_VTT')
    case 'timeline-sprite':
      return storedRoles.has('TIMELINE_SPRITES')
    case 'original':
    case 'download':
      return canUseOriginal && storedRoles.has('ORIGINAL')
    default:
      return false
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const url = new URL(request.url)
  const videoId = url.searchParams.get('videoId')
  const quality = url.searchParams.get('quality') || '720p'

  if (!videoId) {
    return NextResponse.json({ error: 'videoId is required' }, { status: 400 })
  }

  const shareContext = await getShareContext(request)
  if (!shareContext) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const limited = await rateLimit(request, { maxRequests: 120, windowMs: 60_000 }, 'share-video-token')
  if (limited) return limited

  let project: { id: string; slug: string; enableVideos: boolean | null } | null
  let video: { id: string; projectId: string; approved: boolean } | null
  let storedRoles = new Set<string>()
  try {
    project = await prisma.project.findUnique({
      where: { id: shareContext.projectId },
      select: { id: true, slug: true, enableVideos: true },
    })

    if (!project || project.slug !== token) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    if (project.enableVideos === false) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    video = await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        projectId: true,
        approved: true,
      },
    })

    if (!video || video.projectId !== project.id) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    // Resolve available file roles from StoredFile registry
    const storedFiles = await getStoredFileRecords('VIDEO', [videoId], {
      select: { fileRole: true },
    })
    storedRoles = new Set(storedFiles.map(f => f.fileRole))
  } catch (error) {
    console.error('[SHARE] Failed to load project/video:', error)
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 })
  }

  if (!canIssueShareVideoToken(storedRoles, video!.approved, quality)) {
    return NextResponse.json({ error: `${quality} unavailable` }, { status: quality === 'original' ? 403 : 404 })
  }

  const sessionId = shareContext.sessionId || `share:${project!.id}:${token}`

  try {
    const tokenValue = await generateVideoAccessToken(
      video!.id,
      project!.id,
      quality,
      request,
      sessionId
    )

    const response = NextResponse.json({ token: tokenValue })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('[SHARE] Failed to generate video token', { videoId, quality, error })
    return NextResponse.json({ error: 'Failed to generate token' }, { status: 500 })
  }
}
