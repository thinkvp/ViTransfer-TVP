import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getShareContext } from '@/lib/auth'
import { generateVideoAccessToken } from '@/lib/video-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

  if (quality === '480p' && !(video as any).preview480Path) {
    return NextResponse.json({ error: '480p preview unavailable' }, { status: 404 })
  }
  if (quality === '720p' && !video.preview720Path) {
    return NextResponse.json({ error: '720p preview unavailable' }, { status: 404 })
  }
  if (quality === '1080p' && !video.preview1080Path) {
    return NextResponse.json({ error: '1080p preview unavailable' }, { status: 404 })
  }
  if (quality === 'thumbnail' && !video.thumbnailPath) {
    return NextResponse.json({ error: 'Thumbnail unavailable' }, { status: 404 })
  }
  if (quality === 'timeline-vtt' && !video.timelinePreviewVttPath) {
    return NextResponse.json({ error: 'Timeline VTT unavailable' }, { status: 404 })
  }
  if (quality === 'timeline-sprite' && !video.timelinePreviewSpritesPath) {
    return NextResponse.json({ error: 'Timeline sprite unavailable' }, { status: 404 })
  }

  if (quality === 'original' && !video.approved) {
    return NextResponse.json({ error: 'Original quality unavailable' }, { status: 403 })
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
