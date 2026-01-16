import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
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
})

function normalize(input: z.infer<typeof bodySchema>) {
  const startTime = input.allDay ? null : (input.startTime || null)
  const finishTime = input.allDay ? null : (input.finishTime || null)
  const notes = (input.notes || null) as string | null

  return {
    date: input.date,
    allDay: input.allDay,
    startTime,
    finishTime,
    title: input.title,
    notes,
  }
}

// GET /api/users/me/key-dates - list personal key dates
export async function GET(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

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
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

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

  const created = await prisma.userKeyDate.create({
    data: {
      userId: authResult.id,
      ...normalize(parsed.data),
    },
  })

  return NextResponse.json({ keyDate: created }, { status: 201 })
}
