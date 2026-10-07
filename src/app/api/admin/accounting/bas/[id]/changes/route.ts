import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { basPeriodLabel, getLodgedPeriodDrift, getPriorPeriodItems } from '@/lib/accounting/bas-adjustments'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/accounting/bas/[id]/changes
// Lodged period: every change to its figures since lodgement, how each was resolved, and
// the adjustments it carried in from earlier periods.
// Un-lodged period: the outstanding changes from earlier lodged periods it can carry.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'admin-accounting-bas-id-changes',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const period = await prisma.basPeriod.findUnique({ where: { id } })
  if (!period) return NextResponse.json({ error: 'BAS period not found' }, { status: 404 })

  let body: Record<string, unknown>
  if (period.status === 'LODGED') {
    const [drift] = await getLodgedPeriodDrift({ ids: [id] })
    const carriedIn = await prisma.basAdjustment.findMany({
      where: { targetPeriodId: id },
      orderBy: [{ recordDate: 'asc' }],
      include: { sourcePeriod: { select: { label: true, quarter: true, financialYear: true } } },
    })
    body = {
      drift: drift ?? null,
      carriedIn: carriedIn.map((a) => ({
        id: a.id,
        sourcePeriodId: a.sourcePeriodId,
        sourcePeriodLabel: basPeriodLabel(a.sourcePeriod),
        recordKey: a.recordKey,
        description: a.description,
        recordDate: a.recordDate,
        deltas: {
          g1Cents: a.g1Cents, g3Cents: a.g3Cents, g4Cents: a.g4Cents, g10Cents: a.g10Cents,
          g11Cents: a.g11Cents, label1ACents: a.label1ACents, label1BCents: a.label1BCents,
        },
      })),
    }
  } else {
    body = { priorPeriodItems: await getPriorPeriodItems(period) }
  }

  const res = NextResponse.json(body)
  res.headers.set('Cache-Control', 'no-store')
  return res
}
