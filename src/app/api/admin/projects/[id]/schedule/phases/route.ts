import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { requireActionAccess } from '@/lib/rbac-api'
import { rateLimit } from '@/lib/rate-limit'
import { assertProjectAccessOr404 } from '@/lib/gantt/access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createPhaseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, { message: 'Colour must be #RRGGBB' }),
})

// POST /api/admin/projects/[id]/schedule/phases - add a phase to the schedule
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const authResult = await requireApiMenu(request, 'projects')
  if (authResult instanceof Response) return authResult

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'project-schedule-phase-create',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const parsed = createPhaseSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const schedule = await prisma.projectSchedule.findUnique({
    where: { projectId },
    select: { id: true, phases: { select: { sortOrder: true }, orderBy: { sortOrder: 'desc' }, take: 1 } },
  })
  if (!schedule) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 })

  const nextSort = (schedule.phases[0]?.sortOrder ?? -1) + 1

  const phase = await prisma.projectSchedulePhase.create({
    data: {
      scheduleId: schedule.id,
      name: parsed.data.name,
      color: parsed.data.color,
      sortOrder: nextSort,
    },
    include: { tasks: { orderBy: { sortOrder: 'asc' } } },
  })

  const res = NextResponse.json({ phase }, { status: 201 })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
