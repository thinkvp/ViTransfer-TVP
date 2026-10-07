import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenu, requireApiMenuAction } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { basPeriodFromDb } from '@/lib/accounting/db-mappers'
import { calculateBasForPeriod } from '@/lib/accounting/bas-adjustments'
import type { Prisma } from '@prisma/client'

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
  // Prior-period adjustment keys ("<sourcePeriodId>|<recordKey>") to leave out of this BAS
  excludedAdjustmentKeys: z.array(z.string().max(300)).max(5000).optional(),
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
  const period = await prisma.basPeriod.findUnique({ where: { id }, include: { accountingAttachments: true, bankTransaction: { select: { id: true } } } })

  if (!period) {
    return NextResponse.json({ error: 'BAS period not found' }, { status: 404 })
  }

  const res = NextResponse.json({ period: basPeriodFromDb(period) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenuAction(request, 'accounting', 'manageAccounting')
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

  // Snapshot calculation at lodge time. The lodged labels include the prior-period
  // adjustments the user kept; recordsJson stays this period's own records, which is what
  // later edits are compared against. Each included adjustment is recorded as CARRIED so
  // it stops being outstanding on its source period.
  let snapshotData: { calculationJson?: Prisma.InputJsonValue; recordsJson?: Prisma.InputJsonValue } = {}
  let carried: Prisma.BasAdjustmentCreateManyInput[] = []
  if (data.status === 'LODGED') {
    const { calculation, records, priorPeriodItems } = await calculateBasForPeriod({
      ...existing,
      g2Override: data.g2Override !== undefined ? data.g2Override : existing.g2Override,
      g3Override: data.g3Override !== undefined ? data.g3Override : existing.g3Override,
      excludedAdjustmentKeys: data.excludedAdjustmentKeys ?? existing.excludedAdjustmentKeys,
    })
    snapshotData = {
      calculationJson: calculation as unknown as Prisma.InputJsonValue,
      recordsJson: records as unknown as Prisma.InputJsonValue,
    }
    const createdByName = authResult.name || authResult.email || null
    carried = priorPeriodItems.filter((i) => i.included).map((i) => ({
      sourcePeriodId: i.sourcePeriodId,
      targetPeriodId: id,
      resolution: 'CARRIED' as const,
      recordKey: i.recordKey,
      description: i.description.slice(0, 500),
      recordDate: i.date,
      g1Cents: i.outstandingDeltas.g1Cents,
      g3Cents: i.outstandingDeltas.g3Cents,
      g4Cents: i.outstandingDeltas.g4Cents,
      g10Cents: i.outstandingDeltas.g10Cents,
      g11Cents: i.outstandingDeltas.g11Cents,
      label1ACents: i.outstandingDeltas.label1ACents,
      label1BCents: i.outstandingDeltas.label1BCents,
      createdById: authResult.id,
      createdByName,
    }))
  }

  const [updated] = await prisma.$transaction([
    prisma.basPeriod.update({
      where: { id },
      include: { accountingAttachments: true },
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
        ...(data.excludedAdjustmentKeys !== undefined ? { excludedAdjustmentKeys: data.excludedAdjustmentKeys } : {}),
        ...(data.status === 'LODGED' ? { lodgedAt: new Date(), ...snapshotData } : {}),
      },
    }),
    ...(carried.length > 0 ? [prisma.basAdjustment.createMany({ data: carried })] : []),
  ])

  const res = NextResponse.json({ period: basPeriodFromDb(updated) })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenuAction(request, 'accounting', 'manageAccounting')
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
