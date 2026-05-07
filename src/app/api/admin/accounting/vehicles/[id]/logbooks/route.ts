import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { vehicleLogbookFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createSchema = z.object({
  label: z.string().trim().min(1).max(200),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  odometerStart: z.number().int().min(0),
  notes: z.string().trim().max(5000).optional().nullable(),
})

const LOGBOOK_INCLUDE = {
  _count: { select: { trips: true } },
  trips: { select: { tripType: true, distanceKm: true, date: true } },
} as const

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-vehicle-logbooks-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id: vehicleId } = await params
  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } })
  if (!vehicle) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })

  const logbooks = await prisma.vehicleLogbook.findMany({
    where: { vehicleId },
    orderBy: { startDate: 'desc' },
    include: LOGBOOK_INCLUDE,
  })

  const res = NextResponse.json({ logbooks: logbooks.map(l => vehicleLogbookFromDb(l)) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-vehicle-logbooks-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id: vehicleId } = await params
  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } })
  if (!vehicle) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })

  const body = await request.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const data = parsed.data
  const logbook = await prisma.vehicleLogbook.create({
    data: {
      vehicleId,
      label: data.label,
      startDate: data.startDate,
      odometerStart: data.odometerStart,
      notes: data.notes ?? null,
      status: 'ACTIVE',
    },
    include: LOGBOOK_INCLUDE,
  })

  return NextResponse.json({ logbook: vehicleLogbookFromDb(logbook) }, { status: 201 })
}
