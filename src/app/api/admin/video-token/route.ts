import { NextRequest, NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/auth'
import { generateVideoAccessToken } from '@/lib/video-access'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireAnyActionAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
      select: { id: true, projectId: true }
    })

    if (!video || video.projectId !== projectId) {
      return NextResponse.json(
        { error: 'Video not found or does not belong to project' },
        { status: 404 }
      )
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

    const response = NextResponse.json({ token })
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
