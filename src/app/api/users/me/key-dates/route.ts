import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { requireMenuAccess } from '@/lib/rbac-api'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' }),
  allDay: z.boolean().default(false),
  startTime: z
    .union([
      z.string().regex(/^\d{2}:\d{2}$/, { message: 'startTime must be HH:MM' }),
      z.literal(''),
      z.null(),
      z.undefined(),
    ])
    .optional(),
  finishTime: z
    .union([
      z.string().regex(/^\d{2}:\d{2}$/, { message: 'finishTime must be HH:MM' }),
      z.literal(''),
      z.null(),
      z.undefined(),
    ])
    .optional(),
  title: z.string().trim().min(1, { message: 'title is required' }).max(120),
  notes: z.union([z.string().max(500), z.literal(''), z.null(), z.undefined()]).optional(),
  reminderAt: z.union([z.string().datetime(), z.literal(''), z.null(), z.undefined()]).optional(),
  reminderTargets: z
    .object({
      userIds: z.array(z.string()).optional(),
    })
    .optional(),
})

function normalize(input: z.infer<typeof bodySchema>) {
  const startTime = input.allDay ? null : (input.startTime || null)
  const finishTime = input.allDay ? null : (input.finishTime || null)
  const notes = (input.notes || null) as string | null

  const reminderAtParsed = input.reminderAt ? new Date(input.reminderAt as any) : null
  const reminderAt = reminderAtParsed && !isNaN(reminderAtParsed.getTime()) ? reminderAtParsed : null

  const reminderTargetsRaw = (input.reminderTargets || null) as any
  const userIds = Array.isArray(reminderTargetsRaw?.userIds)
    ? reminderTargetsRaw.userIds.map(String).filter(Boolean)
    : []
  const reminderTargets = userIds.length ? ({ userIds } as Prisma.InputJsonValue) : undefined

  return {
    date: input.date,
    allDay: input.allDay,
    startTime,
    finishTime,
    title: input.title,
    notes,
    reminderAt,
    reminderTargets,
  }
}

// GET /api/users/me/key-dates - list personal key dates
export async function GET(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'projects')
  if (forbidden) return forbidden

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'user-key-dates-list'
  )
  if (rateLimitResult) return rateLimitResult

  const rows = await prisma.userKeyDate.findMany({
    where: { userId: authResult.id },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }, { createdAt: 'asc' }],
  })

  const response = NextResponse.json({ keyDates: rows })
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Pragma', 'no-cache')
  return response
}

// POST /api/users/me/key-dates - create personal key date
export async function POST(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) return authResult

  const forbidden = requireMenuAccess(authResult, 'projects')
  if (forbidden) return forbidden

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'user-key-dates-create'
  )
  if (rateLimitResult) return rateLimitResult

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid request' }, { status: 400 })
  }

  const normalized = normalize(parsed.data)

  if (normalized.reminderAt && normalized.reminderAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: 'Reminder must be set to a future date and time' }, { status: 400 })
  }

  const created = await prisma.userKeyDate.create({
    data: {
      userId: authResult.id,
      ...normalized,
    },
  })

  return NextResponse.json({ keyDate: created }, { status: 201 })
}
