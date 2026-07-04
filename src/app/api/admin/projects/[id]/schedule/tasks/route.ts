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

const createTaskSchema = z.object({
  phaseId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  description: z.union([z.string().trim().max(500), z.literal(''), z.null()]).optional(),
  kind: z.enum(['BAR', 'MILESTONE']).default('BAR'),
  owner: z.enum(['STUDIO', 'CLIENT']).default('STUDIO'),
  startDate: isoDate,
  endDate: isoDate.optional(),
  showDeadline: z.boolean().default(false),
})

// POST /api/admin/projects/[id]/schedule/tasks - add a task to a phase
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const authResult = await requireApiMenu(request, 'projects')
  if (authResult instanceof Response) return authResult

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'project-schedule-task-create',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const project = await assertProjectAccessOr404(projectId, authResult)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const parsed = createTaskSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const { phaseId, name, description, kind, owner, startDate, showDeadline } = parsed.data
  const endDate = kind === 'MILESTONE' ? startDate : parsed.data.endDate ?? startDate

  if (compareISO(endDate, startDate) < 0) {
    return NextResponse.json({ error: 'End date must not be before the start date' }, { status: 400 })
  }

  // The phase must belong to this project's schedule
  const phase = await prisma.projectSchedulePhase.findFirst({
    where: { id: phaseId, schedule: { projectId } },
    select: { id: true, tasks: { select: { sortOrder: true }, orderBy: { sortOrder: 'desc' }, take: 1 } },
  })
  if (!phase) return NextResponse.json({ error: 'Phase not found' }, { status: 404 })

  const task = await prisma.projectScheduleTask.create({
    data: {
      phaseId: phase.id,
      name,
      description: description || null,
      kind,
      owner,
      startDate,
      endDate,
      showDeadline,
      sortOrder: (phase.tasks[0]?.sortOrder ?? -1) + 1,
    },
  })

  const res = NextResponse.json({ task }, { status: 201 })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
