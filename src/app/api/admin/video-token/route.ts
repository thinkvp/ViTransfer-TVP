import { NextRequest, NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/auth'
import { generateVideoAccessToken } from '@/lib/video-access'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireAnyActionAccess } from '@/lib/rbac-api'
import { getStoredFileRecords } from '@/lib/stored-file'
import { getDirectStreamUrl, hlsStreamingEnabled, buildHlsMasterUrl, hlsAbrReady } from '@/lib/video-stream-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function canIssueAdminVideoToken(
  storedRoles: Set<string>,
  quality: string,
): boolean {
  const canUseOriginal = storedRoles.has('ORIGINAL')

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
      return canUseOriginal
    default:
      return false
  }
}

/**
 * Admin Video Token Generation Endpoint
 *
 * Generates video access tokens for admin users to stream/download videos
 * Admins bypass normal share authentication but still need tokens for content delivery
 */
export async function GET(request: NextRequest) {
  // Check authentication
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) {
    return authResult
  }

  const forbiddenAction = requireAnyActionAccess(authResult, ['accessSharePage', 'uploadVideosOnProjects', 'manageProjectAlbums', 'accessProjectSettings'])
  if (forbiddenAction) return forbiddenAction

  // Rate limiting: Allow generous limit for token generation
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 200,
    message: 'Too many token generation requests. Please slow down.'
  }, 'admin-video-token')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const { searchParams } = new URL(request.url)
    const videoId = searchParams.get('videoId')
    const projectId = searchParams.get('projectId')
    const quality = searchParams.get('quality')
    const sessionId = searchParams.get('sessionId')

    if (!videoId || !projectId || !quality || !sessionId) {
      return NextResponse.json(
        { error: 'Missing required parameters' },
        { status: 400 }
      )
    }

    // Verify video belongs to project
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        projectId: true,
        hlsVersion: true,
      }
    })

    if (!video || video.projectId !== projectId) {
      return NextResponse.json(
        { error: 'Video not found or does not belong to project' },
        { status: 404 }
      )
    }

    // Resolve available file roles + paths from StoredFile registry. Roles gate which
    // qualities may be issued; paths let us mint a direct-to-R2 stream URL (Option B).
    const storedFiles = await getStoredFileRecords('VIDEO', [videoId], {
      select: { fileRole: true, storagePath: true },
    })
    const storedRoles = new Set(storedFiles.map(f => f.fileRole))
    const storedPaths = new Map(storedFiles.map(f => [f.fileRole, f.storagePath]))

    if (!canIssueAdminVideoToken(storedRoles, quality)) {
      return NextResponse.json({ error: `${quality} unavailable` }, { status: 404 })
    }

    if (authResult.appRoleIsSystemAdmin !== true) {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { status: true, assignedUsers: { select: { userId: true } } },
      })
      if (!project) {
        return NextResponse.json(
          { error: 'Project not found' },
          { status: 404 }
        )
      }

      const assigned = project.assignedUsers?.some((u) => u.userId === authResult.id)
      if (!assigned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

      if (!isVisibleProjectStatusForUser(authResult, project.status)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    // Generate video access token
    const token = await generateVideoAccessToken(
      videoId,
      projectId,
      quality,
      request,
      sessionId
    )

    // Option B: in S3 mode, also hand back a presigned R2 URL for direct streaming
    // (bypasses the /api/content 302 redirect). Admins can serve the original, so it's a
    // valid fallback whenever ORIGINAL exists. Null for local mode / non-stream qualities;
    // the client then falls back to the token-gated /api/content URL.
    const streamUrl = await getDirectStreamUrl({
      storedPaths,
      quality,
      canServeOriginal: storedRoles.has('ORIGINAL'),
      sessionId,
      videoId,
    }).catch(() => null)

    // HLS (proxy-robust segmented) URL — same-origin, token-scoped master playlist.
    // Per-video; offered only when packaging exists and HLS is enabled.
    let hlsUrl = ''
    let hlsAbr = false
    if (hlsStreamingEnabled() && storedRoles.has('HLS_PLAYLIST')) {
      const hlsToken = await generateVideoAccessToken(videoId, projectId, 'hls', request, sessionId).catch(() => '')
      if (hlsToken) {
        hlsUrl = buildHlsMasterUrl(hlsToken)
        hlsAbr = hlsAbrReady(video.hlsVersion)
      }
    }

    const response = NextResponse.json({ token, streamUrl, hlsUrl, hlsAbr })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('[API] Failed to generate admin video token:', error)
    return NextResponse.json(
      { error: 'Failed to generate token' },
      { status: 500 }
    )
  }
}
