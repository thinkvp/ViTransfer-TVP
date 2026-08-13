import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { getCurrentUserFromRequest } from '@/lib/auth'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'
import { publishProjectEvent } from '@/lib/project-events'
import {
  buildReactionSummaries,
  isAllowedReactionEmoji,
  type CommentReactionSummary,
} from '@/lib/comment-reactions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Emoji reactions on a comment (top-level or reply).
 *
 * POST   /api/comments/[id]/reactions        body: { emoji, recipientId? }  -> add
 * DELETE /api/comments/[id]/reactions?emoji= -> remove
 *
 * Both verbs are idempotent rather than a single toggle: a double-click or a retry then
 * lands on the same end state instead of flipping it back, and the client already knows
 * which direction it wants from `viewerReacted`.
 *
 * Guard chain mirrors /api/comments/[id] (rate limit -> hideFeedback -> verifyProjectAccess
 * -> guest reject -> permission -> lock), with one deliberate difference: the reactor's
 * recipient id is resolved server-side. The comment routes accept a body-supplied
 * recipientId because there it is only an attribution label, but here it is the uniqueness
 * key, so trusting the body would let a viewer inflate counts by cycling ids or fake
 * another recipient's reaction.
 */

const RATE_LIMIT = { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' }

type ReactionContext =
  | { ok: true; commentId: string; projectId: string; userId: string | null; recipientId: string | null; isAdmin: boolean }
  | { ok: false; response: NextResponse }

async function resolveReactionContext(
  request: NextRequest,
  commentId: string,
  bodyRecipientId?: unknown,
): Promise<ReactionContext> {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: {
      id: true,
      isInternal: true,
      lockedAt: true,
      projectId: true,
      project: {
        select: {
          id: true,
          sharePassword: true,
          authMode: true,
          hideFeedback: true,
          allowClientReactions: true,
        },
      },
    },
  })

  if (!comment) {
    return { ok: false, response: NextResponse.json({ error: 'Comment not found' }, { status: 404 }) }
  }

  if (comment.project.hideFeedback) {
    return { ok: false, response: NextResponse.json({ error: 'Comments are disabled for this project' }, { status: 403 }) }
  }

  const accessCheck = await verifyProjectAccess(
    request,
    comment.project.id,
    comment.project.sharePassword,
    comment.project.authMode,
  )

  if (accessCheck.isGuest) {
    return { ok: false, response: NextResponse.json({ error: 'Reactions are disabled for guest users' }, { status: 403 }) }
  }

  if (!accessCheck.authorized) {
    // Match the sibling routes: don't confirm the comment exists.
    return { ok: false, response: NextResponse.json({ error: 'Unable to process request' }, { status: 400 }) }
  }

  if (accessCheck.isAdmin) {
    const currentUser = await getCurrentUserFromRequest(request)
    if (!currentUser) {
      return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
    }

    // Reacting is comment participation, not moderation, so it takes the lighter
    // makeCommentsOnProjects action rather than manageSharePageComments.
    if (currentUser.appRoleIsSystemAdmin !== true) {
      const permissions = normalizeRolePermissions(currentUser?.permissions)
      if (!canDoAction(permissions, 'makeCommentsOnProjects')) {
        return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
      }
    }

    return {
      ok: true,
      commentId: comment.id,
      projectId: comment.projectId,
      userId: currentUser.id,
      recipientId: null,
      isAdmin: true,
    }
  }

  // --- Share session (client) ---

  // Internal comments are filtered out of client responses entirely; this is the
  // server-side backstop against a hand-crafted request.
  if (comment.isInternal) {
    return { ok: false, response: NextResponse.json({ error: 'Unable to process request' }, { status: 400 }) }
  }

  if (!comment.project.allowClientReactions) {
    return { ok: false, response: NextResponse.json({ error: 'Reactions are disabled for this project' }, { status: 403 }) }
  }

  // Locked comments (next version requested) are frozen for share sessions, consistent
  // with edit/delete. Admins are unaffected.
  if (comment.lockedAt) {
    return { ok: false, response: NextResponse.json({ error: 'This comment is locked because the next version was requested' }, { status: 403 }) }
  }

  // Trust the session's recipient first. A body-supplied id is only honoured after
  // confirming it belongs to this project — the share page sends one because a viewer can
  // pick their identity after the token was issued.
  let recipientId = accessCheck.shareRecipientId || null
  if (!recipientId && typeof bodyRecipientId === 'string' && bodyRecipientId.trim()) {
    const recipient = await prisma.projectRecipient.findFirst({
      where: { id: bodyRecipientId.trim(), projectId: comment.projectId },
      select: { id: true },
    })
    recipientId = recipient?.id || null
  }

  if (!recipientId) {
    // The share page turns this into its "who are you?" identity prompt rather than an error.
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Select your name before reacting', code: 'RECIPIENT_REQUIRED' },
        { status: 403 },
      ),
    }
  }

  return {
    ok: true,
    commentId: comment.id,
    projectId: comment.projectId,
    userId: null,
    recipientId,
    isAdmin: false,
  }
}

