import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { requireActionAccess } from '@/lib/rbac-api'
import { rateLimit } from '@/lib/rate-limit'
import { assertProjectAccessOr404 } from '@/lib/gantt/access'
import { materializeTemplate } from '@/lib/gantt/template'
import { isValidISODate } from '@/lib/gantt/dates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const isoDate = z.string().refine(isValidISODate, { message: 'Dates must be YYYY-MM-DD' })

const createSchema = z.object({
  anchorDate: isoDate,
  includeWeekends: z.boolean().default(false),
  fromTemplate: z.boolean().default(true),
})

const patchSchema = z.object({
  title: z.union([z.string().trim().max(200), z.literal(''), z.null()]).optional(),
  includeWeekends: z.boolean().optional(),
})

const scheduleInclude = {
  phases: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      tasks: { orderBy: { sortOrder: 'asc' as const } },
    },
  },
}

function noStore(res: NextResponse) {
  res.headers.set('Cache-Control', 'no-store')
  return res
}

// GET /api/admin/projects/[id]/schedule - fetch the project's production schedule
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const authResult = await requireApiMenu(request, 'projects')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'project-schedule-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const schedule = await prisma.projectSchedule.findUnique({
    where: { projectId },
    include: scheduleInclude,
  })

  return noStore(
    NextResponse.json({
      schedule,
      project: {
        id: project.id,
        title: project.title,
        companyName: project.companyName,
        startDate: project.startDate ? project.startDate.toISOString() : null,
      },
    })
  )
}

// POST /api/admin/projects/[id]/schedule - create schedule (blank or from template)
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const authResult = await requireApiMenu(request, 'projects')
  if (authResult instanceof Response) return authResult

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'project-schedule-create',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const existing = await prisma.projectSchedule.findUnique({ where: { projectId }, select: { id: true } })
  if (existing) {
    return NextResponse.json({ error: 'This project already has a schedule.' }, { status: 409 })
  }

  const { anchorDate, includeWeekends, fromTemplate } = parsed.data

  const schedule = await prisma.projectSchedule.create({
    data: {
      projectId,
      includeWeekends,
      ...(fromTemplate ? { phases: materializeTemplate(anchorDate, includeWeekends) } : {}),
    },
    include: scheduleInclude,
  })

  return noStore(NextResponse.json({ schedule }, { status: 201 }))
}

// PATCH /api/admin/projects/[id]/schedule - update title / weekend visibility
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const authResult = await requireApiMenu(request, 'projects')
  if (authResult instanceof Response) return authResult

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'project-schedule-patch',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const parsed = patchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const existing = await prisma.projectSchedule.findUnique({ where: { projectId }, select: { id: true } })
  if (!existing) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 })

  const data: Record<string, unknown> = {}
  if (parsed.data.title !== undefined) data.title = parsed.data.title || null
  if (parsed.data.includeWeekends !== undefined) data.includeWeekends = parsed.data.includeWeekends

  const schedule = await prisma.projectSchedule.update({
    where: { projectId },
    data,
    include: scheduleInclude,
  })

  return noStore(NextResponse.json({ schedule }))
}

// DELETE /api/admin/projects/[id]/schedule - delete schedule (cascades phases/tasks)
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const authResult = await requireApiMenu(request, 'projects')
  if (authResult instanceof Response) return authResult

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'project-schedule-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const existing = await prisma.projectSchedule.findUnique({ where: { projectId }, select: { id: true } })
  if (!existing) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 })

  await prisma.projectSchedule.delete({ where: { projectId } })

  return noStore(NextResponse.json({ ok: true }))
}
