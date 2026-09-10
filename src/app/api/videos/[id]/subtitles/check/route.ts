import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/project-access'
import { rateLimit } from '@/lib/rate-limit'
import { setSubtitleSignOff } from '@/lib/subtitle-store'
import { publishProjectEvent } from '@/lib/project-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Caption sign-off — "someone has read these cues".
 *
 * POST marks the current captions checked, DELETE withdraws that. Admin-only:
 * clients may edit cues (see ../route.ts) but cannot vouch for them. Sign-off
 * releases the .srt to client downloads when the Settings gate is on, and drops
 * the AUTO-DRAFT marker from the delivered filename; every later cue write
 * clears it again, because it describes exact content.
 */
async function resolveAdminAccess(request: NextRequest, videoId: string) {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: {
      id: true,
      projectId: true,
      project: { select: { id: true, sharePassword: true, authMode: true } },
    },
  })
  if (!video) return { error: NextResponse.json({ error: 'Video not found' }, { status: 404 }) }

  const accessCheck = await verifyProjectAccess(
    request,
    video.project.id,
    video.project.sharePassword,
    video.project.authMode
  )
  if (!accessCheck.authorized || !accessCheck.isAdmin) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 403 }) }
  }
  return { video, accessCheck }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: videoId } = await params

    const limited = await rateLimit(request, { maxRequests: 30, windowMs: 60_000 }, `subtitles-check:${videoId}`)
    if (limited) return limited

    const resolved = await resolveAdminAccess(request, videoId)
    if ('error' in resolved) return resolved.error
    const { video, accessCheck } = resolved

    const result = await setSubtitleSignOff(videoId, {
      userId: accessCheck.adminUserId || null,
      name: accessCheck.adminUserName || 'Admin',
    })
    if (!result) {
      return NextResponse.json({ error: 'This video has no subtitles to check' }, { status: 404 })
    }

    await publishProjectEvent(video.projectId, 'video')

    const response = NextResponse.json({
      ok: true,
      fileName: result.fileName,
      checkedBy: { name: accessCheck.adminUserName || 'Admin', at: new Date().toISOString() },
    })
    response.headers.set('Cache-Control', 'no-store')
    return response
  } catch (error) {
    console.error('Subtitle sign-off error:', error)
    return NextResponse.json({ error: 'Failed to mark subtitles checked' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: videoId } = await params

    const limited = await rateLimit(request, { maxRequests: 30, windowMs: 60_000 }, `subtitles-check:${videoId}`)
    if (limited) return limited

    const resolved = await resolveAdminAccess(request, videoId)
    if ('error' in resolved) return resolved.error
    const { video } = resolved

    const result = await setSubtitleSignOff(videoId, null)
    if (!result) {
      return NextResponse.json({ error: 'This video has no subtitles' }, { status: 404 })
    }

    await publishProjectEvent(video.projectId, 'video')

    const response = NextResponse.json({ ok: true, fileName: result.fileName })
    response.headers.set('Cache-Control', 'no-store')
    return response
  } catch (error) {
    console.error('Subtitle sign-off withdraw error:', error)
    return NextResponse.json({ error: 'Failed to withdraw the subtitle check' }, { status: 500 })
  }
}
