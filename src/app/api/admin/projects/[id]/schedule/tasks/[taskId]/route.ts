import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { requireActionAccess } from '@/lib/rbac-api'
import { rateLimit } from '@/lib/rate-limit'
import { assertProjectAccessOr404 } from '@/lib/gantt/access'
import { compareISO, isValidISODate } from '@/lib/gantt/dates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const isoDate = z.string().refine(isValidISODate, { message: 'Dates must be YYYY-MM-DD' })

const patchTaskSchema = z.object({
  phaseId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.union([z.string().trim().max(500), z.literal(''), z.null()]).optional(),
  kind: z.enum(['BAR', 'MILESTONE']).optional(),
  owner: z.enum(['STUDIO', 'CLIENT']).optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  showDeadline: z.boolean().optional(),
  direction: z.enum(['up', 'down']).optional(), // reorder within the phase
})

async function findTaskInProject(projectId: string, taskId: string) {
  return prisma.projectScheduleTask.findFirst({
    where: { id: taskId, phase: { schedule: { projectId } } },
    select: {
      id: true,
      phaseId: true,
      kind: true,
      startDate: true,
      endDate: true,
      sortOrder: true,
    },
  })
}

// PATCH /api/admin/projects/[id]/schedule/tasks/[taskId] - edit / move / reorder a task
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> }
) {
  const { id: projectId, taskId } = await params

  const authResult = await requireApiMenu(request, 'projects')
  if (authResult instanceof Response) return authResult

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 240, message: 'Too many requests. Please slow down.' },
    'project-schedule-task-patch',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const parsed = patchTaskSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const task = await findTaskInProject(projectId, taskId)
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const input = parsed.data

  // Resolve final field values (patch semantics)
  const kind = input.kind ?? task.kind
  const startDate = input.startDate ?? task.startDate
  let endDate = input.endDate ?? task.endDate
  if (kind === 'MILESTONE') endDate = startDate
  if (compareISO(endDate, startDate) < 0) {
    return NextResponse.json({ error: 'End date must not be before the start date' }, { status: 400 })
  }

  // Moving to another phase: validate target belongs to this project's schedule
  let targetPhaseId = task.phaseId
  let sortOrder: number | undefined
  if (input.phaseId && input.phaseId !== task.phaseId) {
    const targetPhase = await prisma.projectSchedulePhase.findFirst({
      where: { id: input.phaseId, schedule: { projectId } },
      select: { id: true, tasks: { select: { sortOrder: true }, orderBy: { sortOrder: 'desc' }, take: 1 } },
    })
    if (!targetPhase) return NextResponse.json({ error: 'Phase not found' }, { status: 404 })
    targetPhaseId = targetPhase.id
    sortOrder = (targetPhase.tasks[0]?.sortOrder ?? -1) + 1
  }

  if (input.direction && targetPhaseId === task.phaseId) {
    const siblings = await prisma.projectScheduleTask.findMany({
      where: { phaseId: task.phaseId },
      orderBy: { sortOrder: 'asc' },
      select: { id: true },
    })
    const idx = siblings.findIndex((s) => s.id === task.id)
    const swapIdx = input.direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx >= 0 && swapIdx < siblings.length) {
      const order = siblings.map((s) => s.id)
      ;[order[idx], order[swapIdx]] = [order[swapIdx], order[idx]]
      await prisma.$transaction(
        order.map((id, i) => prisma.projectScheduleTask.update({ where: { id }, data: { sortOrder: i } }))
      )
    }
  }

  const updated = await prisma.projectScheduleTask.update({
    where: { id: task.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.kind !== undefined ? { kind } : {}),
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      startDate,
      endDate,
      ...(input.showDeadline !== undefined ? { showDeadline: input.showDeadline } : {}),
      ...(targetPhaseId !== task.phaseId ? { phaseId: targetPhaseId } : {}),
      ...(sortOrder !== undefined ? { sortOrder } : {}),
    },
  })

  const res = NextResponse.json({ task: updated })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

// DELETE /api/admin/projects/[id]/schedule/tasks/[taskId]
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> }
) {
  const { id: projectId, taskId } = await params

  const authResult = await requireApiMenu(request, 'projects')
  if (authResult instanceof Response) return authResult

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'project-schedule-task-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const task = await findTaskInProject(projectId, taskId)
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  await prisma.projectScheduleTask.delete({ where: { id: task.id } })

  const res = NextResponse.json({ ok: true })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
