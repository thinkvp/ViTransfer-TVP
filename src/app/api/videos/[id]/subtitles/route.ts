import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/project-access'
import { rateLimit } from '@/lib/rate-limit'
import { readCuesForVideo, writeCuesForVideo, SubtitlesNotFoundError, type SubtitleEditedBy } from '@/lib/subtitle-store'
import { MAX_CUES, MAX_CUE_TEXT_LENGTH, type SubtitleCue } from '@/lib/subtitles'
import { publishProjectEvent } from '@/lib/project-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Cue-level access to a video's auto-generated subtitles.
 *
 * Auth mirrors the sibling asset routes: verifyProjectAccess covers both admin
 * JWTs and share-token sessions. Clients can read AND edit (subtitles are a
 * collaborative review artifact, like comments); only regeneration is
 * admin-only (see ./regenerate).
 */

async function resolveVideoWithAccess(request: NextRequest, videoId: string) {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: {
      id: true,
      projectId: true,
      transcriptionStatus: true,
      subtitlesEditedAt: true,
      subtitlesEditedById: true,
      subtitlesEditedByName: true,
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
  if (!accessCheck.authorized) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 403 }) }
  }
  return { video, accessCheck }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: videoId } = await params

    const limited = await rateLimit(request, { maxRequests: 120, windowMs: 60_000 }, `subtitles-read:${videoId}`)
    if (limited) return limited

    const resolved = await resolveVideoWithAccess(request, videoId)
    if ('error' in resolved) return resolved.error

    const { cues, fileName, updatedAt } = await readCuesForVideo(videoId)
    const { video, accessCheck } = resolved
    // "Last edited by" attribution for the editor header. Guests never learn
    // real names (same rule as the activity feed) — generic Admin/Client only.
    const lastEditedBy = video.subtitlesEditedAt
      ? {
          name: accessCheck.isGuest
            ? (video.subtitlesEditedById ? 'Admin' : 'Client')
            : (video.subtitlesEditedByName || (video.subtitlesEditedById ? 'Admin' : 'Client')),
          at: video.subtitlesEditedAt.toISOString(),
        }
      : null
    const response = NextResponse.json({
      cues,
      fileName,
      updatedAt,
      transcriptionStatus: video.transcriptionStatus,
      lastEditedBy,
    })
    response.headers.set('Cache-Control', 'no-store')
    return response
  } catch (error) {
    if (error instanceof SubtitlesNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    console.error('Subtitle read error:', error)
    return NextResponse.json({ error: 'Failed to load subtitles' }, { status: 500 })
  }
}

const PutBodySchema = z.object({
  cues: z
    .array(
      z.object({
        startMs: z.number().int().min(0).max(1_000_000_000),
        endMs: z.number().int().min(0).max(1_000_000_000),
        text: z.string().max(MAX_CUE_TEXT_LENGTH),
      })
    )
    .max(MAX_CUES),
  // Client identity picked on the share page (same slot comments/approvals use),
  // for "Last edited by" attribution. Ignored for admin sessions.
  recipientId: z.string().trim().max(100).nullish(),
  authorName: z.string().trim().max(120).nullish(),
})

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: videoId } = await params

    const limited = await rateLimit(request, { maxRequests: 30, windowMs: 60_000 }, `subtitles-write:${videoId}`)
    if (limited) return limited

    const resolved = await resolveVideoWithAccess(request, videoId)
    if ('error' in resolved) return resolved.error

    const parsed = PutBodySchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid cues payload' }, { status: 400 })
    }

    // Normalize server-side: drop empty/inverted cues, sort, re-index — the
    // same canonical shape parseSrt produces on read.
    const cues: SubtitleCue[] = parsed.data.cues
      .filter((c) => c.text.trim() !== '' && c.endMs >= c.startMs)
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
      .map((c, i) => ({ index: i + 1, startMs: c.startMs, endMs: c.endMs, text: c.text.trim() }))

    if (cues.length === 0) {
      return NextResponse.json({ error: 'Subtitles must contain at least one cue' }, { status: 400 })
    }

    // Resolve who is editing, for the "Last edited by" header + activity feed.
    // Mirrors the approve route: admin identity, else the recipient picked on
    // the share page (validated against this project) or the one embedded in
    // the OTP share token, falling back to the free-text authorName.
    const { video, accessCheck } = resolved
    let editedBy: SubtitleEditedBy
    if (accessCheck.isAdmin) {
      editedBy = {
        userId: accessCheck.adminUserId || null,
        recipientId: null,
        name: accessCheck.adminUserName || 'Admin',
      }
    } else {
      const candidateRecipientId =
        (parsed.data.recipientId && parsed.data.recipientId.trim()) || accessCheck.shareRecipientId || null
      let recipientId: string | null = null
      let name: string | null = null
      if (candidateRecipientId) {
        const recipient = await prisma.projectRecipient.findFirst({
          where: { id: candidateRecipientId, projectId: video.projectId },
          select: { id: true, name: true },
        })
        if (recipient) {
          recipientId = recipient.id
          name = recipient.name || null
        }
      }
      editedBy = {
        userId: null,
        recipientId,
        name: name || (parsed.data.authorName && parsed.data.authorName.trim()) || 'Client',
      }
    }

    const { cueCount } = await writeCuesForVideo(videoId, cues, { editedBy })
    // Live activity-feed refresh on open share pages / admin dashboards.
    await publishProjectEvent(video.projectId, 'video')
    const response = NextResponse.json({ ok: true, cueCount })
    response.headers.set('Cache-Control', 'no-store')
    return response
  } catch (error) {
    if (error instanceof SubtitlesNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    console.error('Subtitle write error:', error)
    return NextResponse.json({ error: 'Failed to save subtitles' }, { status: 500 })
  }
}
