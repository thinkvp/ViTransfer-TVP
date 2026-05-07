import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { vehicleLogbookFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  odometerStart: z.number().int().min(0).optional(),
  odometerEnd: z.number().int().min(0).optional().nullable(),
  status: z.enum(['ACTIVE', 'CLOSED']).optional(),
  businessUsePercentOverride: z.number().min(0).max(100).optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
})

const LOGBOOK_INCLUDE = {
  _count: { select: { trips: true } },
  trips: { select: { tripType: true, distanceKm: true, date: true } },
} as const

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; logbookId: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-vehicle-logbook-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { logbookId } = await params
  const logbook = await prisma.vehicleLogbook.findUnique({ where: { id: logbookId }, include: LOGBOOK_INCLUDE })
  if (!logbook) return NextResponse.json({ error: 'Logbook not found' }, { status: 404 })

  const res = NextResponse.json({ logbook: vehicleLogbookFromDb(logbook) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string; logbookId: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-vehicle-logbook-put',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { logbookId } = await params
  const body = await request.json().catch(() => null)
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const existing = await prisma.vehicleLogbook.findUnique({ where: { id: logbookId } })
  if (!existing) return NextResponse.json({ error: 'Logbook not found' }, { status: 404 })

  const data = parsed.data
  const logbook = await prisma.vehicleLogbook.update({
    where: { id: logbookId },
    data: {
      ...(data.label !== undefined && { label: data.label }),
      ...(data.startDate !== undefined && { startDate: data.startDate }),
      ...(data.endDate !== undefined && { endDate: data.endDate }),
      ...(data.odometerStart !== undefined && { odometerStart: data.odometerStart }),
      ...(data.odometerEnd !== undefined && { odometerEnd: data.odometerEnd }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.businessUsePercentOverride !== undefined && { businessUsePercentOverride: data.businessUsePercentOverride }),
      ...(data.notes !== undefined && { notes: data.notes }),
    },
    include: LOGBOOK_INCLUDE,
  })

  return NextResponse.json({ logbook: vehicleLogbookFromDb(logbook) })
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; logbookId: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-vehicle-logbook-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { logbookId } = await params
  const existing = await prisma.vehicleLogbook.findUnique({ where: { id: logbookId } })
  if (!existing) return NextResponse.json({ error: 'Logbook not found' }, { status: 404 })

  await prisma.vehicleLogbook.delete({ where: { id: logbookId } })
  return NextResponse.json({ ok: true })
}
