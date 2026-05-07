import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { vehicleYearlyOdometerFromDb } from '@/lib/accounting/db-mappers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const upsertSchema = z.object({
  financialYear: z.string().regex(/^FY\d{4}$/, 'Must be in format FY2026'),
  odometerStart: z.number().int().min(0),
  odometerEnd: z.number().int().min(0).optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
})

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-vehicle-odometer-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id: vehicleId } = await params
  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } })
  if (!vehicle) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })

  const records = await prisma.vehicleYearlyOdometer.findMany({
    where: { vehicleId },
    orderBy: { financialYear: 'desc' },
  })

  const res = NextResponse.json({ yearlyOdometers: records.map(r => vehicleYearlyOdometerFromDb(r)) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-vehicle-odometer-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id: vehicleId } = await params
  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } })
  if (!vehicle) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })

  const body = await request.json().catch(() => null)
  const parsed = upsertSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const data = parsed.data
  const record = await prisma.vehicleYearlyOdometer.upsert({
    where: { vehicleId_financialYear: { vehicleId, financialYear: data.financialYear } },
    create: {
      vehicleId,
      financialYear: data.financialYear,
      odometerStart: data.odometerStart,
      odometerEnd: data.odometerEnd ?? null,
      notes: data.notes ?? null,
    },
    update: {
      odometerStart: data.odometerStart,
      odometerEnd: data.odometerEnd ?? null,
      notes: data.notes ?? null,
    },
  })

  return NextResponse.json({ yearlyOdometer: vehicleYearlyOdometerFromDb(record) })
}
