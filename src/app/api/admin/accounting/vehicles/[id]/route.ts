import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { vehicleFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  make: z.string().trim().min(1).max(100).optional(),
  model: z.string().trim().min(1).max(100).optional(),
  year: z.number().int().min(1900).max(2100).optional().nullable(),
  engineCapacityCc: z.number().int().min(1).max(99999).optional().nullable(),
  registrationNumber: z.string().trim().min(1).max(30).optional(),
  colour: z.string().trim().max(60).optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
  isActive: z.boolean().optional(),
})

const INCLUDE = {
  logbooks: {
    orderBy: { startDate: 'desc' as const },
    include: {
      _count: { select: { trips: true } },
      trips: { select: { tripType: true, distanceKm: true, date: true } },
    },
  },
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-vehicle-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const vehicle = await prisma.vehicle.findUnique({ where: { id }, include: INCLUDE })
  if (!vehicle) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })

  const res = NextResponse.json({ vehicle: vehicleFromDb(vehicle) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-vehicle-put',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const body = await request.json().catch(() => null)
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const existing = await prisma.vehicle.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })

  const data = parsed.data
  const vehicle = await prisma.vehicle.update({
    where: { id },
    data: {
      ...(data.make !== undefined && { make: data.make }),
      ...(data.model !== undefined && { model: data.model }),
      ...(data.year !== undefined && { year: data.year }),
      ...(data.engineCapacityCc !== undefined && { engineCapacityCc: data.engineCapacityCc }),
      ...(data.registrationNumber !== undefined && { registrationNumber: data.registrationNumber }),
      ...(data.colour !== undefined && { colour: data.colour }),
      ...(data.notes !== undefined && { notes: data.notes }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    },
    include: INCLUDE,
  })

  return NextResponse.json({ vehicle: vehicleFromDb(vehicle) })
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-vehicle-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const existing = await prisma.vehicle.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })

  await prisma.vehicle.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
