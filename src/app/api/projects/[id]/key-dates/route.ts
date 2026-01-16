import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { isVisibleProjectStatusForUser, requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function assertProjectAccessOr404(projectId: string, auth: any) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, status: true },
  })
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

const keyDateTypeSchema = z.enum(['PRE_PRODUCTION', 'SHOOTING', 'DUE_DATE', 'OTHER'])

const baseBodySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' }),
  allDay: z.boolean().default(false),
  startTime: z
    .union([
      z
        .string()
        .regex(/^\d{2}:\d{2}$/, { message: 'startTime must be HH:MM' }),
      z.literal(''),
      z.null(),
      z.undefined(),
    ])
    .optional(),
  finishTime: z
    .union([
      z
        .string()
        .regex(/^\d{2}:\d{2}$/, { message: 'finishTime must be HH:MM' }),
      z.literal(''),
      z.null(),
      z.undefined(),
    ])
    .optional(),
  type: keyDateTypeSchema,
  notes: z.union([z.string().max(500), z.literal(''), z.null(), z.undefined()]).optional(),
  reminderAt: z.union([z.string().datetime(), z.literal(''), z.null(), z.undefined()]).optional(),
  reminderTargets: z
    .object({
      userIds: z.array(z.string()).optional(),
      recipientIds: z.array(z.string()).optional(),
    })
    .optional(),
})

function normalizeTimes(input: z.infer<typeof baseBodySchema>) {
  const startTime = input.allDay ? null : (input.startTime || null)
  const finishTime = input.allDay ? null : (input.finishTime || null)
  const notes = (input.notes || null) as string | null
  const reminderAt = (input.reminderAt ? new Date(input.reminderAt as any) : null) as Date | null
  const reminderAtNormalized = reminderAt && !isNaN(reminderAt.getTime()) ? reminderAt : null

  const reminderTargets = (input.reminderTargets || null) as any
  const userIds = Array.isArray(reminderTargets?.userIds)
    ? reminderTargets.userIds.map(String).filter(Boolean)
    : []
  const recipientIds = Array.isArray(reminderTargets?.recipientIds)
    ? reminderTargets.recipientIds.map(String).filter(Boolean)
    : []
  const reminderTargetsNormalized = userIds.length || recipientIds.length ? ({ userIds, recipientIds } as Prisma.InputJsonValue) : undefined

  return {
    date: input.date,
    allDay: input.allDay,
    startTime,
    finishTime,
    type: input.type,
    notes,
    reminderAt: reminderAtNormalized,
    reminderTargets: reminderTargetsNormalized,
  }
}

// GET /api/projects/[id]/key-dates - list key dates (internal only)
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'accessProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'project-key-dates-list'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const rows = await prisma.projectKeyDate.findMany({
    where: { projectId },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }, { createdAt: 'asc' }],
  })

  return NextResponse.json({ keyDates: rows })
}

// POST /api/projects/[id]/key-dates - create key date (internal only)
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'projects')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'project-key-dates-create'
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = baseBodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const normalized = normalizeTimes(parsed.data)

  if (normalized.reminderAt && normalized.reminderAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: 'Reminder must be set to a future date and time' }, { status: 400 })
  }

  const created = await prisma.projectKeyDate.create({
    data: {
      projectId,
      ...normalized,
    },
  })

  return NextResponse.json({ keyDate: created }, { status: 201 })
}
