import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { vehicleTripFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tripType: z.enum(['BUSINESS', 'PRIVATE']).optional(),
  purpose: z.string().trim().min(1).max(500).optional(),
  odometerStart: z.number().int().min(0).optional().nullable(),
  odometerEnd: z.number().int().min(0).optional().nullable(),
  distanceKm: z.number().positive().optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
})

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; logbookId: string; tripId: string }> }
) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-vehicle-trip-put',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { tripId } = await params
  const body = await request.json().catch(() => null)
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const existing = await prisma.vehicleTrip.findUnique({ where: { id: tripId } })
  if (!existing) return NextResponse.json({ error: 'Trip not found' }, { status: 404 })

  const data = parsed.data

  // Recompute distance if odometer values are updated
  let distanceKm: number | undefined
  const newOdomStart = data.odometerStart !== undefined ? data.odometerStart : existing.odometerStart
  const newOdomEnd = data.odometerEnd !== undefined ? data.odometerEnd : existing.odometerEnd
  if (newOdomStart != null && newOdomEnd != null) {
    distanceKm = Math.max(0, newOdomEnd - newOdomStart)
  } else if (data.distanceKm != null) {
    distanceKm = data.distanceKm
  }

  const trip = await prisma.vehicleTrip.update({
    where: { id: tripId },
    data: {
      ...(data.date !== undefined && { date: data.date }),
      ...(data.tripType !== undefined && { tripType: data.tripType }),
      ...(data.purpose !== undefined && { purpose: data.purpose }),
      ...(data.odometerStart !== undefined && { odometerStart: data.odometerStart }),
      ...(data.odometerEnd !== undefined && { odometerEnd: data.odometerEnd }),
      ...(distanceKm !== undefined && { distanceKm }),
      ...(data.notes !== undefined && { notes: data.notes }),
    },
  })

  return NextResponse.json({ trip: vehicleTripFromDb(trip) })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; logbookId: string; tripId: string }> }
) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-vehicle-trip-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { tripId } = await params
  const existing = await prisma.vehicleTrip.findUnique({ where: { id: tripId } })
  if (!existing) return NextResponse.json({ error: 'Trip not found' }, { status: 404 })

  await prisma.vehicleTrip.delete({ where: { id: tripId } })
  return NextResponse.json({ ok: true })
}
