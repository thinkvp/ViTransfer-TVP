import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { basPeriodFromDb } from '@/lib/accounting/db-mappers'
import { calculateBas } from '@/lib/accounting/gst'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(['DRAFT', 'REVIEWED', 'LODGED']).optional(),
  g2Override: z.number().min(0).optional().nullable(),
  g3Override: z.number().min(0).optional().nullable(),
  paygWithholdingCents: z.number().int().min(0).optional().nullable(),
  paygInstalmentCents: z.number().int().min(0).optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
})

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many requests. Please slow down.' },
    'admin-accounting-bas-id-get',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const period = await prisma.basPeriod.findUnique({ where: { id } })

  if (!period) {
    return NextResponse.json({ error: 'BAS period not found' }, { status: 404 })
  }

  const res = NextResponse.json({ period: basPeriodFromDb(period) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-bas-id-put',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const existing = await prisma.basPeriod.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'BAS period not found' }, { status: 404 })
  }

  if (existing.status === 'LODGED') {
    return NextResponse.json({ error: 'Lodged BAS periods cannot be edited' }, { status: 409 })
  }

  const body = await request.json().catch(() => null)
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
  }

  const data = parsed.data

  if (data.status === 'LODGED' && existing.status !== 'REVIEWED') {
    return NextResponse.json({ error: 'Period must be in REVIEWED status before lodging' }, { status: 400 })
  }

  // Snapshot calculation at lodge time
  let snapshotData: { calculationJson?: import('@prisma/client').Prisma.InputJsonValue; recordsJson?: import('@prisma/client').Prisma.InputJsonValue } = {}
  if (data.status === 'LODGED') {
    const { calculation, records } = await calculateBas(
      existing.startDate,
      existing.endDate,
      existing.basis as 'CASH' | 'ACCRUAL',
      data.g2Override !== undefined ? data.g2Override : existing.g2Override,
      data.g3Override !== undefined ? data.g3Override : existing.g3Override,
    )
    snapshotData = {
      calculationJson: calculation as unknown as import('@prisma/client').Prisma.InputJsonValue,
      recordsJson: records as unknown as import('@prisma/client').Prisma.InputJsonValue,
    }
  }

  const updated = await prisma.basPeriod.update({
    where: { id },
    data: {
      ...(data.label !== undefined ? { label: data.label } : {}),
      ...(data.startDate !== undefined ? { startDate: data.startDate } : {}),
      ...(data.endDate !== undefined ? { endDate: data.endDate } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.g2Override !== undefined ? { g2Override: data.g2Override !== null ? Math.round(data.g2Override * 100) : null } : {}),
      ...(data.g3Override !== undefined ? { g3Override: data.g3Override !== null ? Math.round(data.g3Override * 100) : null } : {}),
      ...(data.paygWithholdingCents !== undefined ? { paygWithholdingCents: data.paygWithholdingCents } : {}),
      ...(data.paygInstalmentCents !== undefined ? { paygInstalmentCents: data.paygInstalmentCents } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      ...(data.status === 'LODGED' ? { lodgedAt: new Date(), ...snapshotData } : {}),
    },
  })

  const res = NextResponse.json({ period: basPeriodFromDb(updated) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-bas-id-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const existing = await prisma.basPeriod.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'BAS period not found' }, { status: 404 })
  }

  if (existing.status === 'LODGED') {
    return NextResponse.json({ error: 'Lodged BAS periods cannot be deleted' }, { status: 409 })
  }

  await prisma.basPeriod.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
