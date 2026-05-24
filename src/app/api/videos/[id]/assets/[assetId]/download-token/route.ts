import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/project-access'
import { generateVideoAccessToken } from '@/lib/video-access'
import { rateLimit } from '@/lib/rate-limit'

/**
 * Generate a temporary download token for asset downloads (admins and share users)
 * This allows using window.open() without loading files into browser memory
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> }
) {
  try {
    const { id: videoId, assetId } = await params

    const limited = await rateLimit(
      request,
      { maxRequests: 240, windowMs: 60_000 },
      `asset-download-token:${videoId}`
    )
    if (limited) return limited

    // Get asset with video and project info
    const asset = await prisma.videoAsset.findUnique({
      where: { id: assetId },
      include: {
        video: {
          include: {
            project: true,
          },
        },
      },
    })

    if (!asset || asset.videoId !== videoId) {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
    }

    const project = asset.video.project
    const normalizedFileType = typeof asset.fileType === 'string' ? asset.fileType.toLowerCase() : ''
    const isPreviewableImage = normalizedFileType.startsWith('image/')
    const isPreviewableVideo = normalizedFileType.startsWith('video/')
    const isAudioAsset = normalizedFileType.startsWith('audio/')
    const hasReadyGeneratedPlaybackPreview =
      asset.previewStatus === 'READY'
      && typeof asset.previewPath === 'string'
      && asset.previewPath.length > 0
      && asset.previewPath.toLowerCase().endsWith('.mp4')
    const hasReadyGeneratedPreview =
      asset.previewStatus === 'READY'
      && typeof asset.previewPath === 'string'
      && asset.previewPath.length > 0

    // Verify user has access to this project
    const accessCheck = await verifyProjectAccess(
      request,
      project.id,
      project.sharePassword,
      project.authMode
    )

    if (!accessCheck.authorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    // Check download permissions for non-admins
    if (!accessCheck.isAdmin) {
      if (!asset.video.approved) {
        return NextResponse.json(
          { error: 'Assets are only available for approved videos' },
          { status: 403 }
        )
      }
    }

    // Generate video access token (we use video access tokens for assets too); tag admin sessions.
    // Use a dedicated cache key ('asset-download') and a generous 2-hour TTL so that large
    // file downloads on slow connections aren't interrupted by the normal session timeout.
    const DOWNLOAD_TOKEN_TTL = 2 * 60 * 60 // 2 hours
    const sessionId = accessCheck.shareTokenSessionId || (accessCheck.isAdmin ? `admin:${Date.now()}` : `guest:${Date.now()}`)
    const token = await generateVideoAccessToken(
      videoId,
      project.id,
      'asset-download',
      request,
      sessionId,
      DOWNLOAD_TOKEN_TTL
    )

    const inlineAssetUrl = `/api/content/${token}?assetId=${assetId}`
    const directAssetUrl = `${inlineAssetUrl}&download=true`
    const previewUrl = (isPreviewableImage || isPreviewableVideo) && hasReadyGeneratedPreview
      ? `/api/content/${token}?assetId=${assetId}&assetPreview=1`
      : null

    const playbackUrl = isPreviewableVideo
      ? (hasReadyGeneratedPlaybackPreview
          ? `/api/content/${token}?assetId=${assetId}&assetPlayback=1`
          : inlineAssetUrl)
      : (isAudioAsset ? inlineAssetUrl : null)

    // Return download URL with asset ID parameter
    const response = NextResponse.json({
      url: directAssetUrl,
      ...(previewUrl ? { previewUrl } : {}),
      ...(playbackUrl ? { playbackUrl } : {}),
    })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('Asset download token generation error:', error)
    return NextResponse.json(
      { error: 'Failed to generate download link' },
      { status: 500 }
    )
  }
}
