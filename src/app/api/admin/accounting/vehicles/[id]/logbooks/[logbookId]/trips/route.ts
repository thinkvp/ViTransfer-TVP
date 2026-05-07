import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { vehicleTripFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tripType: z.enum(['BUSINESS', 'PRIVATE']),
  purpose: z.string().trim().min(1).max(500),
  odometerStart: z.number().int().min(0).optional().nullable(),
  odometerEnd: z.number().int().min(0).optional().nullable(),
  distanceKm: z.number().positive().optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
}).refine(
  d => {
    // Must provide either (odometerStart + odometerEnd) or distanceKm
    const hasOdometer = d.odometerStart != null && d.odometerEnd != null
    const hasDistance = d.distanceKm != null && d.distanceKm > 0
    return hasOdometer || hasDistance
  },
  { message: 'Provide either both odometer readings or a distance in km' }
)

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; logbookId: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-vehicle-trips-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { logbookId } = await params
  const logbook = await prisma.vehicleLogbook.findUnique({ where: { id: logbookId } })
  if (!logbook) return NextResponse.json({ error: 'Logbook not found' }, { status: 404 })

  const { searchParams } = new URL(request.url)
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
  const pageSize = Math.min(200, Math.max(1, parseInt(searchParams.get('pageSize') ?? '100', 10)))

  const [total, trips] = await Promise.all([
    prisma.vehicleTrip.count({ where: { logbookId } }),
    prisma.vehicleTrip.findMany({
      where: { logbookId },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  const res = NextResponse.json({
    trips: trips.map(t => vehicleTripFromDb(t)),
    total,
    page,
    pageSize,
  })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; logbookId: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-vehicle-trips-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { logbookId } = await params
  const logbook = await prisma.vehicleLogbook.findUnique({ where: { id: logbookId } })
  if (!logbook) return NextResponse.json({ error: 'Logbook not found' }, { status: 404 })
  if (logbook.status === 'CLOSED') {
    return NextResponse.json({ error: 'Cannot add trips to a closed logbook' }, { status: 409 })
  }

  const body = await request.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const data = parsed.data
  // Compute distance from odometers when both are provided; otherwise use supplied distanceKm
  let distanceKm = data.distanceKm ?? 0
  if (data.odometerStart != null && data.odometerEnd != null) {
    distanceKm = Math.max(0, data.odometerEnd - data.odometerStart)
  }

  const trip = await prisma.vehicleTrip.create({
    data: {
      logbookId,
      date: data.date,
      tripType: data.tripType,
      purpose: data.purpose,
      odometerStart: data.odometerStart ?? null,
      odometerEnd: data.odometerEnd ?? null,
      distanceKm,
      notes: data.notes ?? null,
    },
  })

  return NextResponse.json({ trip: vehicleTripFromDb(trip) }, { status: 201 })
}
