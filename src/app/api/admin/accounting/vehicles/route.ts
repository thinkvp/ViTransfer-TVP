import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { vehicleFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createSchema = z.object({
  make: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(100),
  year: z.number().int().min(1900).max(2100).optional().nullable(),
  engineCapacityCc: z.number().int().min(1).max(99999).optional().nullable(),
  registrationNumber: z.string().trim().min(1).max(30),
  colour: z.string().trim().max(60).optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
  isActive: z.boolean().default(true),
})

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-vehicles-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const vehicles = await prisma.vehicle.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      logbooks: {
        orderBy: { startDate: 'desc' },
        include: {
          _count: { select: { trips: true } },
          trips: { select: { tripType: true, distanceKm: true, date: true } },
        },
      },
    },
  })

  const res = NextResponse.json({ vehicles: vehicles.map(v => vehicleFromDb(v)) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-vehicles-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const body = await request.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const data = parsed.data
  const vehicle = await prisma.vehicle.create({
    data: {
      make: data.make,
      model: data.model,
      year: data.year ?? null,
      engineCapacityCc: data.engineCapacityCc ?? null,
      registrationNumber: data.registrationNumber,
      colour: data.colour ?? null,
      notes: data.notes ?? null,
      isActive: data.isActive,
    },
    include: {
      logbooks: {
        include: {
          _count: { select: { trips: true } },
          trips: { select: { tripType: true, distanceKm: true, date: true } },
        },
      },
    },
  })

  return NextResponse.json({ vehicle: vehicleFromDb(vehicle) }, { status: 201 })
}
