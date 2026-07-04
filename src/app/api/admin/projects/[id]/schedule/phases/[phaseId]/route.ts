import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { requireActionAccess } from '@/lib/rbac-api'
import { rateLimit } from '@/lib/rate-limit'
import { assertProjectAccessOr404 } from '@/lib/gantt/access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const patchPhaseSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, { message: 'Colour must be #RRGGBB' }).optional(),
  direction: z.enum(['up', 'down']).optional(), // swap sortOrder with the neighbour
})

async function findPhaseInProject(projectId: string, phaseId: string) {
  return prisma.projectSchedulePhase.findFirst({
    where: { id: phaseId, schedule: { projectId } },
    select: { id: true, scheduleId: true, sortOrder: true },
  })
}

// PATCH /api/admin/projects/[id]/schedule/phases/[phaseId] - rename, recolour, reorder
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; phaseId: string }> }
) {
  const { id: projectId, phaseId } = await params

  const authResult = await requireApiMenu(request, 'projects')
  if (authResult instanceof Response) return authResult

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'project-schedule-phase-patch',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const parsed = patchPhaseSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const phase = await findPhaseInProject(projectId, phaseId)
  if (!phase) return NextResponse.json({ error: 'Phase not found' }, { status: 404 })

  const { name, color, direction } = parsed.data

  if (direction) {
    const siblings = await prisma.projectSchedulePhase.findMany({
      where: { scheduleId: phase.scheduleId },
      orderBy: { sortOrder: 'asc' },
      select: { id: true },
    })
    const idx = siblings.findIndex((s) => s.id === phase.id)
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx >= 0 && swapIdx < siblings.length) {
      // Normalize sort orders to indices, then swap the two positions
      const order = siblings.map((s) => s.id)
      ;[order[idx], order[swapIdx]] = [order[swapIdx], order[idx]]
      await prisma.$transaction(
        order.map((id, i) =>
          prisma.projectSchedulePhase.update({ where: { id }, data: { sortOrder: i } })
        )
      )
    }
  }

  if (name !== undefined || color !== undefined) {
    await prisma.projectSchedulePhase.update({
      where: { id: phase.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(color !== undefined ? { color } : {}),
      },
    })
  }

  const updated = await prisma.projectSchedulePhase.findUnique({
    where: { id: phase.id },
    include: { tasks: { orderBy: { sortOrder: 'asc' } } },
  })

  const res = NextResponse.json({ phase: updated })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

// DELETE /api/admin/projects/[id]/schedule/phases/[phaseId] - delete phase + its tasks
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; phaseId: string }> }
) {
  const { id: projectId, phaseId } = await params

  const authResult = await requireApiMenu(request, 'projects')
  if (authResult instanceof Response) return authResult

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'project-schedule-phase-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const phase = await findPhaseInProject(projectId, phaseId)
  if (!phase) return NextResponse.json({ error: 'Phase not found' }, { status: 404 })

  await prisma.projectSchedulePhase.delete({ where: { id: phase.id } })

  const res = NextResponse.json({ ok: true })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
