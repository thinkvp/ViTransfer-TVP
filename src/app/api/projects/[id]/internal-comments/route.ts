import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUserFromRequest, requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { contentSchema } from '@/lib/validation'
import { getSafeguardLimits } from '@/lib/settings'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createInternalCommentSchema = z.object({
  content: contentSchema,
  parentId: z.string().regex(/^c[a-z0-9]{24}$/).optional().nullable(),
})

async function assertProjectAccessOr404(projectId: string, auth: any) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, status: true } })
  if (!project) return null

  if (!isVisibleProjectStatusForUser(auth, project.status)) return null

  if (auth.appRoleIsSystemAdmin !== true) {
    const assignment = await prisma.projectUser.findUnique({
      where: {
        projectId_userId: {
          projectId: project.id,
          userId: auth.id,
        },
      },
      select: { projectId: true },
    })
    if (!assignment) return null
  }

  return project
}

function serializeComment(comment: any) {
  return {
    id: comment.id,
    projectId: comment.projectId,
    userId: comment.userId,
    parentId: comment.parentId,
    content: comment.content,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    authorName:
      comment?.user?.name ||
      comment?.user?.email ||
      comment?.authorNameSnapshot ||
      'Unknown',
    displayColor:
      comment?.user?.displayColor ||
      comment?.displayColorSnapshot ||
      null,
    replies: Array.isArray(comment.replies) ? comment.replies.map(serializeComment) : [],
  }
}

// GET /api/projects/[id]/internal-comments
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'project-internal-comments-list'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const comments = await prisma.projectInternalComment.findMany({
    where: { projectId, parentId: null },
    include: {
      user: { select: { id: true, name: true, email: true, displayColor: true } },
      replies: {
        include: {
          user: { select: { id: true, name: true, email: true, displayColor: true } },
          replies: {
            include: {
              user: { select: { id: true, name: true, email: true, displayColor: true } },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  return NextResponse.json(comments.map(serializeComment))
}

// POST /api/projects/[id]/internal-comments
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'makeCommentsOnProjects')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'project-internal-comment-create'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const currentUser = await getCurrentUserFromRequest(request)
  if (!currentUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const parsed = createInternalCommentSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.issues }, { status: 400 })
  }

  // If replying, ensure parent exists and belongs to this project.
  const parentId = parsed.data.parentId || null
  if (parentId) {
    const parent = await prisma.projectInternalComment.findUnique({
      where: { id: parentId },
      select: { id: true, projectId: true, parentId: true },
    })
    if (!parent || parent.projectId !== projectId) {
      return NextResponse.json({ error: 'Invalid parent comment' }, { status: 400 })
    }

    // Only allow one level of nesting: replies must target a top-level comment.
    if (parent.parentId) {
      return NextResponse.json({ error: 'Replies can only be made to the original comment' }, { status: 400 })
    }
  }

  const { maxInternalCommentsPerProject } = await getSafeguardLimits()
  const existingCount = await prisma.projectInternalComment.count({ where: { projectId } })
  if (existingCount >= maxInternalCommentsPerProject) {
    return NextResponse.json(
      { error: `Maximum internal comments (${maxInternalCommentsPerProject}) reached for this project` },
      { status: 400 }
    )
  }

  const created = await prisma.projectInternalComment.create({
    data: {
      projectId,
      userId: currentUser.id,
      authorNameSnapshot: currentUser.name || currentUser.email,
      displayColorSnapshot: (currentUser as any).displayColor || null,
      content: parsed.data.content,
      parentId,
    },
    include: {
      user: { select: { id: true, name: true, email: true, displayColor: true } },
      replies: {
        include: {
          user: { select: { id: true, name: true, email: true, displayColor: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  })

  // Queue for internal-comment summary emails (sent by worker on admin schedule)
  try {
    await prisma.notificationQueue.create({
      data: {
        projectId,
        type: 'INTERNAL_COMMENT',
        // Internal comments are never client-facing.
        sentToClients: true,
        data: {
          type: 'INTERNAL_COMMENT',
          internalCommentId: created.id,
          authorName: currentUser.name || currentUser.email,
          authorEmail: currentUser.email,
          content: created.content,
          parentId,
        },
      },
    })
  } catch (e) {
    console.error('[INTERNAL COMMENTS] Failed to queue notification:', e)
  }

  return NextResponse.json(serializeComment({ ...created, replies: created.replies || [] }))
}

// DELETE /api/projects/[id]/internal-comments (admin/system-admin only)
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  // Only system admins can bulk-delete internal comments.
  if (authResult.appRoleIsSystemAdmin !== true) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 10, message: 'Too many requests. Please slow down.' },
    'project-internal-comments-clear'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  await prisma.projectInternalComment.deleteMany({ where: { projectId } })

  return NextResponse.json({ ok: true })
}
