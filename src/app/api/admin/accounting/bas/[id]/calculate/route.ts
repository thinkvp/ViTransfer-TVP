import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { basPeriodFromDb } from '@/lib/accounting/db-mappers'
import { calculateBasForPeriod } from '@/lib/accounting/bas-adjustments'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/admin/accounting/bas/[id]/calculate
// Runs the BAS calculation engine for this period and returns results (does NOT save figures).
// Un-lodged periods include outstanding changes to earlier lodged periods as prior-period
// adjustments (priorPeriodItems lists them, with the ones the user left out).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireApiMenu(request, 'accounting')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'admin-accounting-bas-calculate',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const { id } = await params
  const period = await prisma.basPeriod.findUnique({ where: { id } })

  if (!period) {
    return NextResponse.json({ error: 'BAS period not found' }, { status: 404 })
  }

  const { calculation, issues, records, priorPeriodItems } = await calculateBasForPeriod(period)

  const res = NextResponse.json({
    period: basPeriodFromDb(period),
    calculation,
    issues,
    records,
    priorPeriodItems,
  })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
