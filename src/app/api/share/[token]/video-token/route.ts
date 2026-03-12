import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getShareContext } from '@/lib/auth'
import { generateVideoAccessToken } from '@/lib/video-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function canIssueShareVideoToken(
  video: {
    approved: boolean
    originalStoragePath: string | null
    thumbnailPath: string | null
    preview480Path: string | null
    preview720Path: string | null
    preview1080Path: string | null
    timelinePreviewVttPath: string | null
    timelinePreviewSpritesPath: string | null
  },
  quality: string,
): boolean {
  const canUseOriginal = Boolean(video.originalStoragePath && video.approved)

  switch (quality) {
    case '480p':
      return Boolean(video.preview480Path || video.preview720Path || video.preview1080Path || canUseOriginal)
    case '720p':
      return Boolean(video.preview720Path || video.preview1080Path || video.preview480Path || canUseOriginal)
    case '1080p':
      return Boolean(video.preview1080Path || video.preview720Path || video.preview480Path || canUseOriginal)
    case 'thumbnail':
      return Boolean(video.thumbnailPath)
    case 'timeline-vtt':
      return Boolean(video.timelinePreviewVttPath)
    case 'timeline-sprite':
      return Boolean(video.timelinePreviewSpritesPath)
    case 'original':
    case 'download':
      return canUseOriginal
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

  const project = await prisma.project.findUnique({
    where: { id: shareContext.projectId },
    select: { id: true, slug: true, enableVideos: true },
  })

  if (!project || project.slug !== token) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  if (project.enableVideos === false) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 })
  }

  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: {
      id: true,
      projectId: true,
      approved: true,
      originalStoragePath: true,
      thumbnailPath: true,
      preview480Path: true,
      preview720Path: true,
      preview1080Path: true,
      timelinePreviewVttPath: true,
      timelinePreviewSpritesPath: true,
    },
  })

  if (!video || video.projectId !== project.id) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 })
  }

  if (!canIssueShareVideoToken(video, quality)) {
    return NextResponse.json({ error: `${quality} unavailable` }, { status: quality === 'original' ? 403 : 404 })
  }

  const sessionId = shareContext.sessionId || `share:${project.id}:${token}`

  try {
    const tokenValue = await generateVideoAccessToken(
      video.id,
      project.id,
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
