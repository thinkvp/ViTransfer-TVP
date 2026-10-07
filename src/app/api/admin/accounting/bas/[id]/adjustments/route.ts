import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiMenuAction } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getLodgedPeriodDrift } from '@/lib/accounting/bas-adjustments'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const amendSchema = z.object({
  // Change keys ("<periodId>|<recordKey>") from this period's drift
  keys: z.array(z.string().max(300)).min(1).max(5000),
})

// POST /api/admin/accounting/bas/[id]/adjustments
// Marks outstanding changes to a lodged period as AMENDED: the user revised the original
// BAS with the ATO, so the changes must not also be carried into a later BAS.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenuAction(request, 'accounting', 'manageAccounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-bas-adjustments-post',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const period = await prisma.basPeriod.findUnique({ where: { id }, select: { status: true } })
  if (!period) return NextResponse.json({ error: 'BAS period not found' }, { status: 404 })
  if (period.status !== 'LODGED') return NextResponse.json({ error: 'Only lodged BAS periods can be amended' }, { status: 409 })

  const body = await request.json().catch(() => null)
  const parsed = amendSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })

  // Amounts come from a fresh comparison, never from the client.
  const [drift] = await getLodgedPeriodDrift({ ids: [id] })
  const wanted = new Set(parsed.data.keys)
  const selected = (drift?.changes ?? []).filter((c) => c.outstanding && wanted.has(c.key))
  if (selected.length === 0) {
    return NextResponse.json({ error: 'None of those changes are still outstanding. Refresh and try again.' }, { status: 409 })
  }

  const createdByName = authResult.name || authResult.email || null
  await prisma.basAdjustment.createMany({
    data: selected.map((c) => ({
      sourcePeriodId: id,
      targetPeriodId: null,
      resolution: 'AMENDED' as const,
      recordKey: c.recordKey,
      description: c.description.slice(0, 500),
      recordDate: c.date,
      g1Cents: c.outstandingDeltas.g1Cents,
      g3Cents: c.outstandingDeltas.g3Cents,
      g4Cents: c.outstandingDeltas.g4Cents,
      g10Cents: c.outstandingDeltas.g10Cents,
      g11Cents: c.outstandingDeltas.g11Cents,
      label1ACents: c.outstandingDeltas.label1ACents,
      label1BCents: c.outstandingDeltas.label1BCents,
      createdById: authResult.id,
      createdByName,
    })),
  })

  return NextResponse.json({ ok: true, count: selected.length })
}

// DELETE /api/admin/accounting/bas/[id]/adjustments?adjustmentId=...
// Undoes an AMENDED resolution so the change is outstanding again. CARRIED rows belong to
// a later lodged BAS and stay.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenuAction(request, 'accounting', 'manageAccounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-bas-adjustments-delete',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const adjustmentId = request.nextUrl.searchParams.get('adjustmentId') ?? ''
  const adjustment = await prisma.basAdjustment.findUnique({ where: { id: adjustmentId }, select: { sourcePeriodId: true, resolution: true } })
  if (!adjustment || adjustment.sourcePeriodId !== id) return NextResponse.json({ error: 'Adjustment not found' }, { status: 404 })
  if (adjustment.resolution !== 'AMENDED') {
    return NextResponse.json({ error: 'This change was reported in a later lodged BAS and cannot be undone here.' }, { status: 409 })
  }

  await prisma.basAdjustment.delete({ where: { id: adjustmentId } })
  return NextResponse.json({ ok: true })
}
