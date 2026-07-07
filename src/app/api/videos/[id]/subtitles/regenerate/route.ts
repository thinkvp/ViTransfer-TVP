import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/project-access'
import { rateLimit } from '@/lib/rate-limit'
import { enqueueVideoSubtitles } from '@/lib/queue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Re-run Whisper transcription for a video, overwriting any manual cue edits
 * (the UI confirms before calling). Admin-only — clients can edit cues but not
 * discard them wholesale.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: videoId } = await params

    const limited = await rateLimit(request, { maxRequests: 10, windowMs: 60_000 }, `subtitles-regenerate:${videoId}`)
    if (limited) return limited

    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        status: true,
        project: { select: { id: true, sharePassword: true, authMode: true } },
      },
    })
    if (!video) return NextResponse.json({ error: 'Video not found' }, { status: 404 })

    const accessCheck = await verifyProjectAccess(
      request,
      video.project.id,
      video.project.sharePassword,
      video.project.authMode
    )
    if (!accessCheck.authorized || !accessCheck.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    if (video.status !== 'READY') {
      return NextResponse.json({ error: 'Video is not ready for transcription' }, { status: 409 })
    }

    const enqueued = await enqueueVideoSubtitles(videoId, { force: true })
    if (!enqueued) {
      return NextResponse.json(
        { error: 'Transcription is not enabled — configure Whisper in Settings first' },
        { status: 409 }
      )
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Subtitle regenerate error:', error)
    return NextResponse.json({ error: 'Failed to queue transcription' }, { status: 500 })
  }
}
