import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { handleRevisionRequestNotification } from '@/lib/notifications'
import { verifyProjectAccess } from '@/lib/project-access'
import { rateLimit } from '@/lib/rate-limit'
import { publishProjectEvent } from '@/lib/project-events'
import { z } from 'zod'
export const runtime = 'nodejs'

const requestNextVersionSchema = z.object({
  authorName: z.string().trim().max(100, 'Name too long').optional().nullable(),
  selectedVideoId: z.string().min(1, 'Selected video is required'),
  recipientId: z.string().trim().max(64).optional().nullable(),
})

/**
 * Client "Request Next Version": marks the selected video version as Reviewed on the
 * share page (one-shot per version) and locks the client-visible comments on it so
 * they can no longer be deleted/edited by share sessions. Does NOT touch the
 * project-level status (unrelated to ProjectStatus.REVIEWED).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 20,
    message: 'Too many requests. Please slow down.'
  }, 'project-request-next-version')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const { id: projectId } = await params
    const body = await request.json()
    const parsed = requestNextVersionSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 })
    }

    const { authorName, selectedVideoId, recipientId } = parsed.data

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        videos: true,
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Dual auth pattern: clients request the next version via the share link
    const accessCheck = await verifyProjectAccess(request, project.id, project.sharePassword, project.authMode)

    if (!accessCheck.authorized) {
      return NextResponse.json({
        error: 'Password required to request the next version'
      }, { status: 401 })
    }

    // Guest-video links are view-only
    if (accessCheck.isGuest) {
      return NextResponse.json({ error: 'Guests cannot request a new version' }, { status: 403 })
    }

    if (project.status === 'APPROVED') {
      return NextResponse.json({ error: 'Project already approved' }, { status: 400 })
    }

    const selectedVideo = project.videos.find(v => v.id === selectedVideoId)

    if (!selectedVideo) {
      return NextResponse.json({ error: 'Selected video not found' }, { status: 404 })
    }

    // A version of this video is already approved — approval wins over revision requests
    const groupApproved = project.videos.some(v => v.name === selectedVideo.name && v.approved)
    if (groupApproved) {
      return NextResponse.json({ error: 'This video already has an approved version' }, { status: 400 })
    }

    // Only the latest version can lodge the request. Versions still processing don't
    // count as newer — the client can't see them yet.
    const newerVersionExists = project.videos.some(v =>
      v.name === selectedVideo.name && v.status === 'READY' && v.version > selectedVideo.version
    )
    if (newerVersionExists) {
      return NextResponse.json({ error: 'A newer version of this video already exists' }, { status: 400 })
    }

    // One-shot per version: idempotent success without re-locking or re-notifying
    // (retry, double-click, or simultaneous sessions).
    if (selectedVideo.revisionRequestedAt) {
      return NextResponse.json({ message: 'Next version already requested' })
    }

    // Server-side mirror of the button-visibility rule: the request must carry feedback.
    const clientCommentCount = await prisma.comment.count({
      where: { videoId: selectedVideoId, isInternal: false },
    })
    if (clientCommentCount === 0) {
      return NextResponse.json({ error: 'Add feedback before requesting the next version' }, { status: 400 })
    }

    // Resolve who is requesting, for activity-feed attribution (mirrors the approve route).
    let revisionRequestedById: string | null = null
    let revisionRequestedByRecipientId: string | null = null
    let revisionRequestedByName: string | null = null
    if (accessCheck.isAdmin) {
      revisionRequestedById = accessCheck.adminUserId || null
      revisionRequestedByName = accessCheck.adminUserName || 'Admin'
    } else {
      const candidateRecipientId = (recipientId && recipientId.trim()) || accessCheck.shareRecipientId || null
      if (candidateRecipientId) {
        const recipient = await prisma.projectRecipient.findFirst({
          where: { id: candidateRecipientId, projectId },
          select: { id: true, name: true },
        })
        if (recipient) {
          revisionRequestedByRecipientId = recipient.id
          revisionRequestedByName = recipient.name || null
        }
      }
      if (!revisionRequestedByName) revisionRequestedByName = (authorName && authorName.trim()) || 'Client'
    }

    const now = new Date()
    await prisma.$transaction([
      prisma.video.update({
        where: { id: selectedVideoId },
        data: {
          revisionRequestedAt: now,
          revisionRequestedById,
          revisionRequestedByRecipientId,
          revisionRequestedByName,
        },
      }),
      // Lock the feedback that was submitted with this request. Replies carry the same
      // videoId, so they lock too. Comments added after this stay unlocked/deletable.
      prisma.comment.updateMany({
        where: { videoId: selectedVideoId, isInternal: false, lockedAt: null },
        data: { lockedAt: now },
      }),
    ])

    try {
      await handleRevisionRequestNotification({
        project: { id: project.id, title: project.title },
        video: {
          id: selectedVideo.id,
          name: selectedVideo.name,
          version: selectedVideo.version,
          versionLabel: selectedVideo.versionLabel ?? null,
        },
        authorName: revisionRequestedByName,
        performedByAdmin: accessCheck.isAdmin,
      })
    } catch (error) {
      console.error('[REVISION-REQUEST] Error handling notifications:', error)
    }

    // Live-update open share pages / admin dashboards (badge + comment locks).
    await publishProjectEvent(projectId, 'approval')

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[REVISION-REQUEST] ERROR in request-next-version route:', error)
    return NextResponse.json({ error: 'Failed to request next version' }, { status: 500 })
  }
}