async function currentReactions(
  commentId: string,
  viewer: { userId: string | null; recipientId: string | null },
): Promise<CommentReactionSummary[]> {
  const rows = await prisma.commentReaction.findMany({
    where: { commentId },
    select: {
      commentId: true,
      emoji: true,
      userId: true,
      recipientId: true,
      user: { select: { name: true, email: true } },
      recipient: { select: { name: true, email: true } },
    },
  })

  // Anyone who reaches this route is either an admin or a share session holding a valid
  // token bound to a recipient — i.e. always in the audience that may see reactor names.
  // Anonymous viewers can't get here at all (they're rejected with RECIPIENT_REQUIRED).
  return buildReactionSummaries(rows, viewer, true).get(commentId) || []
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rateLimitResult = await rateLimit(request, RATE_LIMIT, 'comment-reactions')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const emoji = (body as any)?.emoji

    if (!isAllowedReactionEmoji(emoji)) {
      return NextResponse.json({ error: 'Unsupported reaction' }, { status: 400 })
    }

    const context = await resolveReactionContext(request, id, (body as any)?.recipientId)
    if (!context.ok) return context.response

    try {
      await prisma.commentReaction.create({
        data: {
          commentId: context.commentId,
          emoji,
          userId: context.userId,
          recipientId: context.recipientId,
        },
      })
    } catch (error: any) {
      // P2002 = the identity already reacted with this emoji. Idempotent by design.
      if (error?.code !== 'P2002') throw error
    }

    await publishProjectEvent(context.projectId, 'comment')

    return NextResponse.json(
      { reactions: await currentReactions(context.commentId, context) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch {
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rateLimitResult = await rateLimit(request, RATE_LIMIT, 'comment-reactions')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id } = await params
    // Query param rather than a DELETE body: intermediaries are allowed to drop the latter.
    const emoji = request.nextUrl.searchParams.get('emoji')

    if (!isAllowedReactionEmoji(emoji)) {
      return NextResponse.json({ error: 'Unsupported reaction' }, { status: 400 })
    }

    const context = await resolveReactionContext(request, id, request.nextUrl.searchParams.get('recipientId'))
    if (!context.ok) return context.response

    // Scoped to the caller's own identity — a viewer can never clear someone else's
    // reaction, including admins, who have no moderation path here by design.
    await prisma.commentReaction.deleteMany({
      where: {
        commentId: context.commentId,
        emoji,
        ...(context.userId ? { userId: context.userId } : { recipientId: context.recipientId }),
      },
    })

    await publishProjectEvent(context.projectId, 'comment')

    return NextResponse.json(
      { reactions: await currentReactions(context.commentId, context) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch {
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
