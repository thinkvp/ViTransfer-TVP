import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiAction } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { validateRequest } from '@/lib/validation'
import { isVisibleProjectStatusForUser } from '@/lib/rbac-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const resolveFeedbackSchema = z.object({
  resolved: z.boolean(),
  projectId: z.string().min(1),
  // Scope selectors (most specific wins):
  //  - commentId        → toggle a single comment
  //  - videoIds[]       → toggle every comment on those video rows (one row per version)
  //  - neither          → toggle every comment in the project
  commentId: z.string().min(1).optional(),
  videoIds: z.array(z.string().min(1)).max(500).optional(),
})

/**
 * POST /api/admin/feedback/resolve
 * Mark feedback comments done / not-done. Powers both the admin Projects "Feedback"
 * task list and the green tick on the admin share page.
 */
export async function POST(request: NextRequest) {
  const auth = await requireApiAction(request, 'manageSharePageComments')
  if (auth instanceof Response) return auth
  const user = auth

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: 'Too many requests. Please slow down.',
  }, 'feedback-resolve', user.id)
  if (rateLimitResult) return rateLimitResult

  try {
    const body = await request.json()
    const validation = validateRequest(resolveFeedbackSchema, body)
    if (!validation.success) {
      return NextResponse.json(
        { error: validation.error, details: validation.details },
        { status: 400 }
      )
    }

    const { resolved, projectId, commentId, videoIds } = validation.data

    // Enforce project assignment + status visibility for non-system-admins.
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        status: true,
        assignedUsers: { select: { userId: true } },
      },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    if (user.appRoleIsSystemAdmin !== true) {
      const isAssigned = project.assignedUsers.some((u) => u.userId === user.id)
      if (!isAssigned || !isVisibleProjectStatusForUser(user, project.status)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    // Build the scope. projectId is always part of the filter so a stray
    // commentId/videoId cannot touch another project's comments.
    const where: { projectId: string; id?: string; videoId?: { in: string[] } } = { projectId }
    if (commentId) {
      where.id = commentId
    } else if (videoIds && videoIds.length > 0) {
      where.videoId = { in: videoIds }
    }

    const result = await prisma.comment.updateMany({
      where,
      data: {
        resolvedAt: resolved ? new Date() : null,
        resolvedById: resolved ? user.id : null,
      },
    })

    return NextResponse.json(
      { success: true, count: result.count },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (error) {
    console.error('[FEEDBACK-RESOLVE] Error:', error)
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}
